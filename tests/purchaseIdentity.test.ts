import assert from "node:assert/strict";
import test from "node:test";
import { resolvePurchaseDisplayName } from "../src/purchaseIdentity.js";

test("purchase confirmation prefers the current Taki personalization name", () => {
  assert.equal(resolvePurchaseDisplayName({
    takiName: "Dukes",
    appleName: "David Widuba",
    deviceOwnerName: "David",
    accountId: "12345678"
  }), "Dukes");
});

test("purchase confirmation falls back through Apple, device, and account names", () => {
  assert.equal(resolvePurchaseDisplayName({ appleName: "David", deviceOwnerName: "Dukes", accountId: "12345678" }), "David");
  assert.equal(resolvePurchaseDisplayName({ deviceOwnerName: "Dukes", accountId: "12345678" }), "Dukes");
  assert.equal(resolvePurchaseDisplayName({ accountId: "12345678" }), "Account 12345678");
});
