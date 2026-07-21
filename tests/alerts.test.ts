import test from "node:test";
import assert from "node:assert/strict";

import { addAlert, cancelAlerts, clearAlertsForReset, listAlerts } from "../src/alerts.js";
import { storeDelete } from "../src/store.js";

test("proactive alerts are isolated by physical device", async (t) => {
  clearAlertsForReset();
  t.after(async () => {
    clearAlertsForReset();
    await storeDelete("alerts");
  });

  await addAlert({
    id: "alert-a",
    deviceId: "10000001",
    kind: "price",
    createdAt: Date.now(),
    query: "AAPL",
    target: 250,
    direction: "above",
    label: "Apple"
  });
  await addAlert({
    id: "alert-b",
    deviceId: "10000002",
    kind: "score",
    createdAt: Date.now(),
    query: "Lakers",
    trigger: "final",
    label: "Lakers"
  });

  assert.deepEqual((await listAlerts("10000001")).map((alert) => alert.id), ["alert-a"]);
  assert.deepEqual((await listAlerts("10000002")).map((alert) => alert.id), ["alert-b"]);
  assert.equal(await cancelAlerts("10000001", { id: "alert-b" }), 0);
  assert.equal(await cancelAlerts("10000001", { id: "alert-a" }), 1);
  assert.deepEqual((await listAlerts("10000002")).map((alert) => alert.id), ["alert-b"]);
});
