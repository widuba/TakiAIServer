import crypto from "node:crypto";
import http2 from "node:http2";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeGet, storeSet } from "./store.js";

/* ============================================================================
 * Apple Push Notification service (APNs) — token-based (.p8) provider.
 *
 * Lets the server push proactive alerts to the device (commute "leave now",
 * fresh morning briefing, breaking sports/finance) even when the app is closed.
 *
 * Config (all via .env — nothing is committed):
 *   APNS_KEY_PATH   absolute path to the AuthKey_XXXX.p8 you downloaded
 *   APNS_KEY_ID     the Key ID shown next to the key in the portal (10 chars)
 *   APNS_TEAM_ID    your Apple Developer Team ID (10 chars)
 *   APNS_BUNDLE_ID  app bundle id (default com.davidwiduba.takiai)
 *   APNS_ENV        "sandbox" (Xcode/dev builds, default) or "production"
 *
 * If the key isn't configured the module no-ops cleanly so the rest of the
 * server runs untouched.
 * ==========================================================================*/

const KEY_ID = process.env.APNS_KEY_ID || "";
const TEAM_ID = process.env.APNS_TEAM_ID || "";
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.davidwiduba.takiai";
const APNS_ENV = (process.env.APNS_ENV || "sandbox").toLowerCase();
const APNS_HOST =
  APNS_ENV === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";

function loadKey(): string | null {
  const p = process.env.APNS_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  // Fallback: inline PEM with literal "\n" escapes.
  const inline = process.env.APNS_KEY_P8;
  if (inline) return inline.replace(/\\n/g, "\n");
  return null;
}

const P8 = loadKey();

export function isPushConfigured(): boolean {
  return Boolean(P8 && KEY_ID && TEAM_ID);
}

// --- provider JWT (ES256), cached & refreshed well within Apple's 60-min cap ---
let cachedToken = "";
let cachedAt = 0;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function providerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now - cachedAt < 50 * 60) return cachedToken;

  const header = base64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
  const payload = base64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const signingInput = `${header}.${payload}`;
  // EC P-256 signature in JOSE (raw r||s) form — what JWT ES256 expects.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: P8 as string,
    dsaEncoding: "ieee-p1363"
  });
  cachedToken = `${signingInput}.${base64url(signature)}`;
  cachedAt = now;
  return cachedToken;
}

export interface PushMessage {
  title: string;
  body: string;
  sound?: string;          // default "default"; pass "" for silent
  threadId?: string;       // groups related notifications
  data?: Record<string, unknown>; // custom payload the app can read
}

export interface PushResult {
  token: string;
  ok: boolean;
  status: number;
  reason?: string;
}

// Send one alert to one device token. Resolves with the APNs status.
export function sendPush(deviceToken: string, msg: PushMessage): Promise<PushResult> {
  return new Promise((resolve) => {
    if (!isPushConfigured()) {
      resolve({ token: deviceToken, ok: false, status: 0, reason: "apns-not-configured" });
      return;
    }
    const client = http2.connect(APNS_HOST);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: PushResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { client.close(); } catch { client.destroy(); }
      resolve(result);
    };
    client.on("error", (err) => finish({ token: deviceToken, ok: false, status: 0, reason: String(err) }));

    const aps: Record<string, unknown> = {
      alert: { title: msg.title, body: msg.body }
    };
    if (msg.sound !== "") aps.sound = msg.sound || "default";
    if (msg.threadId) aps["thread-id"] = msg.threadId;
    const payload = JSON.stringify({ aps, ...(msg.data || {}) });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json"
    });

    let status = 0;
    let bodyText = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => (bodyText += chunk));
    req.on("end", () => {
      const ok = status === 200;
      let reason: string | undefined;
      if (!ok && bodyText) {
        try {
          reason = JSON.parse(bodyText).reason;
        } catch {
          reason = bodyText;
        }
      }
      finish({ token: deviceToken, ok, status, reason });
    });
    req.on("error", (err) => {
      finish({ token: deviceToken, ok: false, status, reason: String(err) });
    });
    timeout = setTimeout(() => {
      client.destroy();
      finish({ token: deviceToken, ok: false, status, reason: "APNs request timed out" });
    }, 15_000);
    req.end(payload);
  });
}

/* --- device token registry (in-memory + JSON file so restarts keep tokens) --- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "..", "push-tokens.json");

function readStore(): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

let tokens = readStore();

function persist() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify([...tokens]));
  } catch {
    /* best effort */
  }
}

export function registerToken(token: string): void {
  const t = token.trim();
  if (!t) return;
  if (!tokens.has(t)) {
    tokens.add(t);
    persist();
  }
}

export function forgetToken(token: string): void {
  if (tokens.delete(token.trim())) persist();
}

export function getTokens(): string[] {
  return [...tokens];
}

// Broadcast to every registered device. Prunes tokens Apple reports as dead.
export async function broadcast(msg: PushMessage): Promise<PushResult[]> {
  const results = await Promise.all(getTokens().map((t) => sendPush(t, msg)));
  for (const r of results) {
    // 410 Gone / BadDeviceToken => the app was removed; stop pushing to it.
    if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") {
      forgetToken(r.token);
    }
  }
  return results;
}

/* --- Live Activity push (background updates of an existing activity) -------- *
 * Each running finance/sports/commute Live Activity has its OWN push token. The
 * server pushes content-state updates to it directly, so the lock screen +
 * Dynamic Island stay live even when the app is closed.
 * ------------------------------------------------------------------------- */

export interface LARegistration {
  id: string;       // logical activity id (matches the device)
  kind: string;     // "finance" | "sports" | "commute"
  meta: Record<string, any>; // kind-specific: {query} or commute route params
  token: string;    // ActivityKit push token (hex)
  startedAt: number;
  environment?: "sandbox" | "production";
}

const LA_STORE_PATH = path.join(__dirname, "..", "la-tokens.json");
const LA_STORE_KEY = "live-activity-registrations:v2";

function readLA(): Map<string, LARegistration> {
  try {
    const arr = JSON.parse(fs.readFileSync(LA_STORE_PATH, "utf8"));
    return new Map((Array.isArray(arr) ? arr : []).map((r: LARegistration) => [r.id, r]));
  } catch {
    return new Map();
  }
}

let laRegs = readLA();
let laMutationChain: Promise<unknown> = Promise.resolve();
function mutateLiveActivities<T>(fn: () => Promise<T>): Promise<T> {
  const run = laMutationChain.then(fn, fn);
  laMutationChain = run.then(() => undefined, () => undefined);
  return run;
}
const laReady = (async () => {
  const durable = await storeGet<LARegistration[]>(LA_STORE_KEY, []);
  if (durable.length) laRegs = new Map(durable.map((registration) => [registration.id, registration]));
  else if (laRegs.size) await storeSet(LA_STORE_KEY, [...laRegs.values()]);
})();

async function persistLA() {
  try {
    fs.writeFileSync(LA_STORE_PATH, JSON.stringify([...laRegs.values()]));
  } catch {
    /* best effort */
  }
  await storeSet(LA_STORE_KEY, [...laRegs.values()]);
}

export async function registerLiveActivity(reg: { id: string; kind: string; meta: Record<string, any>; token: string; environment?: "sandbox" | "production" }): Promise<void> {
  await laReady;
  if (!reg.id || !reg.token) return;
  await mutateLiveActivities(async () => {
    const existing = laRegs.get(reg.id);
    laRegs.set(reg.id, { ...reg, startedAt: existing?.startedAt ?? Date.now() });
    await persistLA();
  });
}

export async function unregisterLiveActivity(id: string): Promise<void> {
  await laReady;
  await mutateLiveActivities(async () => {
    if (laRegs.delete(id)) await persistLA();
  });
}

export async function getLiveActivities(): Promise<LARegistration[]> {
  await laReady;
  return [...laRegs.values()];
}

export async function clearPushStateForReset(): Promise<void> {
  await laReady;
  tokens.clear();
  persist();
  await mutateLiveActivities(async () => {
    laRegs.clear();
    await persistLA();
  });
}

// Push a content-state update (or an end) to one Live Activity push token.
// Pass contentState = null for an "end" with no final state.
export function sendLiveActivityUpdate(
  token: string,
  contentState: Record<string, unknown> | null,
  event: "update" | "end" = "update",
  environment?: "sandbox" | "production"
): Promise<PushResult> {
  return new Promise((resolve) => {
    if (!isPushConfigured()) {
      resolve({ token, ok: false, status: 0, reason: "apns-not-configured" });
      return;
    }
    const host = environment === "production"
      ? "https://api.push.apple.com"
      : environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : APNS_HOST;
    const client = http2.connect(host);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: PushResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { client.close(); } catch { client.destroy(); }
      resolve(result);
    };
    client.on("error", (err) => finish({ token, ok: false, status: 0, reason: String(err) }));

    const now = Math.floor(Date.now() / 1000);
    const aps: Record<string, unknown> = { timestamp: now, event };
    if (contentState) aps["content-state"] = contentState;
    // If background updates stop reaching the phone, iOS can visually mark the
    // information stale instead of presenting an old score, quote, or ETA as live.
    if (event === "update") aps["stale-date"] = now + 10 * 60;
    if (event === "end") aps["dismissal-date"] = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ aps });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      // The Live Activity topic is the app bundle id + this suffix.
      "apns-topic": `${BUNDLE_ID}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json"
    });

    let status = 0;
    let bodyText = "";
    req.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
    req.setEncoding("utf8");
    req.on("data", (chunk) => (bodyText += chunk));
    req.on("end", () => {
      const ok = status === 200;
      let reason: string | undefined;
      if (!ok && bodyText) {
        try { reason = JSON.parse(bodyText).reason; } catch { reason = bodyText; }
      }
      finish({ token, ok, status, reason });
    });
    req.on("error", (err) => finish({ token, ok: false, status, reason: String(err) }));
    timeout = setTimeout(() => {
      client.destroy();
      finish({ token, ok: false, status, reason: "APNs request timed out" });
    }, 15_000);
    req.end(payload);
  });
}
