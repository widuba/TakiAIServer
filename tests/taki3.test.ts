import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationState } from "../src/context.js";
import {
  TAKI3_VERSION,
  classifyTaki3Request,
  normalizeTaki3RolloutMode,
  runTaki3Answer,
  shouldShadowTaki3,
  shouldUseTaki3
} from "../src/taki3.js";
import { ServiceError, AI_QUOTA_SPOKEN } from "../src/ai.js";

function state(message: string) {
  return buildConversationState(message, "", undefined, "America/New_York", [], {}, false, "12345678");
}

test("Taki 3.0 is the single public conversational surface", async () => {
  assert.equal(TAKI3_VERSION, "3.0");
  assert.equal(classifyTaki3Request(state("Explain why the sky is blue")).kind, "direct");
  const plan = await runTaki3Answer(state("Explain why the sky is blue"), undefined, {
    generateContent: async () => ({
      text: JSON.stringify({
        answer: "Because air scatters blue light more strongly.",
        confidence: 0.95,
        shouldAskClarification: false,
        clarifyingQuestion: null
      })
    })
  });
  assert.match(plan?.spokenText || "", /scatters blue light/);
});

test("Taki 3.0 owns rollout controls and remains rollback-compatible", () => {
  assert.equal(normalizeTaki3RolloutMode({}), "shadow");
  assert.equal(normalizeTaki3RolloutMode({ TAKI_TAKI3_MODE: "active" }), "disabled");
  assert.equal(shouldUseTaki3({ deviceId: "12345678" }, { TAKI_TAKI3_MODE: "disabled" }), false);
  assert.equal(shouldShadowTaki3({ TAKI_TAKI3_MODE: "shadow", TAKI_TAKI3_SHADOW_PERCENT: "100" }), true);
  assert.equal(normalizeTaki3RolloutMode({ TAKI_OLD_BRAIN_MODE: "active", TAKI_OLD_BRAIN_SHADOW_PERCENT: "100" }), "shadow");
  assert.equal(shouldShadowTaki3({ TAKI_OLD_BRAIN_MODE: "shadow", TAKI_OLD_BRAIN_SHADOW_PERCENT: "100" }), false);
});

test("Taki 3.0 preserves a typed provider outage after one attempt", async () => {
  let calls = 0;
  await assert.rejects(
    () => runTaki3Answer(state("Explain why the sky is blue"), undefined, {
      generateContent: async () => {
        calls += 1;
        throw new ServiceError("ai_quota", AI_QUOTA_SPOKEN, 429);
      }
    }),
    (error: unknown) => error instanceof ServiceError && error.kind === "ai_quota"
  );
  assert.equal(calls, 1);
});
