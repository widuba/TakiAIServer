import { AsyncLocalStorage } from "node:async_hooks";

export const CREDIT_USD = 0.001;
export const TTS_USD_PER_1K_CHARS = 0.05;
export const GOOGLE_SEARCH_USD_PER_REQUEST = 0.035;

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
  const isPro = /(?:^|-)pro(?:-|$)/i.test(model);
  const longPrompt = isPro && prompt > 200_000;
  const regularInputRate = isPro ? (longPrompt ? 2.5 : 1.25) : 0.30;
  const audioInputRate = isPro ? regularInputRate : 1.00;
  const outputRate = isPro ? (longPrompt ? 15 : 10) : 2.50;
  return ((regularInput * regularInputRate) + (audioInput * audioInputRate) + (output * outputRate)) / 1_000_000;
}

function requestedGoogleSearch(args: any): boolean {
  return Array.isArray(args?.config?.tools) && args.config.tools.some((tool: any) => tool?.googleSearch);
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
  // Grounding has a shared daily free pool, so subscription economics reserve
  // list price for every requested grounding call instead of depending on it.
  if (requestedGoogleSearch(args)) usage.searchUsd += GOOGLE_SEARCH_USD_PER_REQUEST;
}

export function totalUsageUsd(usage: MeteredUsage): number {
  return usage.geminiUsd + usage.searchUsd;
}

export function ttsCostUsd(spokenChars: number): number {
  return Math.max(0, Math.floor(spokenChars)) * (TTS_USD_PER_1K_CHARS / 1000);
}
