import assert from "node:assert/strict";
import test from "node:test";
import { classifyGeminiError, ServiceError, AI_UNAVAILABLE_SPOKEN, fallbackModelCandidates, normalizeTakiModel, takiModelInfo, withTakiModel, activeTakiModelInfo, modelForRequest, PLANNER_MODEL } from "../src/ai.js";

test("quota / billing errors classify as a fast ai_quota ServiceError", () => {
  const depleted = classifyGeminiError({ status: 429, message: "Your prepayment credits are depleted." });
  assert.ok(depleted instanceof ServiceError);
  assert.equal(depleted?.kind, "ai_quota");
  assert.equal(depleted?.spoken, AI_UNAVAILABLE_SPOKEN);

  // Same when the status only shows up in the message text.
  assert.equal(classifyGeminiError({ message: "429 RESOURCE_EXHAUSTED" })?.kind, "ai_quota");
  assert.equal(classifyGeminiError({ message: "rate limit exceeded" })?.kind, "ai_quota");
});

test("auth and outage errors classify; ordinary failures do not", () => {
  assert.equal(classifyGeminiError({ status: 403, message: "API key invalid" })?.kind, "ai_auth");
  assert.equal(classifyGeminiError({ status: 408, message: "provider attempt timed out" })?.kind, "ai_unavailable");
  assert.equal(classifyGeminiError({ status: 503, message: "model is overloaded" })?.kind, "ai_unavailable");
  assert.equal(classifyGeminiError({ status: 500, message: "internal error" })?.kind, "ai_unavailable");

  // Not a vendor outage — these are retryable/normal and must return null so the
  // existing fallback logic still runs.
  assert.equal(classifyGeminiError(new Error("General answer timed out")), null);
  assert.equal(classifyGeminiError(new Error("empty")), null);
  assert.equal(classifyGeminiError({ status: 400, message: "bad request" }), null);
  assert.equal(classifyGeminiError(new Error("That information is unavailable to this assistant")), null);
  assert.equal(classifyGeminiError(new Error("Calendar data unavailable")), null);
});

test("an existing ServiceError passes through unchanged", () => {
  const original = new ServiceError("voice_unavailable", "nope", 502);
  assert.equal(classifyGeminiError(original), original);
});

test("Taki model selection is validated, scoped, and has a bounded fallback", async () => {
  assert.equal(normalizeTakiModel(undefined), "taki_2_1");
  assert.equal(normalizeTakiModel("made-up-model"), "taki_2_1");
  assert.equal(takiModelInfo("taki_2_0_swift").name, "Taki 2.0 Swift");
  assert.deepEqual(fallbackModelCandidates("gemini-3.6-flash"), ["gemini-3.6-flash", "gemini-3.5-flash"]);
  assert.deepEqual(fallbackModelCandidates("gemini-3.1-pro-preview"), ["gemini-3.1-pro-preview", "gemini-3.6-flash"]);
  await withTakiModel("taki_2_1_reasoning", async () => {
    assert.equal(activeTakiModelInfo().name, "Taki 2.1 Reasoning");
  });
  await withTakiModel("taki_2_0_swift", async () => {
    assert.equal(modelForRequest({ model: "ignored", config: {} }), "gemini-3.5-flash-lite");
    assert.equal(modelForRequest({ model: "ignored", config: { responseMimeType: "application/json" } }), "gemini-3.5-flash-lite");
  });
  await withTakiModel("taki_2_1", async () => {
    assert.equal(modelForRequest({ model: "ignored", config: { responseMimeType: "application/json" } }), PLANNER_MODEL);
  });
  assert.equal(activeTakiModelInfo().name, "Taki 2.1");
});
