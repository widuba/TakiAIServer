import { AsyncLocalStorage } from "node:async_hooks";

export const CREDIT_USD = 0.001;
// Eleven Flash v2.5 API list price.
export const TTS_USD_PER_1K_CHARS = 0.05;
export const STT_USD_PER_HOUR = 0.22;
export const GEMINI_3_SEARCH_USD_PER_QUERY = 0.014;
export const GEMINI_2_SEARCH_USD_PER_GROUNDED_PROMPT = 0.035;

export interface MeteredUsage {
  geminiUsd: number;
  searchUsd: number;
  calls: number;
  promptTokens: number;
  outputTokens: number;
}

const usageStorage = new AsyncLocalStorage<MeteredUsage>();

export async function measureUsage<T>(fn: () => Promise<T>): Promise<{ value: T; usage: MeteredUsage }> {
  const usage: MeteredUsage = { geminiUsd: 0, searchUsd: 0, calls: 0, promptTokens: 0, outputTokens: 0 };
  const value = await usageStorage.run(usage, fn);
  return { value, usage };
}

function countByModality(details: any, modality: string): number {
  if (!Array.isArray(details)) return 0;
  return details.reduce((sum, detail) => {
    return String(detail?.modality || "").toUpperCase() === modality
      ? sum + Math.max(0, Number(detail?.tokenCount) || 0)
      : sum;
  }, 0);
}

export function geminiListPriceUsd(model: string, metadata: any): number {
  const prompt = Math.max(0, Number(metadata?.promptTokenCount) || 0);
  const candidates = Math.max(0, Number(metadata?.candidatesTokenCount) || 0);
  const thoughts = Math.max(0, Number(metadata?.thoughtsTokenCount) || 0);
  const output = candidates + thoughts;
  const audioInput = Math.min(prompt, countByModality(metadata?.promptTokensDetails, "AUDIO"));
  const regularInput = prompt - audioInput;
  const id = model.toLowerCase();
  const longPrompt = prompt > 200_000;
  let regularInputRate = 1.50;
  let audioInputRate = 1.50;
  let outputRate = 9.00;

  if (/3\.1-pro/.test(id)) {
    regularInputRate = audioInputRate = longPrompt ? 4.00 : 2.00;
    outputRate = longPrompt ? 18.00 : 12.00;
  } else if (/3\.5-flash-lite/.test(id)) {
    // Flash-lite pricing tier (same bracket as 3.1-flash-lite). Must be checked
    // BEFORE /3\.5-flash/ or lite requests would be billed at full-flash rates.
    regularInputRate = 0.25;
    audioInputRate = 0.50;
    outputRate = 1.50;
  } else if (/3\.5-flash/.test(id)) {
    regularInputRate = audioInputRate = 1.50;
    outputRate = 9.00;
  } else if (/3\.1-flash-lite/.test(id)) {
    regularInputRate = 0.25;
    audioInputRate = 0.50;
    outputRate = 1.50;
  } else if (/3-flash/.test(id)) {
    regularInputRate = 0.50;
    audioInputRate = 1.00;
    outputRate = 3.00;
  } else if (/2\.5-pro/.test(id)) {
    regularInputRate = audioInputRate = longPrompt ? 2.50 : 1.25;
    outputRate = longPrompt ? 15.00 : 10.00;
  } else if (/2\.5-flash-lite/.test(id)) {
    regularInputRate = 0.10;
    audioInputRate = 0.30;
    outputRate = 0.40;
  } else if (/2\.5-flash/.test(id)) {
    regularInputRate = 0.30;
    audioInputRate = 1.00;
    outputRate = 2.50;
  }
  return ((regularInput * regularInputRate) + (audioInput * audioInputRate) + (output * outputRate)) / 1_000_000;
}

function requestedGoogleSearch(args: any): boolean {
  return Array.isArray(args?.config?.tools) && args.config.tools.some((tool: any) => tool?.googleSearch);
}

export function googleSearchQueryCount(response: any): number {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const queries = new Set<string>();
  let grounded = false;
  for (const candidate of candidates) {
    const metadata = candidate?.groundingMetadata || candidate?.grounding_metadata;
    const webQueries = metadata?.webSearchQueries || metadata?.web_search_queries;
    if (Array.isArray(webQueries)) {
      for (const query of webQueries) {
        const normalized = String(query || "").trim().toLowerCase();
        if (normalized) queries.add(normalized);
      }
    }
    const chunks = metadata?.groundingChunks || metadata?.grounding_chunks;
    if (Array.isArray(chunks) && chunks.some((chunk: any) => chunk?.web)) grounded = true;
    if (metadata?.searchEntryPoint || metadata?.search_entry_point) grounded = true;
  }
  return queries.size || (grounded ? 1 : 0);
}

export function googleSearchListPriceUsd(model: string, response: any): number {
  const queries = googleSearchQueryCount(response);
  if (!queries) return 0;
  return /gemini-3(?:\.|-)/i.test(model)
    ? queries * GEMINI_3_SEARCH_USD_PER_QUERY
    : GEMINI_2_SEARCH_USD_PER_GROUNDED_PROMPT;
}

export function recordGeminiCall(args: any, response: any): void {
  const usage = usageStorage.getStore();
  if (!usage) return;
  const metadata = response?.usageMetadata || response?.usage_metadata || {};
  const prompt = Math.max(0, Number(metadata?.promptTokenCount) || 0);
  const output = Math.max(0, Number(metadata?.candidatesTokenCount) || 0)
    + Math.max(0, Number(metadata?.thoughtsTokenCount) || 0);
  usage.calls += 1;
  usage.promptTokens += prompt;
  usage.outputTokens += output;
  usage.geminiUsd += geminiListPriceUsd(String(args?.model || ""), metadata);
  // A tool declaration does not mean Search ran. Bill list price only when the
  // grounding metadata confirms actual use, and count Gemini 3's real queries.
  if (requestedGoogleSearch(args)) {
    usage.searchUsd += googleSearchListPriceUsd(String(args?.model || ""), response);
  }
}

export function totalUsageUsd(usage: MeteredUsage): number {
  return usage.geminiUsd + usage.searchUsd;
}

export function ttsCostUsd(spokenChars: number): number {
  return Math.max(0, Math.floor(spokenChars)) * (TTS_USD_PER_1K_CHARS / 1000);
}

export function sttCostUsd(durationMs: number): number {
  return Math.max(0, Math.floor(durationMs)) * (STT_USD_PER_HOUR / 3_600_000);
}
