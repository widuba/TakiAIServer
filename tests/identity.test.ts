import assert from "node:assert/strict";
import test from "node:test";
import { isKnownIdentity, issueDeviceCredential, verifyDeviceCredential } from "../src/identity.js";
import { bypassDeviceAuth } from "../src/deviceAuth.js";
import { linkApple } from "../src/safety.js";
import { storeDelete, storeSet } from "../src/store.js";

test("only issued devices and linked Apple accounts are accepted identities", async () => {
  const suffix = String(Date.now()).slice(-6);
  const deviceId = `19${suffix}`;
  const appleSub = `identity-test-${suffix}`;
  try {
    assert.equal(await isKnownIdentity(deviceId), false);
    assert.equal(await isKnownIdentity(`apple:${appleSub}`), false);

    await storeSet(`devnum:used:${deviceId}`, true);
    await linkApple(appleSub, deviceId);

    assert.equal(await isKnownIdentity(deviceId), true);
    assert.equal(await isKnownIdentity(`apple:${appleSub}`), true);
    assert.equal(await isKnownIdentity("not-an-account"), false);
  } finally {
    await Promise.all([
      storeDelete(`devnum:used:${deviceId}`),
      storeDelete(`safety:applelink:${appleSub}`),
      storeDelete(`safety:devapple:${deviceId}`)
    ]);
  }
});

test("physical device access requires the issued installation credential", async () => {
  const deviceId = `18${String(Date.now()).slice(-6)}`;
  try {
    await storeSet(`devnum:used:${deviceId}`, true);
    const credential = await issueDeviceCredential(deviceId);
    assert.equal(credential.length >= 32, true);
    assert.equal(await verifyDeviceCredential(deviceId, credential), true);
    assert.equal(await verifyDeviceCredential(deviceId, `${credential}x`), false);
    assert.equal(await verifyDeviceCredential(deviceId, ""), false);
    assert.equal(await verifyDeviceCredential("not-an-id", credential), false);
  } finally {
    await Promise.all([
      storeDelete(`devnum:used:${deviceId}`),
      storeDelete(`devicecredential:${deviceId}`)
    ]);
  }
});

test("browser checkout and public account lookup do not require a device credential", () => {
  for (const path of [
    "/api/credits/purchase-link",
    "/api/credits/handoff",
    "/api/credits/account-check",
    "/api/credits/checkout",
    "/api/plans/checkout"
  ]) {
    assert.equal(bypassDeviceAuth(path), true, path);
  }
  assert.equal(bypassDeviceAuth("/api/assistant"), false);
  assert.equal(bypassDeviceAuth("/api/admin/full-reset"), true);
});
