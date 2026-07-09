/* ============================================================================
 * Tier-1 "smart handoff" for real-world bookings (rides, food, reservations,
 * groceries). None of these services let a third-party app COMPLETE an order on
 * the user's account, so Taki does the thinking — parses the request, resolves
 * the details — and the DEVICE deep-links into the real app pre-filled. The user
 * confirms and pays in the app they already trust. This module only detects the
 * intent + extracts parameters; the device (App.tsx) builds the deep link (so it
 * can resolve "home"/"work" and use current GPS) and opens it.
 * ==========================================================================*/

export type ServiceKind = "ride" | "food" | "reservation" | "grocery";

export interface ServiceRequest {
  service: string;          // canonical key, e.g. "uber"
  label: string;            // display name, e.g. "Uber"
  kind: ServiceKind;
  query?: string;           // restaurant / food / store to search
  destination?: string;     // ride destination text (may be home/work/place)
  partySize?: number;       // reservation covers
  // date/time is resolved by the caller (needs tz/nowIso) and set on the action.
}

// Explicit provider names → {key,label,kind}. Named services override the
// verb-inferred default (e.g. "order food on grubhub").
const PROVIDERS: Record<string, { key: string; label: string; kind: ServiceKind }> = {
  uber: { key: "uber", label: "Uber", kind: "ride" },
  lyft: { key: "lyft", label: "Lyft", kind: "ride" },
  doordash: { key: "doordash", label: "DoorDash", kind: "food" },
  "door dash": { key: "doordash", label: "DoorDash", kind: "food" },
  "uber eats": { key: "ubereats", label: "Uber Eats", kind: "food" },
  ubereats: { key: "ubereats", label: "Uber Eats", kind: "food" },
  grubhub: { key: "grubhub", label: "Grubhub", kind: "food" },
  postmates: { key: "ubereats", label: "Uber Eats", kind: "food" },
  opentable: { key: "opentable", label: "OpenTable", kind: "reservation" },
  "open table": { key: "opentable", label: "OpenTable", kind: "reservation" },
  resy: { key: "resy", label: "Resy", kind: "reservation" },
  yelp: { key: "yelp", label: "Yelp", kind: "reservation" },
  instacart: { key: "instacart", label: "Instacart", kind: "grocery" }
};
const DEFAULT_FOR_KIND: Record<ServiceKind, { key: string; label: string }> = {
  ride: { key: "uber", label: "Uber" },
  food: { key: "doordash", label: "DoorDash" },
  reservation: { key: "opentable", label: "OpenTable" },
  grocery: { key: "instacart", label: "Instacart" }
};

function cleanTail(s: string): string {
  return s
    .replace(/[?.!]+$/, "")
    .replace(/\bplease\b/gi, "")
    .replace(/\bfor me\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function partySize(m: string): number | undefined {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const mm = m.match(/\b(?:table |party |reservation )?(?:for|of)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+people)?/);
  if (!mm) return undefined;
  const n = /^\d+$/.test(mm[1]) ? parseInt(mm[1], 10) : words[mm[1]];
  return n && n > 0 && n <= 30 ? n : undefined;
}

// Pull the destination out of a ride request ("uber to the airport", "ride home").
function rideDestination(m: string): string | undefined {
  if (/\b(take me |go |ride |get me )?home\b/.test(m) && !/\bfrom home\b/.test(m)) {
    // "home" only counts as the destination, not e.g. "home screen"
    if (/\b(home)\b/.test(m) && !/\bhome (screen|page|depot|goods)\b/.test(m)) {
      const toHome = /\bto home\b/.test(m) || /\b(ride|uber|lyft|take me|get me|drive me)\b[^.]*\bhome\b/.test(m);
      if (toHome) return "home";
    }
  }
  if (/\bto work\b/.test(m) || /\b(ride|uber|lyft|take me|get me)\b[^.]*\bto work\b/.test(m)) return "work";
  const mm = m.match(/\bto\s+(.+)$/);
  if (mm) {
    let d = cleanTail(mm[1]).replace(/^(the)\s+/, "the ");
    // strip trailing time/party phrases that belong to reservations, not rides
    d = d.replace(/\b(at|around)\s+\d.*$/, "").trim();
    if (d) return d;
  }
  return undefined;
}

const PROVIDER_RE = /\b(doordash|door dash|uber eats|ubereats|grubhub|postmates|instacart|opentable|open table|resy|yelp|uber|lyft)\b/gi;

// Restaurant/food/store text: prefer "order X from/on <provider>", then "from/at
// X", then a bare "order X". Provider names + filler are stripped out.
function afterFromAt(m: string): string | undefined {
  let q: string | undefined;
  let mm = m.match(/\b(?:order|get|grab|deliver|bring)\s+(?:me\s+)?(?:some\s+)?(.+?)\s+(?:from|on|via)\b/);
  if (mm) q = mm[1];
  else if ((mm = m.match(/\b(?:from|at)\s+(.+)$/))) q = mm[1];
  else if ((mm = m.match(/\b(?:order|get|grab|deliver|bring)\s+(?:me\s+)?(?:some\s+)?(.+)$/))) q = mm[1];
  if (!q) return undefined;
  q = cleanTail(q)
    .replace(PROVIDER_RE, "")
    .replace(/^(a|an|some|me)\s+/, "")
    .replace(/\b(food|delivery|takeout|take-out|groceries)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return q || undefined;
}

// Detect a booking/order/ride/reservation. Returns the structured request (minus
// date/time, which the caller resolves), or null. Conservative: requires a clear
// service verb or an explicit provider name so normal chat isn't grabbed.
export function parseServiceRequest(message: string): ServiceRequest | null {
  const m = message.toLowerCase().trim();

  // Which provider (if named)? Check longest names first so "uber eats" wins over
  // "uber".
  let named: { key: string; label: string; kind: ServiceKind } | null = null;
  for (const name of Object.keys(PROVIDERS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`).test(m)) { named = PROVIDERS[name]; break; }
  }

  // Which kind (by intent verbs)?
  const wantsRide = /\b(uber|lyft|taxi|cab)\b/.test(m) || /\b(get|call|order|book|grab|need|hail)\b[^.]*\b(ride|car|cab|taxi|lift)\b/.test(m) || /\bpick me up\b/.test(m) || /\b(ride|drive me)\s+(to|home)\b/.test(m);
  const wantsReservation = /\b(reserve|reservation|book(?:ing)?\s+a?\s*table|table\s+for|book(?:ing)?\s+(?:a\s+)?(?:dinner|lunch|spot)|opentable|resy)\b/.test(m);
  // Require a real delivery/order cue — NOT bare "grab/get" ("let's grab dinner
  // sometime" is making plans, not ordering).
  const wantsFood = /\b(doordash|uber eats|ubereats|grubhub|postmates)\b/.test(m) ||
    (/\b(order|deliver)\b/.test(m) && /\b(food|dinner|lunch|breakfast|takeout|take-out|delivery|pizza|sushi|burgers?|chinese|thai|tacos?|a meal|something to eat)\b/.test(m)) ||
    /\b(food|takeout|take-out) delivery\b/.test(m);
  const wantsGrocery = /\b(instacart|groceries|grocery run)\b/.test(m) || (/\b(order|get)\b/.test(m) && /\bgroceries\b/.test(m));

  // Resolve the service. An explicit provider name wins; else infer from verbs.
  let kind: ServiceKind | null = named?.kind
    ?? (wantsReservation ? "reservation" : wantsRide ? "ride" : wantsGrocery ? "grocery" : wantsFood ? "food" : null);
  if (!kind) return null;
  // OpenTable/Resy are restaurants only — don't hijack hotel/flight/appointment
  // "reservations" (let the LLM handle those).
  if (kind === "reservation" && /\b(hotel|motel|room|flight|airbnb|rental|car rental|campsite|appointment|doctor|dentist|salon|barber)\b/.test(m)) return null;
  // A named provider of one kind but a stronger verb of another → trust the verb
  // only when no provider was named.
  const svc = named ?? { ...DEFAULT_FOR_KIND[kind], kind };

  const req: ServiceRequest = { service: svc.key, label: svc.label, kind: svc.kind };

  if (svc.kind === "ride") {
    req.destination = rideDestination(m);
  } else if (svc.kind === "reservation") {
    // Restaurant name after "at X" only ("for N" is the party size, not a place).
    const rm = m.match(/\bat\s+(.+)$/);
    if (rm) {
      const r = cleanTail(rm[1])
        .replace(/\b(for|party of)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b(\s+people)?/g, "")
        .replace(/\b(tonight|today|tomorrow|this (evening|afternoon|weekend)|next \w+|at|around|@)\b\s*\d?.*$/g, "")
        .replace(/\b(a table|a reservation|dinner|lunch)\b/g, "")
        .replace(PROVIDER_RE, "")
        .replace(/\s+/g, " ")
        .trim();
      // Restaurant names are proper nouns — title-case for the confirmation line.
      if (r && r.length <= 60) req.query = r.replace(/\b([a-z])/g, (c) => c.toUpperCase());
    }
    req.partySize = partySize(m);
  } else if (svc.kind === "food" || svc.kind === "grocery") {
    req.query = afterFromAt(m);
  }
  return req;
}
