import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGeminiError,
  ServiceError,
  AI_AUTH_SPOKEN,
  AI_QUOTA_SPOKEN,
  AI_TIMEOUT_SPOKEN,
  AI_UNAVAILABLE_SPOKEN,
  ProviderCircuitBreaker,
  fallbackModelCandidates,
  providerCandidates,
  normalizeTakiModel,
  takiModelInfo,
  withTakiModel,
  activeTakiModelInfo,
  modelForRequest,
  PLANNER_MODEL,
  openAIModelForTaki
} from "../src/ai.js";

test("quota / billing errors classify as a fast ai_quota ServiceError", () => {
  const depleted = classifyGeminiError({ status: 429, message: "Your prepayment credits are depleted." });
  assert.ok(depleted instanceof ServiceError);
  assert.equal(depleted?.kind, "ai_quota");
  assert.equal(depleted?.spoken, AI_QUOTA_SPOKEN);

  // Same when the status only shows up in the message text.
  assert.equal(classifyGeminiError({ message: "429 RESOURCE_EXHAUSTED" })?.kind, "ai_quota");
  assert.equal(classifyGeminiError({ message: "rate limit exceeded" })?.kind, "ai_quota");
});

test("auth and outage errors classify; ordinary failures do not", () => {
  const auth = classifyGeminiError({ status: 403, message: "API key invalid" });
  assert.equal(auth?.kind, "ai_auth");
  assert.equal(auth?.spoken, AI_AUTH_SPOKEN);
  const timeout = classifyGeminiError({ status: 408, message: "provider attempt timed out" });
  assert.equal(timeout?.kind, "ai_timeout");
  assert.equal(timeout?.spoken, AI_TIMEOUT_SPOKEN);
  assert.equal(classifyGeminiError({ status: 503, message: "model is overloaded" })?.kind, "ai_unavailable");
  assert.equal(classifyGeminiError({ status: 503, message: "model is overloaded" })?.spoken, AI_UNAVAILABLE_SPOKEN);
  assert.equal(classifyGeminiError({ status: 500, message: "internal error" })?.kind, "ai_unavailable");

  // Not a vendor outage — these are retryable/normal and must return null so the
  // existing fallback logic still runs.
  assert.equal(classifyGeminiError(new Error("General answer timed out")), null);
  assert.equal(classifyGeminiError(new Error("empty")), null);
  assert.equal(classifyGeminiError({ status: 400, message: "bad request" }), null);
  assert.equal(classifyGeminiError(new Error("That information is unavailable to this assistant")), null);
  assert.equal(classifyGeminiError(new Error("Calendar data unavailable")), null);
});

test("a degraded model moves behind a healthy fallback during a bounded cooldown", () => {
  const circuit = new ProviderCircuitBreaker();
  const primary = { provider: "openai" as const, model: "gpt-5.4-mini" };
  const fallback = { provider: "openai" as const, model: "gpt-5.4-nano" };
  const start = 1_000_000;

  circuit.recordFailure(primary, new ServiceError("ai_timeout", AI_TIMEOUT_SPOKEN, 408), start);
  assert.deepEqual(circuit.order([primary, fallback], start + 1), [fallback, primary]);
  // A successful recovery immediately restores the configured preference.
  circuit.recordSuccess(primary);
  assert.deepEqual(circuit.order([primary, fallback], start + 2), [primary, fallback]);

  circuit.recordFailure(primary, new ServiceError("ai_quota", AI_QUOTA_SPOKEN, 429), start);
  assert.deepEqual(circuit.order([primary, fallback], start + 29_999), [fallback, primary]);
  assert.deepEqual(circuit.order([primary, fallback], start + 30_001), [primary, fallback]);
});

test("an existing ServiceError passes through unchanged", () => {
  const original = new ServiceError("voice_unavailable", "nope", 502);
  assert.equal(classifyGeminiError(original), original);
});

test("Taki model selection is validated, scoped, and has a bounded fallback", async () => {
  assert.equal(normalizeTakiModel(undefined), "taki_2_1");
  assert.equal(normalizeTakiModel("made-up-model"), "taki_2_1");
  assert.equal(takiModelInfo("taki_2_0_swift").name, "Dromos");
  assert.deepEqual(fallbackModelCandidates("gemini-3.6-flash"), ["gemini-3.6-flash", "gemini-3.5-flash"]);
  assert.deepEqual(fallbackModelCandidates("gemini-3.1-pro-preview"), ["gemini-3.1-pro-preview", "gemini-3.6-flash"]);
  assert.deepEqual(providerCandidates("gemini-3.1-pro-preview", { config: { modelRole: "brain_v3" } }), [
    { provider: "gemini", model: "gemini-3.1-pro-preview" }
  ]);
  await withTakiModel("taki_2_1_reasoning", async () => {
    assert.equal(activeTakiModelInfo().name, "Sophos");
  });
  await withTakiModel("taki_2_0_swift", async () => {
    assert.equal(modelForRequest({ model: "ignored", config: {} }), "gemini-3.5-flash-lite");
    assert.equal(modelForRequest({ model: "ignored", config: { responseMimeType: "application/json" } }), PLANNER_MODEL);
  });
  await withTakiModel("taki_2_1", async () => {
    assert.equal(modelForRequest({ model: "ignored", config: { responseMimeType: "application/json" } }), PLANNER_MODEL);
  });
  assert.equal(activeTakiModelInfo().name, "Metron");
});

test("OpenAI answer models follow the selected Taki speed-to-intelligence tier", () => {
  const defaults = {};
  assert.equal(openAIModelForTaki("taki_2_0_swift", defaults), "gpt-5.4-mini");
  assert.equal(openAIModelForTaki("taki_2_1", defaults), "gpt-5.5");
  assert.equal(openAIModelForTaki("taki_2_1_reasoning", defaults), "gpt-5.6-luna");

  // Tier-specific overrides take precedence, while legacy role names remain
  // supported for existing Render deployments.
  const configured = {
    OPENAI_TAKI_FAST_MODEL: "gpt-5.4-mini",
    OPENAI_TAKI_BALANCED_MODEL: "gpt-5.5",
    OPENAI_TAKI_SMART_MODEL: "gpt-5.6-luna",
    OPENAI_FAST_MODEL: "gpt-5.4-nano",
    OPENAI_MODEL: "gpt-5.4-mini",
    OPENAI_SMART_MODEL: "gpt-5.4-mini"
  };
  assert.equal(openAIModelForTaki("taki_2_0_swift", configured), "gpt-5.4-mini");
  assert.equal(openAIModelForTaki("taki_2_1", configured), "gpt-5.5");
  assert.equal(openAIModelForTaki("taki_2_1_reasoning", configured), "gpt-5.6-luna");

  const legacy = {
    OPENAI_FAST_MODEL: "gpt-5.4-nano",
    OPENAI_MODEL: "gpt-5.4-mini",
    OPENAI_SMART_MODEL: "gpt-5.4-mini"
  };
  assert.equal(openAIModelForTaki("taki_2_0_swift", legacy), "gpt-5.4-nano");
  assert.equal(openAIModelForTaki("taki_2_1", legacy), "gpt-5.4-mini");
  assert.equal(openAIModelForTaki("taki_2_1_reasoning", legacy), "gpt-5.4-mini");
});
