import assert from "node:assert/strict";
import test from "node:test";
import { getTransactionBinding, linkTransactionIdentity, setTransactionRole, transactionIdsForIdentity } from "../src/iap.js";
import { storeDelete } from "../src/store.js";

test("a subscription receipt cannot be rebound by a different signed-out identity", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const transactionId = `tx-${suffix}`;
  const firstIdentity = `device-${suffix}`;
  const otherIdentity = `other-${suffix}`;
  const appleIdentity = `apple:${suffix}`;
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    assert.equal(await linkTransactionIdentity(transactionId, firstIdentity), "claimed");
    assert.equal(await linkTransactionIdentity(transactionId, otherIdentity), "conflict");
    assert.equal((await getTransactionBinding(transactionId)).identity, firstIdentity);

    await setTransactionRole(transactionId, appleIdentity, "primary");
    assert.equal((await getTransactionBinding(transactionId)).identity, appleIdentity);
    assert.deepEqual(await transactionIdsForIdentity(firstIdentity), []);
    assert.deepEqual(await transactionIdsForIdentity(appleIdentity), [transactionId]);
  } finally {
    await Promise.all([
      storeDelete(`iapmap:${transactionId}`),
      storeDelete(`iapidentity:${safe(firstIdentity)}`),
      storeDelete(`iapidentity:${safe(otherIdentity)}`),
      storeDelete(`iapidentity:${safe(appleIdentity)}`)
    ]);
  }
});
