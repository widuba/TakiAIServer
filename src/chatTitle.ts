import { generateContent, PLANNER_MODEL, safetyConfig } from "./ai.js";
import { withTimeout } from "./util.js";

export function normalizeChatTitle(value: string): string {
  return String(value || "")
    .replace(/["'`*_#.:;!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ")
    .slice(0, 60);
}

export async function createChatTitle(message: string, teen = false): Promise<string> {
  const input = String(message || "").trim().slice(0, 1200);
  if (!input) return "New Chat";
  try {
    const result: any = await withTimeout(generateContent({
      model: PLANNER_MODEL,
      contents: `Create a concise chat title for this user message.
Return only the title, 2-5 words, title case, no punctuation or quotation marks.
Name the activity or topic, not the user's intent phrasing.
Example: "help me plan a vacation to Italy" -> Vacation Planning
Example: "what laptop should I buy" -> Laptop Comparison
User message: ${JSON.stringify(input)}`,
      config: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, ...safetyConfig(teen) }
    } as any), 7000, "Chat title");
    return normalizeChatTitle(result?.text || "") || "New Chat";
  } catch {
    return "New Chat";
  }
}
