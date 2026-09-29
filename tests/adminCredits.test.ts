import assert from "node:assert/strict";
import test from "node:test";
import {
  adminCreditAdjustments,
  grantAdminCredits,
  removeAdminCredits,
  MAX_ADMIN_CREDIT_GRANT,
  summary
} from "../src/credits.js";
import { storeDelete } from "../src/store.js";

test("admin credit grants update the balance without changing the tier and keep an audit trail", async () => {
  const identity = `admin-credit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await summary(identity);
    const result = await grantAdminCredits(identity, 1_250, "  Goodwill   correction\n");

    assert.equal(result.granted, true);
    assert.equal(result.identity, identity);
    assert.equal(result.amount, 1_250);
    assert.equal(result.reason, "Goodwill correction");
    assert.equal(result.summary.tier, "free");
    assert.equal(result.summary.balance, 1_750);
    assert.equal(result.summary.additionalCredits, 1_250);
    assert.equal(result.summary.purchasedExpiring.length, 1);

    const history = await adminCreditAdjustments(identity);
    assert.equal(history.length, 1);
    assert.equal(history[0].amount, 1_250);
    assert.equal(history[0].kind, "grant");
    assert.equal(history[0].reason, "Goodwill correction");
    assert.equal(history[0].balanceAfter, 1_750);
    assert.equal(history[0].expiresAt, result.expiresAt);
  } finally {
    await storeDelete(`credits:${identity}`);
  }
});

test("admin credit removal reduces the exact balance and gifted monthly allowance with an audit entry", async () => {
  const identity = `admin-credit-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await summary(identity);
    await grantAdminCredits(identity, 1_250, "support correction");
    const result = await removeAdminCredits(identity, 900, "  Duplicate   grant\n");

    assert.equal(result.removed, true);
    assert.equal(result.identity, identity);
    assert.equal(result.amount, 900);
    assert.equal(result.reason, "Duplicate grant");
    assert.equal(result.summary.tier, "free");
    assert.equal(result.summary.balance, 850);
    assert.equal(result.balanceAfter, 850);
    assert.equal(result.summary.additionalCredits, 850);

    const history = await adminCreditAdjustments(identity);
    const removal = history.find((entry) => entry.kind === "remove");
    assert.ok(removal);
    assert.equal(removal.amount, 900);
    assert.equal(removal.reason, "Duplicate grant");
    assert.equal(removal.balanceAfter, 850);
    assert.equal(removal.expiresAt, 0);
  } finally {
    await storeDelete(`credits:${identity}`);
  }
});

test("admin credit removal rejects invalid and unaffordable amounts atomically", async () => {
  const identity = `admin-credit-remove-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const before = await summary(identity);
    await assert.rejects(() => removeAdminCredits(identity, 0), /whole number/);
    await assert.rejects(() => removeAdminCredits(identity, before.balance + 1), /current balance/);
    assert.equal((await summary(identity)).balance, before.balance);
  } finally {
    await storeDelete(`credits:${identity}`);
  }
});

test("admin credit grants reject non-whole, non-positive, and oversized amounts", async () => {
  const identity = `admin-credit-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await assert.rejects(() => grantAdminCredits(identity, 1.5), /whole number/);
    await assert.rejects(() => grantAdminCredits(identity, 0), /whole number/);
    await assert.rejects(() => grantAdminCredits(identity, MAX_ADMIN_CREDIT_GRANT + 1), /whole number/);
  } finally {
    await storeDelete(`credits:${identity}`);
  }
});
