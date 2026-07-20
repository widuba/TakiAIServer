import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFullReset } from "../src/fullReset.js";
import { storeCategory, type StoreEntry } from "../src/store.js";

test("full reset preview counts every account data family without exposing identities", () => {
  const entries: StoreEntry[] = [
    { key: "users:index", value: { ids: ["apple:test", "12345678"] }, updatedAt: "2026-07-19T00:00:00.000Z" },
    { key: "user:apple:test", value: { identity: "apple:test" } },
    { key: "user:12345678", value: { identity: "12345678" } },
    { key: "credits:apple_test", value: { tier: "plus" } },
    { key: "stripe:subscription:sub_test", value: { id: "sub_test", active: true } },
    { key: "iapmap:original_test", value: { identity: "apple:test" } },
    { key: "safety:acct:apple:test", value: { status: "active" } },
    { key: "email:conn:apple_test", value: { email: "test@example.com" } },
    { key: "push:token:12345678", value: "token" },
    { key: "feedback", value: [{ deviceId: "12345678" }] }
  ];

  const preview = summarizeFullReset(entries, 2);
  assert.equal(preview.accountRecords, 2);
  assert.equal(preview.indexedIdentities, 2);
  assert.equal(preview.appleAccounts, 1);
  assert.equal(preview.activeStripeSubscriptions, 1);
  assert.equal(preview.applePurchaseBindings, 1);
  assert.equal(preview.notificationTokenFiles, 2);
  assert.equal(preview.records, entries.length);
  assert.deepEqual(preview.activeStripeSubscriptionIds, ["sub_test"]);
  assert.equal(preview.categories.accounts, 3);
  assert.equal(preview.categories.notifications, 1);
});

test("reset previews change when stored data changes and classify local fallback keys", () => {
  const first = summarizeFullReset([{ key: "credits_12345678", value: { balance: 1 } }]);
  const second = summarizeFullReset([{ key: "credits_12345678", value: { balance: 2 } }]);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(storeCategory("credits_12345678"), "credits");
  assert.equal(storeCategory("stripe_subscription_sub_test"), "billing");
  assert.equal(storeCategory("nudges_manifest_12345678"), "notifications");
});
