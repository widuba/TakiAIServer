import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { recordGeminiCall } from "./metering.js";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

/**
 * Single shared Gemini client + model constants.
 *
 * MAIN_MODEL   -> answers / grounded web research (higher quality)
 * PLANNER_MODEL -> structured planning + extraction (fast, JSON mode)
 */
export const ai = new GoogleGenAI({ apiKey });
const rawGenerateContent = ai.models.generateContent.bind(ai.models);

// What Taki says out loud when a vendor is the problem, not the question. Kept
// vague on purpose — end users shouldn't hear "billing" or "quota".
export const AI_UNAVAILABLE_SPOKEN = "Sorry — my service is temporarily unavailable right now. Please try again in a little while.";
export const VOICE_UNAVAILABLE_SPOKEN = "Sorry — my voice service is temporarily unavailable right now. Please try again in a little while.";

export type ServiceErrorKind = "ai_quota" | "ai_auth" | "ai_unavailable" | "voice_unavailable" | "server";

// A vendor/infra failure (Gemini or ElevenLabs) rather than a bad answer. Thrown
// so callers can bail out IMMEDIATELY with a spoken message instead of retrying
// into the same wall (a depleted key answers a 429 in ~1s; the old fallback
// chain turned that into a ~minute wait).
export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  readonly spoken: string;
  readonly status?: number;
  constructor(kind: ServiceErrorKind, spoken: string, status?: number) {
    super(spoken);
    this.name = "ServiceError";
    this.kind = kind;
    this.spoken = spoken;
    this.status = status;
  }
}

// Map a raw Gemini/SDK error to a ServiceError, or null if it's an ordinary
// failure (empty output, a timeout we chose, a parse error) we can still retry.
export function classifyGeminiError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  const any = error as any;
  const status = Number(any?.status ?? any?.code ?? any?.response?.status ?? NaN);
  const message = String(any?.message ?? any ?? "").toLowerCase();
  if (status === 429 || /resource_exhausted|\bquota\b|prepay|rate.?limit|too many requests|\b429\b/.test(message)) {
    return new ServiceError("ai_quota", AI_UNAVAILABLE_SPOKEN, 429);
  }
  if (status === 401 || status === 403 || /api[_ ]?key|permission denied|unauthenticated|unauthorized|\b401\b|\b403\b/.test(message)) {
    return new ServiceError("ai_auth", AI_UNAVAILABLE_SPOKEN, Number.isFinite(status) ? status : undefined);
  }
  if ((status >= 500 && status < 600) || /unavailable|overloaded|internal error|deadline exceeded|\b503\b|\b500\b/.test(message)) {
    return new ServiceError("ai_unavailable", AI_UNAVAILABLE_SPOKEN, Number.isFinite(status) ? status : undefined);
  }
  return null;
}

export async function generateContent(args: any): Promise<any> {
  // Gemini 3 uses thinking levels rather than allowing thinking to be disabled.
  // Translate the older zero-budget call sites so they remain fast and valid.
  let request = args;
  const model = String(args?.model || "").toLowerCase();
  if (/gemini-3(?:\.|-)/.test(model) && args?.config?.thinkingConfig?.thinkingBudget === 0) {
    const thinkingLevel = /3\.1-pro/.test(model) ? "LOW" : "MINIMAL";
    request = {
      ...args,
      config: {
        ...args.config,
        thinkingConfig: { ...args.config.thinkingConfig, thinkingBudget: undefined, thinkingLevel }
      }
    };
  }
  let response;
  try {
    response = await rawGenerateContent(request);
  } catch (error) {
    // Surface quota/auth/outage as a typed error so the caller fails fast and
    // speaks a clear message instead of retrying into the same failure.
    throw classifyGeminiError(error) ?? error;
  }
  recordGeminiCall(request, response);
  return response;
}

export const PORT = Number(process.env.PORT || 8787);
function currentModel(configured: string | undefined, fallback: string): string {
  const requested = String(configured || "").trim();
  if (!requested) return fallback;
  if (/^gemini-2(?:\.|-)/i.test(requested)) {
    console.warn(`Ignoring legacy model override ${requested}; using ${fallback}.`);
    return fallback;
  }
  return requested;
}

/**
 * Model roles (each tuned for its job):
 *   PLANNER_MODEL   -> fast routing/extraction. flash with thinking off (~1-2s).
 *                      NOTE: flash-lite was tested and is too inaccurate here —
 *                      it dropped recipients ("text Chris" -> "who?"), so flash
 *                      is the fastest model that still routes correctly.
 *   MAIN_MODEL      -> balanced model, for general answers + research extraction.
 *   RESEARCH_MODEL  -> most accurate model + Google grounding, for current/
 *                      changeable facts (scores, prices, schedules, news).
 */
export const PLANNER_MODEL = currentModel(process.env.GEMINI_PLANNER_MODEL, "gemini-3.5-flash");
export const MAIN_MODEL = currentModel(process.env.GEMINI_MODEL, "gemini-3.5-flash");
export const RESEARCH_MODEL = currentModel(process.env.GEMINI_RESEARCH_MODEL, "gemini-3.1-pro-preview");
// FAST_MODEL answers easy, static knowledge questions (no routing/extraction —
// that's where flash-lite failed as a planner; as a plain answerer it's fine).
export const FAST_MODEL = currentModel(process.env.GEMINI_FAST_MODEL, "gemini-3.5-flash-lite");

// Timeouts (ms), env-overridable. The planner uses minimal thinking for quick
// routing. Grounded research on the Pro model gets a longer budget.
export const PLANNER_TIMEOUT_MS = Number(process.env.PLANNER_TIMEOUT_MS || 12000);
export const RESEARCH_TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS || 20000);
// Enumerating "the next N games" with grounding is heavier than a single fact
// (a busy schedule can take ~20-25s), so the list pass gets a longer budget.
export const LIST_RESEARCH_TIMEOUT_MS = Number(process.env.LIST_RESEARCH_TIMEOUT_MS || 28000);
export const TIME_ZONE = process.env.ASSISTANT_TIMEZONE || "America/New_York";

/* ---- Teen Mode (ages 13-17) safety -------------------------------------- *
 * Hard Gemini content filters for minors. Harassment / hate / sexual are
 * blocked strictly; dangerous content is BLOCK_MEDIUM so factual news about
 * real (dangerous) events still gets through — the "no graphic detail" nuance
 * is handled by the prompt. Spread via safetyConfig() into a call's config.
 * ------------------------------------------------------------------------- */
const TEEN_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
];

export function safetyConfig(teen?: boolean): Record<string, unknown> {
  return teen ? { safetySettings: TEEN_SAFETY_SETTINGS } : {};
}
