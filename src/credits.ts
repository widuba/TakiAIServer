import { storeGet, storeSet, isDurable } from "./store.js";

/* ============================================================================
 * Subscriptions & credits — the metering ENGINE (Phase 1).
 *
 * A "credit" == a token that costs ~$0.001 of real AI usage. Credits are granted
 * per subscription cycle and EXPIRE 90 days after the grant. A question's cost
 * scales with its "brainpower" (which model ran it). Voice-mode questions cost
 * extra EXCEPT on the Plus Voice tier. Pro grants more credits + a discount on
 * extra credit purchases (used later when IAP lands).
 *
 * Identity is the device id for now (no accounts yet). Real Apple IAP + accounts
 * are a later pass; tiers are granted via /api/credits/grant meanwhile.
 *
 * Persistence: the Postgres-durable blob store (store.ts), one blob per device
 * under "credits:<deviceId>". A per-device in-memory mutex serializes the
 * read-modify-write (fine for a single Render instance).
 * ==========================================================================*/

/* ---- CONFIG (tune these) ------------------------------------------------- */

export const CREDIT_USD = 0.001;          // 1 credit ≈ $0.001 (0.1¢) of AI usage
export const GRANT_EXPIRY_DAYS = 90;      // credits expire 90 days after purchase
export const FREE_STARTER_CREDITS = 100;  // a fresh device gets this once, so the app works pre-subscription

// Credits charged per question, by "brainpower" tier.
export const COST_TIERS = { light: 1, standard: 4, heavy: 15 } as const;
export type CostTier = keyof typeof COST_TIERS;

// Extra credits when a question runs with voice mode on (waived on Plus Voice).
export const VOICE_SURCHARGE = 3;

export type Tier = "free" | "plus" | "plus_voice" | "pro";

export interface TierConfig {
  label: string;
  creditsPerCycle: number;   // granted each subscription cycle
  priceUsd: number;          // display only (real pricing lives in App Store later)
  voiceIncluded: boolean;    // voice-mode questions cost no surcharge
  extraCreditDiscount: number; // discount on extra credit packs (used when IAP lands)
}

// Credits are set to ~3× the break-even (a tier's credits cost us ~1/3 of its
// price to run), passing profit back to the user. e.g. Plus Voice = 4500 credits
// ≈ $4.50 of usage on a $14.99 plan.
export const TIERS: Record<Tier, TierConfig> = {
  free:       { label: "Free",       creditsPerCycle: 0,     priceUsd: 0,     voiceIncluded: false, extraCreditDiscount: 0 },
  plus:       { label: "Plus",       creditsPerCycle: 3000,  priceUsd: 9.99,  voiceIncluded: false, extraCreditDiscount: 0 },
  plus_voice: { label: "Plus Voice", creditsPerCycle: 4500,  priceUsd: 14.99, voiceIncluded: true,  extraCreditDiscount: 0 },
  pro:        { label: "Pro",        creditsPerCycle: 15000, priceUsd: 29.99, voiceIncluded: false, extraCreditDiscount: 0.2 }
};

// Map a planner intent → a brainpower cost tier. HEAVY = grounded/pro model
// paths; LIGHT = on-device actions (barely any model cost); everything else is
// STANDARD. Retune freely — cost is an intent-based approximation of real usage.
const HEAVY_INTENTS = new Set(["web_search", "prediction", "freshfact", "liveinfo", "lottery", "vision"]);
const LIGHT_INTENTS = new Set([
  "calendar_create", "calendar_update", "calendar_delete", "reminder_create",
  "alarm_set", "alarm_cancel", "timer_set", "timer_cancel", "stopwatch_start", "stopwatch_stop",
  "music_control", "home_control", "health_query", "photos_show", "contact_create",
  "memory_save", "alert_create", "alert_cancel", "scheduled_message", "automation_create",
  "open_app", "maps_search", "maps_directions", "weather_answer", "call_phone"
]);

export function costTierForIntent(intent: string | null | undefined): CostTier {
  const i = intent || "";
  if (HEAVY_INTENTS.has(i)) return "heavy";
  if (LIGHT_INTENTS.has(i)) return "light";
  return "standard"; // answer_only, live_activity, day_plan, cooking_*, compose_*, etc.
}

export function costForRequest(intent: string | null | undefined, voiceMode: boolean, tier: Tier): number {
  const base = COST_TIERS[costTierForIntent(intent)];
  const conf = TIERS[tier] || TIERS.free;
  const surcharge = voiceMode && !conf.voiceIncluded ? VOICE_SURCHARGE : 0;
  return base + surcharge;
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
export const MIN_REQUEST_CREDITS = COST_TIERS.standard; // 4
// Free tier gets a hard cap of voice questions, independent of credits.
export const FREE_VOICE_LIMIT = 5;

export interface CreditAccount {
  deviceId: string;
  tier: Tier;
  grants: CreditGrant[];
  starterGiven?: boolean;
  // Billing-period keys already granted (StoreKit), so a renewal grants once.
  processedTx?: string[];
  // Lifetime count of voice questions asked (enforces the free-tier voice cap).
  voiceCount?: number;
  updatedAt: number;
}

export interface CreditSummary {
  tier: Tier;
  balance: number;
  nextExpiry: number | null; // epoch ms of the soonest-expiring grant
  // Per-grant breakdown so the UI can show "1,000 credits expire Sep 27".
  expiring: { credits: number; expiresAt: number }[];
  durable: boolean;
  voiceUsed: number;          // voice questions asked (for the free-tier cap)
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
  return acct;
}

async function save(acct: CreditAccount): Promise<void> {
  acct.updatedAt = Date.now();
  await storeSet(keyFor(acct.deviceId), acct);
}

function addGrant(acct: CreditAccount, source: string, amount: number): void {
  if (amount <= 0) return;
  const now = Date.now();
  acct.grants.push({
    id: `g_${now}_${Math.random().toString(36).slice(2, 7)}`,
    amount, remaining: amount, grantedAt: now,
    expiresAt: now + GRANT_EXPIRY_DAYS * 86400000,
    source
  });
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

function summarize(acct: CreditAccount): CreditSummary {
  const now = Date.now();
  const live = acct.grants
    .filter((g) => g.expiresAt > now && g.remaining > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  return {
    tier: acct.tier,
    balance: balanceOf(acct),
    nextExpiry: live[0]?.expiresAt ?? null,
    expiring: live.map((g) => ({ credits: g.remaining, expiresAt: g.expiresAt })),
    durable: isDurable(),
    voiceUsed: acct.voiceCount || 0
  };
}

// Grant a one-off block of credits (e.g. a web top-up purchase). 90-day expiry
// like any grant; does NOT change the subscription tier.
export async function grantCredits(identity: string, amount: number, source: string): Promise<CreditSummary> {
  return withLock(identity, async () => {
    const acct = await load(identity);
    addGrant(acct, source, Math.max(0, Math.floor(amount)));
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
export const CREDIT_TOPUP_PRESETS = [500, 5000, 50000];
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
    if (conf) addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    acct.tier = tier;
    acct.starterGiven = true;
    await save(acct);
    return summarize(acct);
  });
}

// Spend `cost` credits, consuming the SOONEST-expiring grants first. Clamps at 0
// (a last question may slightly overspend rather than be blocked mid-answer).
export async function spend(deviceId: string, cost: number): Promise<{ spent: number; balance: number; nextExpiry: number | null }> {
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
    await save(acct);
    const next = acct.grants.sort((a, b) => a.expiresAt - b.expiresAt)[0];
    return { spent: Math.round(cost) - need, balance: balanceOf(acct), nextExpiry: next?.expiresAt ?? null };
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
    if (conf) addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    acct.tier = tier;
    acct.starterGiven = true;
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
export async function mergeCredits(fromId: string, toId: string): Promise<CreditSummary> {
  if (!fromId || !toId || fromId === toId) return summary(toId);
  return withLock(toId, async () => {
    const from = await load(fromId);
    const to = await load(toId);
    const now = Date.now();
    for (const g of from.grants) {
      if (g.expiresAt > now && g.remaining > 0) to.grants.push(g);
    }
    to.tier = higherTier(to.tier, from.tier);
    to.starterGiven = to.starterGiven || from.starterGiven;
    to.processedTx = [...(to.processedTx || []), ...(from.processedTx || [])].slice(-200);
    await save(to);
    // Empty the source so its credits can't be claimed again.
    await save({ deviceId: fromId, tier: "free", grants: [], starterGiven: true, processedTx: [], updatedAt: Date.now() });
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

// Dev: wipe a device's credits.
export async function reset(deviceId: string): Promise<void> {
  return withLock(deviceId, async () => {
    await save({ deviceId, tier: "free", grants: [], starterGiven: false, updatedAt: Date.now() });
  });
}

// For the client Membership screen: the tier catalog.
export function tierCatalog() {
  return (Object.keys(TIERS) as Tier[]).map((key) => ({ key, ...TIERS[key] }));
}
