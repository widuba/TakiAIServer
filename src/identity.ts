import { devicesForApple } from "./safety.js";
import { storeGet, storeSet } from "./store.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const deviceCredentialKey = (deviceId: string) => `devicecredential:${deviceId}`;
const hashCredential = (value: string) => createHash("sha256").update(value).digest("hex");
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Keep the bearer session secret server-side.  A development-only ephemeral
// fallback avoids making local tests require another .env value, while
// production refuses to issue sessions unless a stable secret is configured.
const WEB_SESSION_SECRET = (process.env.WEB_SESSION_SECRET || process.env.PURCHASE_LINK_SECRET || process.env.ADMIN_SECRET || "").trim();

// The visible eight-digit Account ID is an identifier, never a password. Each
// installation also receives this opaque credential; only its hash is retained.
export async function issueDeviceCredential(deviceId: string): Promise<string> {
  const credential = randomBytes(32).toString("base64url");
  await storeSet(deviceCredentialKey(deviceId), hashCredential(credential));
  return credential;
}

export async function verifyDeviceCredential(deviceId: string, credential: string): Promise<boolean> {
  if (!/^\d{8}$/.test(deviceId) || !credential || credential.length < 32) return false;
  const expected = await storeGet<string>(deviceCredentialKey(deviceId), "");
  const actual = hashCredential(credential);
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// Web sign-ins (takiai.app/app) have no physical device to link, so a verified
// Apple/Google web account is recorded under this marker. It is set ONLY after
// the server has cryptographically verified the provider's ID token.
function webAuthKey(identity: string): string {
  return `webauth:${identity}`;
}

export function isWebAccountIdentity(identity: string): boolean {
  return /^(apple|google):.+/.test(identity);
}

export async function markWebAuthenticated(identity: string): Promise<void> {
  if (isWebAccountIdentity(identity)) await storeSet(webAuthKey(identity), true);
}

function sessionSecret(): string {
  if (WEB_SESSION_SECRET) return WEB_SESSION_SECRET;
  if (process.env.NODE_ENV === "production") return "";
  // The module lifetime is sufficient for local development and test runs;
  // unlike the old permanent identity marker, this is never sent to clients.
  return process.env.TAKI_DEV_SESSION_SECRET || "taki-development-session-secret";
}

function sessionSignature(body: string): string {
  return createHmac("sha256", sessionSecret()).update(body).digest("base64url");
}

/** Issue a short-lived, signed bearer session for a verified web identity. */
export async function issueWebSession(identity: string): Promise<string | null> {
  if (!isWebAccountIdentity(identity) || !sessionSecret()) return null;
  if (!(await storeGet<boolean>(webAuthKey(identity), false)) || !(await isKnownIdentity(identity))) return null;
  const payload = { identity, exp: Date.now() + WEB_SESSION_TTL_MS, nonce: randomBytes(12).toString("base64url") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sessionSignature(body)}`;
}

/** Validate a session and make deletion/revocation effective immediately. */
export async function verifyWebSession(identity: string, token: unknown): Promise<boolean> {
  if (!isWebAccountIdentity(identity) || typeof token !== "string" || token.length > 4096 || !sessionSecret()) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, supplied] = parts;
  if (!body || !supplied || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(supplied)) return false;
  const expected = sessionSignature(body);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { identity?: string; exp?: number; nonce?: string };
    if (payload.identity !== identity || !Number.isSafeInteger(payload.exp) || Number(payload.exp) <= Date.now() || typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.nonce)) return false;
    // A signed token is not a permanent login. Logout, account deletion, and
    // provider reauthentication revoke this marker, which must invalidate all
    // previously issued sessions immediately instead of waiting for expiry.
    return (await storeGet<boolean>(webAuthKey(identity), false)) && await isKnownIdentity(identity);
  } catch {
    return false;
  }
}

export async function revokeWebAuthentication(identity: string): Promise<void> {
  if (isWebAccountIdentity(identity)) await storeSet(webAuthKey(identity), false);
}

export async function isKnownIdentity(identity: string): Promise<boolean> {
  if (/^\d{8}$/.test(identity)) {
    return await storeGet<boolean>(`devnum:used:${identity}`, false);
  }
  if (identity.startsWith("apple:") && identity.length > "apple:".length) {
    // Known through an iOS device link OR a verified web sign-in.
    if ((await devicesForApple(identity.slice("apple:".length))).length > 0) return true;
    return await storeGet<boolean>(webAuthKey(identity), false);
  }
  if (identity.startsWith("google:") && identity.length > "google:".length) {
    return await storeGet<boolean>(webAuthKey(identity), false);
  }
  return false;
}
