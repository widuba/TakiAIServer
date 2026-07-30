import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAssistantCharge,
  planCorrectionSynthesis,
  usageBlockFor,
  voiceTurnEstimateCredits,
  DAILY_LIMIT_MSG,
  OUT_OF_CREDITS_MSG
} from "../src/usage.js";
import { MIN_REQUEST_CREDITS } from "../src/credits.js";
import { sttCostUsd, ttsCostUsd } from "../src/metering.js";

function account(overrides: Record<string, any> = {}) {
  return {
    tier: "plus_voice",
    balance: 6000,
    voiceCredits: 300,
    baseCredits: 6000,
    limitReached: false,
    limitReason: null,
    daily: { used: 0, limit: 5000, resetsAt: 0, percent: 0 },
    monthly: { used: 0, limit: 50_000, resetsAt: 0, percent: 0 },
    ...overrides
  };
}

test("a refused voice request never consumes a Voice Credit", () => {
  const overDaily = account({ daily: { used: 4999, limit: 5000, resetsAt: 0, percent: 99 } });
  const refused = decideAssistantCharge({
    summary: overDaily,
    tier: "plus_voice",
    voiceMode: true,
    includedVoice: true,
    baseUsd: 0.02,
    voiceInputUsd: sttCostUsd(30_000),
    voiceOutputUsd: ttsCostUsd(280)
  });
  assert.equal(refused.block?.reason, "daily");
  assert.equal(refused.consumeIncludedVoice, false);

  const answered = decideAssistantCharge({
    summary: account(),
    tier: "plus_voice",
    voiceMode: true,
    includedVoice: true,
    baseUsd: 0.02,
    voiceInputUsd: sttCostUsd(30_000),
    voiceOutputUsd: ttsCostUsd(280)
  });
  assert.equal(answered.block, null);
  assert.equal(answered.consumeIncludedVoice, false);
  assert.equal(answered.includedVoice, true);
});

test("voice always uses normal AI usage; no Voice Credit adds exactly 40 AI Credits", () => {
  const speechIn = sttCostUsd(30_000);
  const speechOut = ttsCostUsd(280);
  const included = decideAssistantCharge({
    summary: account(), tier: "plus_voice", voiceMode: true, includedVoice: true,
    baseUsd: 0.02, voiceInputUsd: speechIn, voiceOutputUsd: speechOut
  });
  assert.equal(included.usageUsd, 0.02);

  const paid = decideAssistantCharge({
    summary: account({ voiceCredits: 0 }), tier: "plus_voice", voiceMode: true, includedVoice: false,
    baseUsd: 0.02, voiceInputUsd: speechIn, voiceOutputUsd: speechOut
  });
  assert.equal(paid.usageUsd, 0.02);
  assert.equal(paid.requiredCredits, included.requiredCredits + 40);
  assert.equal(paid.consumeIncludedVoice, false);

});

test("correction synthesis is included only with a valid deferral token", () => {
  const chars = 280;
  const cost = Math.ceil(ttsCostUsd(chars) / 0.001);

  const withToken = planCorrectionSynthesis({ included: true }, account(), chars);
  assert.deepEqual(withToken, { allowed: true, included: true, costCredits: 0, message: "" });

  // Missing or expired token: never free, and it must still be affordable.
  const noToken = planCorrectionSynthesis(null, account(), chars);
  assert.equal(noToken.allowed, true);
  assert.equal(noToken.included, false);
  assert.equal(noToken.costCredits, cost);

  const brokeAccount = planCorrectionSynthesis(null, account({ balance: cost - 1 }), chars);
  assert.equal(brokeAccount.allowed, false);
  assert.equal(brokeAccount.included, false);
  assert.equal(brokeAccount.message, OUT_OF_CREDITS_MSG);

  // An account with plenty of credits can still be over its daily window.
  const cappedAccount = planCorrectionSynthesis(
    null,
    account({ daily: { used: 5000, limit: 5000, resetsAt: 0, percent: 100 } }),
    chars
  );
  assert.equal(cappedAccount.allowed, false);
  assert.equal(cappedAccount.message, DAILY_LIMIT_MSG);

  // A token issued for a PAID turn does not grant included speech either.
  const paidToken = planCorrectionSynthesis({ included: false }, account({ balance: 0 }), chars);
  assert.equal(paidToken.allowed, false);
});

test("voice preflight differs by exactly the 40-AI-Credit fallback", () => {
  const paid = voiceTurnEstimateCredits(false);
  const included = voiceTurnEstimateCredits(true);
  assert.equal(paid - included, 40);
  assert.ok(included >= MIN_REQUEST_CREDITS);
});

test("usage blocks report the reason the app renders", () => {
  assert.equal(usageBlockFor(account({ balance: 0 }), 10)?.reason, "credits");
  assert.equal(usageBlockFor(account({ tier: "free", voiceCredits: 0 }), 10), null);
  assert.equal(usageBlockFor(account(), 10), null);
});
