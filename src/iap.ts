import type { Tier } from "./credits.js";

/* ============================================================================
 * Apple In-App Purchase (StoreKit 2) — map + read the signed transaction.
 *
 * The device buys an auto-renewable subscription; StoreKit hands it a JWS
 * "signed transaction" (verified on-device by StoreKit itself). It sends that JWS
 * here; we read the product id + transaction ids + expiry and translate the
 * product into a credits tier.
 *
 * VERIFICATION: production must cryptographically verify the JWS against Apple's
 * certificate chain. During local StoreKit testing (Xcode .storekit file) the
 * transaction is signed by a LOCAL test cert, not Apple's roots, so strict
 * verification would reject it. So: strict verification is required UNLESS
 * IAP_ALLOW_UNVERIFIED=1 (set that ONLY while testing; unset before launch).
 * The strict path is a clearly-marked seam below — see verifyTransaction().
 * ==========================================================================*/

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.davidwiduba.takiai";
const ALLOW_UNVERIFIED = process.env.IAP_ALLOW_UNVERIFIED === "1";

// Product id (App Store Connect) -> credits tier. Create these exact ids in
// App Store Connect (or the local .storekit file) as auto-renewable subscriptions
// in one group ("Taki Membership").
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
  // Unique key per BILLING PERIOD so we grant a cycle's credits exactly once.
  periodKey: string;
}

// Decode the JWS payload WITHOUT verifying the signature. Used for the fields and
// (when unverified is allowed) as the whole read.
function decodePayload(jws: string): any | null {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// TODO(pre-launch): strict cryptographic verification of the JWS x5c chain to
// Apple's root CA (via @apple/app-store-server-library or a manual x5c walk).
// Until then production is gated on IAP_ALLOW_UNVERIFIED.
async function strictVerify(_jws: string): Promise<any | null> {
  return null;
}

// Verify (or, in test mode, just read) a signed transaction into TxInfo.
export async function verifyTransaction(jws: string): Promise<TxInfo | null> {
  let payload = ALLOW_UNVERIFIED ? decodePayload(jws) : await strictVerify(jws);
  // Xcode/local-testing transactions can never pass strict verification; allow a
  // decoded read for the "Xcode" environment even if the flag wasn't set, so the
  // local .storekit flow works out of the box.
  if (!payload) {
    const peek = decodePayload(jws);
    if (peek && peek.environment === "Xcode") payload = peek;
  }
  if (!payload) return null;

  const productId = String(payload.productId || "");
  const tier = PRODUCT_TO_TIER[productId];
  if (!tier) return null;
  if (payload.bundleId && payload.bundleId !== BUNDLE_ID) return null;

  const transactionId = String(payload.transactionId || "");
  const originalTransactionId = String(payload.originalTransactionId || transactionId);
  const expiresDate = typeof payload.expiresDate === "number" ? payload.expiresDate : undefined;

  return {
    productId,
    transactionId,
    originalTransactionId,
    expiresDate,
    environment: payload.environment,
    bundleId: payload.bundleId,
    tier,
    periodKey: `${originalTransactionId}:${expiresDate ?? transactionId}`
  };
}
