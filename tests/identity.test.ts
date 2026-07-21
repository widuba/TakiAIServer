import assert from "node:assert/strict";
import test from "node:test";
import { isKnownIdentity } from "../src/identity.js";
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
