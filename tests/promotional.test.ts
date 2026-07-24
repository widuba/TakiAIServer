import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { enrollApplePromotionalSubscriber, promotionalSummary } from "../src/promotional.js";
import { storeDelete, storeSet } from "../src/store.js";

const email = "apple-member@example.com";
const subscriberId = createHash("sha256").update(email).digest("hex");

test("Apple email enrollment is automatic but never reverses an unsubscribe", async (t) => {
  t.after(async () => {
    await storeDelete("marketing:subscribers");
    await storeDelete(`marketing:subscriber:${subscriberId}`);
  });

  const first = await enrollApplePromotionalSubscriber({
    email,
    appleSub: "apple-sub-1",
    identity: "apple:apple-sub-1"
  });
  assert.equal(first?.status, "subscribed");
  assert.equal((await promotionalSummary()).subscribed, 1);

  await storeSet(`marketing:subscriber:${subscriberId}`, {
    ...first!, status: "unsubscribed", unsubscribedAt: Date.now(), updatedAt: Date.now()
  });
  const repeatedSignIn = await enrollApplePromotionalSubscriber({
    email,
    appleSub: "apple-sub-1",
    identity: "apple:apple-sub-1"
  });
  assert.equal(repeatedSignIn?.status, "unsubscribed");
  assert.equal((await promotionalSummary()).unsubscribed, 1);
});
