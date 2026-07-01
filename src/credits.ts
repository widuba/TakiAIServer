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

export const TIERS: Record<Tier, TierConfig> = {
  free:       { label: "Free",       creditsPerCycle: 0,    priceUsd: 0,     voiceIncluded: false, extraCreditDiscount: 0 },
  plus:       { label: "Plus",       creditsPerCycle: 1000, priceUsd: 9.99,  voiceIncluded: false, extraCreditDiscount: 0 },
  plus_voice: { label: "Plus Voice", creditsPerCycle: 1500, priceUsd: 14.99, voiceIncluded: true,  extraCreditDiscount: 0 },
  pro:        { label: "Pro",        creditsPerCycle: 5000, priceUsd: 29.99, voiceIncluded: false, extraCreditDiscount: 0.2 }
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

export interface CreditAccount {
  deviceId: string;
  tier: Tier;
  grants: CreditGrant[];
  starterGiven?: boolean;
  updatedAt: number;
}

export interface CreditSummary {
  tier: Tier;
  balance: number;
  nextExpiry: number | null; // epoch ms of the soonest-expiring grant
  durable: boolean;
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
  const next = acct.grants
    .filter((g) => g.expiresAt > now && g.remaining > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt)[0];
  return { tier: acct.tier, balance: balanceOf(acct), nextExpiry: next?.expiresAt ?? null, durable: isDurable() };
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
export async function spend(deviceId: string, cost: number): Promise<{ spent: number; balance: number }> {
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
    return { spent: Math.round(cost) - need, balance: balanceOf(acct) };
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
