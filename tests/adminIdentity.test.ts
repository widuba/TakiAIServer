import assert from "node:assert/strict";
import test from "node:test";
import { adminAccountIdFor } from "../src/adminIdentity.js";

test("admin display ID prefers a linked eight-digit device without changing the canonical identity", () => {
  assert.equal(adminAccountIdFor("apple:opaque-provider-sub", ["12345678"]), "12345678");
  assert.equal(adminAccountIdFor("12345678", []), "12345678");
  assert.equal(adminAccountIdFor("apple:opaque-provider-sub", ["not-a-device", "87654321"]), "87654321");
  assert.equal(adminAccountIdFor("google:opaque-provider-sub", []), "");
});
