import assert from "node:assert/strict";
import test from "node:test";
import { CreditLedgerOverdraftError, InsufficientCreditsError } from "../src/credits.js";
import { suspendOnUnfundedUsageCharge } from "../src/creditEnforcement.js";
import { getSafetyAccount } from "../src/safety.js";
import { usageBlockFor } from "../src/usage.js";

test("preflight exhaustion stays a paywall, but an unfunded completed usage charge suspends", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paywallIdentity = `credit-paywall-${suffix}`;
  const overuseIdentity = `credit-overuse-${suffix}`;

  const paywall = usageBlockFor({ balance: 3, limitReached: false, limitReason: null }, 50);
  assert.equal(paywall?.reason, "credits");
  assert.equal((await getSafetyAccount(paywallIdentity)).status, "active");

  assert.equal(
    await suspendOnUnfundedUsageCharge(overuseIdentity, new InsufficientCreditsError("ai", 50, 3)),
    true
  );
  const account = await getSafetyAccount(overuseIdentity);
  assert.equal(account.status, "suspended");
  assert.equal(account.suspensionKind, "credit_integrity");
  assert.equal(account.violations.at(-1)?.category, "credit_overdraft");

  const ledgerIdentity = `credit-ledger-${suffix}`;
  assert.equal(
    await suspendOnUnfundedUsageCharge(ledgerIdentity, new CreditLedgerOverdraftError(2)),
    true
  );
  assert.equal((await getSafetyAccount(ledgerIdentity)).suspensionKind, "credit_integrity");
});
