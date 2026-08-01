import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { recordEngagementOpen, recordEngagementSession, type EngagementCampaign } from "../src/engagement.js";
import { storeGet, storeSet } from "../src/store.js";

test("notification attribution follows its campaign across Apple and device identity aliases", async () => {
  const identity = `apple_${randomUUID().replaceAll("-", "")}`;
  const campaign: EngagementCampaign = {
    id: randomUUID(),
    identity,
    channel: "push",
    category: "sports",
    title: "Catch up on your teams",
    body: "Current scores and schedules are ready.",
    sentAt: Date.now(),
    status: "sent",
    source: "automatic"
  };
  await storeSet(`engagement_campaign:${campaign.id}`, campaign);
  await storeSet(`engagement:${identity}`, {
    campaigns: [campaign],
    performance: { sports: { push: { sent: 1, opened: 0 } } }
  });

  assert.equal(await recordEngagementOpen(campaign.id), true);
  assert.equal(await recordEngagementSession(campaign.id, undefined, 42), true);

  const state = await storeGet<any>(`engagement:${identity}`, null);
  assert.equal(state.performance.sports.push.opened, 1);
  assert.equal(state.performance.sports.push.sessionSeconds, 42);
  assert.ok(state.campaigns[0].openedAt);
});
