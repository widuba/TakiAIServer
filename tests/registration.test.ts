import assert from "node:assert/strict";
import test from "node:test";

import { commitSignupSlot, MAX_ACCOUNTS_PER_IP, releaseSignupSlot, reserveSignupSlot, signupStateKeyForIp } from "../src/registration.js";
import { storeDelete, storeSet } from "../src/store.js";

function ipKey(ip: string): string {
  return `userip:${ip.replace(/[^a-zA-Z0-9_:.-]/g, "_")}`;
}

test("signup allows at most ten accounts per IP and counts concurrent reservations", async () => {
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const ids = Array.from({ length: MAX_ACCOUNTS_PER_IP - 1 }, (_, index) => `1${String(index).padStart(7, "0")}`);
  try {
    await storeSet(ipKey(ip), { ids });
    const first = await reserveSignupSlot(ip);
    assert.ok(first);
    assert.equal(await reserveSignupSlot(ip), null, "the tenth account plus a pending signup is the cap");

    await releaseSignupSlot(ip, first);
    const second = await reserveSignupSlot(ip);
    assert.ok(second);
    assert.equal(await commitSignupSlot(ip, second), true);

    // The committed device is now visible through the authoritative IP index,
    // so a later request is rejected even though no reservation is pending.
    await storeSet(ipKey(ip), { ids: [...ids, "19999999"] });
    assert.equal(await reserveSignupSlot(ip), null);
  } finally {
    await Promise.all([storeDelete(ipKey(ip)), storeDelete(signupStateKeyForIp(ip))]);
  }
});

test("eleven simultaneous signup reservations cannot pass the ten-account cap", async () => {
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const reservations = await Promise.all(Array.from({ length: MAX_ACCOUNTS_PER_IP + 1 }, () => reserveSignupSlot(ip)));
  try {
    assert.equal(reservations.filter(Boolean).length, MAX_ACCOUNTS_PER_IP);
  } finally {
    await Promise.all(reservations.filter((token): token is string => Boolean(token)).map((token) => releaseSignupSlot(ip, token)));
    await storeDelete(signupStateKeyForIp(ip));
  }
});
