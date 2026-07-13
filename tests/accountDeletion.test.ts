import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { purgeAppleAccount } from "../src/accountDeletion.js";
import { storeDelete, storeGet, storeSet } from "../src/store.js";

const safeColon = (value: string) => value.replace(/[^a-zA-Z0-9_:.-]/g, "_");
const safePlain = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const safetySafe = (value: string) => value.replace(/[^a-zA-Z0-9_:-]/g, "_");

test("account deletion purges linked account data and preserves only starter-credit abuse protection", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const sub = `testsub${suffix}`;
  const appleIdentity = `apple:${sub}`;
  const device = `testdevice${suffix}`;
  const appleKey = `safety:applelink:${safetySafe(sub)}`;
  const deviceCreditsKey = `credits:${safePlain(device)}`;
  const originalUsersIndex = await storeGet<{ ids: string[] } | null>("users:index", null);
  const originalFeedback = await storeGet<any[] | null>("feedback", null);

  try {
    await storeSet(appleKey, { devices: [device] });
    await storeSet("users:index", { ids: [...(originalUsersIndex?.ids || []), appleIdentity, device] });
    await storeSet(`user:${safeColon(appleIdentity)}`, { ips: ["192.0.2.8"], name: "Delete Me" });
    await storeSet(`user:${safeColon(device)}`, { ips: ["192.0.2.8"] });
    await storeSet(`userip:${safeColon("192.0.2.8")}`, { ids: [appleIdentity, device] });
    await storeSet(`credits:${safePlain(appleIdentity)}`, { balance: 3000 });
    await storeSet(deviceCreditsKey, { balance: 3000, starterGiven: true });
    await storeSet(`email:conn:${safePlain(appleIdentity)}`, { email: "delete@example.com" });
    await storeSet(`routines:${appleIdentity}`, [{ id: "routine" }]);
    await storeSet("feedback", [...(originalFeedback || []), { deviceId: appleIdentity, note: "remove" }, { deviceId: "keep", note: "keep" }]);

    const deleted = await purgeAppleAccount(sub);

    assert.deepEqual(new Set(deleted.identities), new Set([appleIdentity, device]));
    assert.equal(await storeGet(`user:${safeColon(appleIdentity)}`, null), null);
    assert.equal(await storeGet(`credits:${safePlain(appleIdentity)}`, null), null);
    assert.equal(await storeGet(`email:conn:${safePlain(appleIdentity)}`, null), null);
    assert.equal(await storeGet(`routines:${appleIdentity}`, null), null);
    assert.deepEqual(await storeGet("feedback", []), [...(originalFeedback || []), { deviceId: "keep", note: "keep" }]);
    assert.deepEqual(await storeGet("users:index", { ids: [] }), originalUsersIndex || { ids: [] });
    assert.deepEqual(await storeGet(`userip:${safeColon("192.0.2.8")}`, { ids: [] }), { ids: [] });

    const deviceCredits = await storeGet<any>(deviceCreditsKey, null);
    assert.equal(deviceCredits.deviceId, device);
    assert.equal(deviceCredits.tier, "free");
    assert.equal(deviceCredits.starterGiven, true);
    assert.deepEqual(deviceCredits.grants, []);
  } finally {
    await Promise.all([
      storeDelete(appleKey),
      storeDelete(`user:${safeColon(appleIdentity)}`),
      storeDelete(`user:${safeColon(device)}`),
      storeDelete(`userip:${safeColon("192.0.2.8")}`),
      storeDelete(`credits:${safePlain(appleIdentity)}`),
      storeDelete(deviceCreditsKey),
      storeDelete(`email:conn:${safePlain(appleIdentity)}`),
      storeDelete(`routines:${appleIdentity}`)
    ]);
    if (originalUsersIndex) await storeSet("users:index", originalUsersIndex);
    else await storeDelete("users:index");
    if (originalFeedback) await storeSet("feedback", originalFeedback);
    else await storeDelete("feedback");
  }
});
