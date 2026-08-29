import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { isPrivacyDeletedDevice, privacyDeletedDeviceKey, purgeAppleAccount, purgeDeviceAccount } from "../src/accountDeletion.js";
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
      storeDelete(`routines:${appleIdentity}`),
      storeDelete(privacyDeletedDeviceKey(device))
    ]);
    if (originalUsersIndex) await storeSet("users:index", originalUsersIndex);
    else await storeDelete("users:index");
    if (originalFeedback) await storeSet("feedback", originalFeedback);
    else await storeDelete("feedback");
  }
});

test("device privacy deletion logs out the installation without creating a ban", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const device = `1${String(parseInt(suffix.slice(0, 7), 16) % 10_000_000).padStart(7, "0")}`;
  const ipFromUser = `198.51.100.${(parseInt(suffix.slice(7, 9), 16) % 200) + 1}`;
  const ipFromAssociation = `203.0.113.${(parseInt(suffix.slice(9, 11), 16) % 200) + 1}`;
  const userKey = `user:${safeColon(device)}`;
  const assocKey = `safety:assoc:${safetySafe(device)}`;
  const userIpKey = `userip:${safeColon(ipFromUser)}`;
  const assocIpKey = `userip:${safeColon(ipFromAssociation)}`;
  const credentialKey = `devicecredential:${safePlain(device)}`;
  const deletedKey = privacyDeletedDeviceKey(device);
  const keys = [
    userKey, assocKey, userIpKey, assocIpKey, credentialKey, deletedKey,
    `credits:${safePlain(device)}`, `devnum:used:${device}`, `webauth:${device}`,
    `safety:dev:${safetySafe(device)}`, `safety:devapple:${safetySafe(device)}`,
    "users:index", "safety:flagged", "safety:all", "nudges:index", "feedback", "safety:banlist",
    "push:tokens:index", `push:token:${safePlain(device)}`
  ];
  const original = new Map<string, unknown | null>();
  for (const key of keys) original.set(key, await storeGet<unknown | null>(key, null));

  try {
    await storeSet(userKey, { identity: device, ips: [ipFromUser], device: { name: "Privacy test" } });
    await storeSet(assocKey, { devices: [device], ips: [ipFromAssociation] });
    await storeSet(userIpKey, { ids: [device, "other-account"] });
    await storeSet(assocIpKey, { ids: [device] });
    await storeSet(credentialKey, "hashed-credential");
    await storeSet(`credits:${safePlain(device)}`, { balance: 999, starterGiven: false });
    await storeSet(`devnum:used:${device}`, true);
    await storeSet("users:index", { ids: [device, "other-account"] });
    await storeSet("safety:banlist", { identities: [device, "other-account"], devices: [device], ips: ["198.51.100.200"] });

    const deleted = await purgeDeviceAccount(device);

    assert.deepEqual(deleted, { identities: [device], devices: [device] });
    assert.equal(await storeGet(userKey, null), null);
    assert.equal(await storeGet(assocKey, null), null);
    assert.equal(await storeGet(credentialKey, null), null);
    assert.deepEqual(await storeGet(userIpKey, { ids: [] }), { ids: ["other-account"] });
    assert.deepEqual(await storeGet(assocIpKey, { ids: [] }), { ids: [] });
    assert.deepEqual(await storeGet("safety:banlist", { identities: [], devices: [], ips: [] }), {
      identities: ["other-account"],
      devices: [],
      ips: ["198.51.100.200"]
    });
    assert.equal(await storeGet(`devnum:used:${device}`, false), true);
    assert.equal(await isPrivacyDeletedDevice(device), true);
    const starter = await storeGet<any>(`credits:${safePlain(device)}`, null);
    assert.equal(starter.tier, "free");
    assert.equal(starter.starterGiven, true);
    assert.deepEqual(starter.grants, []);
  } finally {
    for (const key of keys) {
      await storeDelete(key);
      const value = original.get(key);
      if (value !== null && value !== undefined) await storeSet(key, value);
    }
  }
});
