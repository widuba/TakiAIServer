import { ai, MAIN_MODEL, RESEARCH_MODEL, RESEARCH_TIMEOUT_MS, LIST_RESEARCH_TIMEOUT_MS, TIME_ZONE, safetyConfig } from "./ai.js";
import { personaPromptBlock, characterDirective } from "./persona.js";
import type { UserPersona } from "./persona.js";
import { isoFromYmdTime, addMinutesToIsoLocal, addDaysToYmd, ymdInTimeZone } from "./util.js";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The user's current wall-clock time in their timezone, for anchoring "next".
export function nowInTimeZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

// Strip common markdown so plain-text chat bubbles don't show literal **, #, `.
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(^|\n)\s*[-*]\s+/g, "$1• ")
    .trim();
}

// Build an absolute ISO (with the correct, DST-aware offset) from a wall-clock
// local date + time + the venue's IANA timezone. Letting the model give the
// timezone NAME and computing the offset in code avoids the "off by an hour"
// errors the model makes when it does the offset math itself. Returns null if
// the inputs are unusable.
function isoFromLocalParts(
  localDate: any,
  localTime: any,
  timeZone: any,
  fallbackTz: string
): { startDate: string; endDate: string } | null {
  const ymd = String(localDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const t = String(localTime || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  let tz = String(timeZone || "").trim();
  if (!tz || !isValidTimeZone(tz)) tz = fallbackTz;
  const startDate = isoFromYmdTime(ymd, hour, minute, tz);
  if (!Number.isFinite(Date.parse(startDate))) return null;
  return { startDate, endDate: addMinutesToIsoLocal(startDate, 120) };
}
import type { AssistantResponse, ConversationState, DeviceLocation } from "./types.js";
import { safeParseJsonObject, withTimeout } from "./util.js";

/* ============================================================================
 * Tools the planner can invoke. Each tool is a self-contained capability with
 * no memory/routing logic — the planner decides WHEN to use them.
 * ==========================================================================*/

/* ---- Location ----------------------------------------------------------- */

export function isDirectLocationQuestion(message: string) {
  return /\b(where am i|where i am|where i'm at|what is my location|what's my location|current location|my current location|tell me where i am)\b/i.test(message);
}

// Reverse-geocode coordinates to a human place name (city, state/region,
// country). Uses BigDataCloud (free, no key, reliable). Returns null if it
// can't resolve a name — we never fall back to raw coordinates.
async function reverseGeocodeDeviceLocation(deviceLocation: any): Promise<string | null> {
  if (!deviceLocation || typeof deviceLocation.latitude !== "number" || typeof deviceLocation.longitude !== "number") {
    return null;
  }
  const { latitude, longitude } = deviceLocation;

  try {
    const response = await withTimeout(
      fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=en`),
      7000,
      "Reverse geocode"
    );
    if (!response.ok) throw new Error(`Reverse geocode failed: ${response.status}`);

    const d: any = await response.json();
    const city = d.city || d.locality || "";
    const state = d.principalSubdivision || "";
    let country = String(d.countryName || "").replace(/\s*\(the\)\s*$/i, "").trim();
    // Shorten the two verbose official names.
    if (/^united states of america/i.test(country)) country = "United States";
    else if (/^united kingdom of great britain/i.test(country)) country = "United Kingdom";

    const parts: string[] = [];
    if (city) parts.push(city);
    if (state && state.toLowerCase() !== city.toLowerCase()) parts.push(state); // city, state…
    if (country) parts.push(country); // …, country
    return parts.length ? parts.join(", ") : null;
  } catch (error) {
    console.error("Reverse geocode error:", error);
    return null;
  }
}

export async function getLocationAnswer(deviceLocation: any): Promise<AssistantResponse> {
  if (!deviceLocation || typeof deviceLocation.latitude !== "number" || typeof deviceLocation.longitude !== "number") {
    return {
      spokenText: "I couldn't get your location. Make sure location access is allowed for Taki AI, then ask again.",
      action: null
    };
  }
  const label = await reverseGeocodeDeviceLocation(deviceLocation);
  if (!label) {
    return { spokenText: "I can tell you're connected, but I couldn't pin down your city right now.", action: null };
  }
  // City, State, Country (US) — or City, Region, Country elsewhere. No coordinates.
  return { spokenText: `You're in ${label}.`, action: null };
}

/* ---- Weather ------------------------------------------------------------ */

// Deterministic weather detector. Kept CONSERVATIVE on purpose: words like
// "hot"/"cold"/"high"/"low" appear constantly in non-weather questions ("how hot
// is a habanero", "good cold brew", "high score"). This runs before the LLM and
// short-circuits everything, so it must only fire on UNAMBIGUOUS weather. Real
// but ambiguous weather questions still get routed correctly by the LLM planner
// (intent "weather_answer"), so being strict here loses nothing.
export function isWeatherQuestion(message: string) {
  const m = message.toLowerCase();

  // Unambiguous weather vocabulary (precipitation words are weather on their
  // own, e.g. "when is it expected to rain", "is it going to snow").
  if (/\b(weather|forecast|umbrella|temperature|rain|raining|snow|snowing|sleet|drizzle|hail|thunderstorm|humidity)\b/.test(m)) return true;

  // "what's the temp", "how's the temp outside".
  if (/\btemp\b/.test(m) && /\b(outside|out|today|tonight|tomorrow|now)\b/.test(m)) return true;

  // Ambiguous condition words only count as weather when tied to the
  // environment/time (e.g. "is it hot outside", "how cold is it today").
  const condition = /\b(hot|cold|warm|chilly|cool|freezing|muggy|humid|sunny|windy|cloudy)\b/;
  const context = /\b(outside|out there|today|tonight|tomorrow|this (morning|afternoon|evening)|right now|currently|out)\b/;
  const itPattern = /\b(is it|will it be|gonna be|how (hot|cold|warm|chilly|humid) is it)\b/;
  if (condition.test(m) && (context.test(m) || itPattern.test(m))) return true;

  // "what should I wear today/tomorrow/outside" is a weather question.
  if (/\bwear\b/.test(m) && context.test(m)) return true;

  return false;
}

function weatherCodeDescription(code: number) {
  const map: Record<number, string> = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "foggy", 48: "foggy",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain",
    65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
    81: "rain showers", 82: "heavy rain showers", 95: "thunderstorms"
  };
  return map[code] || "unknown conditions";
}

function extractWeatherLocation(message: string) {
  if (/\b(here|near me|nearby|my location|my current location|current location|where i am|where i'm at|around me|outside)\b/i.test(message)) {
    return "DEVICE_LOCATION";
  }
  const inMatch = message.match(/\b(?:in|for|near|at)\s+([a-zA-Z\s,.-]+?)(?:\?|\.|$)/i);
  if (inMatch?.[1]) {
    const location = inMatch[1]
      .replace(/\b(today|tomorrow|tommorow|tonight|this (morning|afternoon|evening|week|weekend))\b/gi, "")
      .replace(/\b(high|low|temperature|temp|weather|forecast|rain|raining|snow|hot|cold|humidity)\b/gi, "")
      // Trailing filler people add: "...in jasper georgia again / right now / please".
      .replace(/\b(again|right now|now|currently|please|expected|supposed( to)?|going to|gonna|like)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/[,. ]+$/g, "")
      .trim();
    if (location) return location;
  }
  // "Boston weather", "Paris forecast" -> the leading words are the place. But
  // strip question/filler words so "what is the weather" doesn't treat
  // "what is the" as a city.
  const frontMatch = message.match(/^([a-zA-Z\s,.'-]+?)\s+(?:weather|temperature|forecast)$/i);
  if (frontMatch?.[1]) {
    const candidate = frontMatch[1]
      .replace(/\b(what'?s?|how'?s?|is|are|the|a|an|my|current|currently|today'?s?|tonight'?s?|tomorrow'?s?|right now|please|tell me|show me|give me|me|will|it|be|like)\b/gi, "")
      .replace(/[,. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (candidate) return candidate;
  }
  // No city mentioned -> weather is about where the user is. Use the device
  // location rather than a hardcoded city.
  return "DEVICE_LOCATION";
}

// Forward-geocode a free-text place ("jasper georgia", "austin tx", "paris")
// via Nominatim (OpenStreetMap) — it parses "city state" natively and returns a
// structured address, so we get the right place and a clean name. Returns null
// if it can't resolve anything.
async function geocodeCity(query: string): Promise<{ latitude: number; longitude: number; name: string } | null> {
  try {
    const r: any = await withTimeout(
      fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&limit=5`, {
        headers: { "User-Agent": "Taki AI weather assistant (support@takiai.app)" }
      }),
      8000,
      "Geocoding"
    );
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    // Prefer an actual city/town over a county/region with the same name
    // ("jasper georgia" -> the town of Jasper, not Jasper County).
    const POP = new Set(["city", "town", "village", "hamlet", "municipality", "suburb", "locality"]);
    const f = arr.find((x: any) => POP.has(String(x.addresstype || "").toLowerCase())) || arr[0];
    if (!f || !f.lat || !f.lon) return null;

    const a = f.address || {};
    const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || f.name || "";
    const region = a.state || a.region || a.province || "";
    let country = a.country || "";
    if (/^united states/i.test(country)) country = "United States";
    else if (/^united kingdom/i.test(country)) country = "United Kingdom";

    // "City, Region, Country", dropping empty or duplicate parts (no "Georgia, Georgia").
    const parts: string[] = [];
    for (const p of [city, region, country]) {
      const t = String(p).trim();
      if (t && (!parts.length || parts[parts.length - 1].toLowerCase() !== t.toLowerCase())) parts.push(t);
    }
    return { latitude: Number(f.lat), longitude: Number(f.lon), name: parts.join(", ") || String(f.display_name || query) };
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}

/* ============================================================================
 * Live Activity: "time to leave" commute tracker + plain countdowns.
 *
 * The server's job is only to (a) detect the intent and (b) name which event to
 * track. The DEVICE owns the rest (it has the calendar, GPS, and ActivityKit):
 * it finds the event, resolves the destination (calendar location, or this
 * module's web-inference endpoint), computes a traffic-aware ETA, and starts the
 * Live Activity that counts down to departure.
 * ==========================================================================*/

// "When do I need to leave for my tennis match?", "track my commute to the game",
// "put a leave time on my lock screen", "when should I head out for dinner".
export function looksLikeLeaveTimeQuestion(message: string): boolean {
  const m = message.toLowerCase();
  // "remind me to <task> when I leave/get to X" is a location REMINDER, not a
  // commute. (Commute phrasing is "remind me WHEN to leave", no task.)
  if (/\bremind me to\b/.test(m)) return false;
  const leave =
    /\b(when|what time|how soon)\b[^.?!]*\b(leave|head out|head off|get going|set off|take off|hit the road)\b/.test(m) ||
    /\b(time to leave|leave time|when to leave|departure time|when i (need|have) to leave|when should i leave)\b/.test(m) ||
    /\b(track|start|put|show)\b[^.?!]*\b(commute|drive|trip|travel time|leave time|departure)\b/.test(m) ||
    /\b(remind me when to leave|tell me when to leave|let me know when to leave)\b/.test(m) ||
    /\bhow long\b[^.?!]*\b(to get|to drive|to reach|to get there)\b/.test(m);
  return leave;
}

// "Start a countdown to the game", "put a countdown to my flight on my lock screen".
export function looksLikeCountdownRequest(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(countdown|count down)\b/.test(m) ||
    /\b(live activity|lock screen timer|dynamic island)\b[^.?!]*\b(to|for|until)\b/.test(m);
}

// Pull the event phrase out of a leave-time / countdown request, so the device
// can match it against the calendar. Strips the command framing and leaves the
// noun ("tennis match", "the Braves game", "my 4pm meeting", "flight").
export function eventQueryFromLiveActivityMessage(message: string): string {
  let q = message.toLowerCase().trim();
  q = q
    .replace(/\b(hey |ok |okay |please |can you |could you |would you |i want you to |i'd like you to )\b/g, " ")
    .replace(/\b(when|what time|how soon|how long)\b/g, " ")
    .replace(/\b(do|should|will|would|can|could|i|need|have)\b/g, " ")
    .replace(/\b(to )?(leave|head out|head off|get going|set off|set out|take off|hit the road|depart)\b/g, " ")
    .replace(/\b(start|put|show|track|set up|create|make)\b/g, " ")
    .replace(/\b(a |an |the )?(countdown|count down|commute|drive|trip|travel time|leave time|departure|live activity|timer)\b/g, " ")
    .replace(/\b(on |to |for |until |my )?(lock screen|dynamic island)\b/g, " ")
    .replace(/\b(remind|tell|let)\b[^.?!]*\b(me|know)\b/g, " ")
    .replace(/\b(when|to|for|until|about)\b/g, " ")
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q;
}

// Resolve where a calendar event is actually happening, so the device can route
// to it. Priority: an explicit calendar location (geocode it) > a venue we can
// infer from the title + the user's city via grounded search. Returns null when
// we can't pin a real place (the device then asks the user or skips).
// Geocode a specific PLACE/venue/address (POI-friendly). Unlike geocodeCity,
// this returns the top hit's exact point (e.g. a stadium), not the enclosing
// city, so routing goes to the actual venue.
async function geocodePlace(query: string): Promise<{ latitude: number; longitude: number; name: string } | null> {
  try {
    const r: any = await withTimeout(
      fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&addressdetails=1&limit=1`, {
        headers: { "User-Agent": "Taki AI weather assistant (support@takiai.app)" }
      }),
      8000,
      "Place geocoding"
    );
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length || !arr[0].lat || !arr[0].lon) return null;
    const f = arr[0];
    const name = String(f.name || String(f.display_name || query).split(",")[0]).trim();
    return { latitude: Number(f.lat), longitude: Number(f.lon), name };
  } catch (error) {
    console.error("Place geocoding error:", error);
    return null;
  }
}

// Ask the model for ONE specific, navigable venue line for an event. Flash knows
// most stadiums/arenas/venues outright, so we try it first (fast, no search) and
// only fall back to grounded search for the ambiguous cases.
async function inferVenueLine(title: string, notes: string | undefined, userCity: string): Promise<string | null> {
  const prompt = `You determine the exact, navigable VENUE for a calendar event so the user can drive there.

Event: "${title}"${notes ? `\nNotes: "${notes}"` : ""}${userCity ? `\nThe user is near: ${userCity}` : ""}

Rules:
- Sports matchup ("Team A vs Team B" / "A vs. B" / "A versus B"): the game is at the HOME team's venue, and the home team is listed FIRST (A). For "A at B" or "A @ B", the home team is B. Use that team's real home stadium/arena.
- Concerts, shows, conferences: use the specific named venue.
- Generic personal activity (gym, dentist, haircut, "tennis", "practice") with no clear venue: only name a specific local place if the user's city is given and one is the obvious choice; otherwise reply "UNKNOWN".
- Output ONE line: the venue name followed by its full street address and city, e.g. "Truist Park, 755 Battery Ave SE, Atlanta, GA 30339". No commentary. If you truly cannot tell, reply exactly "UNKNOWN".`;

  // Fast path: flash, thinking off, no web search.
  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } }
      } as any),
      9000,
      "Venue inference (fast)"
    );
    const line = (res.text || "").trim().split("\n")[0].trim();
    if (line && !/^unknown$/i.test(line)) return line;
  } catch (error) {
    console.error("Venue inference (fast) error:", error);
  }

  // Fallback: grounded search for anything flash wasn't sure about.
  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: RESEARCH_MODEL,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] }
      } as any),
      RESEARCH_TIMEOUT_MS,
      "Venue inference (search)"
    );
    const line = (res.text || "").trim().split("\n")[0].trim();
    if (line && !/^unknown$/i.test(line)) return line;
  } catch (error) {
    console.error("Venue inference (search) error:", error);
  }
  return null;
}

export async function inferEventDestination(opts: {
  title?: string;
  location?: string;
  notes?: string;
  lat?: number;
  lon?: number;
}): Promise<{ name: string; latitude: number; longitude: number; source: "calendar" | "inferred"; confidence: number } | null> {
  // 1) Explicit calendar location wins — geocode it precisely.
  if (opts.location && opts.location.trim()) {
    const g = await geocodePlace(opts.location.trim());
    if (g) return { name: g.name, latitude: g.latitude, longitude: g.longitude, source: "calendar", confidence: 0.95 };
  }

  const title = (opts.title || "").trim();
  if (!title) return null;

  // The user's city helps disambiguate generic/local events (and confirms the
  // right city for home games), but is NOT required for known venues.
  let userCity = "";
  if (Number.isFinite(opts.lat) && Number.isFinite(opts.lon)) {
    userCity = (await reverseGeocodeDeviceLocation({ latitude: opts.lat, longitude: opts.lon })) || "";
  }

  const venue = await inferVenueLine(title, opts.notes, userCity);
  if (!venue) return null;

  // Geocode the full venue line; if the exact address misses, retry with just
  // the venue name.
  let g = await geocodePlace(venue);
  if (!g) g = await geocodePlace(venue.split(",")[0].trim());
  if (!g) return null;

  // Show the venue's own name ("Truist Park") rather than the enclosing city.
  const shortName = venue.split(",")[0].trim() || g.name;
  return { name: shortName, latitude: g.latitude, longitude: g.longitude, source: "inferred", confidence: 0.6 };
}

// Detect the transport mode the user asked for ("" = unspecified -> driving).
export function detectTransportMode(message: string): string {
  const m = message.toLowerCase();
  if (/\b(walk|walking|on foot|by foot)\b/.test(m)) return "walking";
  if (/\b(bike|biking|bicycle|bicycling|cycle|cycling)\b/.test(m)) return "bicycling";
  if (/\b(train|subway|metro|transit|the bus|by bus|public transport|public transit|light ?rail|tram)\b/.test(m)) return "transit";
  if (/\b(driv(e|ing)?|by car|in the car)\b/.test(m)) return "driving";
  return "";
}

// Travel time via the Google Maps Directions API: covers driving (with live
// traffic via duration_in_traffic), walking, bicycling, and transit. Requires
// GOOGLE_MAPS_API_KEY (Maps Platform, Directions API enabled). Returns null if
// no key / no route, so the device can fall back to MapKit for driving+walking.
export async function getTravelTime(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  mode: string
): Promise<{ seconds: number; distanceMeters: number; mode: string } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const m = ["driving", "walking", "bicycling", "transit"].includes(mode) ? mode : "driving";

  const params = new URLSearchParams({
    origin: `${fromLat},${fromLon}`,
    destination: `${toLat},${toLon}`,
    mode: m,
    key
  });
  // Traffic-aware driving + scheduled transit both key off departure_time.
  if (m === "driving" || m === "transit") params.set("departure_time", "now");
  if (m === "driving") params.set("traffic_model", "best_guess");

  try {
    const r: any = await withTimeout(
      fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`),
      9000,
      "Directions"
    );
    const data = await r.json();
    if (data.status !== "OK" || !Array.isArray(data.routes) || !data.routes.length) return null;
    const leg = data.routes[0].legs?.[0];
    if (!leg) return null;
    const seconds = leg.duration_in_traffic?.value ?? leg.duration?.value;
    if (!Number.isFinite(seconds)) return null;
    return { seconds: Math.round(seconds), distanceMeters: Math.round(leg.distance?.value ?? 0), mode: m };
  } catch (error) {
    console.error("Directions error:", error);
    return null;
  }
}

// Let the model read the user's upcoming events + what they actually said, and
// pick which event they mean. Handles loose references the literal matcher
// misses: "the braves game" -> an event titled "Padres @ Braves", nicknames,
// abbreviations, venues, timing words. Returns the event index, or -1 if none.
export async function matchEventToQuery(
  query: string,
  events: { title: string; when?: string; location?: string }[]
): Promise<number> {
  if (!query.trim() || events.length === 0) return -1;

  const list = events
    .map((e, i) => `${i}) ${e.title || "(untitled)"}${e.when ? ` — ${e.when}` : ""}${e.location ? ` @ ${e.location}` : ""}`)
    .join("\n");

  const prompt = `The user wants to set a "time to leave" / countdown for an event they referred to as: "${query}".

Their upcoming calendar events:
${list}

Pick the ONE event that genuinely matches their reference. Reason about:
- team names + nicknames (e.g. "the braves game" = an Atlanta Braves matchup, which may be titled "Padres @ Braves", "ATL vs SD", "Braves baseball", etc.)
- abbreviations, venues, and any timing words ("tonight", "tomorrow", "later").

Be strict: the event must actually correspond to what they said. If they named a DIFFERENT kind of thing than anything on the list (e.g. they said "the concert" but the events are only a baseball game and a dentist appointment), reply -1. Do NOT force a match just to pick something.

Reply with ONLY the index number of the genuine match, or -1 if none. No other text.`;

  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } }
      } as any),
      9000,
      "Event match"
    );
    const m = (res.text || "").trim().match(/-?\d+/);
    if (!m) return -1;
    const idx = parseInt(m[0], 10);
    return Number.isFinite(idx) && idx >= 0 && idx < events.length ? idx : -1;
  } catch (error) {
    console.error("Event match error:", error);
    return -1;
  }
}

/* ============================================================================
 * Alarms (scheduled local notifications on the device).
 * The server only detects intent + parses the target time in the user's local
 * timezone; the device schedules the notification + a countdown Live Activity.
 * ==========================================================================*/

export function looksLikeCancelAlarmRequest(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(cancel|delete|remove|turn off|clear|stop)\b[^.?!]*\balarms?\b/.test(m);
}

export function looksLikeAlarmRequest(message: string): boolean {
  const m = message.toLowerCase();
  if (looksLikeCancelAlarmRequest(message)) return false;
  return (
    /\b(set|create|make|start|add|schedule)\b[^.?!]*\balarm\b/.test(m) ||
    /\balarm\b[^.?!]*\b(at|for)\b/.test(m) ||
    /\bwake me( up)?\b/.test(m)
  );
}

// Resolve the user's phrasing into an absolute local alarm time. Reuses the
// same wall-clock -> offset approach as calendar events (no model UTC math).
export async function parseAlarmTime(
  message: string,
  nowIso: string,
  timeZone: string
): Promise<{ iso: string; label: string } | null> {
  const tz = isValidTimeZone(timeZone) ? timeZone : TIME_ZONE;
  const now = Date.parse(nowIso) || Date.now();
  const m = message.toLowerCase();

  // --- Deterministic fast path (regex). The LLM kept mis-picking the day and
  // botching relative math, so parse the common shapes ourselves. ---

  // Relative: "in 20 minutes", "in an hour", "in half an hour".
  let relMs = 0;
  const rel = m.match(/\bin\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    relMs = rel[2].startsWith("s") ? n * 1000 : rel[2].startsWith("h") ? n * 3600000 : n * 60000;
  } else if (/\bin\s+an?\s+hour\b/.test(m)) {
    relMs = 3600000;
  } else if (/\bin\s+(a\s+|an\s+)?half\s+(an\s+)?hour\b/.test(m)) {
    relMs = 1800000;
  }
  if (relMs > 0) return { iso: new Date(now + relMs).toISOString(), label: "" };

  // Absolute clock time.
  const tomorrow = /\btomorrow\b/.test(m);
  let hour = -1, minute = 0, ampm = "";
  let cm = m.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (cm) {
    hour = parseInt(cm[1], 10); minute = cm[2] ? parseInt(cm[2], 10) : 0; ampm = cm[3].startsWith("p") ? "pm" : "am";
  } else if ((cm = m.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/))) {
    hour = parseInt(cm[1], 10); minute = parseInt(cm[2], 10);
  } else if ((cm = m.match(/\b(?:at|for)\s+(\d{1,2})\b/))) {
    hour = parseInt(cm[1], 10); minute = 0;
  }
  if (/\bnoon\b/.test(m)) { hour = 12; minute = 0; ampm = "pm"; }
  if (/\bmidnight\b/.test(m)) { hour = 12; minute = 0; ampm = "am"; }

  if (hour >= 1 && hour <= 23 && minute >= 0 && minute <= 59) {
    const explicit = !!ampm;
    const h24 = ampm ? (ampm === "pm" ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour)) : hour % 12;
    const todayLocal = ymdInTimeZone(new Date(now), tz); // user's local date (NOT UTC)
    const baseYmd = tomorrow ? addDaysToYmd(todayLocal, 1) : todayLocal;
    let ms = Date.parse(isoFromYmdTime(baseYmd, Math.min(23, h24), minute, tz));
    if (Number.isFinite(ms)) {
      const step = explicit ? 24 * 3600 * 1000 : 12 * 3600 * 1000;
      let guard = 0;
      while (ms <= now + 1000 && guard++ < 4) ms += step;
      return { iso: new Date(ms).toISOString(), label: "" };
    }
  }

  // --- Fall back to the model for anything the regex didn't catch. ---
  const prompt = `Current time: ${nowIso}
Time zone: ${tz}

The user wants to set an alarm. Report the clock time they asked for.

Message: "${message}"

Rules:
- "hour"/"minute": 24-hour. For a bare clock number with no am/pm (e.g. "9:21", "7"), report the AM reading (hour 0-11) and set ampmGiven=false. For a relative time ("in 20 minutes"), compute the resulting clock time.
- "ampmGiven": true if the user explicitly said am/pm, or gave a 24-hour or relative time; false only for a bare clock number.
- "dayOffset": 0 for any plain time today/soonest. Use 1 only if they explicitly said "tomorrow" (or a relative time that crosses past midnight); 2+ for further explicit days. NEVER bump the day just because a time seems to have passed — the app handles that.
- "label": short reason if stated (e.g. "gym"), else "".

Reply with ONLY JSON: {"valid":true,"hour":<0-23>,"minute":<0-59>,"ampmGiven":<true|false>,"dayOffset":<0-7>,"label":"..."}
If you cannot determine a time at all, reply {"valid":false}.`;

  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } }
      } as any),
      9000,
      "Alarm parse"
    );
    const obj = safeParseJsonObject(res.text || "");
    if (!obj || obj.valid === false) return null;
    const hour = Number(obj.hour);
    const minute = Number(obj.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

    // Compute the day entirely in code: start from today (in the user's tz) at
    // the requested clock time, shifted by an explicit dayOffset, then roll
    // forward to the next valid occurrence. (We never trust a model-chosen date,
    // which mis-picked the day in testing.)
    const todayYmd = ymdInTimeZone(new Date(now), tz); // user's local date (NOT UTC)
    const dayOffset = Math.max(0, Math.min(7, Math.round(Number(obj.dayOffset) || 0)));
    const baseYmd = addDaysToYmd(todayYmd, dayOffset);
    let ms = Date.parse(
      isoFromYmdTime(baseYmd, Math.max(0, Math.min(23, Math.round(hour))), Math.max(0, Math.min(59, Math.round(minute))), tz)
    );
    if (!Number.isFinite(ms)) return null;

    // Bare times (no am/pm) advance in 12h steps so "9:21" near 9pm becomes
    // whichever 9:21 is next; explicit am/pm advances 24h (same time next day).
    const explicitAmPm =
      obj.ampmGiven === true ||
      /\b(am|pm|a\.m|p\.m|noon|midnight|morning|afternoon|evening|tonight)\b/i.test(message) ||
      /\bin\s+\d+\s*(min|minute|hour|hr)/i.test(message);
    const stepMs = explicitAmPm ? 24 * 3600 * 1000 : 12 * 3600 * 1000;
    let guard = 0;
    while (ms <= now + 1000 && guard++ < 4) ms += stepMs;

    return { iso: new Date(ms).toISOString(), label: typeof obj.label === "string" ? obj.label.trim().slice(0, 40) : "" };
  } catch (error) {
    console.error("Alarm parse error:", error);
    return null;
  }
}

/* ============================================================================
 * Timers + Stopwatch (in-app, surfaced as countdown / count-up Live Activities;
 * timers also fire a local notification). Server detects intent + parses the
 * duration; the device runs it.
 * ==========================================================================*/

export function looksLikeTimerCancel(message: string): boolean {
  return /\b(cancel|stop|clear|delete|remove|end|kill)\b[^.?!]*\btimers?\b/.test(message.toLowerCase());
}

export function looksLikeTimerRequest(message: string): boolean {
  const m = message.toLowerCase();
  if (looksLikeTimerCancel(message)) return false;
  return /\b(set|start|create|make|put|run)\b[^.?!]*\btimer\b/.test(m) || /\btimer\b[^.?!]*\bfor\b/.test(m);
}

export function looksLikeStopwatchStop(message: string): boolean {
  return /\b(stop|reset|clear|cancel|end|pause)\b[^.?!]*\bstop ?watch\b/.test(message.toLowerCase());
}

export function looksLikeStopwatchStart(message: string): boolean {
  const m = message.toLowerCase();
  if (looksLikeStopwatchStop(message)) return false;
  return /\b(start|begin|launch|run|open)\b[^.?!]*\bstop ?watch\b/.test(m) || /\bstop ?watch\b/.test(m);
}

// Parse a timer duration ("10 minutes", "an hour and a half", "90 secs") into
// seconds + an optional label.
export async function parseTimerDuration(message: string): Promise<{ seconds: number; label: string } | null> {
  const prompt = `The user wants to start a countdown timer. From their message, work out the total duration in SECONDS.

Message: "${message}"

- "an hour and a half" = 5400, "90 seconds" = 90, "2 min" = 120, "1:30" (mm:ss) = 90.
- "label" is what the timer is for if stated (e.g. "pasta", "tea"), else "".

Reply with ONLY JSON: {"seconds":<positive integer>,"label":"..."}.
If no duration is given, reply {"seconds":0}.`;

  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } }
      } as any),
      9000,
      "Timer parse"
    );
    const obj = safeParseJsonObject(res.text || "");
    const seconds = obj ? Math.round(Number(obj.seconds)) : 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return { seconds: Math.min(seconds, 24 * 3600), label: typeof obj.label === "string" ? obj.label.trim().slice(0, 40) : "" };
  } catch (error) {
    console.error("Timer parse error:", error);
    return null;
  }
}

/* ============================================================================
 * Math / calculations. LLMs are unreliable at arithmetic, so we let the model
 * only TRANSLATE the question into a JS math expression, then evaluate it
 * deterministically in code (exact, never hallucinated).
 * ==========================================================================*/

export function looksLikeMathQuestion(message: string): boolean {
  const m = message.toLowerCase();
  if (/\b(natural log|ln of|\bln\b|log of|log base|logarithm|square root|cube root|sqrt|factorial|to the power|raised to|squared|cubed|sine of|cosine of|tangent of)\b/.test(m)) return true;
  if (/\d\s*%\s*of\s+\d/.test(m) || /\bpercent of\b/.test(m)) return true;
  if (/\d\s*(?:[+\-*/^]|x|×|÷)\s*\d/.test(m)) return true; // 8 * 7, 100 / 4, 2^10
  if (/\b(calculate|compute|evaluate|what(?:'?s| is)|how much is)\b/.test(m) &&
      /\d/.test(m) &&
      /[+\-*/^%]|\b(times|plus|minus|divided|multiplied|root|log)\b/.test(m)) return true;
  return false;
}

function formatNumber(val: number): string {
  if (Number.isInteger(val)) return String(val);
  const trimmed = Number(val.toPrecision(7)); // kill float noise (2.0794415 -> 2.079442)
  return String(trimmed);
}

// Evaluate a calculation exactly. Returns a concise string answer, or null if it
// isn't a pure calculation / can't be safely evaluated.
export async function computeMath(message: string): Promise<string | null> {
  const prompt = `Convert this into ONE JavaScript math expression. Use only: numbers, the operators + - * / % **, parentheses, commas, and Math functions/constants — Math.log (natural log/ln), Math.log10, Math.log2, Math.sqrt, Math.cbrt, Math.pow, Math.abs, Math.exp, Math.sin, Math.cos, Math.tan, Math.round, Math.floor, Math.ceil, Math.PI, Math.E. Trig is in radians unless the user says degrees (then convert with *Math.PI/180).

Question: "${message}"

Also give a short "label" naming the quantity in plain words (e.g. "the natural log of 8", "17% of 240", "123 times 456", "2 to the power of 10").

Reply ONLY JSON: {"expr":"<expression>","label":"<short phrase>"}  — or {"expr":null} if it is not a numeric calculation.`;

  try {
    const res: any = await withTimeout(
      ai.models.generateContent({ model: MAIN_MODEL, contents: prompt, config: { thinkingConfig: { thinkingBudget: 0 } } } as any),
      7000,
      "Math translate"
    );
    const obj = safeParseJsonObject(res.text || "");
    const expr = obj && typeof obj.expr === "string" ? obj.expr.trim() : "";
    if (!expr || expr.length > 200) return null;

    // Safety: after removing allowed Math.<fn> tokens, only math characters may
    // remain — no other identifiers, no arbitrary code.
    const stripped = expr.replace(/Math\.[A-Za-z][A-Za-z0-9]*/g, "0");
    if (!/^[0-9+\-*/%.()\s,]*$/.test(stripped)) return null;

    // eslint-disable-next-line no-new-func
    const val = Function('"use strict"; return (' + expr + ");")();
    if (typeof val !== "number" || !Number.isFinite(val)) return null;

    const num = formatNumber(val);
    const phrase = Number.isInteger(val) ? num : `about ${num}`; // "about" for rounded decimals
    const label = obj && typeof obj.label === "string" ? obj.label.trim().slice(0, 60) : "";
    if (label) {
      return `${label.charAt(0).toUpperCase()}${label.slice(1)} is ${phrase}.`;
    }
    return Number.isInteger(val) ? `That's ${num}.` : `That's about ${num}.`;
  } catch (error) {
    console.error("Math compute error:", error);
    return null;
  }
}

/* ============================================================================
 * Health (read-only HealthKit) + HomeKit control. Server only detects intent;
 * the device reads Health / drives HomeKit.
 * ==========================================================================*/

// Returns a HealthKit metric key if the message is asking about the user's own
// daily health stats, else "".
// Map a natural-language health question to one of HealthBridge's metric keys.
// Order matters: more specific patterns first. Body-context is required for the
// ambiguous ones (temperature, distance) so "temperature outside" / "distance to
// the airport" stay weather/maps, not Health.
export function detectHealthMetric(message: string): string {
  const m = message.toLowerCase();
  const pairs: [RegExp, string][] = [
    [/\b(how did i sleep|hours? of sleep|sleep last night|did i sleep|how (long|much) did i sleep|my sleep)\b/, "sleep"],
    [/\bblood ?pressure\b/, "bloodpressure"],
    [/\bresting heart ?rate\b/, "restingheartrate"],
    [/\bwalking heart ?rate\b/, "walkingheartrate"],
    [/\b(hrv|heart rate variability)\b/, "hrv"],
    [/\b(my |average |current )?(heart ?rate|pulse|bpm)\b/, "heartrate"],
    [/\b(blood ?oxygen|oxygen saturation|spo2|o2 sat|my oxygen)\b/, "oxygen"],
    [/\b(respiratory rate|breathing rate|breaths per|how fast am i breathing)\b/, "respiratory"],
    [/\b(body temperature|my (body )?temp(erature)?|do i have a fever|running a fever)\b/, "temperature"],
    [/\b(blood ?sugar|blood ?glucose|my glucose)\b/, "glucose"],
    [/\bvo ?2 ?max|vo₂\b/, "vo2max"],
    [/\b(how many steps|step count|my steps|steps (today|so far|have i|did i|yesterday)|steps\s+(on\s+)?(mon|tues|wednes|thurs|fri|satur|sun)day)\b/, "steps"],
    [/\b(flights? of stairs|stairs climbed|floors climbed|flights? climbed|how many (flights of stairs|floors)|climbed \d+ (flights|floors))\b/, "flights"],
    [/\b(how far|how many miles|how long) (did|have) i (cycl|bike|biked|biking|ride|rode)|cycling distance|biked? today\b/, "cycling"],
    [/\b(how far (did|have) i (walk|ran|run|go|jog)|how many (miles|km|kilomet) (did|have) i|my (walking|running) distance|distance (i (walked|ran)|walked today|today))\b/, "distance"],
    [/\b(resting (energy|calories?)|basal (energy|calories?))\b/, "restingenergy"],
    [/\b(calories (eaten|consumed|i ate)|how many calories did i eat|food calories|calorie intake)\b/, "dietaryenergy"],
    [/\b((active )?calories ?(burned|burnt)?|energy burned|how many calories (have i|did i) burn|calories today)\b/, "energy"],
    [/\b(exercise (minutes|time|today)|how (long|much) did i (exercise|work ?out)|workout (minutes|time)|move ring|active minutes)\b/, "exercise"],
    [/\b(stand (hours|time|ring)|how (long|many hours) (did i|have i) (stood|stand))\b/, "stand"],
    [/\b(how much water|water (did i|i)|hydration|water intake)\b/, "water"],
    [/\b(body ?fat|fat percentage)\b/, "bodyfat"],
    [/\b(lean (body )?mass|muscle mass)\b/, "leanmass"],
    [/\b(bmi|body mass index)\b/, "bmi"],
    [/\b(how much do i weigh|how heavy am i|my weight|what(?:'s| is) my weight|current weight)\b/, "weight"],
    [/\b(how tall am i|my height|what(?:'s| is) my height)\b/, "height"]
  ];
  for (const [re, key] of pairs) if (re.test(m)) return key;
  return "";
}

// Which DAY a health question refers to. Returns { offset (days back from today),
// label } or null (= today/unspecified). The device applies the offset to its own
// "today" so the boundaries are in the user's real local time.
export function detectHealthDay(message: string, timeZone: string): { offset: number; label: string } | null {
  const m = message.toLowerCase();
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const idx = days.findIndex((d) => new RegExp(`\\b${d}\\b`).test(m));
  if (idx >= 0) {
    let todayName = "sunday";
    try { todayName = new Date().toLocaleDateString("en-US", { timeZone, weekday: "long" }).toLowerCase(); } catch { /* default tz */ }
    const today = days.indexOf(todayName);
    let offset = today >= 0 ? (today - idx + 7) % 7 : 0; // most recent occurrence
    if (offset === 0 && new RegExp(`\\blast\\s+${days[idx]}\\b`).test(m)) offset = 7;
    const label = offset === 0 ? "today" : `on ${days[idx][0].toUpperCase()}${days[idx].slice(1)}`;
    return { offset, label };
  }
  if (/\b(day before yesterday|two days ago|2 days ago|the day before|day before)\b/.test(m)) return { offset: 2, label: "two days ago" };
  if (/\byesterday\b/.test(m)) return { offset: 1, label: "yesterday" };
  const n = m.match(/\b(\d+)\s+days?\s+ago\b/);
  if (n) { const k = Math.max(1, Math.min(14, parseInt(n[1], 10))); return { offset: k, label: `${k} days ago` }; }
  return null;
}

// Parse a HomeKit command, else null.
export function parseHomeCommand(message: string): { action: string; target: string; value: number } | null {
  const m = message.toLowerCase().trim();
  // Lights — handle any word order and verb: "turn on the lights", "turn the
  // lights off", "lights out", "dim the bedroom lights", "kitchen lights on".
  if (/\blights?\b/.test(m) && /\b(turn|switch|dim|brighten|lower|raise|shut|kill|out|on|off|set)\b/.test(m)) {
    const isOff = /\b(off|out)\b/.test(m) || /\b(shut|kill)\b/.test(m);
    // Room = the word right before "lights", if it's a real room (not an article/verb).
    let target = "";
    const rm = m.match(/\b([a-z]+)\s+lights?\b/);
    const skip = ["the", "my", "a", "an", "turn", "switch", "dim", "brighten", "lower", "raise", "some", "all", "those", "these", "off", "on", "shut", "kill"];
    if (rm && !skip.includes(rm[1])) target = rm[1];
    return { action: isOff ? "lightsOff" : "lightsOn", target, value: 0 };
  }
  if (/\b(unlock)\b[^.?!]*\b(door|doors|lock|front door)\b/.test(m)) return { action: "unlock", target: "", value: 0 };
  if (/\b(lock)\b[^.?!]*\b(door|doors|up|front door)\b/.test(m) || /\block the door\b/.test(m)) return { action: "lock", target: "", value: 0 };
  if (/\b(thermostat|temperature)\b/.test(m) && /\b(set|make|turn|put|change|adjust|to)\b/.test(m)) {
    const num = m.match(/\b(\d{2,3})\b/);
    if (num) return { action: "thermostat", target: "", value: parseInt(num[1], 10) };
  }
  return null;
}

/* ============================================================================
 * Apple Music control + Photos viewer (device-side). Server detects intent.
 * ==========================================================================*/

// Parse an Apple Music command, else null. "play X" only counts as music when a
// music cue is present, so it doesn't hijack "play the game" etc.
export function parseMusicCommand(message: string): { action: string; query: string } | null {
  const m = message.toLowerCase().trim();
  if (/\b(pause|stop|halt|hold)\b[^.?!]*\b(music|song|playback|playing|track|tune|it)\b/.test(m) || /^(pause|stop|pause music|stop music|shut it off)$/.test(m)) {
    return { action: "pause", query: "" };
  }
  if (/\b(skip|next|forward)\b[^.?!]*\b(song|track|tune|this|one)\b/.test(m) || /^(skip|next|next song|next track|skip this|skip it)$/.test(m) || /\b(skip|next) (this|it|song|track)\b/.test(m)) {
    return { action: "next", query: "" };
  }
  if (/\b(previous|last|prior|go back|back a)\b[^.?!]*\b(song|track|tune|one)\b/.test(m) || /^(previous|previous track|previous song|go back|last song)$/.test(m)) {
    return { action: "previous", query: "" };
  }
  if (/\b(resume|unpause|keep playing|continue|play again|start again)\b/.test(m) && /\b(music|song|playing|playback|track|it)\b/.test(m) || /^(resume|unpause|keep playing|continue)$/.test(m)) {
    return { action: "resume", query: "" };
  }
  // "play / put on / listen to / throw on / queue up / blast / spin X" — treat as
  // music by default (so bare song names like "play all falls down" work), EXCEPT
  // clearly non-music things.
  const pm = m.match(/\b(?:play|put on|listen to|throw on|queue up|queue|blast|spin|start playing|i wanna hear|i want to hear|can you play|let'?s hear)\b\s+(.+)/);
  if (pm) {
    const obj = pm[1].trim();
    const nonMusic =
      /^with\b/.test(obj) ||
      /\b(game|match|video|movie|film|episode|series|trailer|the news|podcast|highlights?|world cup|super ?bowl|nba|nfl|mlb|nhl|youtube|tv|show)\b/.test(obj);
    if (!nonMusic) {
      // Keep the query close to what they said (so "goat songs" / "all falls down"
      // match); only trim framing words.
      const q = obj
        .replace(/\bon apple music\b/g, "")
        .replace(/\bplease\b/g, "")
        .replace(/^(some|my|the|a|an)\s+/, "")
        .replace(/\b(playlist|album)$/g, "")
        .replace(/[?.!]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (q) return { action: "play", query: q };
    }
  }
  return null;
}

// "show my photos / recent photos / photos from today/this week/last week".
export function parsePhotosCommand(message: string): { days: number } | null {
  const m = message.toLowerCase();
  if (!/\b(photos?|pictures?|pics)\b/.test(m)) return null;
  if (!/\b(show|see|view|pull up|open|recent|my|from|take a look)\b/.test(m)) return null;
  let days = 0;
  if (/\btoday\b/.test(m)) days = 1;
  else if (/\b(this week|past week|last 7 days|recent)\b/.test(m)) days = 7;
  else if (/\b(last week)\b/.test(m)) days = 14;
  else if (/\b(this month|past month|last 30 days)\b/.test(m)) days = 30;
  return { days };
}

// Normalized forecast both providers fill, so formatting is shared.
type WeatherData = {
  tempNow: number;
  feelsNow: number;
  condNow: string;
  todayHigh: number;
  todayLow: number;
  todayRainChance: number;
  tomorrowHigh: number | null;
  tomorrowLow: number | null;
  tomorrowCond: string | null;
  tomorrowRainChance: number | null;
  rainingNow: boolean;
  rainStart: string | null; // e.g. "4 PM" / "Wed 9 AM", or null if none expected
};

const isRainyText = (s?: string) => /rain|shower|snow|sleet|storm|drizzle|thunder|wintry/i.test(s || "");

// PRIMARY: weather.gov (National Weather Service). US-only, free, no key, but
// needs a User-Agent. Hourly data lets us answer "when will it rain". Returns
// null when unavailable (outside the US, or an error) so we can fall back.
async function getNwsWeather(lat: number, lon: number, userTz: string): Promise<WeatherData | null> {
  const headers = { "User-Agent": "Taki AI weather assistant (contact: support@takiai.app)", Accept: "application/geo+json" };
  const getJson = async (url: string, label: string) => {
    const r: any = await withTimeout(fetch(url, { headers }), 7000, label);
    return r.ok ? r.json() : null;
  };
  try {
    const pd = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, "NWS points");
    const hourlyUrl = pd?.properties?.forecastHourly;
    const dailyUrl = pd?.properties?.forecast;
    if (!hourlyUrl) return null;
    // Bucket "today/tomorrow" and format times in the LOCATION's timezone.
    const tz = pd?.properties?.timeZone && isValidTimeZone(pd.properties.timeZone) ? pd.properties.timeZone : userTz;

    const [hd, fd] = await Promise.all([getJson(hourlyUrl, "NWS hourly"), dailyUrl ? getJson(dailyUrl, "NWS daily") : null]);
    const hourly: any[] = hd?.properties?.periods;
    if (!Array.isArray(hourly) || !hourly.length) return null;
    const daily: any[] = fd?.properties?.periods || [];

    const dayKey = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
    const todayKey = dayKey(new Date().toISOString());
    const tomorrowKey = dayKey(new Date(Date.now() + 86_400_000).toISOString());
    const now = hourly[0];

    // High/low from the DAILY forecast (a day's high = its daytime period temp),
    // which is correct even late in the day. Fall back to hourly if a period is
    // already past.
    const dayHigh = (key: string) => daily.find((p) => p.isDaytime && dayKey(p.startTime) === key);
    const dayLow = (key: string) => daily.find((p) => !p.isDaytime && dayKey(p.startTime) === key);
    const hourlyTodayTemps = hourly.filter((x) => dayKey(x.startTime) === todayKey).map((x) => Number(x.temperature)).filter(Number.isFinite);
    const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);

    const todayHigh = num(dayHigh(todayKey)?.temperature) ?? (hourlyTodayTemps.length ? Math.max(...hourlyTodayTemps) : Math.round(Number(now.temperature)));
    const todayLow = num(dayLow(todayKey)?.temperature) ?? (hourlyTodayTemps.length ? Math.min(...hourlyTodayTemps) : Math.round(Number(now.temperature)));
    const tomDay = dayHigh(tomorrowKey);

    const precipMax = (key: string) => {
      const v = hourly.filter((x) => dayKey(x.startTime) === key).map((x) => Number(x?.probabilityOfPrecipitation?.value || 0));
      return v.length ? Math.round(Math.max(...v)) : 0;
    };

    // First upcoming hour with meaningful precip → "when will it rain".
    let rainStart: string | null = null;
    for (const x of hourly.slice(1, 48)) {
      if (Number(x?.probabilityOfPrecipitation?.value || 0) >= 40 || isRainyText(x.shortForecast)) {
        const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: "numeric" };
        if (dayKey(x.startTime) !== todayKey) opts.weekday = "short";
        rainStart = new Intl.DateTimeFormat("en-US", opts).format(new Date(x.startTime));
        break;
      }
    }

    return {
      tempNow: Math.round(Number(now.temperature)),
      feelsNow: Math.round(Number(now.temperature)),
      condNow: String(now.shortForecast || "").toLowerCase(),
      todayHigh,
      todayLow,
      todayRainChance: precipMax(todayKey),
      tomorrowHigh: num(tomDay?.temperature) ?? num(dayHigh(tomorrowKey)?.temperature),
      tomorrowLow: num(dayLow(tomorrowKey)?.temperature),
      tomorrowCond: tomDay ? String(tomDay.shortForecast || "").toLowerCase() : null,
      tomorrowRainChance: precipMax(tomorrowKey),
      rainingNow: isRainyText(now.shortForecast) || Number(now?.probabilityOfPrecipitation?.value || 0) >= 55,
      rainStart
    };
  } catch (error) {
    console.error("NWS weather error:", error);
    return null;
  }
}

// FALLBACK: Open-Meteo (global, free, no key) — used outside the US or if NWS fails.
async function getOpenMeteoWeather(lat: number, lon: number, fallbackTz: string): Promise<WeatherData | null> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,apparent_temperature,weather_code",
    hourly: "precipitation_probability,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: "fahrenheit",
    timezone: "auto" // returns the LOCATION's timezone (so today/tomorrow are local)
  });
  try {
    const r: any = await withTimeout(fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`), 8000, "Weather");
    const data = await r.json();
    const current = data.current;
    const daily = data.daily;
    if (!current || !daily) return null;
    const tz = data.timezone && isValidTimeZone(data.timezone) ? data.timezone : fallbackTz;

    // Next hour with >=40% precip chance, scanning from now. open-meteo "auto"
    // returns local times without offsets, so compare against the location-local
    // "now" string instead of an absolute timestamp.
    let rainStart: string | null = null;
    const times: string[] = data.hourly?.time || [];
    const probs: number[] = data.hourly?.precipitation_probability || [];
    const localNowStr = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .format(new Date()).replace(" ", "T");
    const todayStr = localNowStr.slice(0, 10);
    for (let i = 0; i < times.length; i++) {
      if (times[i] < localNowStr) continue;
      if (Number(probs[i] || 0) >= 40) {
        const sameDay = times[i].slice(0, 10) === todayStr;
        const dt = new Date(times[i] + ":00");
        const hour = Number(times[i].slice(11, 13));
        const label = `${((hour % 12) || 12)} ${hour < 12 ? "AM" : "PM"}`;
        const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(dt);
        rainStart = sameDay ? label : `${weekday} ${label}`;
        break;
      }
    }

    return {
      tempNow: Math.round(Number(current.temperature_2m)),
      feelsNow: Math.round(Number(current.apparent_temperature)),
      condNow: weatherCodeDescription(Number(current.weather_code)),
      todayHigh: Math.round(Number(daily.temperature_2m_max?.[0])),
      todayLow: Math.round(Number(daily.temperature_2m_min?.[0])),
      todayRainChance: Math.round(Number(daily.precipitation_probability_max?.[0] || 0)),
      tomorrowHigh: Math.round(Number(daily.temperature_2m_max?.[1])),
      tomorrowLow: Math.round(Number(daily.temperature_2m_min?.[1])),
      tomorrowCond: weatherCodeDescription(Number(daily.weather_code?.[1])),
      tomorrowRainChance: Math.round(Number(daily.precipitation_probability_max?.[1] || 0)),
      rainingNow: Number(current.weather_code) >= 51,
      rainStart
    };
  } catch (error) {
    console.error("Open-Meteo weather error:", error);
    return null;
  }
}

function formatWeather(message: string, name: string, d: WeatherData): string {
  const m = message.toLowerCase();
  const isTomorrow = /\b(tomorrow|tommorow)\b/.test(m);
  const dayLabel = isTomorrow ? "tomorrow" : "today";
  const high = isTomorrow ? d.tomorrowHigh : d.todayHigh;
  const low = isTomorrow ? d.tomorrowLow : d.todayLow;
  const cond = (isTomorrow ? d.tomorrowCond : d.condNow) || "";
  const rainChance = (isTomorrow ? d.tomorrowRainChance : d.todayRainChance) ?? 0;

  // "When will it rain?" — the headline improvement from hourly data.
  if (/\bwhen\b/.test(m) && /\b(rain|snow|precip|storm)\b/.test(m)) {
    if (!isTomorrow && d.rainingNow) return `It looks like it's already raining in ${name}.`;
    if (d.rainStart) return `In ${name}, rain looks likely starting around ${d.rainStart}.`;
    return `No rain is expected ${dayLabel} in ${name} — the chance is only about ${rainChance} percent.`;
  }

  if (/\bhigh\b/.test(m) && /\b(temp|temperature)\b/.test(m) && high != null) {
    return `The high ${dayLabel} in ${name} is around ${high} degrees.`;
  }
  if (/\blow\b/.test(m) && /\b(temp|temperature)\b/.test(m) && low != null) {
    return `The low ${dayLabel} in ${name} is around ${low} degrees.`;
  }

  if (/\b(rain|umbrella|snow)\b/.test(m)) {
    const when = d.rainStart && !isTomorrow ? ` It could start around ${d.rainStart}.` : "";
    return `For ${name}, the rain chance ${dayLabel} is about ${rainChance} percent, with ${cond}.${when}`;
  }

  if (/\b(wear|outside)\b/.test(m)) {
    const ref = isTomorrow ? (high ?? 65) : d.feelsNow;
    let advice = "light, comfortable clothes";
    if (ref < 45) advice = "a warm jacket";
    else if (ref < 60) advice = "a light jacket";
    else if (ref > 85) advice = "cool clothes";
    const lead = isTomorrow ? `tomorrow will be around ${high} degrees with ${cond}` : `it feels like ${d.feelsNow} degrees with ${cond}`;
    return `For ${name}, ${lead}. I would wear ${advice}.`;
  }

  if (isTomorrow) {
    return `For ${name} tomorrow, expect ${cond} with a high of ${high} and a low of ${low}. Rain chance is about ${rainChance} percent.`;
  }

  return `For ${name}, it is ${d.tempNow} degrees and ${cond}. It feels like ${d.feelsNow}. Today's high is ${d.todayHigh}, the low is ${d.todayLow}, and the rain chance is about ${d.todayRainChance} percent.`;
}

// Compact structured weather for the home-screen widget.
export async function getWeatherSnapshot(
  lat: number,
  lon: number,
  userTz?: string
): Promise<{ temp: number; cond: string; high: number; low: number; name: string } | null> {
  const fallbackTz = userTz && isValidTimeZone(userTz) ? userTz : "America/New_York";
  const data = (await getNwsWeather(lat, lon, fallbackTz)) || (await getOpenMeteoWeather(lat, lon, fallbackTz));
  if (!data) return null;
  const label = await reverseGeocodeDeviceLocation({ latitude: lat, longitude: lon });
  const cond = data.condNow ? data.condNow.charAt(0).toUpperCase() + data.condNow.slice(1) : "";
  return {
    temp: data.tempNow,
    cond,
    high: data.todayHigh,
    low: data.todayLow,
    name: (label || "").split(",")[0].trim()
  };
}

export async function getWeatherAnswer(message: string, deviceLocation?: DeviceLocation, userTz?: string): Promise<AssistantResponse> {
  try {
    const locationName = extractWeatherLocation(message);
    const fallbackTz = userTz && isValidTimeZone(userTz) ? userTz : "America/New_York";
    let latitude: number;
    let longitude: number;
    let name: string;

    if (locationName === "DEVICE_LOCATION") {
      if (!deviceLocation?.latitude || !deviceLocation?.longitude) {
        return {
          spokenText:
            "I couldn't get your location. Make sure location access is allowed for Taki AI, then ask again — or tell me which city.",
          action: null
        };
      }
      latitude = deviceLocation.latitude;
      longitude = deviceLocation.longitude;
      name = "your location";
    } else {
      const geocoded = await geocodeCity(locationName);
      if (!geocoded) {
        return { spokenText: `I couldn't find "${locationName}". Could you tell me the city and state or country?`, action: null };
      }
      latitude = geocoded.latitude;
      longitude = geocoded.longitude;
      name = geocoded.name;
    }

    // weather.gov first (US, with hourly "when will it rain"), Open-Meteo as the
    // global fallback. Each uses the LOCATION's own timezone.
    const data =
      (await getNwsWeather(latitude, longitude, fallbackTz)) ||
      (await getOpenMeteoWeather(latitude, longitude, fallbackTz));
    if (!data) return { spokenText: "I couldn't get the weather there right now. Try again in a moment.", action: null };

    return { spokenText: formatWeather(message, name, data), action: null };
  } catch (error) {
    console.error("Weather error:", error);
    return { spokenText: "I couldn't get the weather right now. Try again in a moment.", action: null };
  }
}

/* ---- Live stock + crypto prices (real APIs, no key) --------------------- *
 * Grounded web search returns stale/approximate prices, so quotes go through
 * real-time endpoints: Yahoo Finance for stocks, CoinGecko for crypto. Both are
 * free and need no key. On any failure we return null so the caller falls back
 * to grounded web search.
 * ------------------------------------------------------------------------- */
const PRICE_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TakiAI/1.0)" };

function money(n: number, currency = "USD") {
  const frac = Math.abs(n) < 1 ? 6 : 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: frac }).format(n);
  } catch {
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: frac })}`;
  }
}

const CRYPTO_WORD =
  /\b(bitcoin|btc|ethereum|eth|dogecoin|doge|solana|sol|cardano|ada|xrp|ripple|litecoin|ltc|bnb|polkadot|dot|shiba inu|shib|polygon|matic|avalanche|avax|chainlink|link|tron|trx|monero|xmr|stellar|xlm|usd coin|usdc|tether|usdt)\b/i;

const CRYPTO_IDS: Record<string, string> = {
  bitcoin: "bitcoin", btc: "bitcoin", ethereum: "ethereum", eth: "ethereum",
  dogecoin: "dogecoin", doge: "dogecoin", solana: "solana", sol: "solana",
  cardano: "cardano", ada: "cardano", xrp: "ripple", ripple: "ripple",
  litecoin: "litecoin", ltc: "litecoin", bnb: "binancecoin", polkadot: "polkadot",
  dot: "polkadot", "shiba inu": "shiba-inu", shib: "shiba-inu", polygon: "matic-network",
  matic: "matic-network", avalanche: "avalanche-2", avax: "avalanche-2",
  chainlink: "chainlink", link: "chainlink", tron: "tron", trx: "tron",
  monero: "monero", xmr: "monero", stellar: "stellar", xlm: "stellar",
  "usd coin": "usd-coin", usdc: "usd-coin", tether: "tether", usdt: "tether"
};

export function looksLikeCryptoQuestion(message: string) {
  const m = message.toLowerCase();
  return CRYPTO_WORD.test(m) && /\b(price|worth|cost|value|trading|how much|going for|at)\b/.test(m);
}

export async function getCryptoPrice(message: string): Promise<AssistantResponse | null> {
  const match = message.toLowerCase().match(CRYPTO_WORD);
  if (!match) return null;
  const word = match[0].toLowerCase();
  try {
    let id = CRYPTO_IDS[word];
    if (!id) {
      const s: any = await withTimeout(fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(word)}`), 6000, "Crypto search");
      const sd = await s.json();
      id = sd?.coins?.[0]?.id;
    }
    if (!id) return null;
    const r: any = await withTimeout(
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`),
      6000,
      "Crypto price"
    );
    const d = await r.json();
    const info = d?.[id];
    if (!info || typeof info.usd !== "number") return null;
    const chg = typeof info.usd_24h_change === "number" ? info.usd_24h_change : null;
    const dir = chg == null ? "" : chg >= 0 ? `, up ${chg.toFixed(2)}% today` : `, down ${Math.abs(chg).toFixed(2)}% today`;
    const name = word.charAt(0).toUpperCase() + word.slice(1);
    return { spokenText: `${name} is trading at ${money(info.usd)}${dir}.`, action: null };
  } catch (error) {
    console.error("Crypto price error:", error);
    return null;
  }
}

// Commodities / groceries / generics that look like "price of X" but are NOT a
// stock — these fall through to grounded web search instead.
const NON_STOCK_PRICE =
  /^(gold|silver|platinum|palladium|copper|oil|crude( oil)?|gas|gasoline|petrol|natural gas|wheat|corn|soybeans?|coffee|sugar|cotton|lumber|uranium|milk|eggs?|bread|rice|beef|chicken|water|food|groceries|a house|house|rent|a car|car|gold)$/i;

export function looksLikeStockQuestion(message: string) {
  const m = message.toLowerCase();
  const priceWord = /\b(price|worth|cost|trading|quote|how much|going for)\b/.test(m);
  if (/\b(stock|shares?|ticker|nasdaq|nyse|share price)\b/.test(m) && priceWord) return true;
  if (/\b(stock|share) price\b/.test(m)) return true;
  // "what's apple stock at", "how's tesla stock doing" — natural phrasings.
  if (/\b(stock|shares?)\b/.test(m) && /\b(at|doing|up|down|now)\b/.test(m) && !/\bmarket\b/.test(m)) return true;
  if (/what(?:'?s| is| are)?\s+.+\btrading at\b/.test(m)) return true;
  // Bare uppercase ticker (2-5 letters) with a price word, e.g. "AAPL price".
  if (/\b[A-Z]{2,5}\b/.test(message) && priceWord) return true;
  // "price of <company>", "how much is <company> worth" — the company is
  // validated by Yahoo search in getStockPrice (and commodities are excluded).
  if (/\bprice of\b/.test(m)) return true;
  if (/\bhow much is\b/.test(m) && /\b(worth|stock|share|trading)\b/.test(m)) return true;
  if (/what(?:'?s| is)\b.+\bworth\b/.test(m)) return true;
  return false;
}

function extractStockEntity(message: string): string {
  return message
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .replace(/\b(after ?hours?|after ?market|aftermarket|pre ?market|extended ?hours?|extended)\b/g, " ")
    .replace(
      /\b(what'?s|what is|what are|whats|how much is|how much are|tell me|give me|the|current|currently|right now|today|stock|stocks|shares?|share|price|prices|of|for|quote|trading at|trading|at|nasdaq|nyse|ticker|cost|worth|value|live|going for)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export async function getStockPrice(message: string): Promise<AssistantResponse | null> {
  const entity = extractStockEntity(message);
  // Skip commodities/groceries — those aren't stocks (let web search handle).
  if (!entity || NON_STOCK_PRICE.test(entity)) return null;
  try {
    // Always resolve through search — it maps both company names ("nvidia") AND
    // tickers ("NVDA"/"aapl") to the correct symbol. (Guessing a ticker from the
    // text is unreliable — "NVIDIA" is not a ticker.)
    const s: any = await withTimeout(
      fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(entity)}&quotesCount=3&newsCount=0`, { headers: PRICE_HEADERS }),
      6000,
      "Stock search"
    );
    const sd = await s.json();
    const q = (sd?.quotes || []).find((x: any) => x?.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF")) || (sd?.quotes || [])[0];
    if (!q?.symbol) return null;
    const symbol = q.symbol;
    const name = q.shortname || q.longname || q.symbol;
    // includePrePost gives the latest traded price INCLUDING pre/after-hours.
    const r: any = await withTimeout(
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, { headers: PRICE_HEADERS }),
      6000,
      "Stock price"
    );
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    // Latest price = last non-null 1-minute close (after-hours/pre-market aware),
    // falling back to the regular-market close.
    let price: number | null = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (Array.isArray(closes)) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === "number") { price = closes[i]; break; }
      }
    }
    if (typeof price !== "number") return null;

    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const chg = typeof prev === "number" && prev ? ((price - prev) / prev) * 100 : null;
    const dir = chg == null ? "" : chg >= 0 ? `, up ${chg.toFixed(2)}% today` : `, down ${Math.abs(chg).toFixed(2)}% today`;
    // Note extended-hours when the latest price differs from the 4 PM close.
    const isExt = typeof meta.regularMarketPrice === "number" && Math.abs(price - meta.regularMarketPrice) > 0.001;
    const askedExt = /\b(after.?hours?|after.?market|aftermarket|pre.?market|extended)\b/i.test(message);
    const extNote = isExt && askedExt ? " (extended-hours)" : "";
    return { spokenText: `${name} (${symbol}) is at ${money(price, meta.currency || "USD")}${extNote}${dir}.`, action: null };
  } catch (error) {
    console.error("Stock price error:", error);
    return null;
  }
}

/* ---- Lottery results (NY data.gov, free, no key) ------------------------ */

export function looksLikeLotteryQuestion(message: string) {
  return /\b(powerball|power ball|mega ?millions|lottery|lotto)\b/i.test(message);
}

function lotteryDrawDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

export async function getLotteryAnswer(message: string): Promise<AssistantResponse | null> {
  const m = message.toLowerCase();
  // Jackpot amounts aren't in this dataset — let web search handle those.
  if (/\b(jackpot|prize|payout|how much)\b/.test(m) && !/\b(number|result|won|drawn|winning)\b/.test(m)) return null;

  const isMega = /\bmega ?millions\b/.test(m) && !/powerball/.test(m);
  try {
    if (isMega) {
      const r: any = await withTimeout(
        fetch("https://data.ny.gov/resource/5xaw-6ayf.json?$limit=1&$order=draw_date%20DESC"),
        7000,
        "Mega Millions"
      );
      const e = (await r.json())?.[0];
      if (!e?.winning_numbers) return null;
      const nums = String(e.winning_numbers).trim().split(/\s+/).join(", ");
      const date = lotteryDrawDate(e.draw_date);
      return {
        spokenText: `The latest Mega Millions numbers${date ? ` (drawn ${date})` : ""} were ${nums}, with a Mega Ball of ${e.mega_ball}.`,
        action: null
      };
    }
    const r: any = await withTimeout(
      fetch("https://data.ny.gov/resource/d6yy-54nr.json?$limit=1&$order=draw_date%20DESC"),
      7000,
      "Powerball"
    );
    const e = (await r.json())?.[0];
    if (!e?.winning_numbers) return null;
    const parts = String(e.winning_numbers).trim().split(/\s+/);
    const white = parts.slice(0, 5).join(", ");
    const pb = parts[5];
    const date = lotteryDrawDate(e.draw_date);
    const pp = e.multiplier ? ` (Power Play ${e.multiplier}x)` : "";
    return {
      spokenText: `The latest Powerball numbers${date ? ` (drawn ${date})` : ""} were ${white}, with a Powerball of ${pb}${pp}.`,
      action: null
    };
  } catch (error) {
    console.error("Lottery error:", error);
    return null;
  }
}

/* ---- Open-app URL mapping ----------------------------------------------- */

export function appUrlForName(appName: string) {
  const normalized = appName.toLowerCase().trim();
  const apps: Record<string, { appUrl: string; fallbackUrl: string }> = {
    youtube: { appUrl: "youtube://", fallbackUrl: "https://www.youtube.com" },
    spotify: { appUrl: "spotify://", fallbackUrl: "https://open.spotify.com" },
    maps: { appUrl: "maps://", fallbackUrl: "https://maps.apple.com" },
    "apple maps": { appUrl: "maps://", fallbackUrl: "https://maps.apple.com" },
    google: { appUrl: "https://www.google.com", fallbackUrl: "https://www.google.com" },
    safari: { appUrl: "https://www.google.com", fallbackUrl: "https://www.google.com" },
    gmail: { appUrl: "googlegmail://", fallbackUrl: "https://mail.google.com" },
    mail: { appUrl: "message://", fallbackUrl: "mailto:" },
    music: { appUrl: "music://", fallbackUrl: "https://music.apple.com" },
    "apple music": { appUrl: "music://", fallbackUrl: "https://music.apple.com" },
    settings: { appUrl: "app-settings:", fallbackUrl: "app-settings:" }
  };
  return apps[normalized] || null;
}

/* ---- Grounded web answer (current facts, not calendarable events) ------- */

function getGroundingSourceCount(response: any) {
  const gm = response?.candidates?.[0]?.groundingMetadata;
  const chunks = gm?.groundingChunks || gm?.grounding_chunks || [];
  const supports = gm?.groundingSupports || gm?.grounding_supports || [];
  const webQueries = gm?.webSearchQueries || gm?.web_search_queries || [];
  return {
    chunks: Array.isArray(chunks) ? chunks.length : 0,
    supports: Array.isArray(supports) ? supports.length : 0,
    webQueries: Array.isArray(webQueries) ? webQueries.length : 0
  };
}

// Predictive / opinion questions ("who's expected to win", "who's favored",
// "what are the odds") are not hard facts — they are best answered with live
// odds, recent form, and analyst consensus, framed as a prediction. We must
// NOT refuse these the way we refuse unverifiable hard facts.
export function looksLikePredictionQuestion(message: string) {
  const m = message.toLowerCase();
  if (/\b(odds|betting|favou?rite to win|favou?red to win|prediction|predicted to win|point spread|moneyline)\b/.test(m)) {
    return true;
  }
  if (/\bexpected to win\b/.test(m)) return true;
  if (
    /\b(who|which team|which side|what team)\b/.test(m) &&
    /\b(win|winner|beat|advance|cover)\b/.test(m) &&
    /\b(will|expected|going to|gonna|likely|do you think|predict|favou?r)\b/.test(m)
  ) {
    return true;
  }
  return false;
}

// Questions about the latest / best / newest product, release, or current fact
// can't be answered from the phone or from stale model memory — they need live
// search. We detect them so they always route to grounded web search.
export function looksLikeFreshFactQuestion(message: string) {
  const m = message.toLowerCase();

  const recency = /\b(latest|newest|most recent|current(?:ly)?|right now|nowadays|these days|so far|this year|20\d\d|just (?:released|announced|came out)|recently (?:released|announced|launched))\b/.test(m);
  const release = /\b(release[sd]?|releasing|announce[sd]?|came out|come out|coming out|available now|out now|launch(?:e[sd])?)\b/.test(m);
  const product = /\b(chip|processor|silicon|cpu|gpu|graphics card|iphone|ipad|mac|macbook|imac|phone|laptop|tablet|smartwatch|watch|model|version|console|car|ev|product|device|software|os|update)\b/.test(m);
  const superlative = /\b(best|fastest|newest|latest|top|most powerful|most advanced|highest[- ]end|flagship)\b/.test(m);
  const brand = /\b(apple|google|samsung|nvidia|amd|intel|microsoft|sony|tesla|openai|anthropic|android|iphone|playstation|xbox|pixel|galaxy)\b/.test(m);

  if (superlative && (product || brand)) return true;
  if ((recency || release) && (product || brand)) return true;
  return false;
}

// Clearly LIVE / changeable questions (current scores, standings, prices,
// open-now status). These must hit grounded research on the accurate model, not
// stale model memory. Kept tight to avoid hijacking ordinary chat.
export function looksLikeLiveInfoQuestion(message: string) {
  const m = message.toLowerCase();

  // Live sports / competition state.
  if (/\bwho('?s| is| are)?\s+(winning|leading|ahead|in the lead)\b/.test(m)) return true;
  if (/\bwho won\b/.test(m)) return true;
  if (/\b(what'?s|what is)\s+the\s+(score|result)\b/.test(m) || /\b(final score|current score|score of|standings|leaderboard)\b/.test(m)) return true;

  // Live prices / markets.
  if (/\b(stock price|share price|price of|how much (?:is|does|are|do)|worth|cost|exchange rate)\b/.test(m) &&
      /\b(now|today|currently|right now|trading|cost|worth)\b/.test(m)) return true;

  // Open / closed / status right now.
  if (/\b(open|closed)\b/.test(m) && /\b(right now|now|currently|today|at the moment|still)\b/.test(m)) return true;

  return false;
}

export async function getStrictWebAnswer(
  message: string,
  opts: { allowPrediction?: boolean; persona?: UserPersona; timeZone?: string } = {}
): Promise<AssistantResponse> {
  const allowPrediction = Boolean(opts.allowPrediction);
  const persona = personaPromptBlock(opts.persona);
  const tz = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : "";
  const tzRule = tz
    ? `\n- The user is in timezone ${tz}. If your answer includes any date or clock time (e.g. a game start time), convert it to the user's LOCAL time in ${tz} and state that (you may add the timezone abbreviation).`
    : "";

  const factPrompt = `
You are Taki AI, a daily-life phone assistant. Answer like a Google AI Overview:
direct, current, and concise.

Use live Google Search results (do not rely on memory for current facts).
${persona}
Rules:${tzRule}
- Answer the EXACT question asked, and nothing more. Lead with the direct answer.
- Be concise: 1-2 sentences. Do NOT write paragraphs or list every option.
- If the question asks for the single best / latest / newest / fastest one, name that
  ONE item (you may add the single most relevant detail). Do not enumerate alternatives.
- Always prefer the MOST UP-TO-DATE result. If a newer model/version/fact exists in the
  search results, use it; never give an older one as "the latest/best."
- Do not invent or substitute a different product, matchup, price, or person.
- If search results do not clearly verify the answer, say exactly: "I can't verify that right now."
- No markdown. No JSON. No preamble like "According to...".

User question:
${message}
`;

  // Prediction mode: it is correct (and ChatGPT-like) to answer with live odds,
  // form, and expert consensus, clearly framed as a prediction.
  const predictionPrompt = `
You are Taki AI, a daily-life phone assistant with live Google Search.

The user is asking for a PREDICTION or expectation (who is favored / who will win /
odds / chances), not a settled fact.

Using current web results:
- Identify the specific upcoming game/match/event the user means.
- Report who is favored and why, using betting odds, recent form, rankings, or analyst
  consensus that you actually find.
- Frame it clearly as a prediction, not a guarantee (e.g. "X is the favorite...",
  "oddsmakers lean toward...", "it's expected to be close").
- It is fine and expected to be uncertain. Do NOT refuse just because the outcome is unknown.
- Only if you genuinely cannot find the relevant game or any odds/analysis, say:
  "I couldn't find any predictions or odds for that yet."
- Keep it short and conversational, 1-3 sentences. No markdown. No JSON.${tzRule}

User question:
${message}
`;

  try {
    const response: any = await withTimeout(
      ai.models.generateContent({
        model: RESEARCH_MODEL,
        contents: allowPrediction ? predictionPrompt : factPrompt,
        config: { tools: [{ googleSearch: {} }], ...safetyConfig(opts.persona?.teen) }
      } as any),
      RESEARCH_TIMEOUT_MS,
      "Web answer"
    );

    const answer = (response.text || "").trim();
    const grounding = getGroundingSourceCount(response);
    const grounded = grounding.chunks > 0 || grounding.supports > 0 || grounding.webQueries > 0;

    if (allowPrediction) {
      // Predictions are inherently tentative — return the grounded answer as-is.
      if (!answer) return { spokenText: "I couldn't find any predictions or odds for that yet.", action: null };
      return { spokenText: answer, action: null };
    }

    if (!answer || !grounded) return { spokenText: "I can't verify that right now.", action: null };

    if (/\bprobably|i think|i believe|would be|should be|based on previous|expected around\b/i.test(answer)) {
      if (!/\bnot confirmed|has not confirmed|tentative|rumor|reported|expected\b/i.test(answer)) {
        return { spokenText: "I can't verify that right now.", action: null };
      }
    }

    return { spokenText: answer, action: null };
  } catch (error) {
    console.error("Strict web error:", error);
    return {
      spokenText: allowPrediction
        ? "I couldn't find any predictions or odds for that right now."
        : "I can't verify that right now.",
      action: null
    };
  }
}

/* ---- In-character rephrasing of fixed/preset lines ---------------------- */

// Rewrite a deterministic confirmation/clarification (e.g. "Added Dinner with
// Mom for Friday at 7:00 PM.") so it carries the user's personality, WITHOUT
// changing any facts. Returns the original text when no character is active
// (e.g. "plain"), so plain users keep instant preset lines and pay no latency.
export async function styleInCharacter(text: string, persona?: UserPersona): Promise<string> {
  const directive = characterDirective(persona);
  const clean = String(text || "").trim();
  if (!directive || !clean) return clean;

  const prompt = `Rewrite this short assistant message so it is fully IN CHARACTER.
KEEP EVERY FACT IDENTICAL — names, dates, times, numbers, event titles, places, "I'll"/"Added"
meaning. Do not add or remove any information. Keep it roughly one line.
Output ONLY the rewritten message, nothing else.

Character: ${directive}

Message: ${clean}`;

  try {
    const r: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { temperature: 0.8, thinkingConfig: { thinkingBudget: 0 }, ...safetyConfig(persona?.teen) }
      } as any),
      6000,
      "Style confirmation"
    );
    let out = String(r?.text || "").trim();
    out = out.replace(/^["'“”]+|["'“”]+$/g, "").split(/\r?\n/)[0].trim();
    return out || clean;
  } catch {
    return clean;
  }
}

/* ---- Grounded event research -------------------------------------------- */

export type VerifiedEventResult = {
  found: boolean;
  title?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  notes?: string;
  spokenText?: string;
  reason?: string;
};

async function researchCurrentEventAnswer(eventQuery: string, userTz: string) {
  const localNow = nowInTimeZone(userTz);
  const prompt = `
You are a current-information research assistant for an iPhone personal assistant.

Question:
"${eventQuery.replace(/"/g, '\\"')}"

The user's CURRENT LOCAL time is: ${localNow}
The user's timezone is: ${userTz}

Answer the question using current information.

Rules:
- Prefer official schedules, league/team pages, venue pages, or reputable sports/news sources.
- CRITICAL: "next" means the soonest event whose START TIME is AFTER the user's current local
  time above. If several events are scheduled LATER TODAY, pick the soonest one TODAY — do
  NOT jump to tomorrow while games remain today. Only an event whose start time has already
  passed is skipped.
- Report the date and time CONVERTED TO THE USER'S LOCAL TIMEZONE (${userTz}). State it as the
  user's local time, e.g. "today at 1:00 PM your time".
- Pick ONE specific event. NEVER ask the user to choose.
- Do not mention completed/past events as the answer to "next."
- If you genuinely cannot find any matching upcoming event, say you cannot verify it.
- Keep the answer concise.
`;
  try {
    const response: any = await withTimeout(
      ai.models.generateContent({
        model: RESEARCH_MODEL,
        contents: prompt,
        config: { temperature: 0, tools: [{ googleSearch: {} }] }
      } as any),
      RESEARCH_TIMEOUT_MS,
      "Current event research"
    );
    return String(response.text || "").trim();
  } catch (error) {
    console.error("Current event research failed:", error);
    return "";
  }
}

// Like researchCurrentEventAnswer, but asks for a LIST of the next N events
// (for "add the next 3 games"). The single-event prompt above forces one event,
// so multi needs its own list-oriented research pass.
async function researchUpcomingEventsAnswer(eventQuery: string, count: number, userTz: string) {
  const localNow = nowInTimeZone(userTz);
  const prompt = `
You are a current-information research assistant for an iPhone personal assistant.

Task: list the NEXT ${count} upcoming events for this request, in chronological order.
Request: "${eventQuery.replace(/"/g, '\\"')}"

The user's CURRENT LOCAL time is: ${localNow}
The user's timezone is: ${userTz}

Rules:
- Prefer official schedules, league/team pages, venue pages, or reputable sources.
- Include only events that START AFTER the user's current local time above. If several remain
  TODAY, include those (soonest first) before moving to tomorrow.
- For EACH event give: a short title (e.g. "Braves vs. Mets"), the date, the start time, and the
  venue/city — with the date and time CONVERTED TO THE USER'S LOCAL TIMEZONE (${userTz}).
- Number them 1., 2., 3., … up to ${count}. If you can verify fewer, list as many as you can.
- Do not include past/completed events. Keep each line concise.
`;
  try {
    const response: any = await withTimeout(
      ai.models.generateContent({
        // A schedule LIST is grounded data — the faster model returns it just as
        // well as the accurate one, and pro was too slow for N games (timed out).
        model: MAIN_MODEL,
        contents: prompt,
        config: { temperature: 0, tools: [{ googleSearch: {} }] }
      } as any),
      LIST_RESEARCH_TIMEOUT_MS,
      "Upcoming events research"
    );
    return String(response.text || "").trim();
  } catch (error) {
    console.error("Upcoming events research failed:", error);
    return "";
  }
}

// Ask the model for the WALL-CLOCK local time + the venue's IANA timezone name,
// then compute the absolute time in code (correct offset/DST). Prevents the
// model's own offset math from being an hour off.
const EVENT_TIME_SCHEMA = `
  "localDate": "YYYY-MM-DD (in the user's local timezone)",
  "localTime": "HH:MM in 24-hour clock (the start time in the USER'S local timezone)",`;
const EVENT_TIME_RULES = `
- localDate and localTime must be in the USER'S LOCAL TIMEZONE (the research above already
  converted times to it). Read the time exactly as stated in the research — do not shift it.`;

async function extractFutureEventFromResearch(
  eventQuery: string,
  researchText: string,
  fallbackTz: string
): Promise<VerifiedEventResult> {
  const localNow = nowInTimeZone(fallbackTz);
  const todayLocal = ymdInTimeZone(new Date(), fallbackTz);
  if (!researchText || /cannot verify|can't verify|could not verify/i.test(researchText)) {
    return { found: false, spokenText: researchText || "", reason: "The event could not be verified from current information." };
  }

  const prompt = `
Extract a calendar-ready future event from this research answer.

Original user query:
"${eventQuery.replace(/"/g, '\\"')}"

Current local date & time: ${localNow}
Today's LOCAL date is ${todayLocal}. Resolve "today"/"tonight"/"tomorrow" in the research against THIS local date — never against UTC.

Research answer:
"""
${researchText.replace(/```/g, "")}
"""

Return ONLY valid JSON:
{
  "found": true or false,
  "title": "short event title",${EVENT_TIME_SCHEMA}
  "location": "venue/city if known, otherwise empty string",
  "notes": "short context/source note",
  "reason": "why found=false"
}

Rules:
- found MUST be true whenever the research answer names an event AND gives a specific date with a clock/start time.
${EVENT_TIME_RULES}
- found = false ONLY if there is genuinely no date, no start time, or the event already finished.
- Do not invent a time the research answer does not provide.
`;

  try {
    const response: any = await withTimeout(
      ai.models.generateContent({ model: MAIN_MODEL, contents: prompt, config: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } } }),
      9000,
      "Extract future event"
    );
    const parsed = safeParseJsonObject(String(response.text || ""));
    if (!parsed || parsed.found !== true) {
      return { found: false, spokenText: researchText, reason: parsed?.reason || "Could not extract an exact future date and time." };
    }

    const times = isoFromLocalParts(parsed.localDate, parsed.localTime, fallbackTz, fallbackTz);
    if (!times) {
      return { found: false, spokenText: researchText, reason: "The extracted event had no valid start time." };
    }
    const startMs = Date.parse(times.startDate);

    // Reject an event that has already finished (grace window keeps a live one).
    const FINISHED_GRACE_MS = 3.5 * 60 * 60 * 1000;
    if (startMs < Date.now() - FINISHED_GRACE_MS) {
      return { found: false, spokenText: researchText, reason: "The soonest event found has already passed; could not confirm the next upcoming one." };
    }

    return {
      found: true,
      title: String(parsed.title || "Event"),
      startDate: times.startDate,
      endDate: times.endDate,
      location: String(parsed.location || ""),
      notes: String(parsed.notes || ""),
      spokenText: String(researchText),
      reason: ""
    };
  } catch (error) {
    console.error("Future event extraction failed:", error);
    return { found: false, spokenText: researchText, reason: "Could not extract a calendar-ready event." };
  }
}

export async function findVerifiedFutureEvent(eventQuery: string, fallbackTz: string = TIME_ZONE): Promise<VerifiedEventResult> {
  // One (slow, accurate) grounded research pass, then up to two cheap extraction
  // passes over that same text. Re-researching with the accurate model would
  // risk the overall request budget, and a single grounded pass is reliable.
  const researchText = await researchCurrentEventAnswer(eventQuery, fallbackTz);
  if (!researchText) return { found: false, reason: "No current information found." };
  let last: VerifiedEventResult = { found: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await extractFutureEventFromResearch(eventQuery, researchText, fallbackTz);
    if (result.found) return result;
    last = result;
  }
  return last;
}

// Extract up to `count` future events from one research answer (for "add the
// next N games" style requests).
async function extractFutureEventsFromResearch(
  eventQuery: string,
  researchText: string,
  count: number,
  fallbackTz: string
): Promise<VerifiedEventResult[]> {
  const localNow = nowInTimeZone(fallbackTz);
  const todayLocal = ymdInTimeZone(new Date(), fallbackTz);
  if (!researchText || /cannot verify|can't verify|could not verify/i.test(researchText)) return [];

  const prompt = `
Extract up to ${count} calendar-ready FUTURE events from this research answer, in chronological order (soonest first).

Original user query: "${eventQuery.replace(/"/g, '\\"')}"
Current local date & time: ${localNow}
Today's LOCAL date is ${todayLocal}. Resolve "today"/"tonight"/"tomorrow" against THIS local date — never against UTC.

Research answer:
"""
${researchText.replace(/```/g, "")}
"""

Return ONLY valid JSON:
{ "events": [ { "title": "short title",${EVENT_TIME_SCHEMA} "location": "venue/city or ''", "notes": "short" } ] }

Rules:
- Only events that have a specific date AND start time and are still upcoming.
${EVENT_TIME_RULES}
- Up to ${count} events; fewer is fine. Never invent dates/times.
`;

  try {
    const response: any = await withTimeout(
      ai.models.generateContent({ model: MAIN_MODEL, contents: prompt, config: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } } }),
      12000,
      "Extract future events"
    );
    const parsed = safeParseJsonObject(String(response.text || ""));
    const arr = Array.isArray(parsed?.events) ? parsed.events : [];
    const out: VerifiedEventResult[] = [];
    for (const ev of arr) {
      const times = isoFromLocalParts(ev?.localDate, ev?.localTime, fallbackTz, fallbackTz);
      if (!times) continue;
      const startMs = Date.parse(times.startDate);
      if (startMs < Date.now() - 3600_000) continue; // skip past
      out.push({
        found: true,
        title: String(ev?.title || "Event"),
        startDate: times.startDate,
        endDate: times.endDate,
        location: String(ev?.location || ""),
        notes: String(ev?.notes || "")
      });
      if (out.length >= count) break;
    }
    return out;
  } catch (error) {
    console.error("Multi event extraction failed:", error);
    return [];
  }
}

// Look up the next `count` upcoming events for a query (e.g. "Atlanta Braves
// games"). Returns [] if nothing verifiable.
export async function findVerifiedFutureEvents(eventQuery: string, count: number, fallbackTz: string = TIME_ZONE): Promise<VerifiedEventResult[]> {
  const n = Math.max(1, Math.min(count, 6));
  // One (slow) grounded research pass, then up to two cheap extraction passes
  // that REUSE that text — so a single extraction hiccup doesn't cost another
  // 14s of web research and blow the request budget.
  const researchText = await researchUpcomingEventsAnswer(eventQuery, n, fallbackTz);
  if (!researchText) return [];
  // Single extraction pass — the list research already used most of the budget.
  return extractFutureEventsFromResearch(eventQuery, researchText, n, fallbackTz);
}

// "Add the next World Cup game / next Braves game / next SpaceX launch to my
// calendar" — the event isn't on the phone and has no date in the message, so
// the date/time must be looked up on the web first. Detect it deterministically
// so it never gets stuck asking for a date.
export function looksLikeAddLookupEventToCalendar(message: string) {
  const m = message.toLowerCase();
  const wantsCalendar = /\b(add|put|schedule|save|create)\b/.test(m) && /\b(calendar|cal)\b/.test(m);
  const lookupEvent =
    /\b(next|upcoming|this (?:weekend|week)|tonight'?s|tomorrow'?s)\b/.test(m) &&
    /\b(game|match|fixture|launch|race|fight|bout|concert|show|tournament|final|grand prix|gp|kickoff|premiere|debate|event)s?\b/.test(m);
  return wantsCalendar && lookupEvent;
}

// Strip calendar scaffolding to get a clean web query for the event.
export function eventQueryFromCalendarMessage(message: string) {
  const q = message
    .replace(/\b(add|put|schedule|save|create)\b/gi, " ")
    .replace(/\b(to|on|in|onto)\s+(my\s+|the\s+)?(calendar|cal)\b/gi, " ")
    .replace(/\bmy\s+(calendar|cal)\b/gi, " ")
    .replace(/\bplease\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q || message;
}

/* ---- General conversational answer -------------------------------------- */

export async function getGeneralAnswer(state: ConversationState): Promise<string> {
  const memoryText = state.fullTranscriptText
    ? `

Conversation history for this chat:
${state.fullTranscriptText}

Rules for conversation history:
- Treat facts the user stated earlier in this same chat as available memory.
- If the user asks "what did I say/tell you" or about a fact they gave earlier, answer from the history.
- Do not claim you lack access to personal history when the answer is in this chat.
- If the user corrected you earlier, respect the correction.`
    : "";

  const prompt = `
You are Taki AI, a sharp, genuinely helpful daily-life iPhone assistant talking to one person.
${personaPromptBlock(state.userProfile)}
Current date & time (the user's LOCAL time — use THIS for "today"/"tomorrow"/day-of-week): ${nowInTimeZone(state.timeZone)}.
Any date/time you mention must be in the user's LOCAL time (${state.timeZone}) — never another timezone.

How to answer:
- BE CONCISE. Answer the exact question and nothing more. Follow the LENGTH rule in the personality above (balanced ≈ 1-3 sentences). Lead with the answer; no preamble ("Great question", "Of course", "Sure!"), no restating the question, no wrap-up summary.
- Do NOT volunteer extra background, history, caveats, alternatives, or lists unless the user explicitly asked for them. If they ask "what" give the fact; only explain "why/how" when asked.
- Still be accurate and complete enough to fully satisfy the question — concise, not vague or partial.
- For anything recent, time-sensitive, or that you're unsure of, USE Google Search and rely on the results — never guess at current facts or make things up. If you can't find it, say so plainly.
- Plain text only — NO markdown: no **bold**/*asterisks*, no #headers, no JSON. Plain numbered steps ("1. ...") are fine only if a list was requested. Never say "as an AI".
- Match the personality AND its INTENSITY above — at low intensity stay plain/neutral; at high intensity make the character loud and obvious.

Current user message:
${state.message}
${memoryText}
`;

  try {
    const response: any = await withTimeout(
      ai.models.generateContent({
        model: RESEARCH_MODEL,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }], ...safetyConfig(state.userProfile?.teen) }
      } as any),
      RESEARCH_TIMEOUT_MS,
      "General answer"
    );
    const text = stripMarkdown(String(response.text || "").trim());
    if (text) return text;
    throw new Error("empty");
  } catch (error) {
    console.error("General answer (pro) failed, falling back to flash:", error);
    // Graceful degrade so we always reply, even if the strong model times out.
    try {
      const r2: any = await withTimeout(
        ai.models.generateContent({ model: MAIN_MODEL, contents: prompt, config: { thinkingConfig: { thinkingBudget: 0 }, ...safetyConfig(state.userProfile?.teen) } } as any),
        8000,
        "General answer fast"
      );
      return stripMarkdown(String(r2.text || "").trim()) || "I'm not sure how to answer that — can you say a bit more?";
    } catch {
      return "I had trouble answering that — try me again?";
    }
  }
}

// Vision: answer a question about a photo (base64 JPEG/PNG) the user took.
// Gemini is multimodal, so we pass the image + the question as parts.
export async function answerAboutImage(
  base64: string,
  mimeType: string,
  question: string,
  persona?: UserPersona,
  timeZone?: string
): Promise<string> {
  const q = (question || "").trim() || "What is in this image?";
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : "";
  const prompt = `${personaPromptBlock(persona)}
You are Taki AI looking at a photo the user just took or picked. Answer their question about it.
${tz ? `The user's local time is ${nowInTimeZone(tz)}.\n` : ""}Question: "${q}"

- Answer accurately and concisely (a sentence or two unless more is clearly needed). Lead with the answer.
- If you genuinely can't tell what something is, say so honestly rather than guessing.
- Plain text only — no markdown. Match the personality AND its intensity above (plain at low intensity, loud at high).`;

  try {
    const response: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: [{ inlineData: { mimeType: mimeType || "image/jpeg", data: base64 } }, { text: prompt }],
        config: { ...safetyConfig(persona?.teen) }
      } as any),
      25000,
      "Vision"
    );
    return stripMarkdown(String(response.text || "").trim()) || "I couldn't make out what's in that photo.";
  } catch (error) {
    console.error("Vision answer failed:", error);
    return "I had trouble looking at that image — try again?";
  }
}
