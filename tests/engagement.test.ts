import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { creditNotificationMessage, normalizeEngagementMessage, recordEngagementOpen, recordEngagementSession, sendCustomEngagement, type EngagementCampaign } from "../src/engagement.js";
import { storeDelete, storeGet, storeSet } from "../src/store.js";

test("custom notifications normalize safely and credit copy includes the granted amount", () => {
  assert.deepEqual(normalizeEngagementMessage({ title: "  A   quick update\n", body: "  Hello there.  " }), {
    title: "A quick update",
    body: "Hello there."
  });
  assert.deepEqual(creditNotificationMessage(1_250), {
    title: "Your Taki credits are here",
    body: "We added 1,250 AI Credits to your Taki account. They expire in 90 days."
  });
  assert.throws(() => normalizeEngagementMessage({ title: "", body: "message" }), /title is required/);
  assert.throws(() => normalizeEngagementMessage({ title: "Title", body: "" }), /body is required/);
});

test("a custom push notification is recorded even when the account has no token", async () => {
  const identity = `custom-notification-${randomUUID()}`;
  const result = await sendCustomEngagement({ identity, apple: {} } as any, "push", [], {
    title: "A support update",
    body: "Your account was updated by the Taki team."
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "No registered push token");
    assert.equal(result.campaign.category, "custom");
    assert.equal(result.campaign.source, "admin");
    const state = await storeGet<any>(`engagement:${identity}`, null);
    assert.equal(state.campaigns[0].title, "A support update");
    assert.equal(state.campaigns[0].status, "failed");
  } finally {
    await storeDelete(`engagement:${identity}`);
    await storeDelete(`engagement_campaign:${result.campaign.id}`);
  }
});

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
  assert.equal(await recordEngagementOpen(campaign.id), true);
  assert.equal(await recordEngagementSession(campaign.id, undefined, 42), true);

  const state = await storeGet<any>(`engagement:${identity}`, null);
  assert.equal(state.performance.sports.push.opened, 1);
  assert.equal(state.performance.sports.push.sessionSeconds, 42);
  assert.ok(state.campaigns[0].openedAt);
});

test("a previously recorded tap repairs a stale zero-open aggregate without double counting", async () => {
  const identity = `apple_${randomUUID().replaceAll("-", "")}`;
  const campaign: EngagementCampaign = {
    id: randomUUID(),
    identity,
    channel: "push",
    category: "planning",
    title: "Make today easier",
    body: "Turn the things on your mind into a clear plan.",
    sentAt: Date.now(),
    openedAt: Date.now(),
    status: "sent",
    source: "admin"
  };
  await storeSet(`engagement_campaign:${campaign.id}`, campaign);
  await storeSet(`engagement:${identity}`, {
    campaigns: [campaign],
    performance: { planning: { push: { sent: 1, opened: 0 } } }
  });

  assert.equal(await recordEngagementOpen(campaign.id), true);
  assert.equal(await recordEngagementOpen(campaign.id), true);
  const state = await storeGet<any>(`engagement:${identity}`, null);
  assert.equal(state.performance.planning.push.opened, 1);
});
