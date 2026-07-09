/* ============================================================================
 * Lightweight personal trackers: expenses + habits/medications. Like lists, the
 * data lives on the DEVICE (localStorage + iCloud); the server only parses the
 * intent. Two intents:
 *   - expense_action: log a spend, or total up spending by period/category.
 *   - habit_action:   log a habit/med occurrence, check today, or get the streak.
 * ==========================================================================*/

export type ExpensePeriod = "day" | "week" | "month" | "year" | "all";
export interface ExpenseCommand {
  op: "log" | "query";
  amount?: number;
  category?: string;
  period?: ExpensePeriod;
}

function period(m: string): ExpensePeriod | undefined {
  if (/\b(today|so far today)\b/.test(m)) return "day";
  if (/\b(this week|past week|last 7 days|weekly)\b/.test(m)) return "week";
  if (/\b(this month|past month|last 30 days|monthly)\b/.test(m)) return "month";
  if (/\b(this year|past year|yearly|ytd)\b/.test(m)) return "year";
  if (/\b(all time|total|overall|in total|ever)\b/.test(m)) return "all";
  return undefined;
}

function category(m: string): string | undefined {
  const mm = m.match(/\bon\s+(.+?)(?:\s+(?:today|this (?:week|month|year)|so far)|[?.!]|$)/) ||
             m.match(/\bfor\s+(.+?)(?:\s+(?:today|this (?:week|month|year))|[?.!]|$)/);
  if (!mm) return undefined;
  const c = mm[1].replace(/[?.!]+$/, "").replace(/^(a|an|the|my|some)\s+/, "").trim();
  return c && c.length <= 30 ? c : undefined;
}

export function parseExpense(message: string): ExpenseCommand | null {
  const m = message.toLowerCase().trim();

  // Log: "I spent $40 on gas", "log $12 for lunch", "paid 25 for parking"
  if (/\b(spent|spend|paid|log(?:ged)?|record(?:ed)?|track)\b/.test(m) && /(\$\s*\d|\d+(?:\.\d+)?\s*(?:dollars|bucks|usd))/.test(m) && !/\bhow much\b/.test(m)) {
    const amt = m.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|bucks|usd)/);
    const amount = amt ? parseFloat(amt[1] || amt[2]) : NaN;
    if (Number.isFinite(amount) && amount > 0) {
      return { op: "log", amount: Math.round(amount * 100) / 100, category: category(m) };
    }
  }

  // Query: "how much did I spend this week / on gas this month"
  if (/\bhow much\b[^.]*\bspen[dt]\b/.test(m) || /\bmy (spending|expenses)\b/.test(m) || /\b(spending|expenses?)\s+(this|today|so far)\b/.test(m)) {
    return { op: "query", category: category(m), period: period(m) || "month" };
  }
  return null;
}

/* ---- Habits / medications ------------------------------------------------ */

export interface HabitCommand {
  op: "log" | "check" | "streak" | "list";
  name: string;
}

// Normalize a habit name (meds → medication, etc.); title-ish for display.
function normHabit(raw: string): string {
  let n = (raw || "")
    .toLowerCase()
    .replace(/[?.!,]+$/g, "")
    .replace(/^(my|the|a|an|some)\s+/, "")
    .replace(/\s+(today|this morning|tonight|yet|streak)$/,"")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:ed|ing)$/, ""); // meditated→meditat, journaling→journal, flossing→floss
  if (/^meditat/.test(n)) n = "meditation";
  else if (/^vitamin/.test(n)) n = "vitamins";
  else if (/^(meds?|medication|medicine)$/.test(n)) n = "medication";
  else if (/^pill/.test(n)) n = "pills";
  else if (/^supplement/.test(n)) n = "supplements";
  else if (/^(workout|work out|exercis|gym)/.test(n)) n = "workout";
  else if (/^journal/.test(n)) n = "journaling";
  else if (/^floss/.test(n)) n = "flossing";
  else if (/^stretch/.test(n)) n = "stretching";
  return n.slice(0, 40);
}

// A habit command ALWAYS requires one of these known habits — we never treat a
// bare verb + arbitrary object as a habit (so "mark my words", "log into my
// account", "record label" are NOT habits). Custom habits aren't supported yet;
// add keywords here to grow the set.
const HABIT_WORD = /\b(vitamins?|medications?|medicine|meds|pills?|supplements?|meditat(?:e|ed|es|ing|ion)?|mindfulness|workout|worked out|work out|exercis(?:e|ed|es|ing)?|gym|journal(?:ed|ing|s)?|floss(?:ed|ing|es)?|stretch(?:ed|ing|es)?|yoga|pilates|prayers?|prayed|gratitude|skincare|push-?ups?|sit-?ups?|cold shower)\b/;

export function parseHabit(message: string): HabitCommand | null {
  const m = message.toLowerCase().trim();

  // "what are my habits" / "show my habits"
  if (/\b(show|what are|list)\b[^.]*\bhabits?\b/.test(m)) return { op: "list", name: "" };

  // Everything else REQUIRES a known habit word — no bare-verb hijacks.
  const hm = m.match(HABIT_WORD);
  if (!hm) return null;
  const name = normHabit(hm[0]);
  if (!name) return null;

  // Streak: "what's my meditation streak", "meditation streak"
  if (/\bstreak\b/.test(m)) return { op: "streak", name };

  // Check today: "did I take my meds today", "have I meditated today"
  if (/\b(?:did|have|has)\s+i\b/.test(m) && /\b(today|yet|this morning|already)\b/.test(m)) {
    return { op: "check", name };
  }

  // Log: an explicit log verb, "I took my <habit>", or an "I <verbed>" past tense.
  if (/\b(log|mark|record)\b/.test(m) ||
      /\b(?:i\s+)?(?:just\s+|already\s+)?(?:took|take|taken|had|did|finished|completed)\b/.test(m) ||
      /\bi\s+(?:just\s+|already\s+)?(?:meditated|journaled|flossed|stretched|exercised|worked out|prayed)\b/.test(m)) {
    return { op: "log", name };
  }
  return null;
}
