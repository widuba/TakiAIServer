import { brainV3AuxEnabled, generateContent, MAIN_MODEL } from "./ai.js";
import { runBrainV3Structured } from "./brainV3Specialists.js";
import { isoFromYmdTime, withTimeout } from "./util.js";

/* ============================================================================
 * Day planner. "Plan my day" → a structured set of alarms + calendar blocks the
 * device proposes, and only creates after the user confirms (propose-then-confirm).
 * ==========================================================================*/

export function looksLikePlanDay(message: string): boolean {
  return /\b(plan (out )?my (day|morning|afternoon|evening)|help me plan( my| out)?( day)?|make (me )?a (schedule|plan|routine|day plan)|organi[sz]e my day|set up my day|plan my schedule|build (me )?a schedule)\b/i.test(message);
}

export interface PlanItem {
  type: "alarm" | "event";
  title: string;
  startDate: string;     // local ISO "YYYY-MM-DDTHH:MM:SS"
  durationMin?: number;  // events only
}

export const DAY_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["alarm", "event"] },
          title: { type: "string" },
          startDate: { type: "string" },
          durationMin: { type: ["integer", "null"] }
        },
        required: ["type", "title", "startDate", "durationMin"]
      }
    }
  },
  required: ["summary", "items"]
} as const;

function localDateParts(value: unknown): { ymd: string; hour: number; minute: number; second: number } | null {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || "0");
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null;
  return { ymd: `${match[1]}-${match[2]}-${match[3]}`, hour, minute, second };
}

/** Strict v3 boundary for generated schedules; legacy callers keep their old parser. */
export function normalizeDayPlanObject(
  value: unknown,
  nowIso: string,
  timeZone: string
): { summary: string; items: PlanItem[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as any;
  if (!Array.isArray(raw.items) || raw.items.length < 4 || raw.items.length > 8) return null;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return null;
  let previousMs = -Infinity;
  const items: PlanItem[] = [];
  for (const item of raw.items) {
    if (!item || typeof item !== "object" || (item.type !== "alarm" && item.type !== "event")) return null;
    const title = String(item.title || "").trim().slice(0, 60);
    const parts = localDateParts(item.startDate);
    if (!title || !parts) return null;
    const instant = isoFromYmdTime(parts.ymd, parts.hour, parts.minute, timeZone);
    const instantMs = Date.parse(instant);
    if (!Number.isFinite(instantMs) || instantMs <= nowMs || instantMs <= previousMs) return null;
    const durationRaw = item.durationMin;
    const duration = item.type === "event" ? Number(durationRaw) : null;
    if (item.type === "event" && (!Number.isInteger(duration) || duration < 1 || duration > 1_440)) return null;
    if (item.type === "alarm" && durationRaw !== null && durationRaw !== undefined) return null;
    items.push({
      type: item.type,
      title,
      startDate: `${parts.ymd}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`,
      ...(item.type === "event" ? { durationMin: duration } : {})
    });
    previousMs = instantMs;
  }
  const summary = String(raw.summary || "Here's a plan for your day:").trim().slice(0, 240);
  return summary ? { summary, items } : null;
}

// Ask the model for a realistic plan as JSON. Returns null on any failure so the
// caller can fall back to a normal answer.
export async function generateDayPlan(
  message: string,
  nowLocal: string,
  timeZone: string,
  nowIso = new Date().toISOString()
): Promise<{ summary: string; items: PlanItem[] } | null> {
  const prompt = `The user said: "${message}"
Right now it is ${nowLocal} (${timeZone}). Build a realistic, genuinely helpful plan for the window they asked about (default: the rest of today).
Return ONLY compact JSON, no markdown, no commentary:
{"summary":"<one short friendly sentence>","items":[{"type":"alarm"|"event","title":"<short>","startDate":"YYYY-MM-DDTHH:MM:SS","durationMin":<int for events, null for alarms>}]}
Rules:
- "alarm" = a wake-up or a nudge to START something; "event" = a block of time on the calendar.
- 4 to 8 items, in chronological order, all in the FUTURE relative to now, today's date unless they clearly meant another day.
- startDate is LOCAL time (no timezone suffix). Keep titles short (≤ 5 words). Always include durationMin: an integer for events and null for alarms.
  - Make it sensible and balanced (include breaks/meals where natural).`;
  try {
    const v3 = brainV3AuxEnabled();
    let obj: any;
    if (v3) {
      obj = (await runBrainV3Structured<any>("day_plan", prompt, DAY_PLAN_SCHEMA, {
        timeoutMs: 20_000,
        maxOutputTokens: 1_800,
        reasoning: "low",
        temperature: 0.4,
        thinkingConfig: { thinkingBudget: 0 }
      })).value;
    } else {
      const res: any = await withTimeout(generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { temperature: 0.4, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } }
      } as any), 20_000, "Day plan");
      obj = JSON.parse((res.text || "{}").trim());
    }
    if (v3) return normalizeDayPlanObject(obj, nowIso, timeZone);
    if (!obj || !Array.isArray(obj.items)) return null;
    const items: PlanItem[] = obj.items
      .filter((it: any) => it && it.title && it.startDate && (it.type === "alarm" || it.type === "event"))
      .map((it: any) => ({
        type: it.type === "alarm" ? "alarm" : "event",
        title: String(it.title).slice(0, 60),
        startDate: String(it.startDate),
        durationMin: typeof it.durationMin === "number" ? it.durationMin : undefined
      }))
      .slice(0, 10);
    if (items.length === 0) return null;
    return { summary: String(obj.summary || "Here's a plan for your day:"), items };
  } catch (error) {
    console.error("Day plan error:", error);
    return null;
  }
}
