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
    balance: 4000,
    voiceUsed: 10,
    voiceCycleUsed: 10,
    baseCredits: 4000,
    limitReached: false,
    limitReason: null,
    daily: { used: 0, limit: 5000, resetsAt: 0, percent: 0 },
    monthly: { used: 0, limit: 50_000, resetsAt: 0, percent: 0 },
    ...overrides
  };
}

test("a refused voice turn never consumes an included voice turn", () => {
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
  assert.equal(answered.consumeIncludedVoice, true);
});

test("included voice keeps speech off the bill; paid voice adds STT and TTS", () => {
  const speechIn = sttCostUsd(30_000);
  const speechOut = ttsCostUsd(280);
  const included = decideAssistantCharge({
    summary: account(), tier: "plus_voice", voiceMode: true, includedVoice: true,
    baseUsd: 0.02, voiceInputUsd: speechIn, voiceOutputUsd: speechOut
  });
  assert.equal(included.usageUsd, 0.02);

  const paid = decideAssistantCharge({
    summary: account(), tier: "plus_voice", voiceMode: true, includedVoice: false,
    baseUsd: 0.02, voiceInputUsd: speechIn, voiceOutputUsd: speechOut
  });
  assert.equal(paid.usageUsd, 0.02 + speechIn + speechOut);
  assert.equal(paid.consumeIncludedVoice, false);

  // Free-tier included turns are counted by the lifetime voice counter instead.
  const free = decideAssistantCharge({
    summary: account({ tier: "free", voiceUsed: 1 }), tier: "free", voiceMode: true, includedVoice: true,
    baseUsd: 0.02, voiceInputUsd: speechIn, voiceOutputUsd: speechOut
  });
  assert.equal(free.consumeIncludedVoice, false);
  assert.equal(free.usageUsd, 0.02);
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

test("voice preflight asks for the whole turn, not the one-credit floor", () => {
  const paid = voiceTurnEstimateCredits(false);
  const included = voiceTurnEstimateCredits(true);
  // A paid turn commits to full-length transcription plus a capped spoken reply.
  assert.ok(paid >= Math.ceil((sttCostUsd(60_000) + ttsCostUsd(280)) / 0.001), String(paid));
  assert.ok(paid > included, `${paid} should exceed ${included}`);
  assert.ok(included >= MIN_REQUEST_CREDITS);
  // An included turn only has to cover the planning model.
  assert.ok(included < paid / 2, String(included));
});

test("usage blocks report the reason the app renders", () => {
  assert.equal(usageBlockFor(account({ balance: 0 }), 10, false)?.reason, "credits");
  assert.equal(usageBlockFor(account({ tier: "free", voiceUsed: 5 }), 10, true)?.reason, "voice");
  assert.equal(usageBlockFor(account(), 10, false), null);
});
