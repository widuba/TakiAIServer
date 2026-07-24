import { createRemoteJWKSet, jwtVerify } from "jose";

/* ============================================================================
 * Sign in with Google — verify the ID token the web app gets from Google
 * Identity Services. Same pattern as Sign in with Apple: RS256 JWT verified
 * against Google's published keys, audience must be OUR OAuth client id, and
 * the stable user id (`sub`) becomes the credits identity ("google:<sub>").
 * Web chat requires one of these sign-ins — the monthly free credits attach to
 * the verified account, not to a clearable browser storage key.
 * ==========================================================================*/

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_WEB_CLIENT_ID = (process.env.GOOGLE_WEB_CLIENT_ID || "").trim();

export function isGoogleWebAuthConfigured(): boolean {
  return Boolean(GOOGLE_WEB_CLIENT_ID);
}

export function googleWebClientId(): string {
  return GOOGLE_WEB_CLIENT_ID;
}

export interface GoogleIdentity {
  sub: string;            // stable Google user id
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  if (!idToken || typeof idToken !== "string" || !GOOGLE_WEB_CLIENT_ID) return null;
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: GOOGLE_WEB_CLIENT_ID
    });
    if (!payload.sub) return null;
    return {
      sub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : undefined,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : undefined
    };
  } catch (error) {
    console.error("Google identity verify failed:", (error as Error)?.message || error);
    return null;
  }
}
