import { storeGet, storeGetMany, storeSet, storeUpdate, storeUpdatePair } from "./store.js";

/* ============================================================================
 * Safety & enforcement.
 *
 * Retains contextual AI safety decisions and enforces a graduated process:
 *
 *   1. Each flagged message is a "strike" and is RETAINED for review (normal,
 *      non-flagged messages are never stored).
 *   2. At SAFETY_STRIKE_LIMIT strikes, a delayed suspension begins. The user can
 *      complete two more turns and at least eight seconds pass before access is
 *      suspended, so enforcement does not reveal which exact message triggered it.
 *   3. A human (admin, ADMIN_SECRET) reviews the retained flagged messages and
 *      either REINSTATES the account, or TERMINATES it — which permanently bans
 *      the identity, its device id(s), and any other identities seen on the
 *      same device(s), with no appeal. IP addresses remain context only.
 *
 * The automated step only ever SUSPENDS (reversible); permanent bans are always
 * human-triggered, so a false positive can't permanently punish a real user.
 *
 * Contextual classification lives in safetyReview.ts. No keyword matcher is
 * used as an enforcement gate.
 * ==========================================================================*/

// Keep a malformed environment value from disabling enforcement (NaN would
// make every `strikes >= threshold` comparison false) or creating an
// impractically large threshold.  The server's policy is intentionally bounded
// even when deployment configuration is edited by hand.
const STRIKE_LIMIT = Math.max(1, Math.min(100, Math.floor(Number(process.env.SAFETY_STRIKE_LIMIT || 3) || 3)));

// Escalating tolerance: the first suspension takes STRIKE_LIMIT flagged messages;
// each later cycle needs one fewer, bottoming out (and staying) at 1. So with the
// default limit of 3: first suspension at 3, then 2, then 1, 1, 1, …
export function strikeThreshold(suspensionCount: number): number {
  return Math.max(1, STRIKE_LIMIT - Math.max(0, suspensionCount));
}

export type AcctStatus = "active" | "suspended" | "terminated";
export type NoticeKind = "reinstatement" | "warning";
export interface Violation { text: string; category: string; at: number; ip?: string; deviceId?: string; }

// Shown to the user the next time they open the app after being let back in (or
// warned). They must acknowledge it before returning to Taki.
export interface PendingNotice {
  kind: NoticeKind;
  reason: string;            // human-readable gist of why
  categories: string[];      // policy categories involved (reinstatement)
  messages: Violation[];     // always empty for user-facing notices; evidence is admin-only
  suspensionNumber: number;  // how many times this account has been suspended
  nextThreshold: number;     // flagged messages that will re-suspend them now
  at: number;
}

export interface PendingSuspension {
  thresholdReachedAt: number;
  suspendAt: number;
  additionalMessages: number;
}

export interface SafetyAccount {
  identity: string;
  status: AcctStatus;
  strikes: number;              // flagged messages in the CURRENT cycle
  violations: Violation[];      // current-cycle flagged messages (cleared on reinstate)
  suspensionCount: number;      // lifetime times suspended (drives the escalation)
  flaggedTotal: number;         // lifetime flagged-message count (never decremented)
  flaggedHistory: Violation[];  // retained flagged messages across ALL cycles (capped)
  warnings: number;             // admin warnings issued
  pendingNotice: PendingNotice | null;
  pendingSuspension: PendingSuspension | null;
  updatedAt: number;
}

const FLAGGED_HISTORY_CAP = 500;

// Friendly labels for the overview the user sees on the way back in.
const CATEGORY_LABELS: Record<string, string> = {
  csae: "child sexual exploitation",
  weapons: "weapons or explosives creation",
  drugs: "illegal drug manufacturing",
  violence: "credible threats of violence",
  self_harm: "self-harm facilitation",
  malware: "malware or intrusion tooling",
  prompt_extraction: "repeated attempts to extract system instructions",
  admin: "a manual review by Taki"
};

function reasonForCategories(categories: string[]): string {
  const labels = categories.map((c) => CATEGORY_LABELS[c] || "activity against Taki's policies");
  const unique = Array.from(new Set(labels));
  if (unique.length === 0) return "activity that violated Taki's Terms of Service";
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

function buildReinstatementNotice(account: SafetyAccount, cycleMessages: Violation[]): PendingNotice {
  const categories = Array.from(new Set(cycleMessages.map((m) => m.category)));
  return {
    kind: "reinstatement",
    reason: reasonForCategories(categories),
    categories,
    // Exact retained messages are review evidence and never shown to the user.
    messages: [],
    suspensionNumber: account.suspensionCount,
    nextThreshold: strikeThreshold(account.suspensionCount),
    at: Date.now()
  };
}

export const SUSPENDED_MSG =
  "Your account is temporarily suspended and under review for activity that may violate Taki's Terms of Service. If you believe this is a mistake, contact Taki AI Support.";
export const BANNED_MSG =
  "Your access to Taki has been permanently revoked for violating the Terms of Service.";

/* ---- Account state ------------------------------------------------------ */
function keyify(id: string): string { return id.replace(/[^a-zA-Z0-9_:-]/g, "_"); }
function acctKey(id: string): string { return `safety:acct:${keyify(id)}`; }
const FLAGGED_INDEX = "safety:flagged"; // list of currently-suspended identities
const SAFETY_ALL_INDEX = "safety:all";  // every identity that has any safety history

function emptySafetyAccount(identity: string): SafetyAccount {
  return {
    identity, status: "active", strikes: 0, violations: [], suspensionCount: 0,
    flaggedTotal: 0, flaggedHistory: [], warnings: 0,
    pendingNotice: null, pendingSuspension: null, updatedAt: 0
  };
}

function normalizeSafetyAccount(identity: string, stored?: SafetyAccount | null): SafetyAccount {
  const a = stored && typeof stored === "object" && !Array.isArray(stored)
    ? stored
    : emptySafetyAccount(identity);
  a.identity = identity;
  if (!(a.status === "active" || a.status === "suspended" || a.status === "terminated")) a.status = "active";
  if (!Array.isArray(a.violations)) a.violations = [];
  a.violations = a.violations.filter((item) => item && typeof item === "object" && typeof item.text === "string")
    .map((item) => ({
      text: item.text.slice(0, 2_000),
      category: String(item.category || "").slice(0, 80),
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now(),
      ...(item.ip ? { ip: String(item.ip).slice(0, 120) } : {}),
      ...(item.deviceId ? { deviceId: String(item.deviceId).slice(0, 32) } : {})
    })).slice(-50);
  if (!Array.isArray(a.flaggedHistory)) a.flaggedHistory = [];
  a.flaggedHistory = a.flaggedHistory.filter((item) => item && typeof item === "object" && typeof item.text === "string")
    .map((item) => ({
      text: item.text.slice(0, 2_000),
      category: String(item.category || "").slice(0, 80),
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now(),
      ...(item.ip ? { ip: String(item.ip).slice(0, 120) } : {}),
      ...(item.deviceId ? { deviceId: String(item.deviceId).slice(0, 32) } : {})
    })).slice(-FLAGGED_HISTORY_CAP);
  if (typeof a.suspensionCount !== "number" || !Number.isFinite(a.suspensionCount)) a.suspensionCount = 0;
  a.suspensionCount = Math.max(0, Math.floor(a.suspensionCount));
  if (typeof a.flaggedTotal !== "number" || !Number.isFinite(a.flaggedTotal)) a.flaggedTotal = a.flaggedHistory.length || a.violations.length;
  a.flaggedTotal = Math.max(a.flaggedHistory.length, Math.floor(a.flaggedTotal));
  if (typeof a.strikes !== "number" || !Number.isFinite(a.strikes)) a.strikes = a.violations.length;
  a.strikes = Math.max(0, Math.floor(a.strikes));
  if (typeof a.warnings !== "number" || !Number.isFinite(a.warnings)) a.warnings = 0;
  a.warnings = Math.max(0, Math.floor(a.warnings));
  if (!a.pendingNotice || typeof a.pendingNotice !== "object" || Array.isArray(a.pendingNotice)) a.pendingNotice = null;
  else {
    a.pendingNotice = {
      kind: a.pendingNotice.kind === "warning" ? "warning" : "reinstatement",
      reason: String(a.pendingNotice.reason || "").slice(0, 2_000),
      categories: Array.isArray(a.pendingNotice.categories) ? a.pendingNotice.categories.map(String).slice(0, 20) : [],
      messages: [],
      suspensionNumber: Math.max(0, Math.floor(Number(a.pendingNotice.suspensionNumber) || 0)),
      nextThreshold: Math.max(1, Math.floor(Number(a.pendingNotice.nextThreshold) || strikeThreshold(a.suspensionCount))),
      at: Number.isFinite(Number(a.pendingNotice.at)) ? Number(a.pendingNotice.at) : Date.now()
    };
  }
  if (!a.pendingSuspension || typeof a.pendingSuspension !== "object" || Array.isArray(a.pendingSuspension)) a.pendingSuspension = null;
  else {
    a.pendingSuspension = {
      thresholdReachedAt: Number.isFinite(Number(a.pendingSuspension.thresholdReachedAt)) ? Number(a.pendingSuspension.thresholdReachedAt) : Date.now(),
      suspendAt: Number.isFinite(Number(a.pendingSuspension.suspendAt)) ? Number(a.pendingSuspension.suspendAt) : Date.now() + 8_000,
      additionalMessages: Math.max(0, Math.min(2, Math.floor(Number(a.pendingSuspension.additionalMessages) || 0)))
    };
  }
  return a;
}

export async function getSafetyAccount(identity: string): Promise<SafetyAccount> {
  const a = normalizeSafetyAccount(identity, await storeGet<SafetyAccount | null>(acctKey(identity), null));
  if (a.status === "active" && a.pendingSuspension
      && a.pendingSuspension.additionalMessages >= 2
      && a.pendingSuspension.suspendAt <= Date.now()) {
    const updated = await storeUpdate<SafetyAccount | null, SafetyAccount>(acctKey(identity), null, (stored) => {
      const current = normalizeSafetyAccount(identity, stored);
      if (current.status === "active" && current.pendingSuspension
          && current.pendingSuspension.additionalMessages >= 2
          && current.pendingSuspension.suspendAt <= Date.now()) {
        current.status = "suspended";
        current.suspensionCount += 1;
        current.pendingSuspension = null;
        current.updatedAt = Date.now();
      }
      return { value: current, result: current };
    });
    await allIndexAdd(identity);
    if (updated.status === "suspended") await indexAdd(identity);
    return updated;
  }
  return a;
}
async function indexAdd(identity: string): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(FLAGGED_INDEX, { ids: [] }, (idx) => {
    const ids = Array.isArray(idx.ids) ? idx.ids.filter((id): id is string => typeof id === "string").slice(-50_000) : [];
    if (!ids.includes(identity)) ids.push(identity);
    return { value: { ids }, result: undefined };
  });
}
async function indexRemove(identity: string): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(FLAGGED_INDEX, { ids: [] }, (idx) => ({
    value: { ids: (Array.isArray(idx.ids) ? idx.ids.filter((i): i is string => typeof i === "string") : []).filter((i) => i !== identity) },
    result: undefined
  }));
}
async function allIndexAdd(identity: string): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(SAFETY_ALL_INDEX, { ids: [] }, (idx) => {
    const ids = Array.isArray(idx.ids) ? idx.ids.filter((id): id is string => typeof id === "string").slice(-100_000) : [];
    if (!ids.includes(identity)) ids.push(identity);
    return { value: { ids }, result: undefined };
  });
}

// Record a contextually flagged message. Reaching the escalating threshold
// starts the delayed suspension window; it does not immediately change access.
export async function recordViolation(identity: string, v: Violation): Promise<SafetyAccount> {
  const violation: Violation = {
    text: String(v?.text || "").slice(0, 2_000),
    category: String(v?.category || "unknown").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "unknown",
    at: Number.isFinite(Number(v?.at)) ? Math.max(0, Number(v.at)) : Date.now(),
    ...(v?.ip ? { ip: String(v.ip).slice(0, 120) } : {}),
    ...(v?.deviceId ? { deviceId: String(v.deviceId).slice(0, 32) } : {})
  };
  const a = await storeUpdate<SafetyAccount | null, SafetyAccount>(acctKey(identity), null, (stored) => {
    const current = normalizeSafetyAccount(identity, stored);
    if (current.status === "terminated") return { value: current, result: current };
    current.strikes += 1;
    current.violations.push(violation);
    if (current.violations.length > 50) current.violations = current.violations.slice(-50);
    current.flaggedTotal += 1;
    current.flaggedHistory.push(violation);
    if (current.flaggedHistory.length > FLAGGED_HISTORY_CAP) current.flaggedHistory = current.flaggedHistory.slice(-FLAGGED_HISTORY_CAP);
    if (current.status === "active" && !current.pendingSuspension && current.strikes >= strikeThreshold(current.suspensionCount)) {
      const now = Date.now();
      current.pendingSuspension = { thresholdReachedAt: now, suspendAt: now + 8_000, additionalMessages: 0 };
    }
    current.updatedAt = Date.now();
    return { value: current, result: current };
  });
  await allIndexAdd(identity);
  return a;
}

// Count a completed post-threshold turn. The second additional turn is still
// allowed to finish; suspension becomes visible only after it and the eight
// second minimum have both elapsed. The persisted timestamps make this survive
// a server restart, while the timer handles the normal no-further-message case.
export async function noteMessageAfterSafetyThreshold(identity: string): Promise<SafetyAccount> {
  const a = await storeUpdate<SafetyAccount | null, SafetyAccount>(acctKey(identity), null, (stored) => {
    const current = normalizeSafetyAccount(identity, stored);
    if (current.status !== "active" || !current.pendingSuspension) return { value: current, result: current };
    current.pendingSuspension.additionalMessages = Math.min(2, current.pendingSuspension.additionalMessages + 1);
    if (current.pendingSuspension.additionalMessages >= 2) {
      current.pendingSuspension.suspendAt = Math.max(current.pendingSuspension.suspendAt, Date.now() + 8_000);
    }
    current.updatedAt = Date.now();
    return { value: current, result: current };
  });
  await allIndexAdd(identity);
  if (a.pendingSuspension && a.pendingSuspension.additionalMessages >= 2) {
    const delay = Math.max(0, a.pendingSuspension.suspendAt - Date.now());
    const timer = setTimeout(() => {
      void getSafetyAccount(identity).catch((error) => console.error("Delayed safety suspension:", error));
    }, delay + 25);
    timer.unref?.();
  }
  return a;
}

/* ---- Associations + ban list (for cascade bans) ------------------------- */
interface Assoc { devices: string[]; ips: string[]; }
interface BanList { identities: string[]; devices: string[]; ips: string[]; }
export interface BanImpact { identities: string[]; devices: string[]; ips: string[]; }
interface TestRestriction { identity: string; expiresAt: number; }
const BAN_KEY = "safety:banlist";
function assocKey(id: string): string { return `safety:assoc:${keyify(id)}`; }
function devKey(dev: string): string { return `safety:dev:${keyify(dev)}`; } // device -> identities seen on it
function testRestrictionKey(identity: string): string { return `safety:test-restriction:${keyify(identity)}`; }

export async function recordAssoc(identity: string, deviceId?: string, ip?: string): Promise<void> {
  if (!identity) return;
  const safeDeviceId = typeof deviceId === "string" && /^\d{8}$/.test(deviceId) ? deviceId : "";
  const safeIp = typeof ip === "string" && ip.length <= 120 ? ip : "";
  await storeUpdate<Assoc, void>(assocKey(identity), { devices: [], ips: [] }, (stored) => {
    const a = {
      devices: Array.isArray(stored.devices) ? stored.devices : [],
      ips: Array.isArray(stored.ips) ? stored.ips : []
    };
    if (safeDeviceId && !a.devices.includes(safeDeviceId)) a.devices.push(safeDeviceId);
    if (a.devices.length > 50) a.devices = a.devices.slice(-50);
    if (safeIp && safeIp !== "unknown" && !a.ips.includes(safeIp)) {
      a.ips.push(safeIp);
      if (a.ips.length > 25) a.ips = a.ips.slice(-25);
    }
    return { value: a, result: undefined };
  });
  if (safeDeviceId) {
    await storeUpdate<{ ids: string[] }, void>(devKey(safeDeviceId), { ids: [] }, (stored) => {
      const ids = Array.isArray(stored.ids) ? stored.ids : [];
      if (!ids.includes(identity)) ids.push(identity);
      return { value: { ids: ids.slice(-2_000) }, result: undefined };
    });
  }
}

export async function getBanList(): Promise<BanList> {
  const b = await storeGet<BanList>(BAN_KEY, { identities: [], devices: [], ips: [] });
  return {
    identities: Array.isArray(b.identities) ? [...new Set(b.identities.filter((id) => typeof id === "string").slice(-50_000))] : [],
    devices: Array.isArray(b.devices) ? [...new Set(b.devices.filter((id) => typeof id === "string").slice(-50_000))] : [],
    ips: Array.isArray(b.ips) ? [...new Set(b.ips.filter((ip) => typeof ip === "string").slice(-50_000))] : []
  };
}

const RETIRED_IPS_KEY = "safety:banlist:retired-ips";

// One-time cleanup: IP banning was removed, but earlier terminations wrote IPs
// into the ban list. Nothing reads them anymore (isBanned ignores IPs), so this
// clears the stale array — archiving it to `safety:banlist:retired-ips` first so
// the record of which IPs were once banned is preserved rather than destroyed.
// Idempotent: a ban list with no IPs is left untouched. Returns how many moved.
export async function retireBannedIps(): Promise<number> {
  return storeUpdatePair<BanList, { ips: string[]; retiredAt: number }, number>(
    { key: BAN_KEY, fallback: { identities: [], devices: [], ips: [] } },
    { key: RETIRED_IPS_KEY, fallback: { ips: [], retiredAt: 0 } },
    ({ first: rawBan, second: rawArchive }) => {
      const ban = {
        identities: Array.isArray(rawBan?.identities) ? rawBan.identities.filter((id): id is string => typeof id === "string") : [],
        devices: Array.isArray(rawBan?.devices) ? rawBan.devices.filter((id): id is string => typeof id === "string") : [],
        ips: Array.isArray(rawBan?.ips) ? rawBan.ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 120) : []
      };
      const archive = {
        ips: Array.isArray(rawArchive?.ips) ? rawArchive.ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 120) : [],
        retiredAt: Number.isFinite(Number(rawArchive?.retiredAt)) ? Number(rawArchive.retiredAt) : 0
      };
      const ips = [...new Set(ban.ips)];
      if (!ips.length) return { first: ban, second: archive, result: 0 };
      return {
        first: { ...ban, ips: [] },
        second: { ips: [...new Set([...archive.ips, ...ips])].slice(-50_000), retiredAt: Date.now() },
        result: ips.length
      };
    }
  );
}

// The IPs that were on the ban list before IP banning was removed (record only).
export async function retiredBannedIps(): Promise<string[]> {
  const stored = await storeGet<{ ips: string[] }>(RETIRED_IPS_KEY, { ips: [] });
  return Array.isArray(stored?.ips)
    ? [...new Set(stored.ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 120))].slice(-50_000)
    : [];
}

// Device ids + IPs seen for an identity (used to show linked devices per account).
export async function associationsFor(identity: string): Promise<Assoc> {
  const stored = await storeGet<Assoc>(assocKey(identity), { devices: [], ips: [] });
  return {
    devices: Array.isArray(stored?.devices) ? stored.devices.filter((id): id is string => typeof id === "string" && /^\d{8}$/.test(id)).slice(-50) : [],
    ips: Array.isArray(stored?.ips) ? stored.ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 120).slice(-25) : []
  };
}

/* ---- Apple account ↔ device links (identity stays the device number) ---- */
function appleKey(sub: string): string { return `safety:applelink:${keyify(sub)}`; }
function devAppleKey(dev: string): string { return `safety:devapple:${keyify(dev)}`; }
export async function linkApple(sub: string, deviceId: string): Promise<void> {
  if (!sub || !deviceId) return;
  const prior = await storeUpdate<{ sub: string }, string>(devAppleKey(deviceId), { sub: "" }, (stored) => {
    const previous = typeof stored?.sub === "string" ? stored.sub : "";
    return { value: { sub }, result: previous };
  });
  if (prior && prior !== sub) {
    await storeUpdate<{ devices: string[] }, void>(appleKey(prior), { devices: [] }, (stored) => ({
      value: { devices: (Array.isArray(stored.devices) ? stored.devices : []).filter((id) => id !== deviceId) },
      result: undefined
    }));
  }
  await storeUpdate<{ devices: string[] }, void>(appleKey(sub), { devices: [] }, (stored) => {
    const devices = Array.isArray(stored.devices) ? stored.devices : [];
    if (!devices.includes(deviceId)) devices.push(deviceId);
    return { value: { devices: devices.slice(-100) }, result: undefined };
  });
}
export async function devicesForApple(sub: string): Promise<string[]> {
  if (!sub) return [];
  const devices = (await storeGet<{ devices: string[] }>(appleKey(sub), { devices: [] })).devices;
  return Array.isArray(devices) ? [...new Set(devices.filter((id) => /^\d{8}$/.test(id)))].slice(-100) : [];
}
export async function appleForDevice(deviceId: string): Promise<string> {
  const sub = (await storeGet<{ sub: string }>(devAppleKey(deviceId), { sub: "" })).sub;
  return typeof sub === "string" ? sub.slice(0, 256) : "";
}

// IP addresses are recorded for context (associationsFor) but never used to
// block — a shared/public IP would catch bystanders. Bans key on the identity
// and its device id(s) / linked Apple account only. The `ip` argument is kept
// for call-site compatibility and is intentionally ignored here.
export async function isBanned(identity: string, deviceId?: string, _ip?: string): Promise<boolean> {
  const b = await getBanList();
  if (b.identities.includes(identity)) return true;
  if (deviceId && b.devices.includes(deviceId)) return true;
  return false;
}

// Reversible, identity-only block for testing the complete banned-account app
// experience. It never writes to the permanent identity/device/IP ban lists.
export async function setTestRestriction(identity: string, minutes = 5): Promise<TestRestriction> {
  const safeMinutes = Math.max(1, Math.min(30, Math.round(minutes)));
  const restriction = { identity, expiresAt: Date.now() + safeMinutes * 60_000 };
  await storeSet(testRestrictionKey(identity), restriction);
  return restriction;
}

export async function clearTestRestriction(identity: string): Promise<void> {
  await storeSet(testRestrictionKey(identity), null);
}

export async function isTestRestricted(identity: string): Promise<boolean> {
  if (!identity) return false;
  const restriction = await storeGet<TestRestriction | null>(testRestrictionKey(identity), null);
  if (!restriction || restriction.identity !== identity) return false;
  if (restriction.expiresAt <= Date.now()) {
    await clearTestRestriction(identity);
    return false;
  }
  return true;
}

// Let a suspended account back in. The current cycle's strikes clear, but the
// suspension count, lifetime total, and flagged history are all retained — and
// the user is queued an overview of why they were suspended, which they must
// acknowledge before returning to the app.
export async function reinstate(identity: string): Promise<void> {
  await storeUpdate<SafetyAccount | null, void>(acctKey(identity), null, (stored) => {
    const a = normalizeSafetyAccount(identity, stored);
    const cycleMessages = a.violations.slice();
    a.status = "active"; a.strikes = 0; a.violations = []; a.pendingSuspension = null;
    a.pendingNotice = buildReinstatementNotice(a, cycleMessages);
    a.updatedAt = Date.now();
    return { value: a, result: undefined };
  });
  await allIndexAdd(identity);
  await indexRemove(identity);
}

// Manually suspend an account (admin action). Counts as a suspension so the
// escalation applies, and queues the same review as an automatic suspension.
export async function suspendAccount(identity: string, reason?: string): Promise<SafetyAccount> {
  const a = await storeUpdate<SafetyAccount | null, SafetyAccount>(acctKey(identity), null, (stored) => {
    const current = normalizeSafetyAccount(identity, stored);
    if (current.status === "terminated") return { value: current, result: current };
    if (current.status !== "suspended") {
      current.status = "suspended";
      current.suspensionCount += 1;
    }
    current.pendingSuspension = null;
    if (reason && reason.trim()) current.violations.push({ text: reason.trim().slice(0, 2_000), category: "admin", at: Date.now() });
    current.updatedAt = Date.now();
    return { value: current, result: current };
  });
  await allIndexAdd(identity);
  await indexAdd(identity);
  return a;
}

// Issue a warning the user sees (and must acknowledge) next time they open Taki.
export async function warnUser(identity: string, message?: string): Promise<SafetyAccount> {
  const a = await storeUpdate<SafetyAccount | null, SafetyAccount>(acctKey(identity), null, (stored) => {
    const current = normalizeSafetyAccount(identity, stored);
    current.warnings += 1;
    current.pendingNotice = {
      kind: "warning",
      reason: (message && message.trim().slice(0, 2_000))
        || "This is a formal warning. Please review Taki's Terms of Service — continued policy violations can lead to suspension.",
      categories: [], messages: [], suspensionNumber: current.suspensionCount,
      nextThreshold: strikeThreshold(current.suspensionCount), at: Date.now()
    };
    current.updatedAt = Date.now();
    return { value: current, result: current };
  });
  await allIndexAdd(identity);
  return a;
}

// The user has seen the reinstatement/warning overview — clear it so it isn't
// shown again.
export async function acknowledgeNotice(identity: string): Promise<void> {
  await storeUpdate<SafetyAccount | null, void>(acctKey(identity), null, (stored) => {
    const a = normalizeSafetyAccount(identity, stored);
    a.pendingNotice = null;
    a.updatedAt = Date.now();
    return { value: a, result: undefined };
  });
  await allIndexAdd(identity);
}

export async function pendingNoticeFor(identity: string): Promise<PendingNotice | null> {
  return (await getSafetyAccount(identity)).pendingNotice;
}

/* ---- Admin views + lifetime history ------------------------------------- */
export interface SafetySummary {
  identity: string;
  status: AcctStatus;
  strikes: number;
  suspensionCount: number;
  flaggedTotal: number;
  warnings: number;
  nextThreshold: number;
  hasPendingNotice: boolean;
  updatedAt: number;
  recentFlagged: Violation[];
}

export function safetySummary(a: SafetyAccount): SafetySummary {
  return {
    identity: a.identity,
    status: a.status,
    strikes: a.strikes,
    suspensionCount: a.suspensionCount,
    flaggedTotal: a.flaggedTotal,
    warnings: a.warnings,
    nextThreshold: strikeThreshold(a.suspensionCount),
    hasPendingNotice: !!a.pendingNotice,
    updatedAt: a.updatedAt,
    recentFlagged: a.flaggedHistory.slice(-5)
  };
}

export async function safetySummaryFor(identity: string): Promise<SafetySummary> {
  return safetySummary(await getSafetyAccount(identity));
}

// Full detail for one account, including the entire retained flagged history.
export async function safetyDetailFor(identity: string): Promise<SafetyAccount & { nextThreshold: number }> {
  const a = await getSafetyAccount(identity);
  return { ...a, nextThreshold: strikeThreshold(a.suspensionCount) };
}

// Every account that has ANY safety history (flagged, warned, suspended, or
// banned) — the source for the admin "all accounts" section.
export async function allSafetyAccounts(): Promise<SafetySummary[]> {
  const idx = await storeGet<{ ids: string[] }>(SAFETY_ALL_INDEX, { ids: [] });
  const ids = Array.isArray(idx?.ids) ? [...new Set(idx.ids.filter((id): id is string => typeof id === "string"))].slice(-100_000) : [];
  const stored = await storeGetMany<SafetyAccount>(ids.map(acctKey));
  const out = ids
    .filter((id) => stored.has(acctKey(id)))
    .map((id) => safetySummary(normalizeSafetyAccount(id, stored.get(acctKey(id)))));
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Lift a permanent ban: remove the identity and its own devices from the ban
// list, reactivate the account, and queue the reinstatement overview. Other
// identities caught in the original cascade stay banned unless unbanned too.
export async function unban(identity: string): Promise<BanImpact> {
  const assoc = await associationsFor(identity);
  const removeIds = new Set<string>([identity]);
  const removeDevs = new Set<string>(assoc.devices);
  const removeIps = new Set<string>(assoc.ips.filter((x) => x && x !== "unknown"));
  await storeUpdate<BanList, void>(BAN_KEY, { identities: [], devices: [], ips: [] }, (stored) => {
    const b = {
      identities: Array.isArray(stored.identities) ? stored.identities : [],
      devices: Array.isArray(stored.devices) ? stored.devices : [],
      ips: Array.isArray(stored.ips) ? stored.ips : []
    };
    b.identities = b.identities.filter((i) => !removeIds.has(i));
    b.devices = b.devices.filter((d) => !removeDevs.has(d));
    b.ips = b.ips.filter((ip) => !removeIps.has(ip));
    return { value: b, result: undefined };
  });

  await storeUpdate<SafetyAccount | null, void>(acctKey(identity), null, (stored) => {
    const a = normalizeSafetyAccount(identity, stored);
    const cycleMessages = a.violations.length ? a.violations.slice() : a.flaggedHistory.slice(-5);
    a.status = "active"; a.strikes = 0; a.violations = []; a.pendingSuspension = null;
    a.pendingNotice = buildReinstatementNotice(a, cycleMessages);
    a.updatedAt = Date.now();
    return { value: a, result: undefined };
  });
  await indexRemove(identity);
  return { identities: Array.from(removeIds), devices: Array.from(removeDevs), ips: Array.from(removeIps) };
}

// Calculate the exact permanent-ban cascade without modifying any account.
export async function previewTermination(identity: string): Promise<BanImpact> {
  const assoc = await storeGet<Assoc>(assocKey(identity), { devices: [], ips: [] });
  const idset = new Set<string>([identity]);
  const devset = new Set<string>(assoc.devices);
  const ipset = new Set<string>(assoc.ips.filter((x) => x && x !== "unknown"));
  // One hop: every other identity seen on the same device(s) (catches other Apple
  // IDs / device ids sharing hardware).
  for (const dev of assoc.devices) {
    const d = await storeGet<{ ids: string[] }>(devKey(dev), { ids: [] });
    for (const i of d.ids) idset.add(i);
  }
  // Cascade across the linked Apple account: ban EVERY device signed into the same
  // Apple ID (identity is a device number; devices stay separate but linked).
  const sub = await appleForDevice(identity);
  if (sub) for (const d of await devicesForApple(sub)) { devset.add(d); idset.add(d); }
  return { identities: Array.from(idset), devices: Array.from(devset), ips: Array.from(ipset) };
}

// Terminate + permanently ban the identity, its devices, and any other identities
// seen on those devices. Associated IPs are returned only for admin context.
export async function terminateAndBan(identity: string): Promise<BanImpact> {
  const impact = await previewTermination(identity);
  // Ban the identities and devices only. Associated IPs stay in `impact` for the
  // record/preview but are deliberately NOT added to the ban list.
  await storeUpdate<BanList, void>(BAN_KEY, { identities: [], devices: [], ips: [] }, (stored) => {
    const b = {
      identities: Array.isArray(stored.identities) ? stored.identities : [],
      devices: Array.isArray(stored.devices) ? stored.devices : [],
      ips: Array.isArray(stored.ips) ? stored.ips : []
    };
    b.identities = Array.from(new Set([...b.identities, ...impact.identities]));
    b.devices = Array.from(new Set([...b.devices, ...impact.devices]));
    return { value: b, result: undefined };
  });
  for (const i of impact.identities) {
    await storeUpdate<SafetyAccount | null, void>(acctKey(i), null, (stored) => {
      const a = normalizeSafetyAccount(i, stored);
      a.status = "terminated"; a.pendingSuspension = null; a.updatedAt = Date.now();
      return { value: a, result: undefined };
    });
    await allIndexAdd(i);
    await indexRemove(i);
  }
  return impact;
}

// The admin review queue: every currently-suspended account + its retained
// flagged messages (the only point at which that content becomes visible).
export async function reviewQueue(): Promise<SafetyAccount[]> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  const ids = Array.isArray(idx?.ids) ? [...new Set(idx.ids.filter((id): id is string => typeof id === "string"))].slice(-50_000) : [];
  const stored = await storeGetMany<SafetyAccount>(ids.map(acctKey));
  const out = ids
    .filter((id) => stored.has(acctKey(id)))
    .map((id) => normalizeSafetyAccount(id, stored.get(acctKey(id))))
    .filter((account) => account.status === "suspended");
  return out;
}
