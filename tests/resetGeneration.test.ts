import assert from "node:assert/strict";
import test from "node:test";
import { bypassResetGeneration, hasCurrentResetGeneration } from "../src/resetGeneration.js";

test("post-reset app traffic requires the exact reset generation", () => {
  assert.equal(hasCurrentResetGeneration(0, undefined), true);
  assert.equal(hasCurrentResetGeneration(1784516631749, undefined), false);
  assert.equal(hasCurrentResetGeneration(1784516631749, "1784516631748"), false);
  assert.equal(hasCurrentResetGeneration(1784516631749, "1784516631749"), true);
  assert.equal(hasCurrentResetGeneration(1784516631749, ["1784516631749"]), true);
});

test("billing callbacks, web checkout, and admin remain available after reset", () => {
  assert.equal(bypassResetGeneration("/api/admin/users"), true);
  assert.equal(bypassResetGeneration("/api/stripe/webhook"), true);
  assert.equal(bypassResetGeneration("/api/iap/notifications"), true);
  assert.equal(bypassResetGeneration("/api/credits/account-check"), true);
  assert.equal(bypassResetGeneration("/api/assistant"), false);
  assert.equal(bypassResetGeneration("/api/register-device"), false);
  assert.equal(bypassResetGeneration("/api/iap/verify"), false);
});
