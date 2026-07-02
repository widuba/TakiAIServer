import { createRemoteJWKSet, jwtVerify } from "jose";

/* ============================================================================
 * Sign in with Apple — verify the identity token the device gets from Apple.
 *
 * The token is a JWT signed by Apple (RS256). We verify it against Apple's public
 * keys, check it was issued for OUR app (audience = bundle id) by Apple (issuer),
 * and pull the STABLE user id (`sub`). That `sub` is the same across all of the
 * user's devices, which is exactly what lets credits follow the account.
 * ==========================================================================*/

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.davidwiduba.takiai";

export interface AppleIdentity {
  sub: string;            // stable Apple user id (same on every device)
  email?: string;
  emailVerified?: boolean;
}

export async function verifyAppleIdentityToken(idToken: string): Promise<AppleIdentity | null> {
  if (!idToken || typeof idToken !== "string") return null;
  try {
    const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: BUNDLE_ID
    });
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified: payload.email_verified === true || payload.email_verified === "true"
    };
  } catch (error) {
    console.error("Apple identity verify failed:", (error as Error)?.message || error);
    return null;
  }
}

// The credits-ledger identity for a signed-in Apple user. Namespaced so it can
// never collide with a raw device id.
export function appleIdentity(sub: string): string {
  return `apple:${sub}`;
}
