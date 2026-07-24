import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { SignedDataVerifier, Environment } from "@apple/app-store-server-library";
import { IN_APP_CREDIT_PRODUCTS, type Tier } from "./credits.js";
import { storeGet, storeSet } from "./store.js";

/* ============================================================================
 * Apple In-App Purchase (StoreKit 2) — verify + map the signed transaction.
 *
 * The device buys an auto-renewable subscription; StoreKit hands it a JWS
 * "signed transaction" (signed by Apple's cert chain). We verify it against
 * Apple's root CA using Apple's official library, then map the product to a tier.
 *
 * Environments:
 *  - Sandbox / Production  → FULL cryptographic verification (Apple's cert chain).
 *  - Xcode / LocalTesting  → decode only (Xcode's local .storekit test cert isn't
 *    Apple-signed, so it can't chain to Apple's root — this is dev-only anyway).
 *
 * IAP_ALLOW_UNVERIFIED=1 is an emergency escape hatch that decodes without
 * verifying even for Sandbox/Production. Leave it UNSET in production.
 * ==========================================================================*/

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.davidwiduba.takiai";
const ALLOW_UNVERIFIED = process.env.IAP_ALLOW_UNVERIFIED === "1";
// Required by Apple's library to verify PRODUCTION transactions (the app's
// numeric Apple ID from App Store Connect). Sandbox doesn't need it.
const APP_APPLE_ID = process.env.APP_APPLE_ID ? Number(process.env.APP_APPLE_ID) : undefined;

// Product id (App Store Connect) -> credits tier. Create these exact ids as
// auto-renewable subscriptions in one group ("Taki Membership").
// NOTE: the original *.monthly ids were accidentally used for (deleted) In-App
// Purchases; Apple permanently reserves product ids even after deletion, so the
// subscriptions use these `.sub.` ids instead.
export const PRODUCT_TO_TIER: Record<string, Tier> = {
  "com.davidwiduba.takiai.sub.plus.monthly": "plus",
  "com.davidwiduba.takiai.sub.plusvoice.monthly": "plus_voice",
  "com.davidwiduba.takiai.sub.pro.monthly": "pro"
};

export interface TxInfo {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  expiresDate?: number;   // epoch ms (auto-renewables)
  environment?: string;   // "Xcode" | "Sandbox" | "Production"
  bundleId?: string;
  tier: Tier;
  periodKey: string;      // unique per BILLING PERIOD → grant a cycle once
}

export interface CreditTxInfo {
  productId: string;
  transactionId: string;
  environment?: string;
  bundleId?: string;
  priceCents: number;
}

// Apple's root CA (bundled). Fails closed: if it can't load, Sandbox/Production
// verification is unavailable (returns null) rather than trusting blindly.
let appleRoots: Buffer[] = [];
try {
  appleRoots = [readFileSync(fileURLToPath(new URL("../certs/AppleRootCA-G3.cer", import.meta.url)))];
} catch (e) {
  console.error("IAP: could not load Apple root cert:", (e as Error)?.message);
}

const verifiers = new Map<string, SignedDataVerifier>();
function verifierFor(env: Environment): SignedDataVerifier | null {
  if (appleRoots.length === 0) return null;
  const key = String(env);
  let v = verifiers.get(key);
  if (!v) {
    try {
      // enableOnlineChecks=false: verify the chain offline against the pinned
      // root (skips OCSP revocation calls — no network dependency on Render).
      v = new SignedDataVerifier(appleRoots, false, env, BUNDLE_ID, APP_APPLE_ID);
      verifiers.set(key, v);
    } catch (e) {
      console.error(`IAP: verifier init failed (${key}):`, (e as Error)?.message);
      return null;
    }
  }
  return v;
}

function decodePayload(jws: string): any | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function toTxInfo(payload: any): TxInfo | null {
  const productId = String(payload?.productId || "");
  const tier = PRODUCT_TO_TIER[productId];
  if (!tier) return null;
  if (payload.bundleId && payload.bundleId !== BUNDLE_ID) return null;
  const transactionId = String(payload.transactionId || "");
  const originalTransactionId = String(payload.originalTransactionId || transactionId);
  const expiresDate = typeof payload.expiresDate === "number" ? payload.expiresDate : undefined;
  return {
    productId, transactionId, originalTransactionId, expiresDate,
    environment: payload.environment, bundleId: payload.bundleId, tier,
    periodKey: `${originalTransactionId}:${expiresDate ?? transactionId}`
  };
}

async function verifiedTransactionPayload(jws: string): Promise<any | null> {
  const peek = decodePayload(jws);
  if (!peek) return null;
  const env = String(peek.environment || "");

  // Local Xcode / LocalTesting: no Apple-signed chain to verify — decode only.
  if (env === "Xcode" || env === "LocalTesting") {
    return peek;
  }

  // Emergency override.
  if (ALLOW_UNVERIFIED) return peek;

  // Sandbox / Production: cryptographic verification is REQUIRED.
  const environment = env === "Production" ? Environment.PRODUCTION
    : env === "Sandbox" ? Environment.SANDBOX
    : null;
  if (!environment) return null;
  const verifier = verifierFor(environment);
  if (!verifier) {
    console.error("IAP: no verifier available for", env, "(missing root cert or, for Production, APP_APPLE_ID)");
    return null;
  }
  try {
    return await verifier.verifyAndDecodeTransaction(jws);
  } catch (e) {
    console.error("IAP: transaction verification failed:", (e as Error)?.message);
    return null;
  }
}

// Verify (Sandbox/Production) or decode (Xcode/local) a subscription transaction.
export async function verifyTransaction(jws: string): Promise<TxInfo | null> {
  const payload = await verifiedTransactionPayload(jws);
  return payload ? toTxInfo(payload) : null;
}

// Verify a consumable credit-pack transaction independently of subscriptions.
export async function verifyCreditTransaction(jws: string): Promise<CreditTxInfo | null> {
  const payload = await verifiedTransactionPayload(jws);
  if (!payload) return null;
  const productId = String(payload.productId || "");
  const pack = IN_APP_CREDIT_PRODUCTS[productId];
  const transactionId = String(payload.transactionId || "");
  if (!pack || !transactionId) return null;
  if (payload.bundleId && payload.bundleId !== BUNDLE_ID) return null;
  return {
    productId,
    transactionId,
    environment: payload.environment,
    bundleId: payload.bundleId,
    priceCents: pack.priceCents
  };
}

type CreditClaimResult = "claimed" | "existing" | "conflict";
const creditClaimChains = new Map<string, Promise<unknown>>();
const subscriptionClaimChains = new Map<string, Promise<unknown>>();
const safeIdentity = (identity: string) => identity.replace(/[^a-zA-Z0-9_-]/g, "_");

// Consumables are bearer receipts, so account-level idempotency is not enough:
// the same signed transaction must never be grantable to two different users.
export function claimCreditTransaction(transactionId: string, identity: string): Promise<CreditClaimResult> {
  if (!transactionId || !identity) return Promise.resolve("conflict");
  const prior = creditClaimChains.get(transactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapcredit:${transactionId}`;
    const existing = await storeGet<{ identity: string }>(key, { identity: "" });
    if (existing.identity && existing.identity !== identity) return "conflict";
    if (existing.identity === identity) return "existing";
    await storeSet(key, { identity });
    const reverseKey = `iapcreditidentity:${safeIdentity(identity)}`;
    const reverse = await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] });
    if (!reverse.transactionIds.includes(transactionId)) {
      reverse.transactionIds.push(transactionId);
      await storeSet(reverseKey, { transactionIds: reverse.transactionIds.slice(-1000) });
    }
    return "claimed";
  });
  creditClaimChains.set(transactionId, current.then(() => undefined, () => undefined));
  return current;
}

// A verified consumable JWS proves the presenting device owns the Apple
// purchase, so a stale binding to a prior identity (e.g. the same person on a
// new device, or after signing in with Apple) should transfer rather than wall
// the user with "already linked to another account". Moves ownership only; the
// per-identity grant idempotency still prevents double-crediting.
export async function transferCreditTransaction(transactionId: string, identity: string): Promise<void> {
  if (!transactionId || !identity) return;
  const prior = creditClaimChains.get(transactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapcredit:${transactionId}`;
    const existing = await storeGet<{ identity: string }>(key, { identity: "" });
    if (existing.identity === identity) return;
    // Drop the transaction from the previous owner's reverse index.
    if (existing.identity) {
      const oldKey = `iapcreditidentity:${safeIdentity(existing.identity)}`;
      const old = await storeGet<{ transactionIds: string[] }>(oldKey, { transactionIds: [] });
      const filtered = old.transactionIds.filter((t) => t !== transactionId);
      if (filtered.length !== old.transactionIds.length) await storeSet(oldKey, { transactionIds: filtered });
    }
    await storeSet(key, { identity });
    const reverseKey = `iapcreditidentity:${safeIdentity(identity)}`;
    const reverse = await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] });
    if (!reverse.transactionIds.includes(transactionId)) {
      reverse.transactionIds.push(transactionId);
      await storeSet(reverseKey, { transactionIds: reverse.transactionIds.slice(-1000) });
    }
  });
  creditClaimChains.set(transactionId, current.then(() => undefined, () => undefined));
  return current;
}

// When a device signs in with Apple, its credit ledger moves to the Apple
// account. Move the global receipt ownership too, so an unfinished transaction
// can be safely acknowledged after the identity changes.
export async function rebindCreditTransactions(fromIdentity: string, toIdentity: string): Promise<void> {
  if (!fromIdentity || !toIdentity || fromIdentity === toIdentity) return;
  const fromKey = `iapcreditidentity:${safeIdentity(fromIdentity)}`;
  const toKey = `iapcreditidentity:${safeIdentity(toIdentity)}`;
  const from = await storeGet<{ transactionIds: string[] }>(fromKey, { transactionIds: [] });
  if (!from.transactionIds.length) return;
  const to = await storeGet<{ transactionIds: string[] }>(toKey, { transactionIds: [] });
  for (const transactionId of from.transactionIds) {
    const key = `iapcredit:${transactionId}`;
    const owner = await storeGet<{ identity: string }>(key, { identity: "" });
    if (!owner.identity || owner.identity === fromIdentity) {
      await storeSet(key, { identity: toIdentity });
      if (!to.transactionIds.includes(transactionId)) to.transactionIds.push(transactionId);
    }
  }
  await storeSet(toKey, { transactionIds: to.transactionIds.slice(-1000) });
  await storeSet(fromKey, { transactionIds: [] });
}

/* ---- Ownership map + App Store Server Notifications --------------------- */
// Apple's notifications identify a subscription by its originalTransactionId, not
// by our app identity — so at purchase time we remember which identity owns each
// subscription, and look it up when a renewal/refund notification arrives.
export function linkTransactionIdentity(originalTransactionId: string, identity: string): Promise<CreditClaimResult> {
  if (!originalTransactionId || !identity) return Promise.resolve("conflict");
  const prior = subscriptionClaimChains.get(originalTransactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const existing = await storeGet<{ identity: string; role?: "primary" | "secondary" }>(`iapmap:${originalTransactionId}`, { identity: "" });
    if (existing.identity && existing.identity !== identity) return "conflict";
    if (existing.identity === identity) return "existing";
    await storeSet(`iapmap:${originalTransactionId}`, { identity, role: existing.role });
    const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const reverse = await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] });
    if (!reverse.transactionIds.includes(originalTransactionId)) {
      reverse.transactionIds.push(originalTransactionId);
      await storeSet(reverseKey, reverse);
    }
    return "claimed";
  });
  subscriptionClaimChains.set(originalTransactionId, current.then(() => undefined, () => undefined));
  return current;
}

// A verified, Apple-signed subscription JWS proves the PRESENTER's Apple ID owns
// the entitlement right now. So the same Apple ID on a new device (a new
// anonymous 8-digit identity) reclaiming its subscription must be allowed to
// transfer it — blocking that as a "conflict" is the "already linked to another
// account" bug on a fresh phone. Per-period dedup (claimSubscriptionPeriod)
// still stops the same billing cycle from granting credits to two identities.
export async function transferSubscriptionIdentity(originalTransactionId: string, identity: string): Promise<void> {
  if (!originalTransactionId || !identity) return;
  const prior = subscriptionClaimChains.get(originalTransactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const existing = await storeGet<{ identity: string; role?: "primary" | "secondary" }>(`iapmap:${originalTransactionId}`, { identity: "" });
    if (existing.identity && existing.identity !== identity) {
      const oldKey = `iapidentity:${existing.identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const old = await storeGet<{ transactionIds: string[] }>(oldKey, { transactionIds: [] });
      await storeSet(oldKey, { transactionIds: old.transactionIds.filter((id) => id !== originalTransactionId) });
    }
    await storeSet(`iapmap:${originalTransactionId}`, { identity, role: existing.role || "primary" });
    const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const reverse = await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] });
    if (!reverse.transactionIds.includes(originalTransactionId)) {
      reverse.transactionIds.push(originalTransactionId);
      await storeSet(reverseKey, reverse);
    }
  });
  subscriptionClaimChains.set(originalTransactionId, current.then(() => undefined, () => undefined));
  return current;
}

// Global "this subscription billing period was already granted" guard, keyed by
// the period key (which embeds the originalTransactionId). Returns true the FIRST
// time a period is seen and false afterward, so credits for one cycle land on
// exactly one identity even across device transfers.
const periodClaimChains = new Map<string, Promise<void>>();
export function claimSubscriptionPeriod(periodKey: string): Promise<boolean> {
  if (!periodKey) return Promise.resolve(true);
  const prior = periodClaimChains.get(periodKey) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapperiod:${periodKey}`;
    if (await storeGet<boolean>(key, false)) return false;
    await storeSet(key, true);
    return true;
  });
  periodClaimChains.set(periodKey, current.then(() => undefined, () => undefined));
  return current;
}

export async function getTransactionIdentity(originalTransactionId: string): Promise<string> {
  const v = await storeGet<{ identity: string }>(`iapmap:${originalTransactionId}`, { identity: "" });
  return v?.identity || "";
}

export async function transactionIdsForIdentity(identity: string): Promise<string[]> {
  const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] })).transactionIds;
}

export async function setTransactionRole(
  originalTransactionId: string,
  identity: string,
  role: "primary" | "secondary"
): Promise<void> {
  if (!originalTransactionId || !identity) return;
  const prior = await storeGet<{ identity: string; role?: "primary" | "secondary" }>(
    `iapmap:${originalTransactionId}`,
    { identity: "" }
  );
  await storeSet(`iapmap:${originalTransactionId}`, { identity, role });
  if (prior.identity && prior.identity !== identity) {
    const priorKey = `iapidentity:${prior.identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const priorReverse = await storeGet<{ transactionIds: string[] }>(priorKey, { transactionIds: [] });
    await storeSet(priorKey, { transactionIds: priorReverse.transactionIds.filter((id) => id !== originalTransactionId) });
  }
  const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const reverse = await storeGet<{ transactionIds: string[] }>(reverseKey, { transactionIds: [] });
  if (!reverse.transactionIds.includes(originalTransactionId)) reverse.transactionIds.push(originalTransactionId);
  await storeSet(reverseKey, reverse);
}

export async function getTransactionBinding(originalTransactionId: string): Promise<{
  identity: string;
  role: "primary" | "secondary";
}> {
  const value = await storeGet<{ identity: string; role?: "primary" | "secondary" }>(
    `iapmap:${originalTransactionId}`,
    { identity: "" }
  );
  return { identity: value.identity || "", role: value.role || "primary" };
}

function primaryKey(identity: string): string {
  return `iapprimary:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export async function primarySubscriptionForIdentity(identity: string): Promise<string> {
  return (await storeGet<{ originalTransactionId: string }>(primaryKey(identity), { originalTransactionId: "" })).originalTransactionId;
}

export async function claimPrimarySubscription(identity: string, originalTransactionId: string): Promise<"primary" | "secondary"> {
  const existing = await primarySubscriptionForIdentity(identity);
  if (!existing) {
    await storeSet(primaryKey(identity), { originalTransactionId });
    await setTransactionRole(originalTransactionId, identity, "primary");
    return "primary";
  }
  const role = existing === originalTransactionId ? "primary" : "secondary";
  await setTransactionRole(originalTransactionId, identity, role);
  return role;
}

export function subscriptionMergeDecision(primary: string, deviceTransactions: string[]): {
  mode: "keep" | "convert" | "discard";
  secondaryTransactionId: string;
} {
  if (!primary || !deviceTransactions.length) return { mode: "keep", secondaryTransactionId: "" };
  const secondaryTransactionId = deviceTransactions.find((transactionId) => transactionId !== primary) || "";
  return secondaryTransactionId
    ? { mode: "convert", secondaryTransactionId }
    : { mode: "discard", secondaryTransactionId: "" };
}

export interface NotificationInfo {
  notificationType: string;
  subtype?: string;
  tx: TxInfo | null;
}

// Verify + decode an App Store Server Notification V2 (signedPayload).
export async function verifyNotification(signedPayload: string): Promise<NotificationInfo | null> {
  const peek = decodePayload(signedPayload);
  if (!peek) return null;
  const env = String(peek?.data?.environment || "");
  let decoded: any;
  if (env === "Xcode" || env === "LocalTesting" || ALLOW_UNVERIFIED) {
    decoded = peek;
  } else {
    const environment = env === "Production" ? Environment.PRODUCTION : env === "Sandbox" ? Environment.SANDBOX : null;
    if (!environment) return null;
    const verifier = verifierFor(environment);
    if (!verifier) return null;
    try {
      decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    } catch (e) {
      console.error("IAP: notification verification failed:", (e as Error)?.message);
      return null;
    }
  }
  const signedTx = decoded?.data?.signedTransactionInfo;
  const tx = typeof signedTx === "string" ? await verifyTransaction(signedTx) : null;
  return {
    notificationType: String(decoded.notificationType || ""),
    subtype: decoded.subtype ? String(decoded.subtype) : undefined,
    tx
  };
}
