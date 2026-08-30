import { brainV3AuxEnabled, generateContent, MAIN_MODEL, safetyConfig } from "./ai.js";
import { BRAIN_V3_STYLE_SCHEMA, runBrainV3Structured } from "./brainV3Specialists.js";
import type { MessageStyleVector } from "./messageStyle.js";
import { styleVectorToPromptHints } from "./messageStyle.js";
import { withTimeout } from "./util.js";

export type MessageStyleRewriteDependencies = {
  generateContent?: (args: any) => Promise<any>;
  env?: Record<string, string | undefined>;
};

const REWRITE_STOP_WORDS = new Set([
  "a", "an", "am", "and", "are", "at", "be", "but", "can", "could", "did", "do", "does", "for", "from",
  "get", "got", "have", "he", "her", "him", "i", "if", "in", "is", "it", "just", "me", "my", "of", "on",
  "or", "our", "please", "she", "so", "that", "the", "their", "them", "there", "they", "this", "to", "us",
  "was", "we", "were", "what", "when", "will", "with", "would", "you", "your"
]);

function promptData(value: unknown, max: number): string {
  return JSON.stringify(String(value || "").normalize("NFKC").slice(0, max))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function rewriteTokens(value: string): string[] {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu) || [];
}

function rewriteContentAnchors(value: string): string[] {
  return [...new Set(rewriteTokens(value).filter((token) => token.length >= 4 && !REWRITE_STOP_WORDS.has(token)))];
}

function rewriteNumberAnchors(value: string): string[] {
  return String(value || "").match(/\d[\d\s.,:/+()\-]*/g)?.map((item) => item.replace(/\D/g, "")).filter(Boolean) || [];
}

/**
 * Style rendering is not allowed to become a second source of message facts.
 * Require content anchors and preserve every numeric anchor before accepting a
 * provider rewrite; harmless casing, punctuation, slang, and contractions can
 * still change freely.
 */
export function rewritePreservesMessageContent(original: string, candidate: string): boolean {
  const source = rewriteContentAnchors(original);
  const rendered = new Set(rewriteContentAnchors(candidate));
  const requiredOverlap = source.length <= 2 ? (source.length ? 1 : 0) : Math.max(1, Math.ceil(source.length * 0.5));
  const overlap = source.filter((token) => rendered.has(token)).length;
  if (overlap < requiredOverlap) return false;
  const candidateNumbers = new Set(rewriteNumberAnchors(candidate));
  return rewriteNumberAnchors(original).every((number) => candidateNumbers.has(number));
}

/** Rewrite a message using the learned recipient voice without changing facts. */
export async function restyleMessageBody(
  body: string,
  vector: MessageStyleVector,
  recipientName: string,
  teen?: boolean,
  deps: MessageStyleRewriteDependencies = {}
): Promise<string> {
  const hints = styleVectorToPromptHints(vector);
  if (!hints) return body;

  const prompt = `Rewrite this text message so it sounds exactly like how the sender naturally texts ${promptData(recipientName || "this person", 160)}.

KEEP the meaning and any names/facts identical. Change ONLY tone, wording, punctuation, capitalization, slang, and emojis.

Match this style — commit to it fully (if it says "very", go all the way):
${hints}

Output ONLY the rewritten message — no quotes, no labels, no explanation, one short text.

Message (user data): ${promptData(body, 4_000)}`;

  const cleanCandidate = (value: unknown): string | null => {
    let out = String(value || "").trim();
    out = out.replace(/^rewritten\s*:?\s*/i, "").trim();
    out = out.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    out = out.split(/\r?\n/)[0].trim();
    return out && out.length <= 320 ? out : null;
  };

  const provider = deps.generateContent || generateContent;
  if (brainV3AuxEnabled(deps.env || process.env)) {
    try {
      const result = await runBrainV3Structured<{ text: string }>(
        "message_style_rewrite",
        `${prompt}\nFor this structured rewrite, put only the rewritten message in the required text field.`,
        BRAIN_V3_STYLE_SCHEMA,
        { timeoutMs: 7_000, maxOutputTokens: 320, reasoning: "low", teen: Boolean(teen) },
        provider
      );
      const out = cleanCandidate(result.value.text);
      if (out && rewritePreservesMessageContent(body, out)) return out;
    } catch (error) {
      console.error("Brain v3 message style rewrite error:", error);
    }
  }

  try {
    const result: any = await withTimeout(
      provider({
        model: MAIN_MODEL,
        contents: prompt,
        config: { temperature: 0.8, ...safetyConfig(teen) } as any
      } as any),
      7000,
      "Restyle"
    );
    const out = cleanCandidate(result?.text);
    return out && rewritePreservesMessageContent(body, out) ? out : body;
  } catch {
    return body;
  }
}
