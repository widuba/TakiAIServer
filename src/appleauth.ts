import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import fs from "node:fs";

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
// Sign in with Apple on the WEB (takiai.app/app) issues tokens whose audience is
// a Services ID, not the app's bundle id. Accept it too when configured.
const WEB_SERVICES_ID = (process.env.APPLE_WEB_SERVICES_ID || "").trim();
const APPLE_AUDIENCES = [BUNDLE_ID, ...(WEB_SERVICES_ID ? [WEB_SERVICES_ID] : [])];

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
      audience: APPLE_AUDIENCES
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

export async function revokeAppleAuthorizationCode(authorizationCode: string): Promise<boolean> {
  const teamId = (process.env.APPLE_TEAM_ID || process.env.APNS_TEAM_ID || "").trim();
  const keyId = (process.env.APPLE_SIGN_IN_KEY_ID || process.env.APNS_KEY_ID || "").trim();
  const keyPath = (process.env.APPLE_SIGN_IN_KEY_PATH || process.env.APNS_KEY_PATH || "").trim();
  let privateKeyText = (process.env.APPLE_SIGN_IN_KEY_P8 || process.env.APNS_KEY_P8 || "")
    .replace(/\\n/g, "\n").trim();
  if (!privateKeyText && keyPath) {
    try { privateKeyText = fs.readFileSync(keyPath, "utf8").trim(); }
    catch (error) { console.error("Apple private key read failed:", (error as Error)?.message || error); }
  }
  if (!authorizationCode || !teamId || !keyId || !privateKeyText) {
    console.error("Apple token revocation is not configured");
    return false;
  }
  try {
    const privateKey = await importPKCS8(privateKeyText, "ES256");
    const clientSecret = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setSubject(BUNDLE_ID)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const tokenResponse = await fetch(`${APPLE_ISSUER}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: BUNDLE_ID,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: "authorization_code"
      })
    });
    const tokens: any = await tokenResponse.json().catch(() => ({}));
    const token = String(tokens.refresh_token || tokens.access_token || "");
    if (!tokenResponse.ok || !token) {
      console.error("Apple authorization-code exchange failed:", tokenResponse.status);
      return false;
    }
    const revokeResponse = await fetch(`${APPLE_ISSUER}/auth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: BUNDLE_ID,
        client_secret: clientSecret,
        token,
        token_type_hint: tokens.refresh_token ? "refresh_token" : "access_token"
      })
    });
    if (!revokeResponse.ok) console.error("Apple token revocation failed:", revokeResponse.status);
    return revokeResponse.ok;
  } catch (error) {
    console.error("Apple token revocation error:", (error as Error)?.message || error);
    return false;
  }
}

// The credits-ledger identity for a signed-in Apple user. Namespaced so it can
// never collide with a raw device id.
export function appleIdentity(sub: string): string {
  return `apple:${sub}`;
}
