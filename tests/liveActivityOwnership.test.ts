import assert from "node:assert/strict";
import test from "node:test";
import { getLiveActivities, registerLiveActivity, unregisterLiveActivity } from "../src/push.js";

test("devices with the same logical Live Activity id cannot replace each other", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = `shared-${suffix}`;
  const firstDevice = "11000001";
  const secondDevice = "11000002";
  try {
    await registerLiveActivity({ id, deviceId: firstDevice, kind: "flight", meta: { query: "UA123" }, token: `token-a-${suffix}` });
    await registerLiveActivity({ id, deviceId: secondDevice, kind: "sports", meta: { query: "Knicks" }, token: `token-b-${suffix}` });

    const matching = (await getLiveActivities()).filter((item) => item.id === id);
    assert.equal(matching.length, 2);
    assert.deepEqual(new Set(matching.map((item) => item.deviceId)), new Set([firstDevice, secondDevice]));

    await unregisterLiveActivity(id, firstDevice);
    const remaining = (await getLiveActivities()).filter((item) => item.id === id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].deviceId, secondDevice);
  } finally {
    await Promise.all([
      unregisterLiveActivity(id, firstDevice),
      unregisterLiveActivity(id, secondDevice)
    ]);
  }
});
