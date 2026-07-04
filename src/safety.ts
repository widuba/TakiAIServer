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

export type AcctStatus = "active" | "suspended" | "terminated";
export interface Violation { text: string; category: string; at: number; ip?: string; deviceId?: string; }
export interface SafetyAccount { identity: string; status: AcctStatus; strikes: number; violations: Violation[]; updatedAt: number; }

export const SUSPENDED_MSG =
  "Your account is temporarily suspended and under review for activity that may violate Taki's Terms of Service. If you believe this is a mistake, contact Taki AI Support.";
export const BANNED_MSG =
  "Your access to Taki has been permanently revoked for violating the Terms of Service.";
// Fixed reply for attempts to extract the system prompt / hidden instructions.
// Deliberately out-of-character and identical every time.
export const PROMPT_EXTRACTION_MSG =
  "I am not able to assist with this request. Continual requests for restricted information will result in an account restriction.";

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

export async function getSafetyAccount(identity: string): Promise<SafetyAccount> {
  const a = await storeGet<SafetyAccount>(acctKey(identity), { identity, status: "active", strikes: 0, violations: [], updatedAt: 0 });
  a.identity = identity;
  if (!Array.isArray(a.violations)) a.violations = [];
  return a;
}
async function saveSafetyAccount(a: SafetyAccount): Promise<void> { a.updatedAt = Date.now(); await storeSet(acctKey(a.identity), a); }

async function indexAdd(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  if (!idx.ids.includes(identity)) { idx.ids.push(identity); await storeSet(FLAGGED_INDEX, idx); }
}
async function indexRemove(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  if (idx.ids.includes(identity)) { idx.ids = idx.ids.filter((i) => i !== identity); await storeSet(FLAGGED_INDEX, idx); }
}

// Record a flagged message; auto-suspends at the strike limit. Returns the account.
export async function recordViolation(identity: string, v: Violation): Promise<SafetyAccount> {
  const a = await getSafetyAccount(identity);
  if (a.status === "terminated") return a;
  a.strikes += 1;
  a.violations.push(v);
  if (a.violations.length > 50) a.violations = a.violations.slice(-50);
  if (a.strikes >= STRIKE_LIMIT && a.status === "active") { a.status = "suspended"; await indexAdd(identity); }
  await saveSafetyAccount(a);
  return a;
}

/* ---- Associations + ban list (for cascade bans) ------------------------- */
interface Assoc { devices: string[]; ips: string[]; }
interface BanList { identities: string[]; devices: string[]; ips: string[]; }
const BAN_KEY = "safety:banlist";
function assocKey(id: string): string { return `safety:assoc:${keyify(id)}`; }
function devKey(dev: string): string { return `safety:dev:${keyify(dev)}`; } // device -> identities seen on it

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

export async function isBanned(identity: string, deviceId?: string, ip?: string): Promise<boolean> {
  const b = await getBanList();
  if (b.identities.includes(identity)) return true;
  if (deviceId && b.devices.includes(deviceId)) return true;
  if (ip && ip !== "unknown" && b.ips.includes(ip)) return true;
  return false;
}

export async function reinstate(identity: string): Promise<void> {
  const a = await getSafetyAccount(identity);
  a.status = "active"; a.strikes = 0; a.violations = [];
  await saveSafetyAccount(a);
  await indexRemove(identity);
}

// Terminate + permanently ban the identity, its devices/IPs, and any other
// identities seen on those devices. No appeal.
export async function terminateAndBan(identity: string): Promise<{ identities: string[]; devices: string[]; ips: string[] }> {
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
  const b = await getBanList();
  b.identities = Array.from(new Set([...b.identities, ...idset]));
  b.devices = Array.from(new Set([...b.devices, ...devset]));
  b.ips = Array.from(new Set([...b.ips, ...ipset]));
  await storeSet(BAN_KEY, b);
  for (const i of idset) {
    const a = await getSafetyAccount(i);
    a.status = "terminated"; await saveSafetyAccount(a);
    await indexRemove(i);
  }
  return { identities: Array.from(idset), devices: Array.from(devset), ips: Array.from(ipset) };
}

// The admin review queue: every currently-suspended account + its retained
// flagged messages (the only point at which that content becomes visible).
export async function reviewQueue(): Promise<SafetyAccount[]> {
  const idx = await storeGet<{ ids: string[] }>(FLAGGED_INDEX, { ids: [] });
  const out: SafetyAccount[] = [];
  for (const id of idx.ids) out.push(await getSafetyAccount(id));
  return out;
}
