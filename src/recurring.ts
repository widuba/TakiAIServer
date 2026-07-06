/* ============================================================================
 * Recurring reminders / proactivity. "remind me to stretch every 2 hours",
 * "every weekday at 7am brief me", "every Monday at 9 remind me to…".
 * Parsed into a schedule the device turns into a REPEATING local notification
 * (reliable, offline, exact timing — no server push loop needed).
 * ==========================================================================*/

export interface Recurring {
  title: string;
  kind: "daily" | "weekly" | "interval";
  hour?: number;
  minute?: number;
  weekdays?: number[];      // iOS weekday: 1=Sun … 7=Sat
  intervalMinutes?: number;
  isBriefing?: boolean;
  descr: string;            // human-readable, for the confirmation line
}

const WD: Record<string, number> = { sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7 };

function parseTimeOfDay(m: string): { hour: number; minute: number } | null {
  // "at 7am", "at 7:30 pm", "at 19:00", "at 7"
  const re = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
  const x = m.match(re);
  if (!x) return null;
  let h = parseInt(x[1], 10);
  const min = x[2] ? parseInt(x[2], 10) : 0;
  const ap = (x[3] || "").replace(/\./g, "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  else if (ap === "am" && h === 12) h = 0;
  else if (!ap && /\b(night|evening|tonight)\b/.test(m) && h >= 1 && h <= 11) h += 12; // "10 at night" = 10pm
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

function parseWeekdays(m: string): number[] | null {
  if (/\bweekday(s)?\b/.test(m) || /\bevery weekday\b/.test(m)) return [2, 3, 4, 5, 6];
  if (/\bweekend(s)?\b/.test(m)) return [1, 7];
  const found: number[] = [];
  for (const [name, n] of Object.entries(WD)) if (new RegExp(`\\b${name}s?\\b`).test(m)) found.push(n);
  return found.length ? Array.from(new Set(found)).sort() : null;
}

function fmtTime(h: number, min: number): string {
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(min).padStart(2, "0")} ${ap}`;
}
const DAY_NAMES = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function extractTitle(message: string): string {
  return message
    .replace(/^\s*(please\s+|can you\s+|could you\s+)?/i, "")
    .replace(/\b(remind me to|remind me|reminder to|tell me to|nudge me to|ping me to|get me to|prompt me to|make me)\b/gi, "")
    .replace(/\bevery\s+\d+\s*(hours?|hrs?|minutes?|mins?)\b/gi, "")
    .replace(/\bevery\s+(other\s+)?(hour|half\s*hour|day|morning|afternoon|night|evening|weekday|weekend|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\beach\s+(day|morning|afternoon|night|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\bat\s+\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/gi, "")
    .replace(/\b(daily|on weekdays|on weekends|repeatedly)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .replace(/^to\s+/i, "")
    .trim();
}

export function looksLikeRecurring(message: string): boolean {
  const m = message.toLowerCase();
  if (!/\b(every|each|daily)\b/.test(m)) return false;
  // Must be a reminder/briefing intent, not "every time I…" chatter.
  const intent = /\b(remind|reminder|nudge|ping|prompt me|tell me to|brief|briefing|check in|take my|drink|stretch|stand up|water|meds|medicine|pills)\b/.test(m);
  const timing = /\bevery\s+(\d+\s*(hours?|hrs?|minutes?|mins?)|hour|half\s*hour|other\s+\w+|day|morning|afternoon|night|evening|weekday|weekend|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(m)
    || /\b(daily|each (day|morning|night))\b/.test(m);
  return intent && timing;
}

export function parseRecurring(message: string): Recurring | null {
  if (!looksLikeRecurring(message)) return null;
  const m = message.toLowerCase();
  let title = extractTitle(message);
  // A bare "brief me" / "briefing" is the daily briefing, not a text reminder.
  const isBriefing = /^(brief( me)?|briefing|my briefing|the (rundown|briefing)|my day|rundown)$/i.test(title) || (!title && /\b(brief|briefing|rundown|my day|schedule and weather)\b/.test(m));
  if (isBriefing) title = "";
  const finalTitle = title || (isBriefing ? "Morning briefing" : "Reminder");

  // Interval: "every N hours/minutes", "every hour", "every half hour".
  let intervalMinutes = 0;
  const im = m.match(/\bevery\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)\b/);
  if (im) intervalMinutes = /min/.test(im[2]) ? parseInt(im[1], 10) : parseInt(im[1], 10) * 60;
  else if (/\bevery\s+hour\b/.test(m)) intervalMinutes = 60;
  else if (/\bevery\s+half\s*hour\b/.test(m)) intervalMinutes = 30;
  if (intervalMinutes >= 1) {
    intervalMinutes = Math.max(1, intervalMinutes);
    const descr = intervalMinutes % 60 === 0 ? `every ${intervalMinutes / 60} hour${intervalMinutes === 60 ? "" : "s"}` : `every ${intervalMinutes} minutes`;
    return { title: finalTitle, kind: "interval", intervalMinutes, isBriefing, descr };
  }

  const tod = parseTimeOfDay(m);
  const hour = tod?.hour ?? (/\b(night|evening)\b/.test(m) ? 21 : /\bmorning\b/.test(m) ? 8 : /\bafternoon\b/.test(m) ? 14 : 9);
  const minute = tod?.minute ?? 0;
  const weekdays = parseWeekdays(m);

  if (weekdays && weekdays.length) {
    const label = weekdays.length === 5 && weekdays.join() === "2,3,4,5,6" ? "every weekday"
      : weekdays.length === 2 && weekdays.join() === "1,7" ? "every weekend"
      : "every " + weekdays.map((w) => DAY_NAMES[w]).join(", ");
    return { title: finalTitle, kind: "weekly", weekdays, hour, minute, isBriefing, descr: `${label} at ${fmtTime(hour, minute)}` };
  }
  if (tod || /\b(every day|each day|daily|every morning|every night|every evening|every afternoon)\b/.test(m)) {
    return { title: finalTitle, kind: "daily", hour, minute, isBriefing, descr: `every day at ${fmtTime(hour, minute)}` };
  }
  return null;
}
