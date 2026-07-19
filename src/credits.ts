import { storeGet, storeSet, isDurable } from "./store.js";
import { CREDIT_USD, sttCostUsd, ttsCostUsd } from "./metering.js";

export { CREDIT_USD } from "./metering.js";

/* ============================================================================
 * Subscriptions & credits — the metering ENGINE (Phase 1).
 *
 * A credit represents exactly $0.001 of list-price vendor usage. Gemini token
 * metadata, grounding requests, and paid TTS are accumulated as microdollars;
 * only complete credits are deducted. Credits expire 90 days after each grant.
 *
 * Identity is the device id for now (no accounts yet). Real Apple IAP + accounts
 * are a later pass; tiers are granted via /api/credits/grant meanwhile.
 *
 * Persistence: the Postgres-durable blob store (store.ts), one blob per device
 * under "credits:<deviceId>". A per-device in-memory mutex serializes the
 * read-modify-write (fine for a single Render instance).
 * ==========================================================================*/

/* ---- CONFIG (tune these) ------------------------------------------------- */

export const GRANT_EXPIRY_DAYS = 90;      // credits expire 90 days after purchase
export const FREE_STARTER_CREDITS = 100;  // a fresh device gets this once, so the app works pre-subscription

export type Tier = "free" | "plus" | "plus_voice" | "pro";

export interface TierConfig {
  label: string;
  creditsPerCycle: number;   // granted each subscription cycle
  priceUsd: number;          // display only (real pricing lives in App Store later)
  voiceIncluded: boolean;    // voice-mode questions cost no surcharge
  extraCreditDiscount: number; // discount on extra credit packs (used when IAP lands)
}

// Credits are direct usage value: 3,000 credits cover $3.00 of vendor usage.
export const TIERS: Record<Tier, TierConfig> = {
  free:       { label: "Free",       creditsPerCycle: 0,     priceUsd: 0,     voiceIncluded: false, extraCreditDiscount: 0 },
  plus:       { label: "Plus",       creditsPerCycle: 3000,  priceUsd: 9.99,  voiceIncluded: false, extraCreditDiscount: 0 },
  plus_voice: { label: "Plus Voice", creditsPerCycle: 4000,  priceUsd: 14.99, voiceIncluded: true,  extraCreditDiscount: 0 },
  // Pro now includes voice (on base credits only, like Plus Voice).
  pro:        { label: "Pro",        creditsPerCycle: 15000, priceUsd: 29.99, voiceIncluded: true,  extraCreditDiscount: 0.2 }
};

// Voice pricing. Plus Voice / Pro get a per-cycle allowance of included speech;
// after that, voice continues at list-price STT/TTS cost against normal credits.
// Free gets five lifetime included turns, then follows that same paid path.
export const FREE_VOICE_PER_CYCLE: Record<Tier, number> = { free: 0, plus: 0, plus_voice: 150, pro: 150 };
export const FREE_VOICE_LIMIT = 5;
export const APP_STORE_COMMISSION_RATE = 0.15;
export const MAX_VOICE_RESPONSE_CHARS = 280;
export const MAX_VOICE_INPUT_MS = 60_000;

// Images and uploaded files have a predictable multimodal processing floor in
// addition to measured Gemini usage. URLs and pasted text do not pay this fee.
export const ATTACHMENT_BASE_CREDITS = 40;
export function attachmentBaseCostCredits(attachments: Array<{ kind?: unknown }>): number {
  return attachments.filter((attachment) => attachment?.kind === "image" || attachment?.kind === "file").length
    * ATTACHMENT_BASE_CREDITS;
}

// Is this voice turn covered by the free-voice allowance? Only on an included
// tier, only while base subscription credits remain, and only under the cap.
export function isFreeVoice(tier: Tier, baseCredits: number, voiceCycleUsed: number, voiceLifetimeUsed = 0): boolean {
  if (tier === "free") return voiceLifetimeUsed < FREE_VOICE_LIMIT;
  const cap = FREE_VOICE_PER_CYCLE[tier] || 0;
  return cap > 0 && baseCredits > 0 && voiceCycleUsed < cap;
}
// Credits charged for a paid voice turn (beyond the free allowance).
export function worstCaseContributionUsd(tier: Tier): number {
  const config = TIERS[tier];
  const netRevenue = config.priceUsd * (1 - APP_STORE_COMMISSION_RATE);
  const aiCost = config.creditsPerCycle * CREDIT_USD;
  // Every included turn may use the full cloud-transcription fallback and
  // synthesizes one final response capped to MAX_VOICE_RESPONSE_CHARS.
  const voiceCost = FREE_VOICE_PER_CYCLE[tier]
    * (sttCostUsd(MAX_VOICE_INPUT_MS) + ttsCostUsd(MAX_VOICE_RESPONSE_CHARS));
  return netRevenue - aiCost - voiceCost;
}

/* ---- LEDGER -------------------------------------------------------------- */

export interface CreditGrant {
  id: string;
  amount: number;      // originally granted
  remaining: number;   // still available
  grantedAt: number;   // epoch ms
  expiresAt: number;   // epoch ms (grantedAt + 90d)
  source: string;      // "free_starter" | "subscription:plus" | ...
}

// Minimum balance required to ask anything (cut users off before they hit 0,
// so a request can't overspend into a negative balance).
export const MIN_REQUEST_CREDITS = 1;
export interface CreditAccount {
  deviceId: string;
  tier: Tier;
  grants: CreditGrant[];
  starterGiven?: boolean;
  // Billing-period keys already granted (StoreKit), so a renewal grants once.
  processedTx?: string[];
  // Lifetime count of voice questions asked (enforces the free-tier voice cap).
  voiceCount?: number;
  // FREE voice turns used THIS billing cycle (reset on renewal). Enforces the
  // per-cycle free-voice allowance for Plus Voice / Pro.
  voiceCycleCount?: number;
  dailyUsage?: { key: string; used: number };
  monthlyUsage?: { key: string; used: number };
  topupAllowances?: { id: string; amount: number; expiresAt: number }[];
  retiredSubscriptionIds?: string[];
  // Unbilled vendor cost below one credit, stored as integer millionths of a
  // dollar. 1 credit is exactly 1,000 microdollars ($0.001).
  usageRemainderMicros?: number;
  updatedAt: number;
}

export interface UsageWindow {
  used: number;
  limit: number;
  resetsAt: number;
  percent: number;
}

export interface CreditSummary {
  tier: Tier;
  balance: number;
  nextExpiry: number | null; // epoch ms of the soonest-expiring grant
  // Per-grant breakdown so the UI can show "1,000 credits expire Sep 27".
  expiring: { credits: number; expiresAt: number }[];
  durable: boolean;
  voiceUsed: number;          // voice questions asked (for the free-tier cap)
  // Remaining BASE subscription credits (source "subscription:*"). Free/included
  // voice only applies while these are > 0 — purchased top-ups never get it.
  baseCredits: number;
  // FREE voice turns used this cycle (for the per-cycle allowance).
  voiceCycleUsed: number;
  voiceAllowanceUsed: number;
  voiceAllowanceLimit: number;
  additionalCredits: number;
  daily: UsageWindow;
  monthly: UsageWindow;
  limitReached: boolean;
  limitReason: "daily" | "monthly" | null;
  duplicateSubscriptionNeedsCancellation: boolean;
}

function keyFor(deviceId: string): string {
  return `credits:${deviceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

// Per-device serialization so concurrent requests don't clobber the blob.
const chains = new Map<string, Promise<unknown>>();
function withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(deviceId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(deviceId, run.then(() => {}, () => {}));
  return run;
}

async function load(deviceId: string): Promise<CreditAccount> {
  const acct = await storeGet<CreditAccount>(keyFor(deviceId), {
    deviceId, tier: "free", grants: [], starterGiven: false, updatedAt: 0
  });
  acct.deviceId = deviceId;
  if (!Array.isArray(acct.grants)) acct.grants = [];
  // Drop fully-expired / emptied grants to keep the blob small.
  const now = Date.now();
  acct.grants = acct.grants.filter((g) => g.expiresAt > now && g.remaining > 0);
  if (!Array.isArray(acct.topupAllowances)) acct.topupAllowances = [];
  for (const grant of acct.grants) {
    if (/topup/i.test(grant.source) && !acct.topupAllowances.some((item) => item.id === grant.id)) {
      acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
    }
  }
  acct.topupAllowances = acct.topupAllowances.filter((item) => item.expiresAt > now && item.amount > 0);
  rollUsageWindows(acct, now);
  return acct;
}

async function save(acct: CreditAccount): Promise<void> {
  acct.updatedAt = Date.now();
  await storeSet(keyFor(acct.deviceId), acct);
}

function addGrant(acct: CreditAccount, source: string, amount: number): CreditGrant | null {
  if (amount <= 0) return null;
  const now = Date.now();
  const grant: CreditGrant = {
    id: `g_${now}_${Math.random().toString(36).slice(2, 7)}`,
    amount, remaining: amount, grantedAt: now,
    expiresAt: now + GRANT_EXPIRY_DAYS * 86400000,
    source
  };
  acct.grants.push(grant);
  return grant;
}

export function balanceOf(acct: CreditAccount): number {
  const now = Date.now();
  return acct.grants.reduce((sum, g) => (g.expiresAt > now ? sum + g.remaining : sum), 0);
}

function ensureStarter(acct: CreditAccount): boolean {
  if (acct.starterGiven) return false;
  if (FREE_STARTER_CREDITS > 0) addGrant(acct, "free_starter", FREE_STARTER_CREDITS);
  acct.starterGiven = true;
  return true;
}

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function utcMonthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function nextUTCDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function nextUTCMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function rollUsageWindows(acct: CreditAccount, now = Date.now()): void {
  const day = utcDayKey(now);
  const month = utcMonthKey(now);
  if (acct.dailyUsage?.key !== day) acct.dailyUsage = { key: day, used: 0 };
  if (acct.monthlyUsage?.key !== month) acct.monthlyUsage = { key: month, used: 0 };
}

export function usageLimitsFor(tier: Tier, additionalCredits: number): { daily: number; monthly: number } {
  const base = tier === "free" ? FREE_STARTER_CREDITS : TIERS[tier].creditsPerCycle;
  const additional = Math.max(0, Math.floor(additionalCredits));
  return {
    daily: Math.ceil(base * 0.05) + additional,
    monthly: base + additional
  };
}

function usageWindow(used: number, limit: number, resetsAt: number): UsageWindow {
  const safeLimit = Math.max(0, limit);
  const safeUsed = Math.max(0, Math.round(used));
  return {
    used: safeUsed,
    limit: safeLimit,
    resetsAt,
    percent: safeLimit > 0 ? Math.min(100, Math.round((safeUsed / safeLimit) * 100)) : 100
  };
}

function summarize(acct: CreditAccount): CreditSummary {
  const now = Date.now();
  rollUsageWindows(acct, now);
  const live = acct.grants
    .filter((g) => g.expiresAt > now && g.remaining > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  const additionalCredits = (acct.topupAllowances || [])
    .filter((item) => item.expiresAt > now)
    .reduce((sum, item) => sum + item.amount, 0);
  const limits = usageLimitsFor(acct.tier, additionalCredits);
  const daily = usageWindow(acct.dailyUsage?.used || 0, limits.daily, nextUTCDay(now));
  const monthly = usageWindow(acct.monthlyUsage?.used || 0, limits.monthly, nextUTCMonth(now));
  const voiceAllowanceLimit = acct.tier === "free" ? FREE_VOICE_LIMIT : FREE_VOICE_PER_CYCLE[acct.tier] || 0;
  const voiceAllowanceUsed = Math.min(
    voiceAllowanceLimit,
    acct.tier === "free" ? acct.voiceCount || 0 : acct.voiceCycleCount || 0
  );
  const limitReason = daily.used >= daily.limit ? "daily" : monthly.used >= monthly.limit ? "monthly" : null;
  return {
    tier: acct.tier,
    balance: balanceOf(acct),
    nextExpiry: live[0]?.expiresAt ?? null,
    expiring: live.map((g) => ({ credits: g.remaining, expiresAt: g.expiresAt })),
    durable: isDurable(),
    voiceUsed: acct.voiceCount || 0,
    baseCredits: live.filter((g) => g.source.startsWith("subscription:")).reduce((s, g) => s + g.remaining, 0),
    voiceCycleUsed: acct.voiceCycleCount || 0,
    voiceAllowanceUsed,
    voiceAllowanceLimit,
    additionalCredits,
    daily,
    monthly,
    limitReached: limitReason !== null,
    limitReason,
    duplicateSubscriptionNeedsCancellation: (acct.retiredSubscriptionIds || []).length > 0
  };
}

// Record a FREE voice turn against the per-cycle allowance. Returns the new count.
export async function noteFreeVoice(identity: string): Promise<number> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.voiceCycleCount = (acct.voiceCycleCount || 0) + 1;
    await save(acct);
    return acct.voiceCycleCount;
  });
}

// Grant a one-off block of credits (e.g. a web top-up purchase). 90-day expiry
// like any grant; does NOT change the subscription tier.
export async function grantCredits(identity: string, amount: number, source: string): Promise<CreditSummary> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    const grant = addGrant(acct, source, Math.max(0, Math.floor(amount)));
    if (grant && /topup/i.test(source)) {
      acct.topupAllowances = acct.topupAllowances || [];
      acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
    }
    acct.starterGiven = true;
    await save(acct);
    return summarize(acct);
  });
}

// Web top-up pricing: server-authoritative (never trust a client-sent price).
// Deliberately POOR value vs. a subscription (subscriptions are ~1/3¢ per credit
// of granted value) — buying à la carte is 1¢/credit flat, so subscribing is
// always the better deal. Pro subscribers get 20% off (0.8¢/credit).
export const CREDIT_TOPUP_MIN = 500;
export const CREDIT_TOPUP_MAX = 500000;
export const CREDIT_TOPUP_PRESETS = [500, 5000, 25000];
export const TOPUP_CENTS_PER_CREDIT = 1;      // 1¢ per credit, no volume discount
export const PRO_TOPUP_DISCOUNT = 0.2;         // Pro members: 20% off
// Cents per credit for a given buyer (whole-cent for display; Stripe charges the
// exact computed total).
export function topupCentsPerCredit(isPro: boolean): number {
  return TOPUP_CENTS_PER_CREDIT * (isPro ? 1 - PRO_TOPUP_DISCOUNT : 1);
}
export function topupPriceCents(credits: number, isPro = false): number | null {
  if (!Number.isFinite(credits)) return null;
  const c = Math.floor(credits);
  if (c < CREDIT_TOPUP_MIN || c > CREDIT_TOPUP_MAX) return null;
  return Math.round(c * topupCentsPerCredit(isPro));
}

// Count a voice question (for the free-tier cap). Returns the new total.
export async function noteVoiceQuestion(identity: string): Promise<number> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.voiceCount = (acct.voiceCount || 0) + 1;
    await save(acct);
    return acct.voiceCount;
  });
}

// First-touch starter grant + current summary.
export async function summary(deviceId: string): Promise<CreditSummary> {
  return withLock(deviceId, async () => {
    const acct = await load(deviceId);
    if (ensureStarter(acct)) await save(acct);
    return summarize(acct);
  });
}

// Grant a tier's credits (simulates a purchase/renewal until IAP). New grant
// expires in 90 days; sets the account's tier.
export async function grantTier(deviceId: string, tier: Tier): Promise<CreditSummary> {
  return withLock(deviceId, async () => {
    const acct = await load(deviceId);
    const conf = TIERS[tier];
    if (conf) {
      acct.grants = acct.grants.filter((grant) => grant.source !== "free_starter");
      addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    }
    acct.tier = tier;
    acct.starterGiven = true;
    await save(acct);
    return summarize(acct);
  });
}

// Spend `cost` credits, consuming the SOONEST-expiring grants first. Clamps at 0
// (a last question may slightly overspend rather than be blocked mid-answer).
export async function spend(deviceId: string, cost: number): Promise<CreditSummary & { spent: number }> {
  return withLock(deviceId, async () => {
    const acct = await load(deviceId);
    ensureStarter(acct);
    const now = Date.now();
    let need = Math.max(0, Math.round(cost));
    const ordered = acct.grants
      .filter((g) => g.expiresAt > now && g.remaining > 0)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const g of ordered) {
      if (need <= 0) break;
      const take = Math.min(g.remaining, need);
      g.remaining -= take;
      need -= take;
    }
    acct.grants = acct.grants.filter((g) => g.expiresAt > now && g.remaining > 0);
    const actualSpent = Math.round(cost) - need;
    rollUsageWindows(acct, now);
    acct.dailyUsage!.used += actualSpent;
    acct.monthlyUsage!.used += actualSpent;
    await save(acct);
    return { ...summarize(acct), spent: actualSpent };
  });
}

// Spend exact list-price vendor usage without rounding every request up. Costs
// below one credit accumulate until they reach exactly $0.001.
export async function spendUsageUsd(deviceId: string, costUsd: number): Promise<CreditSummary & { spent: number; usageUsd: number }> {
  return withLock(deviceId, async () => {
    const acct = await load(deviceId);
    ensureStarter(acct);
    const now = Date.now();
    const costMicros = Math.max(0, Math.round(costUsd * 1_000_000));
    const accumulated = Math.max(0, Math.floor(acct.usageRemainderMicros || 0)) + costMicros;
    let need = Math.floor(accumulated / 1000);
    acct.usageRemainderMicros = accumulated % 1000;
    const requested = need;
    const ordered = acct.grants
      .filter((grant) => grant.expiresAt > now && grant.remaining > 0)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const grant of ordered) {
      if (need <= 0) break;
      const take = Math.min(grant.remaining, need);
      grant.remaining -= take;
      need -= take;
    }
    acct.grants = acct.grants.filter((grant) => grant.expiresAt > now && grant.remaining > 0);
    const actualSpent = requested - need;
    rollUsageWindows(acct, now);
    acct.dailyUsage!.used += actualSpent;
    acct.monthlyUsage!.used += actualSpent;
    await save(acct);
    return { ...summarize(acct), spent: actualSpent, usageUsd: costMicros / 1_000_000 };
  });
}

// Rank tiers so a merge keeps the strongest one.
const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, plus_voice: 2, pro: 3 };
function higherTier(a: Tier, b: Tier): Tier {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

// Grant a subscription's credits for a REAL verified StoreKit transaction. Keyed
// by billing period so re-sending the same period (app relaunch, restore) grants
// once. Returns whether it actually granted + the fresh summary.
export async function grantForTransaction(
  identity: string, tier: Tier, periodKey: string
): Promise<{ granted: boolean; summary: CreditSummary }> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.processedTx = acct.processedTx || [];
    if (periodKey && acct.processedTx.includes(periodKey)) {
      acct.tier = higherTier(acct.tier, tier);
      await save(acct);
      return { granted: false, summary: summarize(acct) };
    }
    const conf = TIERS[tier];
    if (conf) {
      acct.grants = acct.grants.filter((grant) => grant.source !== "free_starter");
      addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    }
    acct.tier = tier;
    acct.starterGiven = true;
    acct.voiceCycleCount = 0; // new cycle → reset the free-voice allowance
    if (periodKey) {
      acct.processedTx.push(periodKey);
      if (acct.processedTx.length > 200) acct.processedTx = acct.processedTx.slice(-200);
    }
    await save(acct);
    return { granted: true, summary: summarize(acct) };
  });
}

// Merge one identity's live credits/tier into another (used when a user signs in
// with Apple: their device's credits follow them to the account). The source is
// emptied so nothing is double-counted. Idempotent-ish: only live grants move.
export async function mergeCredits(
  fromId: string,
  toId: string,
  options: { subscriptionMode?: "keep" | "convert" | "discard"; secondaryTransactionId?: string } = {}
): Promise<CreditSummary> {
  if (!fromId || !toId || fromId === toId) return summary(toId);
  return withLock(toId, async () => {
    const from = await load(fromId);
    const to = await load(toId);
    const now = Date.now();
    const mode = options.subscriptionMode || "keep";
    for (const g of from.grants) {
      if (g.expiresAt <= now || g.remaining <= 0) continue;
      if (g.source === "free_starter" && (to.tier !== "free" || to.grants.some((grant) => grant.source === "free_starter"))) continue;
      if (g.source.startsWith("subscription:")) {
        if (mode === "discard") continue;
        if (mode === "convert") {
          const converted: CreditGrant = {
            ...g,
            id: `merged_${g.id}`,
            amount: g.remaining,
            source: `topup:merged_subscription:${options.secondaryTransactionId || "duplicate"}`
          };
          to.grants.push(converted);
          to.topupAllowances = to.topupAllowances || [];
          to.topupAllowances.push({ id: converted.id, amount: converted.remaining, expiresAt: converted.expiresAt });
          to.retiredSubscriptionIds = to.retiredSubscriptionIds || [];
          if (options.secondaryTransactionId && !to.retiredSubscriptionIds.includes(options.secondaryTransactionId)) {
            to.retiredSubscriptionIds.push(options.secondaryTransactionId);
          }
          continue;
        }
      }
      to.grants.push(g);
    }
    to.topupAllowances = [...(to.topupAllowances || []), ...(from.topupAllowances || [])]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
    if (mode === "keep") to.tier = higherTier(to.tier, from.tier);
    to.starterGiven = to.starterGiven || from.starterGiven;
    to.processedTx = [...(to.processedTx || []), ...(from.processedTx || [])].slice(-200);
    await save(to);
    // Empty the source so its credits can't be claimed again.
    await save({ deviceId: fromId, tier: "free", grants: [], starterGiven: true, processedTx: [], topupAllowances: [], updatedAt: Date.now() });
    return summarize(to);
  });
}

// Subscription lapsed naturally (EXPIRED / grace period over): drop to free but
// keep any credits already granted (the user paid for them; 90-day expiry still
// applies).
export async function downgradeToFree(identity: string): Promise<void> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.tier = "free";
    await save(acct);
  });
}

// Refund / revoke: drop to free AND claw back unused subscription-granted credits.
export async function revokeSubscription(identity: string): Promise<void> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.tier = "free";
    for (const g of acct.grants) {
      if (g.source.startsWith("subscription:")) g.remaining = 0;
    }
    const now = Date.now();
    acct.grants = acct.grants.filter((g) => g.remaining > 0 && g.expiresAt > now);
    await save(acct);
  });
}

export async function revokeMergedSubscriptionCredits(identity: string, originalTransactionId: string): Promise<void> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    const source = `topup:merged_subscription:${originalTransactionId}`;
    const removedIds = new Set(acct.grants.filter((grant) => grant.source === source).map((grant) => grant.id));
    acct.grants = acct.grants.filter((grant) => grant.source !== source);
    acct.topupAllowances = (acct.topupAllowances || []).filter((allowance) => !removedIds.has(allowance.id));
    acct.retiredSubscriptionIds = (acct.retiredSubscriptionIds || []).filter((id) => id !== originalTransactionId);
    await save(acct);
  });
}

export async function clearRetiredSubscription(identity: string, originalTransactionId: string): Promise<void> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    acct.retiredSubscriptionIds = (acct.retiredSubscriptionIds || []).filter((id) => id !== originalTransactionId);
    await save(acct);
  });
}

// Dev: wipe a device's credits.
export async function reset(deviceId: string): Promise<void> {
  return withLock(deviceId, async () => {
    await save({ deviceId, tier: "free", grants: [], starterGiven: false, updatedAt: Date.now() });
  });
}

// For the client Membership screen: the tier catalog.
export function tierCatalog() {
  return (Object.keys(TIERS) as Tier[]).map((key) => ({
    key,
    ...TIERS[key],
    includedVoiceTurns: FREE_VOICE_PER_CYCLE[key]
  }));
}
