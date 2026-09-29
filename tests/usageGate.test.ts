import assert from "node:assert/strict";
import test from "node:test";
import {
  decideAssistantCharge,
  planCorrectionSynthesis,
  usageBlockFor,
  voiceTurnEstimateCredits,
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

test("daily usage never blocks a request; monthly affordability still does", () => {
  const pastOldDailyCap = account({ daily: { used: 50_000, limit: 5000, resetsAt: 0, percent: 100 } });
  const allowed = decideAssistantCharge({
    summary: pastOldDailyCap,
    tier: "plus_voice",
    voiceMode: true,
    includedVoice: true,
    baseUsd: 0.02,
    voiceInputUsd: sttCostUsd(30_000),
    voiceOutputUsd: ttsCostUsd(280)
  });
  assert.equal(allowed.block, null);
  assert.equal(allowed.consumeIncludedVoice, false);

  const overMonthly = decideAssistantCharge({
    summary: account({ monthly: { used: 49_999, limit: 50_000, resetsAt: 0, percent: 100 } }),
    tier: "plus_voice",
    voiceMode: true,
    includedVoice: true,
    baseUsd: 0.02,
    voiceInputUsd: sttCostUsd(30_000),
    voiceOutputUsd: ttsCostUsd(280)
  });
  assert.equal(overMonthly.block?.reason, "monthly");
  assert.equal(overMonthly.consumeIncludedVoice, false);
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

  // An account with plenty of credits can still be over its monthly allowance.
  const cappedAccount = planCorrectionSynthesis(
    null,
    account({ monthly: { used: 50_000, limit: 50_000, resetsAt: 0, percent: 100 } }),
    chars
  );
  assert.equal(cappedAccount.allowed, false);
  assert.match(cappedAccount.message, /this month's usage limit/i);

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
