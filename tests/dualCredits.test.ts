import assert from "node:assert/strict";
import test from "node:test";
import {
  InsufficientCreditsError,
  TIERS,
  VOICE_SURCHARGE_CREDITS,
  chargeRequestCredits,
  downgradeToFree,
  grantForTransaction,
  quoteCreditCharge,
  revokeSubscription,
  summary,
  updateSubscriptionStatus,
  type CreditAccount,
  type Tier
} from "../src/credits.js";
import { storeDelete, storeGet, storeSet } from "../src/store.js";

const created = new Set<string>();
const keyFor = (identity: string) => `credits:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const identity = (name: string) => {
  const id = `dual-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  created.add(id);
  return id;
};

async function seed(id: string, aiCredits: number, voiceCredits: number, tier: Tier = "plus_voice", extraGrants: CreditAccount["grants"] = []) {
  const now = Date.now();
  const account: CreditAccount = {
    schemaVersion: 2,
    deviceId: id,
    tier,
    grants: [
      ...(aiCredits > 0 ? [{ id: "subscription", amount: aiCredits, remaining: aiCredits, grantedAt: now, expiresAt: now + 90 * 86_400_000, source: `subscription:${tier}` }] : []),
      ...extraGrants
    ],
    voiceCredits,
    subscriptionStatus: tier === "free" ? "none" : "active",
    starterGiven: true,
    updatedAt: now
  };
  await storeSet(keyFor(id), account);
}

test.after(async () => {
  await Promise.all([...created].map((id) => storeDelete(keyFor(id))));
});

test("1. text request deducts only its normal AI Credits", async () => {
  const id = identity("text");
  await seed(id, 100, 5);
  const charged = await chargeRequestCredits({ identity: id, requestId: "text-1", mode: "text", normalAiCredits: 7 });
  assert.equal(charged.spent, 7);
  assert.equal(charged.balance, 93);
  assert.equal(charged.voiceCredits, 5);
});

test("2. insufficient text balance rejects atomically without a partial deduction", async () => {
  const id = identity("text-insufficient");
  await seed(id, 3, 2);
  await assert.rejects(
    chargeRequestCredits({ identity: id, requestId: "text-too-large", mode: "text", normalAiCredits: 4 }),
    InsufficientCreditsError
  );
  const after = await summary(id);
  assert.equal(after.balance, 3);
  assert.equal(after.voiceCredits, 2);
});

test("3. voice with a Voice Credit deducts normal AI Credits plus one Voice Credit", async () => {
  const id = identity("voice-credit");
  await seed(id, 100, 2);
  const charged = await chargeRequestCredits({ identity: id, requestId: "voice-1", mode: "voice", normalAiCredits: 9 });
  assert.equal(charged.spent, 9);
  assert.equal(charged.voiceCreditsCharged, 1);
  assert.equal(charged.voiceSurchargeCredits, 0);
  assert.equal(charged.balance, 91);
  assert.equal(charged.voiceCredits, 1);
});

test("4. voice without a Voice Credit adds exactly 40 AI Credits", async () => {
  const id = identity("voice-surcharge");
  await seed(id, 100, 0);
  const charged = await chargeRequestCredits({ identity: id, requestId: "voice-2", mode: "voice", normalAiCredits: 9 });
  assert.equal(VOICE_SURCHARGE_CREDITS, 40);
  assert.equal(charged.spent, 49);
  assert.equal(charged.voiceCreditsCharged, 0);
  assert.equal(charged.balance, 51);
});

test("5. an unaffordable voice surcharge rejects the entire charge", async () => {
  const id = identity("voice-insufficient");
  await seed(id, 48, 0);
  await assert.rejects(
    chargeRequestCredits({ identity: id, requestId: "voice-3", mode: "voice", normalAiCredits: 9 }),
    (error: unknown) => error instanceof InsufficientCreditsError && error.required === 49 && error.available === 48
  );
  assert.equal((await summary(id)).balance, 48);
});

test("6. the final Voice Credit is usable and the following request uses the fallback", async () => {
  const id = identity("final-voice");
  await seed(id, 100, 1);
  const first = await chargeRequestCredits({ identity: id, requestId: "voice-final", mode: "voice", normalAiCredits: 5 });
  const second = await chargeRequestCredits({ identity: id, requestId: "voice-after", mode: "voice", normalAiCredits: 5 });
  assert.equal(first.voiceCredits, 0);
  assert.equal(first.spent, 5);
  assert.equal(second.spent, 45);
  assert.equal(second.balance, 50);
});

test("7. simultaneous requests cannot overspend or consume one Voice Credit twice", async () => {
  const id = identity("concurrent");
  await seed(id, 10, 1);
  const results = await Promise.allSettled([
    chargeRequestCredits({ identity: id, requestId: "concurrent-a", mode: "voice", normalAiCredits: 1 }),
    chargeRequestCredits({ identity: id, requestId: "concurrent-b", mode: "voice", normalAiCredits: 1 })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const after = await summary(id);
  assert.equal(after.balance, 9);
  assert.equal(after.voiceCredits, 0);
});

test("8. all plans grant the exact advertised monthly balances", async () => {
  for (const tier of ["plus", "plus_voice", "pro"] as const) {
    const id = identity(`plan-${tier}`);
    await seed(id, 0, 0, "free");
    const grant = await grantForTransaction(id, tier, `new-${tier}`);
    assert.equal(grant.summary.balance, TIERS[tier].creditsPerCycle);
    assert.equal(grant.summary.voiceCredits, TIERS[tier].voiceCreditsPerCycle);
  }
});

test("9. renewal grants AI Credits under the existing rollover policy and resets Voice Credits", async () => {
  const id = identity("renewal");
  await seed(id, 100, 2);
  const renewed = await grantForTransaction(id, "plus_voice", "period-2", { periodStart: 2_000, periodEnd: 3_000, reason: "renewal" });
  assert.equal(renewed.summary.balance, 6_100);
  assert.equal(renewed.summary.voiceCredits, 300);
});

test("10. duplicate renewal and restore events are idempotent", async () => {
  const id = identity("duplicate");
  await seed(id, 0, 0, "free");
  const first = await grantForTransaction(id, "plus", "same-period", { transactionId: "tx-1", periodEnd: 3_000 });
  const duplicate = await grantForTransaction(id, "plus", "same-period", { transactionId: "tx-1", periodEnd: 3_000, reason: "restore" });
  assert.equal(first.granted, true);
  assert.equal(duplicate.granted, false);
  assert.equal(duplicate.summary.balance, 4_000);
  const raw = await storeGet<CreditAccount | null>(keyFor(id), null);
  assert.equal(raw?.grantLedger?.filter((entry) => entry.idempotencyKey === "same-period").length, 1);
});

test("11. upgrades and effective downgrades apply the new plan's full Voice Credit allowance", async () => {
  const id = identity("plan-change");
  await seed(id, 0, 0, "free");
  const plus = await grantForTransaction(id, "plus", "period-plus", { periodEnd: 2_000 });
  const upgraded = await grantForTransaction(id, "pro", "period-pro", { periodEnd: 3_000 });
  const downgraded = await grantForTransaction(id, "plus_voice", "period-premium", { periodEnd: 4_000 });
  assert.equal(plus.summary.voiceCredits, 50);
  assert.equal(upgraded.summary.tier, "pro");
  assert.equal(upgraded.summary.voiceCredits, 600);
  assert.equal(downgraded.summary.tier, "plus_voice");
  assert.equal(downgraded.summary.voiceCredits, 300);
});

test("a mid-cycle StoreKit upgrade never duplicates the period's AI grant", async () => {
  const id = identity("mid-cycle-upgrade");
  await seed(id, 0, 0, "free");
  await grantForTransaction(id, "plus", "shared-period", { periodStart: 1_000, periodEnd: 2_000 });
  const upgraded = await grantForTransaction(id, "pro", "shared-period", { periodStart: 1_000, periodEnd: 2_000 });
  assert.equal(upgraded.granted, false);
  assert.equal(upgraded.summary.tier, "pro");
  assert.equal(upgraded.summary.balance, 4_000);
  assert.equal(upgraded.summary.voiceCredits, 600);
});

test("12. cancellation keeps paid access and balances through the period end", async () => {
  const id = identity("cancel");
  await seed(id, 400, 40, "plus");
  const cancelled = await updateSubscriptionStatus(id, "cancelled", { periodEnd: Date.now() + 86_400_000 });
  assert.equal(cancelled.tier, "plus");
  assert.equal(cancelled.subscriptionStatus, "cancelled");
  assert.equal(cancelled.balance, 400);
  assert.equal(cancelled.voiceCredits, 40);
});

test("13. billing retry and grace preserve the entitlement", async () => {
  const id = identity("grace");
  await seed(id, 400, 40, "plus");
  assert.equal((await updateSubscriptionStatus(id, "billing_retry")).tier, "plus");
  const grace = await updateSubscriptionStatus(id, "grace");
  assert.equal(grace.tier, "plus");
  assert.equal(grace.subscriptionStatus, "grace");
});

test("14. expiration removes the entitlement and Voice Credits but preserves paid AI grants", async () => {
  const id = identity("expire");
  await seed(id, 400, 40, "plus");
  await downgradeToFree(id);
  const expired = await summary(id);
  assert.equal(expired.tier, "free");
  assert.equal(expired.subscriptionStatus, "expired");
  assert.equal(expired.voiceCredits, 0);
  assert.equal(expired.balance, 650);
});

test("15. refund claws back subscription AI Credits but preserves purchased top-ups", async () => {
  const id = identity("refund");
  const now = Date.now();
  await seed(id, 400, 40, "plus", [{ id: "topup", amount: 25, remaining: 25, grantedAt: now, expiresAt: now + 90 * 86_400_000, source: "web_topup" }]);
  await revokeSubscription(id);
  const revoked = await summary(id);
  assert.equal(revoked.tier, "free");
  assert.equal(revoked.subscriptionStatus, "revoked");
  assert.equal(revoked.voiceCredits, 0);
  assert.equal(revoked.balance, 275);
});

test("16. legacy Plus Voice accounts migrate to Premium without losing AI Credits or top-ups", async () => {
  const id = identity("legacy");
  const now = Date.now();
  await storeSet(keyFor(id), {
    deviceId: id,
    tier: "plus_voice",
    grants: [
      { id: "legacy-plan", amount: 1_200, remaining: 1_000, grantedAt: now, expiresAt: now + 86_400_000, source: "subscription:plus_voice" },
      { id: "legacy-topup", amount: 250, remaining: 250, grantedAt: now, expiresAt: now + 86_400_000, source: "web_topup" }
    ],
    voiceCycleCount: 7,
    starterGiven: true,
    updatedAt: now
  });
  const migrated = await summary(id);
  assert.equal(migrated.tier, "plus_voice");
  assert.equal(migrated.balance, 1_250);
  assert.equal(migrated.voiceCredits, 293);
  assert.equal(migrated.subscriptionStatus, "active");
});

test("17. stale out-of-order lifecycle notifications cannot overwrite a newer period", async () => {
  const id = identity("out-of-order");
  await seed(id, 0, 0, "free");
  await grantForTransaction(id, "pro", "new-period", { periodStart: 2_000, periodEnd: 3_000 });
  await downgradeToFree(id, { periodEnd: 1_500 });
  const current = await updateSubscriptionStatus(id, "expired", { periodEnd: 1_500 });
  assert.equal(current.tier, "pro");
  assert.equal(current.subscriptionStatus, "active");
  assert.equal(current.billingPeriodEnd, 3_000);
});

test("charge quotes are pure, complete, and never negative", () => {
  assert.deepEqual(quoteCreditCharge(7.1, "text", 0), { normalAiCredits: 8, voiceSurchargeCredits: 0, voiceCreditsCharged: 0, totalAiCredits: 8 });
  assert.deepEqual(quoteCreditCharge(7, "voice", 1), { normalAiCredits: 7, voiceSurchargeCredits: 0, voiceCreditsCharged: 1, totalAiCredits: 7 });
  assert.deepEqual(quoteCreditCharge(-1, "voice", 0), { normalAiCredits: 0, voiceSurchargeCredits: 40, voiceCreditsCharged: 0, totalAiCredits: 40 });
});
