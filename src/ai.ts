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
  const response = await rawGenerateContent(request);
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
