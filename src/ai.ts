import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { AsyncLocalStorage } from "node:async_hooks";
import { recordGeminiCall, recordOpenAICall } from "./metering.js";
import {
  generateOpenAIContent,
  generateOpenAIContentStream,
  OpenAIHTTPError,
  UnsupportedOpenAIInputError
} from "./openaiProvider.js";
import { brainV3PromotionGateStatus } from "./brainV3Promotion.js";

dotenv.config();

const geminiApiKey = String(process.env.GEMINI_API_KEY || "").trim();
const openAIApiKey = String(process.env.OPENAI_API_KEY || "").trim();
export type AIProvider = "openai" | "gemini";
function configuredProvider(): AIProvider {
  const requested = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (requested === "openai" || requested === "gemini") return requested;
  // Adding OPENAI_API_KEY is enough to make OpenAI primary. AI_PROVIDER can
  // still explicitly pin Gemini during a rollback.
  return openAIApiKey ? "openai" : "gemini";
}
export const ACTIVE_AI_PROVIDER = configuredProvider();
if (ACTIVE_AI_PROVIDER === "openai" && !openAIApiKey) {
  throw new Error("Missing OPENAI_API_KEY in the server environment.");
}
if (ACTIVE_AI_PROVIDER === "gemini" && !geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY in the server environment.");
}

/**
 * Shared provider clients + model constants.
 *
 * MAIN_MODEL   -> answers / grounded web research (higher quality)
 * PLANNER_MODEL -> structured planning + extraction (fast, JSON mode)
 */
export const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const rawGenerateContent = ai?.models.generateContent.bind(ai.models);
const rawGenerateContentStream = ai?.models.generateContentStream.bind(ai.models);

// What Taki says out loud when a vendor is the problem, not the question. Kept
// vague on purpose — end users shouldn't hear "billing" or "quota".
export const AI_UNAVAILABLE_SPOKEN = "Taki's answer system didn't respond just now. I couldn't finish that request, but your question wasn't the problem — please try again.";
export const AI_TIMEOUT_SPOKEN = "That answer took too long, so I stopped waiting instead of leaving you stuck. I couldn't finish the request — please try again.";
export const AI_QUOTA_SPOKEN = "Taki's answer capacity is busy right now. I couldn't finish that request — please try again in a minute.";
export const AI_AUTH_SPOKEN = "Taki's answer system needs attention right now. I couldn't finish that request — please try again later.";
export const VOICE_UNAVAILABLE_SPOKEN = "I couldn't generate spoken audio just now. Please try voice again.";

export type ServiceErrorKind = "ai_quota" | "ai_auth" | "ai_timeout" | "ai_unavailable" | "voice_unavailable" | "server";

// A vendor/infra failure (OpenAI, Gemini, or ElevenLabs) rather than a bad answer. Thrown
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

// Map a raw provider/SDK error to a ServiceError, or null if it's an ordinary
// failure (empty output, a timeout we chose, a parse error) we can still retry.
export function classifyAIError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  const any = error as any;
  const status = Number(any?.status ?? any?.code ?? any?.response?.status ?? NaN);
  const message = String(any?.message ?? any ?? "").toLowerCase();
  if (status === 402 || status === 429 || /resource_exhausted|\bquota\b|prepay|rate.?limit|too many requests|\b402\b|\b429\b/.test(message)) {
    return new ServiceError("ai_quota", AI_QUOTA_SPOKEN, Number.isFinite(status) ? status : 429);
  }
  if (status === 401 || status === 403 || /api[_ ]?key|permission denied|unauthenticated|unauthorized|\b401\b|\b403\b/.test(message)) {
    return new ServiceError("ai_auth", AI_AUTH_SPOKEN, Number.isFinite(status) ? status : undefined);
  }
  // A provider-attempt deadline is different from an outer tool timeout. The
  // router should immediately try its alternate model, and if every candidate
  // times out the route should return a typed, speakable service response.
  if (status === 408) {
    return new ServiceError("ai_timeout", AI_TIMEOUT_SPOKEN, 408);
  }
  const explicitProviderOutage =
    /\b(?:service|server|backend|model)(?:\s+is)?\s+(?:temporarily\s+)?unavailable\b/.test(message)
    || /\b(?:model|server|service)\s+(?:is\s+)?overloaded\b/.test(message)
    || /\bdeadline exceeded\b|\b(?:status|code)\s*[:=]?\s*(?:unavailable|503|500)\b|\b503\b|\b500\b/.test(message);
  if ((status >= 500 && status < 600) || explicitProviderOutage) {
    return new ServiceError("ai_unavailable", AI_UNAVAILABLE_SPOKEN, Number.isFinite(status) ? status : undefined);
  }
  return null;
}

// Backward-compatible export used by existing tests and callers.
export const classifyGeminiError = classifyAIError;

export type TakiModelKey = "taki_2_0_swift" | "taki_2_1" | "taki_2_1_reasoning";

type ModelEnvironment = Record<string, string | undefined>;

function configuredModel(env: ModelEnvironment, names: string[], fallback: string): string {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return fallback;
}

/**
 * Map the customer-facing Taki tier to the OpenAI answer model. Keep this
 * separate from the JSON action planner: Dromos can be inexpensive for
 * conversational answers while every tier still gets the dependable planner
 * needed to execute calendar, maps, messages, and other device actions.
 *
 * The defaults intentionally follow the customer-facing speed-to-intelligence
 * order requested by the product: Dromos -> GPT-5.4 Mini, Metron -> GPT-5.5,
 * Sophos -> GPT-5.6 Luna. The OPENAI_TAKI_* variables are tier-specific
 * overrides; the older role variables remain supported for existing Render
 * deployments during the transition.
 */
export function openAIModelForTaki(key: TakiModelKey, env: ModelEnvironment = process.env): string {
  const fast = configuredModel(env, ["OPENAI_TAKI_FAST_MODEL", "OPENAI_FAST_MODEL"], "gpt-5.4-mini");
  const balanced = configuredModel(env, ["OPENAI_TAKI_BALANCED_MODEL", "OPENAI_BALANCED_MODEL", "OPENAI_MODEL"], "gpt-5.5");
  const smart = configuredModel(env, ["OPENAI_TAKI_SMART_MODEL", "OPENAI_SMART_MODEL", "OPENAI_RESEARCH_MODEL"], "gpt-5.6-luna");
  if (key === "taki_2_0_swift") return fast;
  if (key === "taki_2_1_reasoning") return smart;
  return balanced;
}

function takiAnswerModel(key: TakiModelKey): string {
  if (ACTIVE_AI_PROVIDER === "openai") {
    return openAIModelForTaki(key);
  }
  if (key === "taki_2_0_swift") return "gemini-3.5-flash-lite";
  if (key === "taki_2_1_reasoning") return "gemini-3.1-pro-preview";
  return "gemini-3.6-flash";
}

export const TAKI_MODELS = [
  {
    key: "taki_2_0_swift",
    name: "Dromos",
    detail: "Usually fastest and lowest-credit across everyday questions; still uses research and reliable action planning when the request requires them",
    providerModel: takiAnswerModel("taki_2_0_swift")
  },
  {
    key: "taki_2_1",
    name: "Metron",
    detail: "Balanced for speed, credit use, accuracy, and current information",
    providerModel: takiAnswerModel("taki_2_1")
  },
  {
    key: "taki_2_1_reasoning",
    name: "Sophos",
    detail: "Usually the most thorough and highest-credit option; actual speed and cost also depend on research and tools used",
    providerModel: takiAnswerModel("taki_2_1_reasoning")
  }
] as const;

export const DEFAULT_TAKI_MODEL: TakiModelKey = "taki_2_1";
const modelSelectionStorage = new AsyncLocalStorage<TakiModelKey>();

export function normalizeTakiModel(value: unknown): TakiModelKey {
  const key = String(value || "").trim().toLowerCase();
  return TAKI_MODELS.some((entry) => entry.key === key) ? key as TakiModelKey : DEFAULT_TAKI_MODEL;
}

export function takiModelInfo(value: unknown): typeof TAKI_MODELS[number] {
  const key = normalizeTakiModel(value);
  return TAKI_MODELS.find((entry) => entry.key === key)!;
}

export function withTakiModel<T>(value: unknown, fn: () => Promise<T>): Promise<T> {
  return modelSelectionStorage.run(normalizeTakiModel(value), fn);
}

export function activeTakiModelInfo(): typeof TAKI_MODELS[number] {
  return takiModelInfo(modelSelectionStorage.getStore());
}

// One quick alternate-model attempt handles temporary per-model capacity and
// rate limits without turning a voice request into a long retry loop.
export function fallbackModelCandidates(primary: string): string[] {
  const id = String(primary || "").trim();
  const production = /^gpt-/i.test(id)
    ? ["gpt-5.4-mini", "gpt-5.4-nano"]
    : ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  return [id, ...production.filter((candidate) => candidate !== id)].filter(Boolean).slice(0, 2);
}

export function modelForRequest(args: any): string {
  const selected = modelSelectionStorage.getStore();
  if (!selected) return String(args?.model || MAIN_MODEL);
  // Brain v3 has its own model role and structured-output contract. Do not
  // silently replace it with the legacy planner model just because its output
  // is JSON; the role is what makes the replacement independently tunable.
  if (args?.config?.modelRole === "brain_v3") {
    return String(args?.model || MAIN_MODEL);
  }
  // Model choice controls answer depth, latency, and the usual token price. It
  // must never remove capabilities: every tier uses the dependable structured
  // planner for actions/extraction, including web-researched calendar events.
  if (args?.config?.responseMimeType === "application/json") {
    return PLANNER_MODEL;
  }
  return takiModelInfo(selected).providerModel;
}

export function prepareGeminiRequest(args: any, selectedModel: string): any {
  let config = { ...(args?.config || {}) };
  // Provider-adapter-only controls must not leak into Gemini's config schema.
  const {
    forceWebSearch: _forceWebSearch,
    force_web_search: _forceWebSearchSnake,
    webSearchContextSize: _webSearchContextSize,
    web_search_context_size: _webSearchContextSizeSnake,
    modelRole: _modelRole,
    responseJsonSchemaName: _responseJsonSchemaName,
    response_json_schema_name: _responseJsonSchemaNameSnake,
    openAIReasoningEffort: _openAIReasoningEffort,
    openai_reasoning_effort: _openAIReasoningEffortSnake,
    ...providerSafeConfig
  } = config;
  config = providerSafeConfig;
  // Current 3.5 Lite and 3.6 models choose their own sampling settings. Avoid
  // sending legacy tuning fields that newer endpoints may reject.
  if (/gemini-3\.(?:5-flash-lite|6-flash)/i.test(selectedModel)) {
    const { temperature: _temperature, topP: _topP, topK: _topK, ...supported } = config;
    config = supported;
  }
  if (/gemini-3(?:\.|-)/i.test(selectedModel) && config?.thinkingConfig?.thinkingBudget === 0) {
    const thinkingLevel = /3\.1-pro/i.test(selectedModel) ? "LOW" : "MINIMAL";
    config = {
      ...config,
      thinkingConfig: { ...config.thinkingConfig, thinkingBudget: undefined, thinkingLevel }
    };
  }
  return { ...args, model: selectedModel, config };
}

function prepareOpenAIRequest(args: any, selectedModel: string): any {
  const selected = modelSelectionStorage.getStore();
  const isPlanner = args?.config?.responseMimeType === "application/json";
  // Each tier has a default thinking budget: Sophos reasons hard, Metron stays
  // balanced, Dromos answers instantly. Sophos is the opt-in "go deep" tier, so
  // it now uses high effort rather than medium.
  const tierEffort =
    selected === "taki_2_1_reasoning" && !isPlanner
      ? "high"
      : selected === "taki_2_1" || isPlanner
        ? "low"
        : "none";
  // A caller (e.g. getGeneralAnswer's difficulty routing) may explicitly request
  // a different effort for a single request — bumping the balanced tier up for a
  // genuinely hard question, or dropping the deep tier down for a trivial one.
  const requested = String(args?.config?.openAIReasoningEffort || "").toLowerCase();
  const openAIReasoningEffort =
    (requested === "none" || requested === "low" || requested === "medium" || requested === "high")
      ? requested
      : tierEffort;
  return {
    ...args,
    model: selectedModel,
    config: { ...(args?.config || {}), openAIReasoningEffort }
  };
}

export type ProviderCandidate = { provider: AIProvider; model: string };

function providerCandidateKey(candidate: ProviderCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

function providerFailureCooldownMs(error: unknown): number {
  const serviceError = classifyAIError(error);
  switch (serviceError?.kind) {
    case "ai_auth": return 5 * 60_000;
    case "ai_quota": return 30_000;
    case "ai_timeout": return 15_000;
    case "ai_unavailable": return 20_000;
    default: return 0;
  }
}

/**
 * A tiny in-process circuit breaker keeps a sick model from adding the same
 * timeout to every turn. Healthy alternates move to the front during a short,
 * bounded cooldown; a cooling candidate remains last-resort rather than being
 * permanently disabled.
 */
export class ProviderCircuitBreaker {
  private readonly openUntil = new Map<string, number>();

  order(candidates: ProviderCandidate[], now = Date.now()): ProviderCandidate[] {
    return candidates
      .map((candidate, index) => ({ candidate, index, until: this.openUntil.get(providerCandidateKey(candidate)) || 0 }))
      .sort((a, b) => {
        const aCooling = a.until > now ? 1 : 0;
        const bCooling = b.until > now ? 1 : 0;
        if (aCooling !== bCooling) return aCooling - bCooling;
        if (aCooling && a.until !== b.until) return a.until - b.until;
        return a.index - b.index;
      })
      .map((entry) => entry.candidate);
  }

  recordFailure(candidate: ProviderCandidate, error: unknown, now = Date.now()): void {
    const cooldown = providerFailureCooldownMs(error);
    if (cooldown > 0) this.openUntil.set(providerCandidateKey(candidate), now + cooldown);
  }

  recordSuccess(candidate: ProviderCandidate): void {
    this.openUntil.delete(providerCandidateKey(candidate));
  }

  reset(): void {
    this.openUntil.clear();
  }
}

const providerCircuit = new ProviderCircuitBreaker();

function geminiFallbackFor(openAIModel: string): string {
  const id = String(openAIModel || "").toLowerCase();
  if (/luna|nano/.test(id)) return "gemini-3.5-flash-lite";
  if (/sol|pro/.test(id)) return "gemini-3.1-pro-preview";
  return "gemini-3.6-flash";
}

export function providerCandidates(primary: string, args: any = {}): ProviderCandidate[] {
  // Brain v3 promotion evidence is provider- and model-bound. Do not silently
  // move an evaluated v3 request to the legacy alternate provider: the planner
  // owns the compatibility fallback after this single promoted attempt fails.
  if (args?.config?.modelRole === "brain_v3") {
    return [{ provider: ACTIVE_AI_PROVIDER, model: primary }];
  }
  if (/^gpt-/i.test(primary)) {
    const candidates: ProviderCandidate[] = [{ provider: "openai", model: primary }];
    if (geminiApiKey) candidates.push({ provider: "gemini", model: geminiFallbackFor(primary) });
    else {
      const alternate = fallbackModelCandidates(primary)[1];
      if (alternate) candidates.push({ provider: "openai", model: alternate });
    }
    return candidates;
  }
  return fallbackModelCandidates(primary).map((model) => ({ provider: "gemini", model }));
}

function canTryNextProvider(error: unknown, serviceError: ServiceError | null): boolean {
  if (error instanceof UnsupportedOpenAIInputError || error instanceof OpenAIHTTPError) return true;
  return serviceError?.kind === "ai_quota"
    || serviceError?.kind === "ai_auth"
    || serviceError?.kind === "ai_timeout"
    || serviceError?.kind === "ai_unavailable";
}

export async function generateContent(args: any): Promise<any> {
  const candidates = providerCircuit.order(providerCandidates(modelForRequest(args), args));
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const request = candidate.provider === "gemini"
      ? prepareGeminiRequest(args, candidate.model)
      : prepareOpenAIRequest(args, candidate.model);
    try {
      const response = candidate.provider === "openai"
        ? await generateOpenAIContent(request, candidate.model, openAIApiKey)
        : await rawGenerateContent!(request);
      providerCircuit.recordSuccess(candidate);
      if (candidate.provider === "openai") recordOpenAICall(request, response);
      else recordGeminiCall(request, response);
      return response;
    } catch (error) {
      const serviceError = classifyAIError(error);
      providerCircuit.recordFailure(candidate, serviceError ?? error);
      lastError = serviceError ?? error;
      const canFailOver = candidate.provider === "openai" || canTryNextProvider(error, serviceError);
      if (!canFailOver || index === candidates.length - 1) throw lastError;
      console.warn(`Taki ${candidate.provider} model ${candidate.model} unavailable; trying ${candidates[index + 1].provider}.`);
    }
  }
  throw lastError;
}

// Streaming counterpart used by voice answers. It preserves model selection,
// metering, and failover, but only fails over before any text has been emitted
// so a user can never hear the beginning of one model's answer and the ending
// of another model's answer.
export async function* generateContentStream(args: any): AsyncGenerator<any> {
  const candidates = providerCircuit.order(providerCandidates(modelForRequest(args), args));
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const request = candidate.provider === "gemini"
      ? prepareGeminiRequest(args, candidate.model)
      : prepareOpenAIRequest(args, candidate.model);
    let emitted = false;
    let lastResponse: any;
    try {
      const stream = candidate.provider === "openai"
        ? generateOpenAIContentStream(request, candidate.model, openAIApiKey)
        : await rawGenerateContentStream!(request);
      for await (const response of stream) {
        if (String(response?.text || "")) emitted = true;
        lastResponse = response;
        yield response;
      }
      if (lastResponse) {
        providerCircuit.recordSuccess(candidate);
        if (candidate.provider === "openai") recordOpenAICall(request, lastResponse);
        else recordGeminiCall(request, lastResponse);
      }
      return;
    } catch (error) {
      const serviceError = classifyAIError(error);
      providerCircuit.recordFailure(candidate, serviceError ?? error);
      lastError = serviceError ?? error;
      const canFailOver = !emitted && (candidate.provider === "openai" || canTryNextProvider(error, serviceError));
      if (!canFailOver || index === candidates.length - 1) throw lastError;
      console.warn(`Taki streaming ${candidate.provider} model ${candidate.model} unavailable; trying ${candidates[index + 1].provider}.`);
    }
  }
  throw lastError;
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
 *   RESEARCH_MODEL  -> most accurate model + web grounding, for current/
 *                      changeable facts (scores, prices, schedules, news).
 */
export const PLANNER_MODEL = ACTIVE_AI_PROVIDER === "openai"
  ? String(process.env.OPENAI_PLANNER_MODEL || "gpt-5.4-mini").trim()
  : currentModel(process.env.GEMINI_PLANNER_MODEL, "gemini-3.6-flash");
export const MAIN_MODEL = ACTIVE_AI_PROVIDER === "openai"
  ? openAIModelForTaki("taki_2_1")
  : currentModel(process.env.GEMINI_MODEL, "gemini-3.6-flash");
// Brain v3 is deliberately separate from the legacy planner and answer roles.
// It can be tuned in staging without changing customer-facing model selection.
export const BRAIN_V3_MODEL = ACTIVE_AI_PROVIDER === "openai"
  ? currentModel(process.env.OPENAI_BRAIN_V3_MODEL, openAIModelForTaki("taki_2_1_reasoning"))
  : currentModel(process.env.GEMINI_BRAIN_V3_MODEL, "gemini-3.1-pro-preview");
// Promotion evidence must cover every provider model that the v3 pipeline can
// actually use: the dedicated understanding/specialist model plus each
// customer-facing answer tier. Keeping this set explicit prevents a valid
// token for one tier from silently authorizing an untested tier.
export const BRAIN_V3_MODELS = Array.from(new Set([
  BRAIN_V3_MODEL,
  ...TAKI_MODELS.map((entry) => entry.providerModel)
]));

/**
 * Core v3 is selected per request by the planner. This process-level helper
 * only answers whether the deployed environment permits a selected request to
 * use the core pipeline; it deliberately does not include device bucketing.
 * The planner still calls shouldUseBrainV3(state) before passing brainV3Core.
 *
 * Shadow is the one exception to the promotion-evidence requirement: its detached,
 * discarded run must exercise the same strict research path as a promoted
 * request so staging evidence is meaningful. The planner never passes
 * brainV3Core for customer traffic while mode is shadow.
 */
export function brainV3CoreEnabled(env: ModelEnvironment = process.env): boolean {
  const coreMode = String(env.TAKI_BRAIN_V3_MODE || "disabled").trim().toLowerCase();
  if (coreMode === "shadow") return true;
  return brainV3PromotionGateStatus(env, ACTIVE_AI_PROVIDER, BRAIN_V3_MODEL, Date.now(), BRAIN_V3_MODELS).ready
    && (coreMode === "active" || coreMode === "canary" || coreMode === "v3");
}

/**
 * Auxiliary model surfaces (memory, recipes, day plans, summaries, titles, and
 * contextual review) have their own
 * promotion gate. They must not silently change just because the main brain
 * is in shadow or a partial canary. Enable this only after the core v3 ramp is
 * fully active and its provider-backed evaluation has passed.
 */
export function brainV3AuxEnabled(env: ModelEnvironment = process.env): boolean {
  const coreMode = String(env.TAKI_BRAIN_V3_MODE || "disabled").trim().toLowerCase();
  const auxMode = String(env.TAKI_BRAIN_V3_AUX_MODE || "disabled").trim().toLowerCase();
  return brainV3CoreEnabled(env)
    && (coreMode === "active" || coreMode === "v3")
    && (auxMode === "active" || auxMode === "v3");
}

/** Build the one versioned strict-JSON request shape shared by v3 auxiliaries. */
export function brainV3StructuredRequest(
  name: string,
  contents: unknown,
  schema: Record<string, unknown>,
  options: Record<string, unknown> = {}
): any {
  const safeName = String(name || "surface").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "surface";
  return {
    model: BRAIN_V3_MODEL,
    contents,
    config: {
      ...options,
      modelRole: "brain_v3",
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      responseJsonSchemaName: `taki_brain_v3_${safeName}`
    }
  };
}
export const RESEARCH_MODEL = ACTIVE_AI_PROVIDER === "openai"
  ? openAIModelForTaki("taki_2_1_reasoning")
  : currentModel(process.env.GEMINI_RESEARCH_MODEL, "gemini-3.1-pro-preview");
// FAST_MODEL answers easy, static knowledge questions (no routing/extraction —
// that's where flash-lite failed as a planner; as a plain answerer it's fine).
export const FAST_MODEL = ACTIVE_AI_PROVIDER === "openai"
  ? openAIModelForTaki("taki_2_0_swift")
  : currentModel(process.env.GEMINI_FAST_MODEL, "gemini-3.5-flash-lite");

// Timeouts (ms), env-overridable. The planner uses minimal thinking for quick
// routing. Grounded research on the Pro model gets a longer budget.
export const PLANNER_TIMEOUT_MS = Number(process.env.PLANNER_TIMEOUT_MS || 12000);
export const RESEARCH_TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS || 20000);
// Enumerating "the next N games" with grounding is heavier than a single fact
// (a busy schedule can take ~20-25s), so the list pass gets a longer budget.
export const LIST_RESEARCH_TIMEOUT_MS = Number(process.env.LIST_RESEARCH_TIMEOUT_MS || 28000);
export const TIME_ZONE = process.env.ASSISTANT_TIMEZONE || "America/New_York";

/* ---- Teen Mode (ages 13-17) safety -------------------------------------- *
 * Hard Gemini content filters for minors when Gemini is active. Harassment / hate / sexual are
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
