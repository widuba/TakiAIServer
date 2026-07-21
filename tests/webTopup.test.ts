import assert from "node:assert/strict";
import test from "node:test";
import { grantWebTopup } from "../src/credits.js";
import { storeDelete } from "../src/store.js";

test("a retried Stripe checkout session grants web credits only once", async () => {
  const identity = `web-topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const first = await grantWebTopup(identity, 500, "cs_test_same_session");
    const retry = await grantWebTopup(identity, 500, "cs_test_same_session");
    assert.equal(first.granted, true);
    assert.equal(retry.granted, false);
    assert.equal(retry.summary.balance, 500);
    assert.equal(retry.summary.purchasedExpiring.length, 1);
  } finally {
    await storeDelete(`credits:${identity}`);
  }
});
