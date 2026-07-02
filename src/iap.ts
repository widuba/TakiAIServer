import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { SignedDataVerifier, Environment } from "@apple/app-store-server-library";
import type { Tier } from "./credits.js";

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
export const PRODUCT_TO_TIER: Record<string, Tier> = {
  "com.davidwiduba.takiai.plus.monthly": "plus",
  "com.davidwiduba.takiai.plusvoice.monthly": "plus_voice",
  "com.davidwiduba.takiai.pro.monthly": "pro"
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

// Verify (Sandbox/Production) or decode (Xcode/local) a signed transaction.
export async function verifyTransaction(jws: string): Promise<TxInfo | null> {
  const peek = decodePayload(jws);
  if (!peek) return null;
  const env = String(peek.environment || "");

  // Local Xcode / LocalTesting: no Apple-signed chain to verify — decode only.
  if (env === "Xcode" || env === "LocalTesting") {
    return toTxInfo(peek);
  }

  // Emergency override.
  if (ALLOW_UNVERIFIED) return toTxInfo(peek);

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
    const decoded = await verifier.verifyAndDecodeTransaction(jws);
    return toTxInfo(decoded);
  } catch (e) {
    console.error("IAP: transaction verification failed:", (e as Error)?.message);
    return null;
  }
}
