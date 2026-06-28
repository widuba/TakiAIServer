import { TIME_ZONE } from "./ai.js";

/* ============================================================================
 * Pure, domain-free helpers: timeouts, JSON parsing, date/time, text cleanup.
 * No Gemini, no network, no memory concepts here.
 * ==========================================================================*/

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function cleanJson(value: string) {
  return value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function extractJsonObject(value: string): any {
  const cleaned = cleanJson(value);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("No JSON object found.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function safeParseJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/* ---- Date / time -------------------------------------------------------- */

export function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function getDatePartsInTimeZone(date: Date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long"
  }).formatToParts(date);

  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }

  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: out.weekday
  };
}

export function ymdInTimeZone(date: Date, timeZone = TIME_ZONE) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

// Add N calendar days to a YYYY-MM-DD string using a UTC-noon anchor. This is
// timezone- and DST-safe (no local-clock dependency, never crosses a day
// boundary by accident).
export function addDaysToYmd(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

// UTC-offset (in minutes) of an IANA timezone at a given instant. Handles DST
// automatically, so we never hardcode -04:00 / -05:00.
export function tzOffsetMinutes(timeZone: string, atInstant: Date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(atInstant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUTC - atInstant.getTime()) / 60000);
}

function offsetString(minutes: number) {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// Resolve a relative date phrase to a YYYY-MM-DD in the user's OWN timezone, so
// "Thursday" means Thursday on the user's calendar (not the server's).
export function resolveRelativeYmd(message: string, timeZone = TIME_ZONE) {
  const now = new Date();
  const lower = message.toLowerCase();
  const todayYmd = ymdInTimeZone(now, timeZone);

  if (/\btoday\b/.test(lower)) return todayYmd;
  if (/\btonight\b/.test(lower)) return todayYmd;
  if (/\b(tomorrow|tommorow)\b/.test(lower)) return addDaysToYmd(todayYmd, 1);

  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const mentionedIndex = weekdays.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(message));

  if (mentionedIndex >= 0) {
    const todayWeekday = getDatePartsInTimeZone(now, timeZone).weekday.toLowerCase();
    const todayIndex = weekdays.indexOf(todayWeekday);
    let daysUntil = mentionedIndex - todayIndex;
    if (daysUntil <= 0) daysUntil += 7;
    return addDaysToYmd(todayYmd, daysUntil);
  }

  const isoMatch = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) return isoMatch[1];

  const slashMatch = message.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    let year = slashMatch[3] ? Number(slashMatch[3]) : Number(todayYmd.split("-")[0]);
    if (year < 100) year += 2000;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  return null;
}

export function resolveTimeFromMessage(message: string) {
  const lower = message.toLowerCase();

  if (/\bnoon\b/.test(lower)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lower)) return { hour: 0, minute: 0 };

  const ampmMatch = lower.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]);
    const minute = Number(ampmMatch[2] || "0");
    const ampm = ampmMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }

  const plainHourMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (plainHourMatch) {
    let hour = Number(plainHourMatch[1]);
    const minute = Number(plainHourMatch[2] || "0");
    // Daily-life default: "at 4" usually means 4 PM.
    if (hour >= 1 && hour <= 8) hour += 12;
    return { hour, minute };
  }

  return null;
}

// Build an ISO timestamp for a wall-clock time in the user's timezone, with the
// correct UTC offset for that date (DST-aware). The resulting instant therefore
// renders as the intended day/time on the user's device.
export function isoFromYmdTime(ymd: string, hour: number, minute: number, timeZone = TIME_ZONE) {
  const [y, m, d] = ymd.split("-").map(Number);
  const approx = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const off = tzOffsetMinutes(timeZone, approx);
  return `${ymd}T${pad2(hour)}:${pad2(minute)}:00${offsetString(off)}`;
}

// Human-readable "Thursday, June 18 at 4:00 PM" in the user's timezone.
export function formatEventDateTime(iso: string, timeZone = TIME_ZONE) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
  return `${datePart} at ${timePart}`;
}

export function addMinutesToIsoLocal(iso: string, minutesToAdd: number) {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00([+-]\d{2}:\d{2})$/);
  if (!match) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms + minutesToAdd * 60 * 1000).toISOString();
    return iso;
  }

  const [_, y, mo, d, h, mi, offset] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  date.setUTCMinutes(date.getUTCMinutes() + minutesToAdd);

  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:00${offset}`;
}

export function messageHasExplicitDateOrTime(message: string) {
  return (
    /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(message) ||
    /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(message) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(message) ||
    /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(message) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(message) ||
    /\b(noon|midnight)\b/i.test(message)
  );
}

/* ---- Text -------------------------------------------------------------- */

export function titleCaseTask(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;

  // Sentence case: capitalize only the first character and leave the rest as
  // written. "take out the trash" -> "Take out the trash", while proper nouns
  // ("call John") and acronyms ("renew DMV tags") keep their casing. (Title
  // Case made every word uppercase: "Take Out The Trash".)
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Rewrite a spoken instruction into the actual message body a person would
// send. "Tell Chris I love him" -> "I love you." This is a deterministic
// safety net; the planner also rewrites bodies semantically.
export function normalizeMessageBodyForRecipient(body: string) {
  let text = String(body || "").replace(/\s+/g, " ").trim();

  text = text.replace(/^(that|to say that|and say that|saying that|saying|to say|and tell (him|her|them)|tell (him|her|them) that|tell (him|her|them))\s+/i, "");
  text = text.replace(/^(if|whether)\s+(he|she|they)\s+(is|are|was|were)\s+/i, "Are you ");

  text = text.replace(/\bIm\b/g, "I'm");
  text = text.replace(/\bi'm\b/g, "I'm");

  text = text.replace(/\bwhat he['’]?s done\b/gi, "what you've done");
  text = text.replace(/\bwhat she['’]?s done\b/gi, "what you've done");
  text = text.replace(/\bwhat they['’]?ve done\b/gi, "what you've done");

  text = text.replace(/\bhe['’]?s done\b/gi, "you've done");
  text = text.replace(/\bshe['’]?s done\b/gi, "you've done");
  text = text.replace(/\bthey['’]?ve done\b/gi, "you've done");

  text = text.replace(/\bhe['’]?s\b/gi, "you're");
  text = text.replace(/\bshe['’]?s\b/gi, "you're");

  text = text.replace(/\bhis\b/gi, "your");
  text = text.replace(/\btheir\b/gi, "your");
  text = text.replace(/\bher\b/gi, "your");

  text = text.replace(/\bhim\b/gi, "you");
  text = text.replace(/\bthem\b/gi, "you");
  text = text.replace(/\bhe\b/gi, "you");
  text = text.replace(/\bshe\b/gi, "you");
  text = text.replace(/\bthey\b/gi, "you");

  text = text.replace(/\bI love him\b/i, "I love you");
  text = text.replace(/\bI love her\b/i, "I love you");
  text = text.replace(/\bI love them\b/i, "I love you");

  text = text.replace(/\s+([,.!?])/g, "$1").trim();

  if (text) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
    // Add a closing period only when it doesn't already end in terminal
    // punctuation OR an emoji (a trailing "😊." reads wrong, especially for the
    // casual, low-polish styles the learner can produce).
    const endsWithEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]$/u.test(text);
    if (!/[.!?]$/.test(text) && !endsWithEmoji) text += ".";
  }

  return text;
}

/* ---- Deterministic calendar/reminder title extraction ------------------- */

export function extractCalendarLocation(message: string) {
  const atMatch = message.match(/\bat\s+(.+?)(?:\s+(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\s+at\s+\d|\.\s*put|\s+put that|$)/i);
  if (!atMatch?.[1]) return null;
  const location = atMatch[1].replace(/^the\s+/i, "").replace(/\s+/g, " ").trim();
  return location || null;
}

export function extractCalendarTitle(message: string) {
  if (/\bdinner reservation\b/i.test(message)) return "Dinner reservation";
  if (/\blunch reservation\b/i.test(message)) return "Lunch reservation";
  if (/\breservation\b/i.test(message)) return "Reservation";

  let title = message
    .replace(/^(add|put|create|schedule)\s+/i, "")
    .replace(/\b(a|an|the)?\s*(event|appointment)?\s*(to|in|on)\s+(my\s+)?calendar\b/gi, "")
    .replace(/^that\s+/i, "")
    .replace(/^i\s+(need|have|want|got)\s+to\s+/i, "")
    .replace(/^i\s+have\s+/i, "")
    .replace(/\bput that.*$/i, "")
    .replace(/\balong with.*$/i, "")
    .replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "")
    .replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const location = extractCalendarLocation(message);
  if (location) {
    title = title.replace(new RegExp(`\\bat\\s+${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").trim();
  }

  if (!title) title = "Calendar event";
  return titleCaseTask(title);
}

export function extractReminderTitle(message: string) {
  let title = message
    .replace(/^(remind me to|remind me|add a reminder to|add reminder to|create a reminder to|add)\s+/i, "")
    .replace(/\b(to|in|on)\s+(my\s+)?reminders\b/gi, "")
    .replace(/^that\s+/i, "")
    .replace(/^i\s+(need|have|want|got)\s+to\s+/i, "")
    .replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "")
    .replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) title = "Reminder";
  return titleCaseTask(title);
}
