import { brainV3AuxEnabled, generateContent, MAIN_MODEL } from "./ai.js";
import { runBrainV3Structured } from "./brainV3Specialists.js";
import { withTimeout } from "./util.js";
import { fetchPublicUrl, readPublicResponseText, validatePublicHttpUrl } from "./urlSafety.js";
import { GUARDRAILS, personaPromptBlock } from "./persona.js";
import type { ConversationState } from "./types.js";

export const URL_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { summary: { type: "string" } },
  required: ["summary"]
} as const;

/* ============================================================================
 * URL summarization. "summarize this: <link>" (or just a bare link) → Taki reads
 * the page via the free Jina reader proxy (renders JS + bypasses the bot blocks
 * that 403 a direct datacenter fetch) and summarizes it. No API key.
 * ==========================================================================*/

export function extractUrl(text: string): string | null {
  const m = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0].replace(/[.,;:!?)]+$/, "") : null;
}

// Ask-to-summarize a link: explicit intent, or a message that's basically just a URL.
export function looksLikeUrlSummarize(message: string): boolean {
  const url = extractUrl(message);
  if (!url) return false;
  const m = message.toLowerCase();
  const intent = /\b(summar|tl;?dr|tldr|what('?s| is)\s+(this|it|that)|read this|explain this|the gist|key points|main points|what'?s? (this|it) about|breakdown|recap|overview|read it to me)\b/.test(m);
  const bare = message.trim().replace(url, "").trim().length < 5; // just the link
  return intent || bare;
}

async function fetchReadable(url: string): Promise<string> {
  try {
    const safe = await validatePublicHttpUrl(url);
    if (!safe) return "";
    const r = await fetchPublicUrl(
      `https://r.jina.ai/${safe.toString()}`,
      { headers: { Accept: "text/plain", "User-Agent": "TakiAI/1.0" } },
      18_000,
      "URL reader"
    );
    if (!r?.ok) return "";
    return (await readPublicResponseText(r, 40_000)).slice(0, 40_000);
  } catch (error) {
    console.error("URL reader error:", error);
    return "";
  }
}

export async function summarizeUrl(state: ConversationState): Promise<string> {
  const url = extractUrl(state.message);
  if (!url) return "";
  const text = await fetchReadable(url);
  if (!text || text.trim().length < 200) {
    return "I couldn't read that page — it may be private, empty, or blocking readers. Try pasting the text instead.";
  }
  const lengthRule = state.voiceMode
    ? "Answer in ONE or two short sentences (it's read aloud)."
    : "Give a short paragraph, or 3–6 tight bullet points if the content is list-like.";
  // Strip the URL from the user's ask so we can honor any extra instruction.
  const extra = state.message.replace(url, "").trim();
  const prompt = `${GUARDRAILS}
You are Taki AI. Summarize the web page below for the user.
${personaPromptBlock(state.userProfile)}
- ${lengthRule}
- Lead with the single most important takeaway.
- Be accurate to the page; never invent facts that aren't in it.
- Plain text — no markdown headers, no "According to the article…" preamble.
${extra && extra.length > 3 ? `\nThe user also said: "${extra}" — address that specifically if relevant.` : ""}

PAGE (${url}):
${text}`;
  try {
    const v3 = brainV3AuxEnabled();
    if (v3) {
      const result = await runBrainV3Structured<{ summary: string }>(
        "url_summary",
        `${prompt}\n\nReturn the final summary inside this JSON object only: {"summary":"..."}. Do not add any other keys.`,
        URL_SUMMARY_SCHEMA,
        { timeoutMs: 20_000, maxOutputTokens: 1_800, reasoning: "low", temperature: 0 }
      );
      const out = String(result.value.summary || "").trim();
      return out || "I read the page but couldn't summarize it — try again.";
    }
    const r: any = await withTimeout(generateContent({
      model: MAIN_MODEL,
      contents: prompt,
      config: { thinkingConfig: { thinkingBudget: 0 } }
    } as any), 20_000, "URL summary");
    const out = String(r?.text || "").trim();
    return out || "I read the page but couldn't summarize it — try again.";
  } catch (error) {
    console.error("summarizeUrl error:", error);
    return "I had trouble summarizing that page.";
  }
}
