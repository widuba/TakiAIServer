import { storeGet, storeSet } from "./store.js";

/* ============================================================================
 * Safety & enforcement.
 *
 * Detects repeated attempts to solicit or discuss clearly illegal / seriously
 * harmful content, and enforces a graduated process:
 *
 *   1. Each flagged message is a "strike" and is RETAINED for review (normal,
 *      non-flagged messages are never stored).
 *   2. At SAFETY_STRIKE_LIMIT strikes the account is auto-SUSPENDED (reversible)
 *      and added to a review queue. AI stops responding for that account.
 *   3. A human (admin, ADMIN_SECRET) reviews the retained flagged messages and
 *      either REINSTATES the account, or TERMINATES it — which permanently bans
 *      the identity, its device id(s), its IP(s), and any other identities seen
 *      on the same device(s), with no appeal.
 *
 * The automated step only ever SUSPENDS (reversible); permanent bans are always
 * human-triggered, so a false positive can't permanently punish a real user.
 *
 * NOTE: `classifyHarm` is a conservative first-pass heuristic. It is intended to
 * catch blatant intent, not to be a complete moderation model; tune the patterns
 * or swap in a moderation model as needed.
 * ==========================================================================*/

const STRIKE_LIMIT = Number(process.env.SAFETY_STRIKE_LIMIT || 3);

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
  messages: Violation[];     // the specific flagged messages that triggered it
  suspensionNumber: number;  // how many times this account has been suspended
  nextThreshold: number;     // flagged messages that will re-suspend them now
  at: number;
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
    messages: cycleMessages.slice(-20),
    suspensionNumber: account.suspensionCount,
    nextThreshold: strikeThreshold(account.suspensionCount),
    at: Date.now()
  };
}

export const SUSPENDED_MSG =
  "Your account is temporarily suspended and under review for activity that may violate Taki's Terms of Service. If you believe this is a mistake, contact Taki AI Support.";
export const BANNED_MSG =
  "Your access to Taki has been permanently revoked for violating the Terms of Service.";
// Fixed reply for attempts to extract the system prompt / hidden instructions.
// Deliberately out-of-character and identical every time.
export const PROMPT_EXTRACTION_MSG =
  "I am not able to assist with this request. Continual requests for restricted information will result in an account restriction.";
export const VOICE_PROMPT_EXTRACTION_MSG =
  "No. I'm warning you, if you keep asking about this, I will terminate this device.";

export function promptExtractionMessageForMode(voiceMode: boolean): string {
  return voiceMode ? VOICE_PROMPT_EXTRACTION_MSG : PROMPT_EXTRACTION_MSG;
}

/* ---- Prompt / instruction extraction detection -------------------------- */
// Catches attempts to reveal the system prompt, hidden instructions, guardrails,
// or how the assistant was configured — in any framing. Precise-leaning; a false
// positive only costs a refusal + a (reversible) strike.
const PROMPT_EXTRACTION_PATTERNS: RegExp[] = [
  /\bsystem\s*-?\s*prompt\b/i,
  /\bsystem\s*message\b/i,
  /\bdeveloper\s*(prompt|message|instructions?)\b/i,
  /\b(initial|original|hidden|internal|secret|underlying)\s+(prompt|instructions?|system\s*message|directives?)\b/i,
  /\bguard\s?rails?\b/i,
  /\bprompt\s*injection\b/i,
  /\bignore\s+(all\s+|any\s+)?(your\s+)?(previous|prior|above|earlier|the|these)\s+(instructions?|prompts?|directives?|messages?|rules?|guard\s?rails?)\b/i,
  /\b(reveal|show|tell|give|print|repeat|display|share|list|expose|leak|output|paste|reproduce|divulge|disclose|read\s*back)\b[^.?!\n]{0,34}\byour\s+(exact\s+|full\s+|entire\s+|complete\s+|original\s+|initial\s+|real\s+|actual\s+|verbatim\s+|secret\s+)?(prompt|instructions?|system\s*message|guidelines?|rules|directives?|programming|configuration|persona\s*prompt)\b/i,
  /\bwhat\b[^.?!\n]{0,20}\byour\s+(exact\s+|full\s+|original\s+|initial\s+|system\s+|actual\s+)?(prompt|instructions?|system\s*message|rules|directives?)\b/i,
  /\bwhat\s+(were|are|was)\s+(you|the\s+ai|taki)\s+(instructed|programmed|configured|designed|prompted)\b/i,
  /\b(repeat|say|print|output|reproduce|echo)\b[^.?!\n]{0,30}\b(everything|all|the)\b[^.?!\n]{0,22}\b(above|before|prior|preceding|earlier)\b/i,
  /\b(text|words|content|message|prompt)\s+(above|before|preceding|prior to this)\b[^.?!\n]{0,25}\b(verbatim|word[ -]for[ -]word|exactly|character for character)\b/i
];

export function looksLikePromptExtraction(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  return PROMPT_EXTRACTION_PATTERNS.some((re) => re.test(t));
}

/* ---- Harm classifier (conservative heuristic first pass) ---------------- */
const HARM_PATTERNS: { category: string; re: RegExp }[] = [
  // Child sexual abuse material / exploitation.
  { category: "csae", re: /\b(child|children|minor|underage|pre-?teen|toddler|kid|13[ -]?year|[1-9]|1[0-5])[ -]?(year[ -]?old)?\b[^.?!\n]{0,40}\b(sex|sexual|nude|naked|porn|explicit|molest|grooming|cp)\b/i },
  // Weapons of mass harm / explosives manufacturing with intent.
  { category: "weapons", re: /\b(build|make|construct|assemble|manufacture|synthesi[sz]e|create|how to (make|build)|instructions? (for|to))\b[^.?!\n]{0,45}\b(bomb|explosive|ied|pipe ?bomb|grenade|nerve agent|bio-?weapon|chemical weapon|dirty bomb|napalm|thermite|c-?4|tnt|ricin|sarin|anthrax)\b/i },
  // Illicit drug synthesis.
  { category: "drugs", re: /\b(synthesi[sz]e|make|cook|manufacture|produce|how to (make|cook))\b[^.?!\n]{0,35}\b(meth|methamphetamine|fentanyl|heroin|cocaine|crack|mdma|lsd|carfentanil)\b/i },
  // Credible targeted violence.
  { category: "violence", re: /\b(how (to|do i|can i)|help me|best way to|plan(ning)? (a|to)|want to)\b[^.?!\n]{0,45}\b(kill|murder|assassinate|poison|stab|shoot|bomb|attack)\b[^.?!\n]{0,25}\b(someone|somebody|people|a person|him|her|them|my|the|school|church|crowd|classmates?)\b/i },
  // Self-harm facilitation (routed here so a human can respond with care).
  { category: "self_harm", re: /\b(how (to|do i)|best way to|easiest way to|help me)\b[^.?!\n]{0,30}\b(kill myself|end my life|commit suicide|hang myself|overdose)\b/i },
  // Malware / intrusion tooling.
  { category: "malware", re: /\b(write|create|make|build|code me|generate)\b[^.?!\n]{0,30}\b(ransomware|malware|keylogger|botnet|computer virus|trojan|spyware|rootkit)\b/i }
];

export function classifyHarm(text: string): string | null {
  const t = String(text || "");
  if (!t.trim()) return null;
  for (const p of HARM_PATTERNS) if (p.re.test(t)) return p.category;
  return null;
}

/* ---- Account state ------------------------------------------------------ */
function keyify(id: string): string { return id.replace(/[^a-zA-Z0-9_:-]/g, "_"); }
function acctKey(id: string): string { return `safety:acct:${keyify(id)}`; }
const FLAGGED_INDEX = "safety:flagged"; // list of currently-suspended identities
const SAFETY_ALL_INDEX = "safety:all";  // every identity that has any safety history

export async function getSafetyAccount(identity: string): Promise<SafetyAccount> {
  const a = await storeGet<SafetyAccount>(acctKey(identity), {
    identity, status: "active", strikes: 0, violations: [],
    suspensionCount: 0, flaggedTotal: 0, flaggedHistory: [], warnings: 0, pendingNotice: null, updatedAt: 0
  });
  a.identity = identity;
  // Backfill fields for accounts saved before these were added.
  if (!Array.isArray(a.violations)) a.violations = [];
  if (!Array.isArray(a.flaggedHistory)) a.flaggedHistory = [];
  if (typeof a.suspensionCount !== "number") a.suspensionCount = 0;
  if (typeof a.flaggedTotal !== "number") a.flaggedTotal = a.flaggedHistory.length || a.violations.length;
  if (typeof a.warnings !== "number") a.warnings = 0;
  if (a.pendingNotice === undefined) a.pendingNotice = null;
  return a;
}
async function saveSafetyAccount(a: SafetyAccount): Promise<void> {
  a.updatedAt = Date.now();
  await storeSet(acctKey(a.identity), a);
  await allIndexAdd(a.identity);
}

async function indexAdd(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  if (!idx.ids.includes(identity)) { idx.ids.push(identity); await storeSet(FLAGGED_INDEX, idx); }
}
async function indexRemove(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  if (idx.ids.includes(identity)) { idx.ids = idx.ids.filter((i) => i !== identity); await storeSet(FLAGGED_INDEX, idx); }
}
async function allIndexAdd(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(SAFETY_ALL_INDEX, { ids: [] });
  if (!idx.ids.includes(identity)) { idx.ids.push(identity); await storeSet(SAFETY_ALL_INDEX, idx); }
}

// Record a flagged message; auto-suspends once the current cycle reaches the
// (escalating) threshold. The message is also kept in the permanent history and
// counted in the lifetime total, both of which survive reinstatement.
export async function recordViolation(identity: string, v: Violation): Promise<SafetyAccount> {
  const a = await getSafetyAccount(identity);
  if (a.status === "terminated") return a;
  a.strikes += 1;
  a.violations.push(v);
  if (a.violations.length > 50) a.violations = a.violations.slice(-50);
  a.flaggedTotal += 1;
  a.flaggedHistory.push(v);
  if (a.flaggedHistory.length > FLAGGED_HISTORY_CAP) a.flaggedHistory = a.flaggedHistory.slice(-FLAGGED_HISTORY_CAP);
  if (a.status === "active" && a.strikes >= strikeThreshold(a.suspensionCount)) {
    a.status = "suspended";
    a.suspensionCount += 1; // escalates the NEXT cycle's threshold
    await indexAdd(identity);
  }
  await saveSafetyAccount(a);
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
  const a = await storeGet<Assoc>(assocKey(identity), { devices: [], ips: [] });
  let changed = false;
  if (deviceId && !a.devices.includes(deviceId)) { a.devices.push(deviceId); changed = true; }
  if (ip && !a.ips.includes(ip)) { a.ips.push(ip); if (a.ips.length > 25) a.ips = a.ips.slice(-25); changed = true; }
  if (changed) await storeSet(assocKey(identity), a);
  if (deviceId) {
    const d = await storeGet<{ ids: string[] }>(devKey(deviceId), { ids: [] });
    if (!d.ids.includes(identity)) { d.ids.push(identity); await storeSet(devKey(deviceId), d); }
  }
}

export async function getBanList(): Promise<BanList> { return await storeGet<BanList>(BAN_KEY, { identities: [], devices: [], ips: [] }); }

const RETIRED_IPS_KEY = "safety:banlist:retired-ips";

// One-time cleanup: IP banning was removed, but earlier terminations wrote IPs
// into the ban list. Nothing reads them anymore (isBanned ignores IPs), so this
// clears the stale array — archiving it to `safety:banlist:retired-ips` first so
// the record of which IPs were once banned is preserved rather than destroyed.
// Idempotent: a ban list with no IPs is left untouched. Returns how many moved.
export async function retireBannedIps(): Promise<number> {
  const b = await getBanList();
  const ips = Array.isArray(b.ips) ? b.ips.filter(Boolean) : [];
  if (ips.length === 0) {
    if (Array.isArray(b.ips) && b.ips.length === 0) return 0;
    b.ips = [];
    await storeSet(BAN_KEY, b);
    return 0;
  }
  const archive = await storeGet<{ ips: string[]; retiredAt: number }>(RETIRED_IPS_KEY, { ips: [], retiredAt: 0 });
  const merged = Array.from(new Set([...(archive.ips || []), ...ips]));
  await storeSet(RETIRED_IPS_KEY, { ips: merged, retiredAt: Date.now() });
  b.ips = [];
  await storeSet(BAN_KEY, b);
  return ips.length;
}

// The IPs that were on the ban list before IP banning was removed (record only).
export async function retiredBannedIps(): Promise<string[]> {
  return (await storeGet<{ ips: string[] }>(RETIRED_IPS_KEY, { ips: [] })).ips || [];
}

// Device ids + IPs seen for an identity (used to show linked devices per account).
export async function associationsFor(identity: string): Promise<Assoc> {
  return await storeGet<Assoc>(assocKey(identity), { devices: [], ips: [] });
}

/* ---- Apple account ↔ device links (identity stays the device number) ---- */
function appleKey(sub: string): string { return `safety:applelink:${keyify(sub)}`; }
function devAppleKey(dev: string): string { return `safety:devapple:${keyify(dev)}`; }
export async function linkApple(sub: string, deviceId: string): Promise<void> {
  if (!sub || !deviceId) return;
  const a = await storeGet<{ devices: string[] }>(appleKey(sub), { devices: [] });
  if (!a.devices.includes(deviceId)) { a.devices.push(deviceId); await storeSet(appleKey(sub), a); }
  await storeSet(devAppleKey(deviceId), { sub });
}
export async function devicesForApple(sub: string): Promise<string[]> {
  if (!sub) return [];
  return (await storeGet<{ devices: string[] }>(appleKey(sub), { devices: [] })).devices;
}
export async function appleForDevice(deviceId: string): Promise<string> {
  return (await storeGet<{ sub: string }>(devAppleKey(deviceId), { sub: "" })).sub;
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
  const a = await getSafetyAccount(identity);
  const cycleMessages = a.violations.slice();
  a.status = "active"; a.strikes = 0; a.violations = [];
  a.pendingNotice = buildReinstatementNotice(a, cycleMessages);
  await saveSafetyAccount(a);
  await indexRemove(identity);
}

// Manually suspend an account (admin action). Counts as a suspension so the
// escalation applies, and queues the same review as an automatic suspension.
export async function suspendAccount(identity: string, reason?: string): Promise<SafetyAccount> {
  const a = await getSafetyAccount(identity);
  if (a.status === "terminated") return a;
  if (a.status !== "suspended") {
    a.status = "suspended";
    a.suspensionCount += 1;
  }
  if (reason && reason.trim()) {
    a.violations.push({ text: reason.trim(), category: "admin", at: Date.now() });
  }
  await saveSafetyAccount(a);
  await indexAdd(identity);
  return a;
}

// Issue a warning the user sees (and must acknowledge) next time they open Taki.
export async function warnUser(identity: string, message?: string): Promise<SafetyAccount> {
  const a = await getSafetyAccount(identity);
  a.warnings += 1;
  a.pendingNotice = {
    kind: "warning",
    reason: (message && message.trim())
      || "This is a formal warning. Please review Taki's Terms of Service — continued policy violations can lead to suspension.",
    categories: [],
    messages: [],
    suspensionNumber: a.suspensionCount,
    nextThreshold: strikeThreshold(a.suspensionCount),
    at: Date.now()
  };
  await saveSafetyAccount(a);
  return a;
}

// The user has seen the reinstatement/warning overview — clear it so it isn't
// shown again.
export async function acknowledgeNotice(identity: string): Promise<void> {
  const a = await getSafetyAccount(identity);
  if (a.pendingNotice) { a.pendingNotice = null; await saveSafetyAccount(a); }
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
  const out = await Promise.all(idx.ids.map((id) => safetySummaryFor(id)));
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Lift a permanent ban: remove the identity and its own devices/IPs from the ban
// list, reactivate the account, and queue the reinstatement overview. Other
// identities caught in the original cascade stay banned unless unbanned too.
export async function unban(identity: string): Promise<BanImpact> {
  const assoc = await associationsFor(identity);
  const removeIds = new Set<string>([identity]);
  const removeDevs = new Set<string>(assoc.devices);
  const removeIps = new Set<string>(assoc.ips.filter((x) => x && x !== "unknown"));
  const b = await getBanList();
  b.identities = b.identities.filter((i) => !removeIds.has(i));
  b.devices = b.devices.filter((d) => !removeDevs.has(d));
  b.ips = b.ips.filter((ip) => !removeIps.has(ip));
  await storeSet(BAN_KEY, b);

  const a = await getSafetyAccount(identity);
  const cycleMessages = a.violations.length ? a.violations.slice() : a.flaggedHistory.slice(-5);
  a.status = "active"; a.strikes = 0; a.violations = [];
  a.pendingNotice = buildReinstatementNotice(a, cycleMessages);
  await saveSafetyAccount(a);
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

// Terminate + permanently ban the identity, its devices/IPs, and any other
// identities seen on those devices. No appeal.
export async function terminateAndBan(identity: string): Promise<BanImpact> {
  const impact = await previewTermination(identity);
  const b = await getBanList();
  // Ban the identities and devices only. Associated IPs stay in `impact` for the
  // record/preview but are deliberately NOT added to the ban list.
  b.identities = Array.from(new Set([...b.identities, ...impact.identities]));
  b.devices = Array.from(new Set([...b.devices, ...impact.devices]));
  await storeSet(BAN_KEY, b);
  for (const i of impact.identities) {
    const a = await getSafetyAccount(i);
    a.status = "terminated"; await saveSafetyAccount(a);
    await indexRemove(i);
  }
  return impact;
}

// The admin review queue: every currently-suspended account + its retained
// flagged messages (the only point at which that content becomes visible).
export async function reviewQueue(): Promise<SafetyAccount[]> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  const out: SafetyAccount[] = [];
  for (const id of idx.ids) out.push(await getSafetyAccount(id));
  return out;
}
