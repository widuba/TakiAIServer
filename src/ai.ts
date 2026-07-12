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
  const response = await rawGenerateContent(args);
  recordGeminiCall(args, response);
  return response;
}

export const PORT = Number(process.env.PORT || 8787);
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
export const PLANNER_MODEL = process.env.GEMINI_PLANNER_MODEL || "gemini-2.5-flash";
export const MAIN_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const RESEARCH_MODEL = process.env.GEMINI_RESEARCH_MODEL || "gemini-2.5-pro";

// Timeouts (ms), env-overridable. The planner is now flash-lite with thinking
// off (~1-2s typical), so a tighter budget is fine. Grounded research on the
// accurate model is slower, so it gets a longer budget.
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
