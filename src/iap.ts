import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { SignedDataVerifier, Environment } from "@apple/app-store-server-library";
import { IN_APP_CREDIT_PRODUCTS, type Tier } from "./credits.js";
import { storeGet, storeUpdate } from "./store.js";

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
// Local StoreKit transactions are intentionally opt-in.  A payload that says
// `environment: Xcode` is not proof of an Apple purchase and must never be
// accepted merely because the server is running without NODE_ENV set (which is
// common on hosted Node deployments).
const NON_PRODUCTION = process.env.NODE_ENV !== "production";
const ALLOW_LOCAL_TRANSACTIONS = process.env.IAP_ALLOW_LOCAL_TESTING === "1" && NON_PRODUCTION;
const ALLOW_UNVERIFIED = process.env.IAP_ALLOW_UNVERIFIED === "1"
  && process.env.IAP_UNVERIFIED_ENV === "development"
  && NON_PRODUCTION;
// Required by Apple's library to verify PRODUCTION transactions (the app's
// numeric Apple ID from App Store Connect). Sandbox doesn't need it.
const configuredAppleId = Number(process.env.APP_APPLE_ID || "");
const APP_APPLE_ID = Number.isSafeInteger(configuredAppleId) && configuredAppleId > 0
  ? configuredAppleId
  : undefined;
const MAX_SIGNED_PAYLOAD_LENGTH = 64 * 1024;

// Product id (App Store Connect) -> credits tier. Create these exact ids as
// auto-renewable subscriptions in one group ("Taki Membership").
// NOTE: the original *.monthly ids were accidentally used for (deleted) In-App
// Purchases; Apple permanently reserves product ids even after deletion, so the
// subscriptions use these `.sub.` ids instead.
export const APP_STORE_PRODUCT_IDS: Record<Exclude<Tier, "free">, string> = {
  plus: process.env.IAP_PLUS_PRODUCT_ID || "com.davidwiduba.takiai.sub.plus.monthly",
  plus_voice: process.env.IAP_PREMIUM_PRODUCT_ID || "com.davidwiduba.takiai.sub.plusvoice.monthly",
  pro: process.env.IAP_PRO_PRODUCT_ID || "com.davidwiduba.takiai.sub.pro.monthly"
};

export const PRODUCT_TO_TIER: Record<string, Tier> = {
  [APP_STORE_PRODUCT_IDS.plus]: "plus",
  [APP_STORE_PRODUCT_IDS.plus_voice]: "plus_voice",
  [APP_STORE_PRODUCT_IDS.pro]: "pro",
  // Preserve receipts from the original customer-facing Plus Voice product.
  "com.davidwiduba.takiai.sub.plusvoice.monthly": "plus_voice"
};

export interface TxInfo {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  purchaseDate?: number;
  expiresDate?: number;   // epoch ms (auto-renewables)
  revocationDate?: number;
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
  if (typeof jws !== "string" || jws.length === 0 || jws.length > MAX_SIGNED_PAYLOAD_LENGTH) return null;
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function toTxInfo(payload: any, options: { allowRevoked?: boolean } = {}): TxInfo | null {
  const productId = String(payload?.productId || "");
  const tier = PRODUCT_TO_TIER[productId];
  if (!tier) return null;
  // Apple always includes bundleId in a verified transaction.  Treat a missing
  // value as invalid rather than accepting an attacker-controlled partial JSON
  // payload.
  if (payload.bundleId !== BUNDLE_ID) return null;
  const transactionId = String(payload.transactionId || "");
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(transactionId)) return null;
  const originalTransactionId = String(payload.originalTransactionId || transactionId);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(originalTransactionId)) return null;
  const expiresDate = typeof payload.expiresDate === "number" && Number.isFinite(payload.expiresDate) ? payload.expiresDate : undefined;
  const purchaseDate = typeof payload.purchaseDate === "number" && Number.isFinite(payload.purchaseDate) ? payload.purchaseDate : undefined;
  const revocationDate = typeof payload.revocationDate === "number" && Number.isFinite(payload.revocationDate) ? payload.revocationDate : undefined;
  // A revoked/refunded transaction is not an active entitlement.  It may still
  // be delivered in a restore snapshot or notification, but it must not reach a
  // grant path.
  if (!options.allowRevoked && revocationDate !== undefined && revocationDate > 0) return null;
  return {
    productId, transactionId, originalTransactionId, purchaseDate, expiresDate, revocationDate,
    environment: payload.environment, bundleId: payload.bundleId, tier,
    periodKey: `${originalTransactionId}:${expiresDate ?? transactionId}`
  };
}

async function verifiedTransactionPayload(jws: string): Promise<any | null> {
  const peek = decodePayload(jws);
  if (!peek) return null;
  const env = String(peek.environment || "");

  // Local Xcode / LocalTesting is only valid when an operator explicitly opts in
  // for a non-production test process.  Never trust this marker by itself.
  if (env === "Xcode" || env === "LocalTesting") {
    if (!ALLOW_LOCAL_TRANSACTIONS) return null;
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
  if (!pack || !/^[A-Za-z0-9._:-]{1,256}$/.test(transactionId)) return null;
  if (payload.bundleId !== BUNDLE_ID) return null;
  if (typeof payload.revocationDate === "number" && payload.revocationDate > 0) return null;
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
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(transactionId) || !identity) return Promise.resolve("conflict");
  const prior = creditClaimChains.get(transactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapcredit:${transactionId}`;
    const result = await storeUpdate<{ identity: string }, CreditClaimResult>(key, { identity: "" }, (existing) => {
      if (existing.identity && existing.identity !== identity) return { value: existing, result: "conflict" };
      if (existing.identity === identity) return { value: existing, result: "existing" };
      return { value: { identity }, result: "claimed" };
    });
    if (result === "conflict") return result;
    const reverseKey = `iapcreditidentity:${safeIdentity(identity)}`;
    await storeUpdate<{ transactionIds: string[] }, void>(reverseKey, { transactionIds: [] }, (reverse) => {
      const transactionIds = Array.isArray(reverse.transactionIds) ? reverse.transactionIds : [];
      if (!transactionIds.includes(transactionId)) transactionIds.push(transactionId);
      return { value: { transactionIds: transactionIds.slice(-1000) }, result: undefined };
    });
    return result;
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
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(transactionId) || !identity) return;
  const prior = creditClaimChains.get(transactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapcredit:${transactionId}`;
    const change = await storeUpdate<{ identity: string }, { previous: string; alreadyOwned: boolean }>(key, { identity: "" }, (existing) => {
      if (existing.identity === identity) return { value: existing, result: { previous: identity, alreadyOwned: true } };
      return { value: { identity }, result: { previous: existing.identity || "", alreadyOwned: false } };
    });
    if (change.alreadyOwned) return;
    // Drop the transaction from the previous owner's reverse index.
    if (change.previous) {
      const oldKey = `iapcreditidentity:${safeIdentity(change.previous)}`;
      await storeUpdate<{ transactionIds: string[] }, void>(oldKey, { transactionIds: [] }, (stored) => ({
        value: { transactionIds: (Array.isArray(stored.transactionIds) ? stored.transactionIds : []).filter((t) => t !== transactionId) },
        result: undefined
      }));
    }
    const reverseKey = `iapcreditidentity:${safeIdentity(identity)}`;
    await storeUpdate<{ transactionIds: string[] }, void>(reverseKey, { transactionIds: [] }, (stored) => {
      const transactionIds = Array.isArray(stored.transactionIds) ? stored.transactionIds : [];
      if (!transactionIds.includes(transactionId)) transactionIds.push(transactionId);
      return { value: { transactionIds: transactionIds.slice(-1000) }, result: undefined };
    });
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
  const transactionIds = await storeUpdate<{ transactionIds: string[] }, string[]>(fromKey, { transactionIds: [] }, (stored) => {
    const ids = Array.isArray(stored.transactionIds) ? stored.transactionIds : [];
    return { value: { transactionIds: [] }, result: ids };
  });
  if (!transactionIds.length) return;
  for (const transactionId of transactionIds) {
    const key = `iapcredit:${transactionId}`;
    const moved = await storeUpdate<{ identity: string }, boolean>(key, { identity: "" }, (owner) => {
      if (owner.identity && owner.identity !== fromIdentity) return { value: owner, result: false };
      return { value: { identity: toIdentity }, result: true };
    });
    if (!moved) continue;
    await storeUpdate<{ transactionIds: string[] }, void>(toKey, { transactionIds: [] }, (stored) => {
      const ids = Array.isArray(stored.transactionIds) ? stored.transactionIds : [];
      if (!ids.includes(transactionId)) ids.push(transactionId);
      return { value: { transactionIds: ids.slice(-1000) }, result: undefined };
    });
  }
}

/* ---- Ownership map + App Store Server Notifications --------------------- */
// Apple's notifications identify a subscription by its originalTransactionId, not
// by our app identity — so at purchase time we remember which identity owns each
// subscription, and look it up when a renewal/refund notification arrives.
export function linkTransactionIdentity(originalTransactionId: string, identity: string): Promise<CreditClaimResult> {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(originalTransactionId) || !identity) return Promise.resolve("conflict");
  const prior = subscriptionClaimChains.get(originalTransactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const result = await storeUpdate<{ identity: string; role?: "primary" | "secondary" }, CreditClaimResult>(
      `iapmap:${originalTransactionId}`,
      { identity: "" },
      (existing) => {
        if (existing.identity && existing.identity !== identity) return { value: existing, result: "conflict" };
        if (existing.identity === identity) return { value: existing, result: "existing" };
        return { value: { identity, role: existing.role }, result: "claimed" };
      }
    );
    if (result === "conflict") return result;
    const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    await storeUpdate<{ transactionIds: string[] }, void>(reverseKey, { transactionIds: [] }, (reverse) => {
      const transactionIds = Array.isArray(reverse.transactionIds) ? reverse.transactionIds : [];
      if (!transactionIds.includes(originalTransactionId)) transactionIds.push(originalTransactionId);
      return { value: { transactionIds }, result: undefined };
    });
    return result;
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
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(originalTransactionId) || !identity) return;
  const prior = subscriptionClaimChains.get(originalTransactionId) || Promise.resolve();
  const current = prior.then(async () => {
    const existing = await storeUpdate<{ identity: string; role?: "primary" | "secondary" }, { identity: string; role?: "primary" | "secondary" }>(
      `iapmap:${originalTransactionId}`,
      { identity: "" },
      (stored) => ({ value: { identity, role: stored.role || "primary" }, result: { identity: stored.identity || "", role: stored.role } })
    );
    if (existing.identity && existing.identity !== identity) {
      const oldKey = `iapidentity:${existing.identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      await storeUpdate<{ transactionIds: string[] }, void>(oldKey, { transactionIds: [] }, (stored) => ({
        value: { transactionIds: (Array.isArray(stored.transactionIds) ? stored.transactionIds : []).filter((id) => id !== originalTransactionId) },
        result: undefined
      }));
    }
    const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    await storeUpdate<{ transactionIds: string[] }, void>(reverseKey, { transactionIds: [] }, (stored) => {
      const transactionIds = Array.isArray(stored.transactionIds) ? stored.transactionIds : [];
      if (!transactionIds.includes(originalTransactionId)) transactionIds.push(originalTransactionId);
      return { value: { transactionIds }, result: undefined };
    });
  });
  subscriptionClaimChains.set(originalTransactionId, current.then(() => undefined, () => undefined));
  return current;
}

// Global "this subscription billing period was already granted" guard, keyed by
// the period key (which embeds the originalTransactionId). Returns true the FIRST
// time a period is seen and false afterward, so credits for one cycle land on
// exactly one identity even across device transfers.
const periodClaimChains = new Map<string, Promise<void>>();
const PERIOD_CLAIM_TTL_MS = 10 * 60_000;
export function claimSubscriptionPeriod(periodKey: string): Promise<boolean> {
  if (!periodKey) return Promise.resolve(true);
  const prior = periodClaimChains.get(periodKey) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapperiod:${periodKey}`;
    return storeUpdate<unknown, boolean>(key, false, (claimed) => {
      const now = Date.now();
      // A claim is normally permanent because grantForTransaction records its
      // own idempotency key. If the process dies after claiming but before the
      // grant write, allow a later retry to recover instead of losing a cycle.
      const claimedAt = claimed && typeof claimed === "object"
        ? Number((claimed as { claimedAt?: unknown }).claimedAt || 0)
        : claimed === true ? Number.POSITIVE_INFINITY : 0;
      if (claimedAt === Number.POSITIVE_INFINITY || (claimedAt > 0 && now - claimedAt < PERIOD_CLAIM_TTL_MS)) {
        return { value: claimed, result: false };
      }
      return { value: { claimedAt: now }, result: true };
    });
  });
  periodClaimChains.set(periodKey, current.then(() => undefined, () => undefined));
  return current;
}

/**
 * Release a period reservation when the ledger grant could not be committed.
 * The reservation is deliberately short-lived to recover from a process crash,
 * but an immediate release avoids losing a renewal when a transient database
 * error happens between the claim and the account write.
 */
export function releaseSubscriptionPeriod(periodKey: string): Promise<void> {
  if (!periodKey) return Promise.resolve();
  const prior = periodClaimChains.get(periodKey) || Promise.resolve();
  const current = prior.then(async () => {
    const key = `iapperiod:${periodKey}`;
    await storeUpdate<unknown, void>(key, false, (claimed) => {
      if (claimed === true) return { value: claimed, result: undefined };
      // A failed grant owns the fresh reservation and must release it
      // immediately.  Leaving it in place until the ten-minute recovery TTL
      // made a transient ledger/database error permanently look like a
      // successful grant to subsequent retries.  Old, already-expired claims
      // are simply cleared as well; the next verified transaction can safely
      // claim the period again.
      return { value: false, result: undefined };
    });
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
  const prior = await storeUpdate<{ identity: string; role?: "primary" | "secondary" }, { identity: string }>(
    `iapmap:${originalTransactionId}`,
    { identity: "" },
    (stored) => ({ value: { identity, role }, result: { identity: String(stored?.identity || "") } })
  );
  if (prior.identity && prior.identity !== identity) {
    const priorKey = `iapidentity:${prior.identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    await storeUpdate<{ transactionIds: string[] }, void>(priorKey, { transactionIds: [] }, (stored) => ({
      value: { transactionIds: (Array.isArray(stored.transactionIds) ? stored.transactionIds : []).filter((id) => id !== originalTransactionId) },
      result: undefined
    }));
  }
  const reverseKey = `iapidentity:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await storeUpdate<{ transactionIds: string[] }, void>(reverseKey, { transactionIds: [] }, (stored) => {
    const transactionIds = Array.isArray(stored.transactionIds) ? stored.transactionIds : [];
    if (!transactionIds.includes(originalTransactionId)) transactionIds.push(originalTransactionId);
    return { value: { transactionIds: transactionIds.slice(-1000) }, result: undefined };
  });
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
  const role = await storeUpdate<{ originalTransactionId: string }, "primary" | "secondary">(
    primaryKey(identity),
    { originalTransactionId: "" },
    (stored) => {
      const existing = String(stored?.originalTransactionId || "");
      if (!existing) return { value: { originalTransactionId }, result: "primary" };
      return { value: { originalTransactionId: existing }, result: existing === originalTransactionId ? "primary" : "secondary" };
    }
  );
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
  if (env === "Xcode" || env === "LocalTesting") {
    if (!ALLOW_LOCAL_TRANSACTIONS) return null;
    decoded = peek;
  } else if (ALLOW_UNVERIFIED) {
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
  // A REFUND/REVOKE notification intentionally carries a transaction whose
  // revocationDate is set. It must still be decoded so the owner can be found
  // and unused subscription credits can be clawed back; ordinary purchase
  // verification continues to reject revoked transactions.
  const signedTransactionPayload = typeof signedTx === "string" ? await verifiedTransactionPayload(signedTx) : null;
  const tx = signedTransactionPayload ? toTxInfo(signedTransactionPayload, { allowRevoked: true }) : null;
  return {
    notificationType: String(decoded.notificationType || ""),
    subtype: decoded.subtype ? String(decoded.subtype) : undefined,
    tx
  };
}
