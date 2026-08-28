import { storeGet, storeUpdate, storeUpdatePair, isDurable } from "./store.js";
import { CREDIT_USD, sttCostUsd, ttsCostUsd } from "./metering.js";

export { CREDIT_USD } from "./metering.js";

/* ============================================================================
 * Subscriptions & credits — the metering ENGINE (Phase 1).
 *
 * A credit represents exactly $0.001 of list-price vendor usage. Gemini token
 * metadata, grounding requests, and paid TTS are accumulated as microdollars;
 * only complete credits are deducted. Credits expire 90 days after each grant.
 *
 * Persistence is one ledger per verified identity. Postgres updates take a row
 * lock, so checks and deductions remain atomic across server instances.
 * ==========================================================================*/

/* ---- CONFIG (tune these) ------------------------------------------------- */

export const GRANT_EXPIRY_DAYS = 90;      // credits expire 90 days after purchase
export const FREE_STARTER_CREDITS = 250;  // free accounts get this recurring allotment, refreshed each month (device-ID capped)
const NON_EXPIRING_GRANT_DATE = Date.UTC(9999, 11, 31);

export type Tier = "free" | "plus" | "plus_voice" | "pro";

export interface TierConfig {
  label: string;
  creditsPerCycle: number;   // AI Credits granted each subscription cycle
  voiceCreditsPerCycle: number;
  priceUsd: number;
  description: string;
  badge?: string;
  extraCreditDiscount: number; // discount on extra credit packs (used when IAP lands)
}

// One authoritative catalog feeds APIs and every client pricing surface. The
// internal `plus_voice` key and existing App Store product remain supported for
// installed builds and current subscribers; its customer-facing name is Premium.
export const TIERS: Record<Tier, TierConfig> = {
  free:       { label: "Free",    creditsPerCycle: 0,      voiceCreditsPerCycle: 0,   priceUsd: 0,     description: "Try Taki", extraCreditDiscount: 0 },
  plus:       { label: "Plus",    creditsPerCycle: 4_000,  voiceCreditsPerCycle: 50,  priceUsd: 9.99,  description: "Best for mostly text usage", extraCreditDiscount: 0 },
  plus_voice: { label: "Premium", creditsPerCycle: 6_000,  voiceCreditsPerCycle: 300, priceUsd: 14.99, description: "Best for voice", badge: "Most Popular", extraCreditDiscount: 0.2 },
  pro:        { label: "Pro",     creditsPerCycle: 12_000, voiceCreditsPerCycle: 600, priceUsd: 24.99, description: "Best for heavy overall usage", extraCreditDiscount: 0.4 }
};

// Voice pricing: every voice request consumes its normal variable AI Credits.
// One Voice Credit removes the fixed 40-AI-Credit surcharge; without one, voice
// remains available when the account can afford normal usage plus that surcharge.
export const FREE_VOICE_PER_CYCLE: Record<Tier, number> = {
  free: 0,
  plus: TIERS.plus.voiceCreditsPerCycle,
  plus_voice: TIERS.plus_voice.voiceCreditsPerCycle,
  pro: TIERS.pro.voiceCreditsPerCycle
};
export const FREE_VOICE_LIMIT = 0;
export const VOICE_SURCHARGE_CREDITS = 40;
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

// Compatibility helpers used by account and pricing checks. The lifetime
// counter remains in the signature for older callers, but current eligibility
// is determined by the cycle balance.
export function isFreeVoice(tier: Tier, baseCredits: number, voiceCycleUsed: number, _voiceLifetimeUsed = 0): boolean {
  if (tier === "free") return false;
  const cap = FREE_VOICE_PER_CYCLE[tier] || 0;
  return cap > 0 && baseCredits > 0 && voiceCycleUsed < cap;
}

export function hasVoiceAccess(tier: Tier, _voiceLifetimeUsed = 0, hasPurchasedCredits = false): boolean {
  return tier !== "free" || hasPurchasedCredits;
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

export type SubscriptionStatus = "none" | "active" | "cancelled" | "billing_retry" | "grace" | "expired" | "revoked";

export interface CreditGrantAudit {
  userId: string;
  subscriptionId: string;
  transactionId: string;
  productId: string;
  periodStart: number | null;
  periodEnd: number | null;
  aiCreditsGranted: number;
  voiceCreditsGranted: number;
  idempotencyKey: string;
  createdAt: number;
  reason: string;
}

export interface CreditUsageTransaction {
  userId: string;
  requestId: string;
  mode: "text" | "voice";
  normalAiCredits: number;
  voiceSurchargeCredits: number;
  voiceCreditsCharged: number;
  totalAiCreditsCharged: number;
  aiCreditBalanceAfter: number;
  voiceCreditBalanceAfter: number;
  createdAt: number;
  status: "charged" | "reversed" | "rejected";
  reversedAt?: number;
}

// Manual credit grants are kept on the same durable account record as the
// balance. This gives the dashboard a reliable audit trail instead of relying
// on transient server logs or a second, eventually-consistent store.
export interface AdminCreditAdjustment {
  id: string;
  amount: number;
  reason: string;
  grantedAt: number;
  expiresAt: number;
  balanceAfter: number;
}

// Minimum balance required to ask anything (cut users off before they hit 0,
// so a request can't overspend into a negative balance).
export const MIN_REQUEST_CREDITS = 1;
export interface CreditAccount {
  schemaVersion?: number;
  deviceId: string;
  tier: Tier;
  grants: CreditGrant[];
  voiceCredits?: number;
  subscriptionStatus?: SubscriptionStatus;
  billingPeriodStart?: number | null;
  billingPeriodEnd?: number | null;
  subscriptionId?: string;
  productId?: string;
  grantLedger?: CreditGrantAudit[];
  usageLedger?: CreditUsageTransaction[];
  adminAdjustments?: AdminCreditAdjustment[];
  starterGiven?: boolean;
  // UTC month ("YYYY-MM") of the free tier's last recurring allotment, so the
  // 500 free credits + free-voice count refresh once per month, not every load.
  freeCycleKey?: string;
  // Billing-period keys already granted (StoreKit), so a renewal grants once.
  processedTx?: string[];
  // Consumable StoreKit transactions are permanent and must only grant once.
  processedConsumableTx?: string[];
  // Stripe checkout sessions are permanent and must only grant once. Keeping
  // this marker in the same ledger write as the grant makes webhook retries safe.
  processedWebTopups?: string[];
  // Remains true after purchased credits are spent or expire, so Membership can
  // keep the expiry-history control hidden for people who have never bought any.
  hasPurchasedCredits?: boolean;
  // Free voice turns used this month (reset with the free cycle). Enforces the
  // free tier's per-month surcharge-free voice allowance (FREE_VOICE_LIMIT).
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
  aiCredits: number;
  voiceCredits: number;
  subscriptionStatus: SubscriptionStatus;
  billingPeriodStart: number | null;
  billingPeriodEnd: number | null;
  nextExpiry: number | null; // epoch ms of the soonest-expiring grant
  // Per-grant breakdown so the UI can show "1,000 credits expire Sep 27".
  expiring: { credits: number; expiresAt: number }[];
  purchasedExpiring: { credits: number; expiresAt: number }[];
  hasPurchasedCredits: boolean;
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

function emptyAccount(deviceId: string): CreditAccount {
  return { deviceId, tier: "free", grants: [], voiceCredits: 0, subscriptionStatus: "none", starterGiven: false, updatedAt: 0 };
}

// Version-2 migration is deliberately non-destructive: every existing AI grant
// and purchased top-up is kept exactly as-is. `plus_voice` remains the internal
// compatibility key but is presented as Premium. Existing paid users receive
// the unused portion of the new Voice Credit allowance for their current cycle;
// no AI balance is reduced or replaced during migration.
function normalizeAccount(acct: CreditAccount, deviceId: string): CreditAccount {
  if (!acct || typeof acct !== "object" || Array.isArray(acct)) acct = emptyAccount(deviceId);
  acct.deviceId = deviceId;
  if (!(["free", "plus", "plus_voice", "pro"] as string[]).includes(acct.tier)) acct.tier = "free";
  if (!Array.isArray(acct.grants)) acct.grants = [];
  acct.grants = acct.grants.flatMap((raw: any, index): CreditGrant[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const amount = Number(raw.amount);
    const remaining = Number(raw.remaining);
    const grantedAt = Number(raw.grantedAt);
    const expiresAt = Number(raw.expiresAt);
    if (!Number.isFinite(amount) || !Number.isFinite(remaining) || !Number.isFinite(expiresAt)) return [];
    const safeAmount = Math.min(100_000_000, Math.max(0, Math.floor(amount)));
    const safeRemaining = Math.max(0, Math.min(safeAmount, Math.floor(remaining)));
    if (safeAmount <= 0 || safeRemaining <= 0) return [];
    return [{
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 128) : `legacy_${deviceId}_${index}`,
      amount: safeAmount,
      remaining: safeRemaining,
      grantedAt: Number.isFinite(grantedAt) ? Math.max(0, Math.floor(grantedAt)) : 0,
      expiresAt: Math.max(0, Math.floor(expiresAt)),
      source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim().slice(0, 160) : "legacy"
    }];
  }).slice(-1_000);
  if (!Array.isArray(acct.grantLedger)) acct.grantLedger = [];
  acct.grantLedger = acct.grantLedger
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry: any) => ({
      userId: String(entry.userId || deviceId).slice(0, 256),
      subscriptionId: String(entry.subscriptionId || "").slice(0, 256),
      transactionId: String(entry.transactionId || "").slice(0, 256),
      productId: String(entry.productId || "").slice(0, 256),
      periodStart: entry.periodStart == null ? null : Number.isFinite(Number(entry.periodStart)) ? Number(entry.periodStart) : null,
      periodEnd: entry.periodEnd == null ? null : Number.isFinite(Number(entry.periodEnd)) ? Number(entry.periodEnd) : null,
      aiCreditsGranted: Math.min(100_000_000, Math.max(0, Math.floor(Number(entry.aiCreditsGranted) || 0))),
      voiceCreditsGranted: Math.min(1_000_000, Math.max(0, Math.floor(Number(entry.voiceCreditsGranted) || 0))),
      idempotencyKey: String(entry.idempotencyKey || "").slice(0, 256),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Math.max(0, Number(entry.createdAt)) : 0,
      reason: String(entry.reason || "subscription_cycle").slice(0, 120)
    }))
    .slice(-500);
  if (!Array.isArray(acct.usageLedger)) acct.usageLedger = [];
  acct.usageLedger = acct.usageLedger
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry: any): CreditUsageTransaction => ({
      userId: String(entry.userId || deviceId).slice(0, 256),
      requestId: String(entry.requestId || "").slice(0, 256),
      mode: entry.mode === "voice" ? "voice" : "text",
      normalAiCredits: Math.min(100_000_000, Math.max(0, Math.floor(Number(entry.normalAiCredits) || 0))),
      voiceSurchargeCredits: Math.min(100_000_000, Math.max(0, Math.floor(Number(entry.voiceSurchargeCredits) || 0))),
      voiceCreditsCharged: Math.min(1_000_000, Math.max(0, Math.floor(Number(entry.voiceCreditsCharged) || 0))),
      totalAiCreditsCharged: Math.min(100_000_000, Math.max(0, Math.floor(Number(entry.totalAiCreditsCharged) || 0))),
      aiCreditBalanceAfter: Math.min(100_000_000, Math.max(0, Math.floor(Number(entry.aiCreditBalanceAfter) || 0))),
      voiceCreditBalanceAfter: Math.min(1_000_000, Math.max(0, Math.floor(Number(entry.voiceCreditBalanceAfter) || 0))),
      createdAt: Number.isFinite(Number(entry.createdAt)) ? Math.max(0, Number(entry.createdAt)) : 0,
      status: entry.status === "reversed" ? "reversed" : entry.status === "rejected" ? "rejected" : "charged",
      ...(Number.isFinite(Number(entry.reversedAt)) ? { reversedAt: Math.max(0, Number(entry.reversedAt)) } : {})
    }))
    .slice(-2_000);
  if (!Array.isArray(acct.adminAdjustments)) acct.adminAdjustments = [];
  acct.adminAdjustments = acct.adminAdjustments
    .filter((adjustment) => adjustment && typeof adjustment === "object" && !Array.isArray(adjustment))
    .map((adjustment: any) => ({
      id: String(adjustment.id || "").slice(0, 128),
      amount: Math.min(100_000_000, Math.max(0, Math.floor(Number(adjustment.amount) || 0))),
      reason: String(adjustment.reason || "Administrative credit grant").slice(0, 240),
      grantedAt: Number.isFinite(Number(adjustment.grantedAt)) ? Math.max(0, Number(adjustment.grantedAt)) : 0,
      expiresAt: Number.isFinite(Number(adjustment.expiresAt)) ? Math.max(0, Number(adjustment.expiresAt)) : 0,
      balanceAfter: Math.min(100_000_000, Math.max(0, Math.floor(Number(adjustment.balanceAfter) || 0)))
    }))
    .slice(-200);
  if (!Array.isArray(acct.processedTx)) acct.processedTx = [];
  acct.processedTx = acct.processedTx.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(-500);
  if (!Array.isArray(acct.processedConsumableTx)) acct.processedConsumableTx = [];
  acct.processedConsumableTx = acct.processedConsumableTx.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(-500);
  if (!Array.isArray(acct.processedWebTopups)) acct.processedWebTopups = [];
  acct.processedWebTopups = acct.processedWebTopups.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(-500);
  if (!Array.isArray(acct.retiredSubscriptionIds)) acct.retiredSubscriptionIds = [];
  acct.retiredSubscriptionIds = acct.retiredSubscriptionIds.filter((id): id is string => typeof id === "string" && id.length <= 256).slice(-200);
  if (!Array.isArray(acct.topupAllowances)) acct.topupAllowances = [];
  acct.topupAllowances = acct.topupAllowances
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item: any) => ({
      id: String(item.id || "").slice(0, 128),
      amount: Math.min(100_000_000, Math.max(0, Math.floor(Number(item.amount) || 0))),
      expiresAt: Number.isFinite(Number(item.expiresAt)) ? Math.max(0, Number(item.expiresAt)) : 0
    }))
    .filter((item) => item.id && item.amount > 0 && item.expiresAt > 0)
    .slice(-1_000);
  const statusValues: SubscriptionStatus[] = ["none", "active", "cancelled", "billing_retry", "grace", "expired", "revoked"];
  if (!statusValues.includes(acct.subscriptionStatus as SubscriptionStatus)) acct.subscriptionStatus = acct.tier === "free" ? "none" : "active";
  acct.usageRemainderMicros = Number.isFinite(Number(acct.usageRemainderMicros))
    ? Math.max(0, Math.floor(Number(acct.usageRemainderMicros)) % 1000)
    : 0;
  if ((acct.schemaVersion || 0) < 2) {
    const alreadyUsed = Math.max(0, Math.floor(acct.voiceCycleCount || 0));
    const migratedRemaining = Math.max(0, TIERS[acct.tier].voiceCreditsPerCycle - alreadyUsed);
    acct.voiceCredits = Math.max(Math.floor(acct.voiceCredits || 0), migratedRemaining);
    acct.subscriptionStatus = acct.tier === "free" ? "none" : "active";
    acct.billingPeriodStart = acct.billingPeriodStart ?? null;
    acct.billingPeriodEnd = acct.billingPeriodEnd ?? null;
    acct.schemaVersion = 2;
  }
  acct.voiceCredits = Number.isFinite(Number(acct.voiceCredits)) ? Math.min(1_000_000, Math.max(0, Math.floor(Number(acct.voiceCredits)))) : 0;
  acct.voiceCount = Number.isFinite(Number(acct.voiceCount)) ? Math.min(100_000_000, Math.max(0, Math.floor(Number(acct.voiceCount)))) : 0;
  acct.voiceCycleCount = Number.isFinite(Number(acct.voiceCycleCount)) ? Math.min(1_000_000, Math.max(0, Math.floor(Number(acct.voiceCycleCount)))) : 0;
  acct.billingPeriodStart = acct.billingPeriodStart == null ? null : Number.isFinite(Number(acct.billingPeriodStart)) ? Math.max(0, Number(acct.billingPeriodStart)) : null;
  acct.billingPeriodEnd = acct.billingPeriodEnd == null ? null : Number.isFinite(Number(acct.billingPeriodEnd)) ? Math.max(0, Number(acct.billingPeriodEnd)) : null;
  acct.updatedAt = Number.isFinite(Number(acct.updatedAt)) ? Math.max(0, Number(acct.updatedAt)) : 0;
  acct.schemaVersion = Number.isFinite(Number(acct.schemaVersion)) ? Math.max(0, Math.floor(Number(acct.schemaVersion))) : 0;
  acct.starterGiven = acct.starterGiven === true;
  acct.hasPurchasedCredits = acct.hasPurchasedCredits === true;
  acct.subscriptionStatus ||= acct.tier === "free" ? "none" : "active";
  return acct;
}

async function updateAccount<R>(
  identity: string,
  fn: (acct: CreditAccount) => Promise<R> | R
): Promise<R> {
  return storeUpdate(keyFor(identity), emptyAccount(identity), async (raw) => {
    const acct = normalizeAccount(raw, identity);
    const result = await fn(acct);
    acct.updatedAt = Date.now();
    return { value: acct, result };
  });
}

// Per-device serialization so concurrent requests don't clobber the blob.
const chains = new Map<string, Promise<unknown>>();
function withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(deviceId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(deviceId, run.then(() => {}, () => {}));
  return run;
}

function withLocks<T>(deviceIds: string[], fn: () => Promise<T>): Promise<T> {
  const ids = [...new Set(deviceIds)].sort();
  const acquire = (index: number): Promise<T> => index >= ids.length
    ? fn()
    : withLock(ids[index], () => acquire(index + 1));
  return acquire(0);
}

async function load(deviceId: string): Promise<CreditAccount> {
  const acct = normalizeAccount(await storeGet<CreditAccount>(keyFor(deviceId), emptyAccount(deviceId)), deviceId);
  const now = Date.now();
  // Migrate credit packs from the earlier non-expiring implementation.
  for (const grant of acct.grants) {
    if (isPurchasedGrant(grant) && grant.expiresAt >= NON_EXPIRING_GRANT_DATE) {
      grant.expiresAt = grant.grantedAt + GRANT_EXPIRY_DAYS * 86400000;
    }
  }
  // Drop fully-expired / emptied grants to keep the blob small.
  acct.grants = acct.grants.filter((g) => g.expiresAt > now && g.remaining > 0);
  if (!Array.isArray(acct.topupAllowances)) acct.topupAllowances = [];
  for (const grant of acct.grants) {
    if (/topup/i.test(grant.source)) {
      const allowance = acct.topupAllowances.find((item) => item.id === grant.id);
      if (allowance) allowance.expiresAt = grant.expiresAt;
      else acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
    }
  }
  acct.topupAllowances = acct.topupAllowances.filter((item) => item.expiresAt > now && item.amount > 0);
  if (acct.hasPurchasedCredits !== true) {
    acct.hasPurchasedCredits = acct.grants.some((grant) => isPurchasedGrant(grant))
      || (acct.processedConsumableTx?.length || 0) > 0
      || acct.topupAllowances.length > 0;
  }
  rollUsageWindows(acct, now);
  return acct;
}

function addGrant(acct: CreditAccount, source: string, amount: number, expiresAt?: number): CreditGrant | null {
  if (amount <= 0) return null;
  const now = Date.now();
  const grant: CreditGrant = {
    id: `g_${now}_${Math.random().toString(36).slice(2, 7)}`,
    amount, remaining: amount, grantedAt: now,
    expiresAt: expiresAt ?? now + GRANT_EXPIRY_DAYS * 86400000,
    source
  };
  acct.grants.push(grant);
  return grant;
}

export function balanceOf(acct: CreditAccount): number {
  const now = Date.now();
  return acct.grants.reduce((sum, g) => (g.expiresAt > now ? sum + g.remaining : sum), 0);
}

export interface CreditChargeQuote {
  normalAiCredits: number;
  voiceSurchargeCredits: number;
  voiceCreditsCharged: number;
  totalAiCredits: number;
}

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  constructor(
    public readonly balance: "ai" | "voice",
    public readonly required: number,
    public readonly available: number
  ) {
    super(balance === "ai"
      ? `This request needs ${required} AI Credits, but only ${available} are available. Upgrade or renew to continue.`
      : "A Voice Credit is not available.");
  }
}

export function quoteCreditCharge(normalAiCredits: number, mode: "text" | "voice", voiceCreditsAvailable: number): CreditChargeQuote {
  const normal = Math.max(0, Math.ceil(normalAiCredits));
  const useVoiceCredit = mode === "voice" && Math.floor(voiceCreditsAvailable) > 0;
  const surcharge = mode === "voice" && !useVoiceCredit ? VOICE_SURCHARGE_CREDITS : 0;
  return {
    normalAiCredits: normal,
    voiceSurchargeCredits: surcharge,
    voiceCreditsCharged: useVoiceCredit ? 1 : 0,
    totalAiCredits: normal + surcharge
  };
}

function deductAiCredits(acct: CreditAccount, amount: number): void {
  let remaining = Math.max(0, Math.floor(amount));
  const now = Date.now();
  const ordered = acct.grants
    .filter((grant) => grant.expiresAt > now && grant.remaining > 0)
    .sort(compareGrantSpendOrder);
  for (const grant of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(grant.remaining, remaining);
    grant.remaining -= take;
    remaining -= take;
  }
  if (remaining > 0) throw new Error("credit invariant violated");
  acct.grants = acct.grants.filter((grant) => grant.expiresAt > now && grant.remaining > 0);
}

export async function chargeRequestCredits(args: {
  identity: string;
  requestId: string;
  mode: "text" | "voice";
  normalAiCredits: number;
}): Promise<CreditSummary & CreditChargeQuote & { spent: number }> {
  let rejection: InsufficientCreditsError | null = null;
  const result = await updateAccount(args.identity, (acct) => {
    ensureFreeCycle(acct);
    const existing = (acct.usageLedger || []).find((entry) => entry.requestId === args.requestId && entry.status === "charged");
    if (existing) {
      return {
        ...summarize(acct),
        normalAiCredits: existing.normalAiCredits,
        voiceSurchargeCredits: existing.voiceSurchargeCredits,
        voiceCreditsCharged: existing.voiceCreditsCharged,
        totalAiCredits: existing.totalAiCreditsCharged,
        spent: existing.totalAiCreditsCharged
      };
    }
    const quote = quoteCreditCharge(args.normalAiCredits, args.mode, acct.voiceCredits || 0);
    const available = balanceOf(acct);
    if (available < quote.totalAiCredits) {
      rejection = new InsufficientCreditsError("ai", quote.totalAiCredits, available);
      acct.usageLedger = [...(acct.usageLedger || []), {
        userId: args.identity,
        requestId: args.requestId,
        mode: args.mode,
        ...quote,
        totalAiCreditsCharged: quote.totalAiCredits,
        aiCreditBalanceAfter: available,
        voiceCreditBalanceAfter: Math.max(0, acct.voiceCredits || 0),
        createdAt: Date.now(),
        status: "rejected" as const
      }].slice(-2000);
      return { ...summarize(acct), ...quote, spent: 0 };
    }
    deductAiCredits(acct, quote.totalAiCredits);
    if (quote.voiceCreditsCharged) acct.voiceCredits = Math.max(0, (acct.voiceCredits || 0) - 1);
    rollUsageWindows(acct);
    acct.dailyUsage!.used += quote.totalAiCredits;
    acct.monthlyUsage!.used += quote.totalAiCredits;
    const after = summarize(acct);
    acct.usageLedger = [...(acct.usageLedger || []), {
      userId: args.identity,
      requestId: args.requestId,
      mode: args.mode,
      normalAiCredits: quote.normalAiCredits,
      voiceSurchargeCredits: quote.voiceSurchargeCredits,
      voiceCreditsCharged: quote.voiceCreditsCharged,
      totalAiCreditsCharged: quote.totalAiCredits,
      aiCreditBalanceAfter: after.balance,
      voiceCreditBalanceAfter: after.voiceCredits,
      createdAt: Date.now(),
      status: "charged" as const
    }].slice(-2000);
    return { ...after, ...quote, spent: quote.totalAiCredits };
  });
  if (rejection) throw rejection;
  return result;
}

export async function chargeUsageUsd(
  identity: string,
  costUsd: number,
  mode: "text" | "voice",
  requestId: string
): Promise<CreditSummary & CreditChargeQuote & { spent: number; usageUsd: number; deduplicated: boolean }> {
  const costMicros = Math.max(0, Math.round(costUsd * 1_000_000));
  let rejection: InsufficientCreditsError | null = null;
  const charged = await updateAccount(identity, (acct) => {
    ensureFreeCycle(acct);
    const existing = (acct.usageLedger || []).find((entry) => entry.requestId === requestId && entry.status === "charged");
    if (existing) {
      return {
        ...summarize(acct),
        normalAiCredits: existing.normalAiCredits,
        voiceSurchargeCredits: existing.voiceSurchargeCredits,
        voiceCreditsCharged: existing.voiceCreditsCharged,
        totalAiCredits: existing.totalAiCreditsCharged,
        spent: existing.totalAiCreditsCharged,
        usageUsd: costMicros / 1_000_000,
        deduplicated: true
      };
    }
    const accumulated = Math.max(0, Math.floor(acct.usageRemainderMicros || 0)) + costMicros;
    const quote = quoteCreditCharge(Math.floor(accumulated / 1000), mode, acct.voiceCredits || 0);
    const available = balanceOf(acct);
    if (available < quote.totalAiCredits) {
      rejection = new InsufficientCreditsError("ai", quote.totalAiCredits, available);
      acct.usageLedger = [...(acct.usageLedger || []), {
        userId: identity, requestId, mode,
        normalAiCredits: quote.normalAiCredits,
        voiceSurchargeCredits: quote.voiceSurchargeCredits,
        voiceCreditsCharged: quote.voiceCreditsCharged,
        totalAiCreditsCharged: quote.totalAiCredits,
        aiCreditBalanceAfter: available,
        voiceCreditBalanceAfter: Math.max(0, acct.voiceCredits || 0),
        createdAt: Date.now(), status: "rejected" as const
      }].slice(-2000);
      return { ...summarize(acct), ...quote, spent: 0, usageUsd: costMicros / 1_000_000, deduplicated: false };
    }
    deductAiCredits(acct, quote.totalAiCredits);
    if (quote.voiceCreditsCharged) acct.voiceCredits = Math.max(0, (acct.voiceCredits || 0) - 1);
    acct.usageRemainderMicros = accumulated % 1000;
    rollUsageWindows(acct);
    acct.dailyUsage!.used += quote.totalAiCredits;
    acct.monthlyUsage!.used += quote.totalAiCredits;
    const after = summarize(acct);
    acct.usageLedger = [...(acct.usageLedger || []), {
      userId: identity, requestId, mode,
      normalAiCredits: quote.normalAiCredits,
      voiceSurchargeCredits: quote.voiceSurchargeCredits,
      voiceCreditsCharged: quote.voiceCreditsCharged,
      totalAiCreditsCharged: quote.totalAiCredits,
      aiCreditBalanceAfter: after.balance,
      voiceCreditBalanceAfter: after.voiceCredits,
      createdAt: Date.now(), status: "charged" as const
    }].slice(-2000);
    return { ...after, ...quote, spent: quote.totalAiCredits, usageUsd: costMicros / 1_000_000, deduplicated: false };
  });
  if (rejection) throw rejection;
  return charged;
}

export function isPurchasedGrant(grant: Pick<CreditGrant, "source">): boolean {
  return /topup/i.test(grant.source);
}

// A subscription balance is always consumed before purchased credits. Within
// each bucket, use the soonest-expiring grant first.
export function compareGrantSpendOrder(a: CreditGrant, b: CreditGrant): number {
  const priority = (grant: CreditGrant) => grant.source.startsWith("subscription:")
    ? 0
    : isPurchasedGrant(grant) ? 2 : 1;
  return priority(a) - priority(b) || a.expiresAt - b.expiresAt || a.grantedAt - b.grantedAt;
}

function ensureStarter(acct: CreditAccount): boolean {
  if (acct.starterGiven) return false;
  if (FREE_STARTER_CREDITS > 0) addGrant(acct, "free_starter", FREE_STARTER_CREDITS);
  acct.starterGiven = true;
  return true;
}

// Free accounts get a recurring monthly allotment: FREE_STARTER_CREDITS fresh
// credits and a reset free-voice count at the start of each UTC month. The prior
// month's free credits are replaced (not stacked); purchased top-ups and any
// other grants are left untouched. Non-free accounts fall back to the one-time
// starter. Returns true if the account changed (so the caller persists it).
function ensureFreeCycle(acct: CreditAccount, now = Date.now()): boolean {
  if (acct.tier !== "free") return ensureStarter(acct);
  const month = utcMonthKey(now);
  if (acct.starterGiven && acct.freeCycleKey === month) return false;
  acct.grants = acct.grants.filter((g) => g.source !== "free_starter" && g.source !== "free_monthly");
  if (FREE_STARTER_CREDITS > 0) addGrant(acct, "free_monthly", FREE_STARTER_CREDITS);
  acct.voiceCount = 0;
  acct.freeCycleKey = month;
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
  const dayUsed = acct.dailyUsage && Number.isFinite(Number(acct.dailyUsage.used)) ? Math.max(0, Math.floor(Number(acct.dailyUsage.used))) : 0;
  const monthUsed = acct.monthlyUsage && Number.isFinite(Number(acct.monthlyUsage.used)) ? Math.max(0, Math.floor(Number(acct.monthlyUsage.used))) : 0;
  acct.dailyUsage = acct.dailyUsage?.key === day ? { key: day, used: dayUsed } : { key: day, used: 0 };
  acct.monthlyUsage = acct.monthlyUsage?.key === month ? { key: month, used: monthUsed } : { key: month, used: 0 };
}

export function usageLimitsFor(tier: Tier, additionalCredits: number): { daily: number; monthly: number } {
  const base = tier === "free" ? FREE_STARTER_CREDITS : TIERS[tier].creditsPerCycle;
  const additional = Math.max(0, Math.floor(additionalCredits));
  if (tier === "free") {
    // Free credits are a finite balance, not a monthly subscription allowance.
    // Keep both guardrails equal to the full available grant so a free account
    // is never restricted by the paid-plan 5% daily formula.
    return { daily: base + additional, monthly: base + additional };
  }
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
  const voiceAllowanceLimit = TIERS[acct.tier].voiceCreditsPerCycle;
  const voiceAllowanceUsed = Math.max(0, voiceAllowanceLimit - Math.max(0, acct.voiceCredits || 0));
  const limitReason = daily.used >= daily.limit ? "daily" : monthly.used >= monthly.limit ? "monthly" : null;
  return {
    tier: acct.tier,
    balance: balanceOf(acct),
    aiCredits: balanceOf(acct),
    voiceCredits: Math.max(0, Math.floor(acct.voiceCredits || 0)),
    subscriptionStatus: acct.subscriptionStatus || (acct.tier === "free" ? "none" : "active"),
    billingPeriodStart: acct.billingPeriodStart ?? null,
    billingPeriodEnd: acct.billingPeriodEnd ?? null,
    nextExpiry: live.find((g) => g.expiresAt < NON_EXPIRING_GRANT_DATE)?.expiresAt ?? null,
    expiring: live.filter((g) => g.expiresAt < NON_EXPIRING_GRANT_DATE).map((g) => ({ credits: g.remaining, expiresAt: g.expiresAt })),
    purchasedExpiring: live.filter(isPurchasedGrant).map((g) => ({ credits: g.remaining, expiresAt: g.expiresAt })),
    hasPurchasedCredits: acct.hasPurchasedCredits === true,
    durable: isDurable(),
    voiceUsed: acct.voiceCount || 0,
    baseCredits: live.filter((g) => g.source.startsWith("subscription:")).reduce((s, g) => s + g.remaining, 0),
    voiceCycleUsed: voiceAllowanceUsed,
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
  return updateAccount(identity, (acct) => {
    ensureFreeCycle(acct);
    acct.voiceCycleCount = (acct.voiceCycleCount || 0) + 1;
    return acct.voiceCycleCount;
  });
}

// Grant a one-off block of credits (e.g. a web top-up purchase). 90-day expiry
// like any grant; does NOT change the subscription tier.
export async function grantCredits(identity: string, amount: number, source: string): Promise<CreditSummary> {
  return updateAccount(identity, async (acct) => {
    const grant = addGrant(acct, source, Math.max(0, Math.floor(amount)));
    if (grant && /topup/i.test(source)) {
      acct.topupAllowances = acct.topupAllowances || [];
      acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
      acct.hasPurchasedCredits = true;
    }
    acct.starterGiven = true;
    return summarize(acct);
  });
}

export const MAX_ADMIN_CREDIT_GRANT = 1_000_000;

export interface AdminCreditGrantResult {
  granted: boolean;
  identity: string;
  amount: number;
  reason: string;
  expiresAt: number | null;
  summary: CreditSummary;
}

// Add a one-time, non-subscription credit grant from the protected admin
// dashboard. It follows the same 90-day expiry and usage-window rules as a
// purchased top-up, but never changes the user's membership tier. The reason
// and resulting balance are written atomically with the grant for auditing.
export async function grantAdminCredits(
  identity: string,
  amount: number,
  reason = "Administrative credit grant"
): Promise<AdminCreditGrantResult> {
  const normalizedAmount = Number(amount);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 1 || normalizedAmount > MAX_ADMIN_CREDIT_GRANT) {
    throw new Error(`Credits must be a whole number from 1 to ${MAX_ADMIN_CREDIT_GRANT.toLocaleString()}.`);
  }
  const normalizedReason = String(reason || "Administrative credit grant")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Administrative credit grant";
  return updateAccount(identity, async (acct) => {
    ensureFreeCycle(acct);
    const grant = addGrant(acct, "topup:admin", normalizedAmount);
    if (!grant) throw new Error("Credits could not be added.");
    acct.topupAllowances = acct.topupAllowances || [];
    acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
    acct.hasPurchasedCredits = true;
    acct.adminAdjustments = [...(acct.adminAdjustments || []), {
      id: grant.id,
      amount: grant.amount,
      reason: normalizedReason,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      balanceAfter: balanceOf(acct)
    }].slice(-200);
    return {
      granted: true,
      identity,
      amount: grant.amount,
      reason: normalizedReason,
      expiresAt: grant.expiresAt,
      summary: summarize(acct)
    };
  });
}

export async function adminCreditAdjustments(identity: string): Promise<AdminCreditAdjustment[]> {
  const acct = await load(identity);
  return [...(acct.adminAdjustments || [])].sort((a, b) => b.grantedAt - a.grantedAt).slice(0, 200);
}

export async function grantWebTopup(
  identity: string,
  amount: number,
  checkoutSessionId: string
): Promise<{ granted: boolean; summary: CreditSummary }> {
  return updateAccount(identity, async (acct) => {
    acct.processedWebTopups = acct.processedWebTopups || [];
    if (!checkoutSessionId || acct.processedWebTopups.includes(checkoutSessionId)) {
      return { granted: false, summary: summarize(acct) };
    }
    const grant = addGrant(acct, "web_topup", Math.max(0, Math.floor(amount)));
    if (!grant) return { granted: false, summary: summarize(acct) };
    acct.topupAllowances = acct.topupAllowances || [];
    acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
    acct.hasPurchasedCredits = true;
    acct.starterGiven = true;
    acct.processedWebTopups.push(checkoutSessionId);
    if (acct.processedWebTopups.length > 500) acct.processedWebTopups = acct.processedWebTopups.slice(-500);
    return { granted: true, summary: summarize(acct) };
  });
}

// Web top-up pricing: server-authoritative (never trust a client-sent price).
// Deliberately POOR value vs. a subscription (subscriptions are ~1/3¢ per credit
// of granted value) — buying à la carte is 1¢/credit flat, so subscribing is
// always the better deal. Plus Voice gets 20% off and Pro gets 40% off.
export const CREDIT_TOPUP_MIN = 500;
export const CREDIT_TOPUP_MAX = 500000;
export const CREDIT_TOPUP_PRESETS = [500, 5000, 25000];
export const TOPUP_CENTS_PER_CREDIT = 1;      // 1¢ per credit, no volume discount
export const PLUS_VOICE_TOPUP_DISCOUNT = 0.2;
export const PRO_TOPUP_DISCOUNT = 0.4;
// Cents per credit for a given buyer (whole-cent for display; Stripe charges the
// exact computed total).
export function topupCentsPerCredit(tier: Tier = "free"): number {
  const discount = tier === "pro"
    ? PRO_TOPUP_DISCOUNT
    : tier === "plus_voice" ? PLUS_VOICE_TOPUP_DISCOUNT : 0;
  return TOPUP_CENTS_PER_CREDIT * (1 - discount);
}
export function topupPriceCents(credits: number, tier: Tier = "free"): number | null {
  if (!Number.isFinite(credits)) return null;
  const c = Math.floor(credits);
  if (c < CREDIT_TOPUP_MIN || c > CREDIT_TOPUP_MAX) return null;
  return Math.round(c * topupCentsPerCredit(tier));
}

// Consumable credit packs sold through StoreKit. Their nominal rate is exactly
// twice the website rate. Tier discounts are delivered as bonus credits, so the
// signed product ID and current server-side tier remain authoritative.
export const IN_APP_CREDIT_PRODUCTS: Record<string, { priceCents: number; label: string }> = {
  "com.davidwiduba.takiai.credits.999": { priceCents: 999, label: "$9.99 pack" },
  "com.davidwiduba.takiai.credits.2499": { priceCents: 2499, label: "$24.99 pack" },
  "com.davidwiduba.takiai.credits.4999": { priceCents: 4999, label: "$49.99 pack" },
  "com.davidwiduba.takiai.credits.9999": { priceCents: 9999, label: "$99.99 pack" }
};
export const IN_APP_RATE_MULTIPLIER = 2;

export function inAppCreditsForProduct(productId: string, tier: Tier): number | null {
  const pack = IN_APP_CREDIT_PRODUCTS[productId];
  if (!pack) return null;
  const baseCredits = Math.max(1, Math.round(pack.priceCents / (TOPUP_CENTS_PER_CREDIT * IN_APP_RATE_MULTIPLIER)));
  const discount = Math.max(0, Math.min(0.9, TIERS[tier]?.extraCreditDiscount || 0));
  // Discounts are delivered as bonus credits, but awkward totals such as 833
  // look accidental in pricing. Round the final grant to the nearest 50 while
  // keeping the signed product and server-side tier authoritative.
  return Math.max(50, Math.round((baseCredits / (1 - discount)) / 50) * 50);
}

export async function grantForConsumableTransaction(
  identity: string,
  transactionId: string,
  productId: string
): Promise<{ granted: boolean; credits: number; priceCents: number; summary: CreditSummary }> {
  return updateAccount(identity, async (acct) => {
    const pack = IN_APP_CREDIT_PRODUCTS[productId];
    const credits = inAppCreditsForProduct(productId, acct.tier);
    if (!pack || !credits || !transactionId) {
      return { granted: false, credits: 0, priceCents: 0, summary: summarize(acct) };
    }
    acct.processedConsumableTx = acct.processedConsumableTx || [];
    if (acct.processedConsumableTx.includes(transactionId)) {
      return { granted: false, credits, priceCents: pack.priceCents, summary: summarize(acct) };
    }
    const grant = addGrant(acct, `iap_topup:${productId}`, credits);
    if (grant) {
      acct.topupAllowances = acct.topupAllowances || [];
      acct.topupAllowances.push({ id: grant.id, amount: grant.amount, expiresAt: grant.expiresAt });
      acct.hasPurchasedCredits = true;
    }
    acct.processedConsumableTx.push(transactionId);
    if (acct.processedConsumableTx.length > 500) acct.processedConsumableTx = acct.processedConsumableTx.slice(-500);
    acct.starterGiven = true;
    return { granted: true, credits, priceCents: pack.priceCents, summary: summarize(acct) };
  });
}

// Count a voice question (for the free-tier cap). Returns the new total.
export async function noteVoiceQuestion(identity: string): Promise<number> {
  return updateAccount(identity, (acct) => {
    ensureFreeCycle(acct);
    acct.voiceCount = (acct.voiceCount || 0) + 1;
    return acct.voiceCount;
  });
}

// First-touch starter grant + current summary.
export async function summary(deviceId: string): Promise<CreditSummary> {
  return updateAccount(deviceId, async (acct) => {
    ensureFreeCycle(acct);
    return summarize(acct);
  });
}

// Grant a tier's credits (simulates a purchase/renewal until IAP). New grant
// expires in 90 days; sets the account's tier.
export async function grantTier(deviceId: string, tier: Tier): Promise<CreditSummary> {
  return updateAccount(deviceId, async (acct) => {
    const conf = TIERS[tier];
    if (conf) {
      acct.grants = acct.grants.filter((grant) => grant.source !== "free_starter" && grant.source !== "free_monthly");
      addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    }
    acct.tier = tier;
    acct.voiceCredits = conf?.voiceCreditsPerCycle || 0;
    acct.subscriptionStatus = tier === "free" ? "none" : "active";
    acct.starterGiven = true;
    return summarize(acct);
  });
}

// Spend `cost` credits, consuming the SOONEST-expiring grants first. Clamps at 0
// (a last question may slightly overspend rather than be blocked mid-answer).
export async function spend(deviceId: string, cost: number): Promise<CreditSummary & { spent: number }> {
  return updateAccount(deviceId, (acct) => {
    ensureFreeCycle(acct);
    const now = Date.now();
    let need = Math.max(0, Math.round(cost));
    const ordered = acct.grants
      .filter((g) => g.expiresAt > now && g.remaining > 0)
      .sort(compareGrantSpendOrder);
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
    return { ...summarize(acct), spent: actualSpent };
  });
}

// Spend exact list-price vendor usage without rounding every request up. Costs
// below one credit accumulate until they reach exactly $0.001.
export async function spendUsageUsd(deviceId: string, costUsd: number): Promise<CreditSummary & { spent: number; usageUsd: number }> {
  return updateAccount(deviceId, (acct) => {
    ensureFreeCycle(acct);
    const now = Date.now();
    const costMicros = Math.max(0, Math.round(costUsd * 1_000_000));
    const accumulated = Math.max(0, Math.floor(acct.usageRemainderMicros || 0)) + costMicros;
    let need = Math.floor(accumulated / 1000);
    acct.usageRemainderMicros = accumulated % 1000;
    const requested = need;
    const ordered = acct.grants
      .filter((grant) => grant.expiresAt > now && grant.remaining > 0)
      .sort(compareGrantSpendOrder);
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
// Put an identity on `tier` (never lowering it) WITHOUT granting a new cycle's
// credits — used when a transferred subscription's current period was already
// granted to a prior identity, so the entitlement (tier) still applies.
export async function activateSubscriptionTier(identity: string, tier: Tier): Promise<CreditSummary> {
  return updateAccount(identity, async (acct) => {
    const priorAllowance = TIERS[acct.tier].voiceCreditsPerCycle;
    const nextTier = higherTier(acct.tier, tier);
    if (nextTier !== acct.tier) {
      // StoreKit upgrades can take effect inside an already-granted billing
      // period. Do not grant AI Credits twice; add only the Voice Credit
      // allowance difference. Downgrades remain effective at renewal.
      acct.voiceCredits = Math.max(0, acct.voiceCredits || 0) + Math.max(0, TIERS[nextTier].voiceCreditsPerCycle - priorAllowance);
    }
    acct.tier = nextTier;
    acct.subscriptionStatus = "active";
    acct.starterGiven = true;
    return summarize(acct);
  });
}

export interface SubscriptionGrantContext {
  subscriptionId?: string;
  transactionId?: string;
  productId?: string;
  periodStart?: number | null;
  periodEnd?: number | null;
  reason?: string;
  status?: SubscriptionStatus;
}

export async function grantForTransaction(
  identity: string, tier: Tier, periodKey: string, context: SubscriptionGrantContext = {}
): Promise<{ granted: boolean; summary: CreditSummary }> {
  return updateAccount(identity, async (acct) => {
    acct.processedTx = acct.processedTx || [];
    const incomingEnd = context.periodEnd ?? null;
    if (incomingEnd && acct.billingPeriodEnd && incomingEnd < acct.billingPeriodEnd && !acct.processedTx.includes(periodKey)) {
      return { granted: false, summary: summarize(acct) };
    }
    if (periodKey && acct.processedTx.includes(periodKey)) {
      const priorAllowance = TIERS[acct.tier].voiceCreditsPerCycle;
      const nextTier = higherTier(acct.tier, tier);
      if (nextTier !== acct.tier) {
        acct.voiceCredits = Math.max(0, acct.voiceCredits || 0) + Math.max(0, TIERS[nextTier].voiceCreditsPerCycle - priorAllowance);
      }
      acct.tier = nextTier;
      acct.subscriptionStatus = context.status || "active";
      if (incomingEnd && incomingEnd >= (acct.billingPeriodEnd || 0)) {
        acct.billingPeriodStart = context.periodStart ?? acct.billingPeriodStart ?? null;
        acct.billingPeriodEnd = incomingEnd;
        acct.subscriptionId = context.subscriptionId || acct.subscriptionId;
        acct.productId = context.productId || acct.productId;
      }
      return { granted: false, summary: summarize(acct) };
    }
    const conf = TIERS[tier];
    if (conf) {
      acct.grants = acct.grants.filter((grant) => grant.source !== "free_starter" && grant.source !== "free_monthly");
      addGrant(acct, `subscription:${tier}`, conf.creditsPerCycle);
    }
    acct.tier = tier;
    acct.voiceCredits = conf?.voiceCreditsPerCycle || 0;
    acct.subscriptionStatus = context.status || "active";
    acct.billingPeriodStart = context.periodStart ?? acct.billingPeriodStart ?? null;
    acct.billingPeriodEnd = context.periodEnd ?? acct.billingPeriodEnd ?? null;
    acct.subscriptionId = context.subscriptionId || acct.subscriptionId;
    acct.productId = context.productId || acct.productId;
    acct.starterGiven = true;
    acct.voiceCycleCount = 0;
    if (periodKey) {
      acct.processedTx.push(periodKey);
      if (acct.processedTx.length > 200) acct.processedTx = acct.processedTx.slice(-200);
    }
    acct.grantLedger = [...(acct.grantLedger || []), {
      userId: identity,
      subscriptionId: context.subscriptionId || "",
      transactionId: context.transactionId || "",
      productId: context.productId || "",
      periodStart: context.periodStart ?? null,
      periodEnd: context.periodEnd ?? null,
      aiCreditsGranted: conf?.creditsPerCycle || 0,
      voiceCreditsGranted: conf?.voiceCreditsPerCycle || 0,
      idempotencyKey: periodKey,
      createdAt: Date.now(),
      reason: context.reason || "subscription_cycle"
    }].slice(-500);
    return { granted: true, summary: summarize(acct) };
  });
}

export async function updateSubscriptionStatus(
  identity: string,
  status: SubscriptionStatus,
  context: SubscriptionGrantContext = {}
): Promise<CreditSummary> {
  return updateAccount(identity, (acct) => {
    const incomingEnd = context.periodEnd ?? null;
    if (incomingEnd && acct.billingPeriodEnd && incomingEnd < acct.billingPeriodEnd) return summarize(acct);
    acct.subscriptionStatus = status;
    if (context.periodStart != null) acct.billingPeriodStart = context.periodStart;
    if (incomingEnd != null) acct.billingPeriodEnd = incomingEnd;
    if (context.subscriptionId) acct.subscriptionId = context.subscriptionId;
    if (context.productId) acct.productId = context.productId;
    // Cancellation and billing retry do not remove access. Apple/Stripe keeps
    // the current entitlement active through the paid-through/grace date.
    return summarize(acct);
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
  return withLocks([fromId, toId], async () => {
    const merged = await storeUpdatePair<CreditAccount, CreditAccount, CreditSummary>(
      { key: keyFor(fromId), fallback: emptyAccount(fromId) },
      { key: keyFor(toId), fallback: emptyAccount(toId) },
      ({ first: rawFirst, second: rawSecond }) => {
        // The pair helper passes values in caller order even though the
        // database locks keys alphabetically.
        const from = normalizeAccount(rawFirst, fromId);
        const to = normalizeAccount(rawSecond, toId);
        // `load` also expires grants, rolls usage windows, and backfills top-up
        // allowances. Reproduce that normalization inside the transaction so
        // the two ledgers are never persisted in a half-migrated state.
        const now = Date.now();
        for (const account of [from, to]) {
          for (const grant of account.grants) {
            if (isPurchasedGrant(grant) && grant.expiresAt >= NON_EXPIRING_GRANT_DATE) {
              grant.expiresAt = grant.grantedAt + GRANT_EXPIRY_DAYS * 86400000;
            }
          }
          account.grants = account.grants.filter((grant) => grant.expiresAt > now && grant.remaining > 0);
          if (!Array.isArray(account.topupAllowances)) account.topupAllowances = [];
          account.topupAllowances = account.topupAllowances.filter((item) => item.expiresAt > now && item.amount > 0);
          rollUsageWindows(account, now);
        }
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
          to.hasPurchasedCredits = true;
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
        to.processedTx = [...(to.processedTx || []), ...(from.processedTx || [])]
          .filter((id, index, all) => all.indexOf(id) === index).slice(-200);
        to.processedConsumableTx = [...(to.processedConsumableTx || []), ...(from.processedConsumableTx || [])]
          .filter((id, index, all) => all.indexOf(id) === index).slice(-500);
        to.processedWebTopups = [...(to.processedWebTopups || []), ...(from.processedWebTopups || [])]
          .filter((id, index, all) => all.indexOf(id) === index).slice(-500);
        to.adminAdjustments = [...(to.adminAdjustments || []), ...(from.adminAdjustments || [])]
          .sort((a, b) => a.grantedAt - b.grantedAt).slice(-200);
        to.voiceCount = Math.max(0, to.voiceCount || 0) + Math.max(0, from.voiceCount || 0);
        to.voiceCycleCount = Math.max(to.voiceCycleCount || 0, from.voiceCycleCount || 0);
        to.hasPurchasedCredits = to.hasPurchasedCredits === true || from.hasPurchasedCredits === true
          || to.grants.some(isPurchasedGrant);
        const emptied: CreditAccount = {
          deviceId: fromId,
          tier: "free",
          grants: [],
          starterGiven: true,
          processedTx: [],
          processedConsumableTx: [],
          processedWebTopups: [],
          topupAllowances: [],
          voiceCount: 0,
          voiceCycleCount: 0,
          updatedAt: Date.now()
        };
        to.updatedAt = Date.now();
        return { first: emptied, second: to, result: summarize(to) };
      }
    );
    return merged;
  });
}

// Subscription lapsed naturally (EXPIRED / grace period over): drop to free but
// keep any credits already granted (the user paid for them; 90-day expiry still
// applies).
export async function downgradeToFree(identity: string, context: SubscriptionGrantContext = {}): Promise<void> {
  return updateAccount(identity, async (acct) => {
    if (context.periodEnd && acct.billingPeriodEnd && context.periodEnd < acct.billingPeriodEnd) return;
    acct.tier = "free";
    acct.voiceCredits = 0;
    acct.subscriptionStatus = "expired";
  });
}

// Refund / revoke: drop to free AND claw back unused subscription-granted credits.
export async function revokeSubscription(identity: string, context: SubscriptionGrantContext = {}): Promise<void> {
  return updateAccount(identity, async (acct) => {
    if (context.periodEnd && acct.billingPeriodEnd && context.periodEnd < acct.billingPeriodEnd) return;
    acct.tier = "free";
    acct.voiceCredits = 0;
    acct.subscriptionStatus = "revoked";
    for (const g of acct.grants) {
      if (g.source.startsWith("subscription:")) g.remaining = 0;
    }
    const now = Date.now();
    acct.grants = acct.grants.filter((g) => g.remaining > 0 && g.expiresAt > now);
  });
}

export async function revokeMergedSubscriptionCredits(identity: string, originalTransactionId: string): Promise<void> {
  return updateAccount(identity, (acct) => {
    const source = `topup:merged_subscription:${originalTransactionId}`;
    const removedIds = new Set(acct.grants.filter((grant) => grant.source === source).map((grant) => grant.id));
    acct.grants = acct.grants.filter((grant) => grant.source !== source);
    acct.topupAllowances = (acct.topupAllowances || []).filter((allowance) => !removedIds.has(allowance.id));
    acct.retiredSubscriptionIds = (acct.retiredSubscriptionIds || []).filter((id) => id !== originalTransactionId);
  });
}

export async function clearRetiredSubscription(identity: string, originalTransactionId: string): Promise<void> {
  return updateAccount(identity, (acct) => {
    acct.retiredSubscriptionIds = (acct.retiredSubscriptionIds || []).filter((id) => id !== originalTransactionId);
  });
}

// Dev: wipe a device's credits.
export async function reset(deviceId: string): Promise<void> {
  await updateAccount(deviceId, (acct) => {
    // Keep the account shape normalized while clearing all credit-bearing state.
    Object.assign(acct, { tier: "free", grants: [], voiceCredits: 0, subscriptionStatus: "none", starterGiven: false, processedTx: [], processedConsumableTx: [], processedWebTopups: [], topupAllowances: [], voiceCount: 0, voiceCycleCount: 0, usageRemainderMicros: 0, hasPurchasedCredits: false, retiredSubscriptionIds: [] });
  });
}

// For the client Membership screen: the tier catalog.
export function tierCatalog() {
  return (Object.keys(TIERS) as Tier[]).map((key) => ({
    key,
    planId: key === "plus_voice" ? "premium_monthly" : `${key}_monthly`,
    ...TIERS[key],
    voiceCredits: TIERS[key].voiceCreditsPerCycle
  }));
}
