import assert from "node:assert/strict";
import test from "node:test";
import { classifyGeminiError, ServiceError, AI_UNAVAILABLE_SPOKEN } from "../src/ai.js";

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
  assert.equal(classifyGeminiError({ status: 503, message: "model is overloaded" })?.kind, "ai_unavailable");
  assert.equal(classifyGeminiError({ status: 500, message: "internal error" })?.kind, "ai_unavailable");

  // Not a vendor outage — these are retryable/normal and must return null so the
  // existing fallback logic still runs.
  assert.equal(classifyGeminiError(new Error("General answer timed out")), null);
  assert.equal(classifyGeminiError(new Error("empty")), null);
  assert.equal(classifyGeminiError({ status: 400, message: "bad request" }), null);
});

test("an existing ServiceError passes through unchanged", () => {
  const original = new ServiceError("voice_unavailable", "nope", 502);
  assert.equal(classifyGeminiError(original), original);
});
