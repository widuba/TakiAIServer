import { ai, MAIN_MODEL } from "./ai.js";
import { withTimeout } from "./util.js";

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

// Ask the model for a realistic plan as JSON. Returns null on any failure so the
// caller can fall back to a normal answer.
export async function generateDayPlan(
  message: string,
  nowLocal: string,
  timeZone: string
): Promise<{ summary: string; items: PlanItem[] } | null> {
  const prompt = `The user said: "${message}"
Right now it is ${nowLocal} (${timeZone}). Build a realistic, genuinely helpful plan for the window they asked about (default: the rest of today).
Return ONLY compact JSON, no markdown, no commentary:
{"summary":"<one short friendly sentence>","items":[{"type":"alarm"|"event","title":"<short>","startDate":"YYYY-MM-DDTHH:MM:SS","durationMin":<int for events>}]}
Rules:
- "alarm" = a wake-up or a nudge to START something; "event" = a block of time on the calendar.
- 4 to 8 items, in chronological order, all in the FUTURE relative to now, today's date unless they clearly meant another day.
- startDate is LOCAL time (no timezone suffix). Keep titles short (≤ 5 words).
- Make it sensible and balanced (include breaks/meals where natural).`;
  try {
    const res: any = await withTimeout(
      ai.models.generateContent({
        model: MAIN_MODEL,
        contents: prompt,
        config: { temperature: 0.4, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } }
      } as any),
      20000,
      "Day plan"
    );
    const obj = JSON.parse((res.text || "{}").trim());
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
