import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  recordViolation,
  recordAssoc,
  associationsFor,
  reinstate,
  unban,
  warnUser,
  suspendAccount,
  acknowledgeNotice,
  terminateAndBan,
  isBanned,
  getBanList,
  retireBannedIps,
  retiredBannedIps,
  getSafetyAccount,
  noteMessageAfterSafetyThreshold,
  safetyDetailFor,
  strikeThreshold
} from "../src/safety.js";
import { storeSet } from "../src/store.js";

const newId = () => `sfdev${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const flag = (identity: string) =>
  recordViolation(identity, { text: "make a bomb", category: "weapons", at: Date.now() });

async function finishDelayedSuspension(identity: string) {
  await noteMessageAfterSafetyThreshold(identity);
  await noteMessageAfterSafetyThreshold(identity);
  const account = await getSafetyAccount(identity);
  assert.equal(account.status, "active", "two grace messages do not bypass the eight-second minimum");
  assert.equal(account.pendingSuspension?.additionalMessages, 2);
  await storeSet(`safety:acct:${identity}`, {
    ...account,
    pendingSuspension: { ...account.pendingSuspension!, suspendAt: Date.now() - 1 }
  });
  return getSafetyAccount(identity);
}

test("suspension threshold escalates 3 -> 2 -> 1 and stays at 1", () => {
  assert.equal(strikeThreshold(0), 3);
  assert.equal(strikeThreshold(1), 2);
  assert.equal(strikeThreshold(2), 1);
  assert.equal(strikeThreshold(3), 1);
  assert.equal(strikeThreshold(50), 1);
});

test("each reinstatement lowers the bar: 3 flags, then 2, then 1", async () => {
  const id = newId();

  // First cycle: three contextual flags start the delayed suspension window.
  await flag(id);
  assert.equal((await getSafetyAccount(id)).status, "active");
  await flag(id);
  assert.equal((await getSafetyAccount(id)).status, "active");
  let acct = await flag(id);
  assert.equal(acct.status, "active");
  assert.ok(acct.pendingSuspension);
  acct = await finishDelayedSuspension(id);
  assert.equal(acct.status, "suspended");
  assert.equal(acct.suspensionCount, 1);

  // Second cycle: two flagged messages.
  await reinstate(id);
  await flag(id);
  assert.equal((await getSafetyAccount(id)).status, "active");
  acct = await flag(id);
  assert.ok(acct.pendingSuspension);
  acct = await finishDelayedSuspension(id);
  assert.equal(acct.status, "suspended");
  assert.equal(acct.suspensionCount, 2);

  // Third cycle and beyond: a single flagged message re-suspends.
  await reinstate(id);
  acct = await flag(id);
  acct = await finishDelayedSuspension(id);
  assert.equal(acct.status, "suspended");
  assert.equal(acct.suspensionCount, 3);

  await reinstate(id);
  acct = await flag(id);
  acct = await finishDelayedSuspension(id);
  assert.equal(acct.status, "suspended", "stays at a 1-strike threshold");
  assert.equal(acct.suspensionCount, 4);
});

test("lifetime flagged total survives every reinstatement", async () => {
  const id = newId();
  for (let i = 0; i < 3; i++) await flag(id);
  await finishDelayedSuspension(id);
  await reinstate(id);
  await flag(id);
  await flag(id);
  await finishDelayedSuspension(id);
  await reinstate(id);
  await flag(id);
  await finishDelayedSuspension(id);
  await reinstate(id);

  const detail = await safetyDetailFor(id);
  assert.equal(detail.flaggedTotal, 6, "counts every flagged message ever, across suspensions");
  assert.equal(detail.strikes, 0, "current-cycle strikes reset after a suspend+reinstate");
  assert.equal(detail.suspensionCount, 3);
});

test("reinstatement queues an overview the user must acknowledge", async () => {
  const id = newId();
  for (let i = 0; i < 3; i++) await flag(id);
  await finishDelayedSuspension(id);
  await reinstate(id);

  const acct = await getSafetyAccount(id);
  assert.ok(acct.pendingNotice, "an overview is queued");
  assert.equal(acct.pendingNotice?.kind, "reinstatement");
  assert.match(acct.pendingNotice?.reason || "", /weapons|explosives/i);
  assert.deepEqual(acct.pendingNotice?.messages, [], "does not expose the exact flagged messages");
  assert.equal(acct.pendingNotice?.nextThreshold, 2, "tells them the bar is now lower");

  await acknowledgeNotice(id);
  assert.equal((await getSafetyAccount(id)).pendingNotice, null);
});

test("a warning is an acknowledgeable notice without a suspension", async () => {
  const id = newId();
  const acct = await warnUser(id, "Knock it off.");
  assert.equal(acct.warnings, 1);
  assert.equal(acct.status, "active");
  assert.equal(acct.pendingNotice?.kind, "warning");
  assert.equal(acct.pendingNotice?.reason, "Knock it off.");
});

test("manual suspend counts toward escalation like an auto-suspend", async () => {
  const id = newId();
  const acct = await suspendAccount(id, "manual review");
  assert.equal(acct.status, "suspended");
  assert.equal(acct.suspensionCount, 1);
});

test("terminating never adds an IP to the ban list, and IPs never block", async () => {
  const id = newId();
  const ip = "203.0.113.77";
  await recordAssoc(id, undefined, ip);
  await flag(id);
  await terminateAndBan(id);

  const list = await getBanList();
  assert.equal(list.ips.includes(ip), false, "the IP is not added to the ban list");
  // A different, unbanned identity sharing that IP must stay unblocked.
  assert.equal(await isBanned(newId(), undefined, ip), false, "a shared IP never blocks a bystander");
  // The IP is still on the record for the terminated identity.
  assert.ok((await associationsFor(id)).ips.includes(ip), "the IP is still recorded");
});

test("stale banned IPs are archived and cleared, idempotently", async () => {
  const stale = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const list = await getBanList();
  await storeSet("safety:banlist", { ...list, ips: [...list.ips, stale] });

  const moved = await retireBannedIps();
  assert.ok(moved >= 1, "reports how many were retired");
  assert.deepEqual((await getBanList()).ips, [], "ban list no longer carries IPs");
  assert.ok((await retiredBannedIps()).includes(stale), "the record is preserved, not destroyed");

  // Running it again is a no-op.
  assert.equal(await retireBannedIps(), 0);
  assert.ok((await retiredBannedIps()).includes(stale), "archive survives a second run");
});

test("unban lifts the permanent ban and reactivates with an overview", async () => {
  const id = newId();
  for (let i = 0; i < 3; i++) await flag(id);
  await finishDelayedSuspension(id);
  await terminateAndBan(id);
  assert.equal(await isBanned(id), true);
  assert.equal((await getSafetyAccount(id)).status, "terminated");

  await unban(id);
  assert.equal(await isBanned(id), false, "identity is removed from the ban list");
  const acct = await getSafetyAccount(id);
  assert.equal(acct.status, "active");
  assert.ok(acct.pendingNotice, "unbanned users still see why they were removed");
});
