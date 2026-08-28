import crypto from "node:crypto";
import http2 from "node:http2";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDurable, storeDelete, storeEntries, storeGet, storeGetMany, storeSet, storeUpdate } from "./store.js";

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
const REQUIRES_DURABLE_STORAGE = process.env.NODE_ENV === "production"
  || process.env.RENDER === "true"
  || process.env.REQUIRE_DURABLE_STORAGE === "1";

function durableStateRequired(): boolean {
  return REQUIRES_DURABLE_STORAGE;
}

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

const APNS_TOKEN_PATTERN = /^[a-f0-9]{32,256}$/i;
const MAX_PUSH_PAYLOAD_BYTES = 4_096;

function validProviderToken(token: string): boolean {
  return APNS_TOKEN_PATTERN.test(String(token || "").trim());
}

function safeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data).slice(0, 24)) {
    const cleanKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
    if (!cleanKey) continue;
    if (typeof value === "string") result[cleanKey] = value.slice(0, 500);
    else if (typeof value === "number" && Number.isFinite(value)) result[cleanKey] = value;
    else if (typeof value === "boolean") result[cleanKey] = value;
  }
  return result;
}

// Send one alert to one device token. Resolves with the APNs status.
export function sendPush(deviceToken: string, msg: PushMessage): Promise<PushResult> {
  return new Promise((resolve) => {
    const token = String(deviceToken || "").trim();
    if (!validProviderToken(token)) {
      resolve({ token, ok: false, status: 400, reason: "InvalidDeviceToken" });
      return;
    }
    if (!isPushConfigured()) {
      resolve({ token, ok: false, status: 0, reason: "apns-not-configured" });
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
      alert: {
        title: String(msg.title || "Taki AI").slice(0, 200),
        body: String(msg.body || "").slice(0, 2_000)
      }
    };
    if (msg.sound !== "") aps.sound = msg.sound || "default";
    if (msg.threadId) aps["thread-id"] = String(msg.threadId).slice(0, 100);
    let payloadObject: Record<string, unknown> = { aps, ...safeData(msg.data) };
    let payload = JSON.stringify(payloadObject);
    // APNs rejects oversized alert payloads. Drop optional custom data before
    // trimming the user-visible text so a malformed admin payload cannot make
    // an otherwise valid notification fail at the provider.
    if (Buffer.byteLength(payload, "utf8") > MAX_PUSH_PAYLOAD_BYTES) {
      payloadObject = { aps: { ...aps, alert: { title: String(msg.title || "Taki AI").slice(0, 120), body: String(msg.body || "").slice(0, 900) } } };
      payload = JSON.stringify(payloadObject);
    }

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
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
    req.on("data", (chunk) => {
      if (bodyText.length < 8_000) bodyText += String(chunk).slice(0, 8_000 - bodyText.length);
    });
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
const TOKEN_INDEX_KEY = "push:tokens:index";

function readStore(): Set<string> {
  // In a hosted production process the local JSON registry is only a
  // diagnostic copy. Never broadcast to stale tokens when the authoritative
  // database is absent; health checks will report the storage configuration
  // problem and a later healthy process can resume safely.
  if (durableStateRequired() && !isDurable()) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const values = Array.isArray(arr)
      ? arr.filter((value): value is string => typeof value === "string" && validProviderToken(value.trim()))
      : [];
    return new Set(values.slice(-100_000));
  } catch {
    return new Set();
  }
}

let tokens = readStore();

function persist() {
  const encoded = JSON.stringify([...tokens]);
  const temporary = `${STORE_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, STORE_PATH);
  } catch {
    /* best effort */
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

export function registerToken(token: string): void {
  const t = String(token || "").trim();
  if (!validProviderToken(t)) return;
  if (!tokens.has(t)) {
    tokens.add(t);
    if (tokens.size > 100_000) tokens = new Set([...tokens].slice(-100_000));
    persist();
  }
}

export function forgetToken(token: string): void {
  if (tokens.delete(String(token || "").trim())) persist();
}

export function getTokens(): string[] {
  return [...tokens];
}

/**
 * Return every known token, including device-bound tokens persisted in the
 * durable store.  The old broadcast path only used the process-local JSON
 * registry, so a Render restart silently stopped admin/test broadcasts even
 * though normal device-targeted nudges still had their token.
 */
export async function getRegisteredTokens(): Promise<string[]> {
  if (durableStateRequired() && !isDurable()) return [];
  const result = new Set(getTokens().filter(validProviderToken));
  if (isDurable()) {
    try {
      // The nudge index is the authoritative bounded list of installations
      // that have synchronized a push manifest. Fetch just those token rows;
      // scanning the entire KV table for every admin broadcast became a major
      // source of timeouts once the account count grew.
      const [nudgeIndex, tokenIndex] = await Promise.all([
        storeGet<{ ids?: unknown }>("nudges:index", { ids: [] }),
        storeGet<{ ids?: unknown }>(TOKEN_INDEX_KEY, { ids: [] })
      ]);
      const deviceIds = [...new Set([
        ...(Array.isArray(nudgeIndex?.ids) ? nudgeIndex.ids : []),
        ...(Array.isArray(tokenIndex?.ids) ? tokenIndex.ids : [])
      ].filter((id): id is string => typeof id === "string" && /^\d{8}$/.test(id)))].slice(-100_000);
      const values = await storeGetMany<string>(deviceIds.map((deviceId) => `push:token:${deviceId}`));
      for (const tokenValue of values.values()) {
        const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
        if (validProviderToken(token)) result.add(token);
        if (result.size >= 100_000) break;
      }
    } catch (error) {
      console.error("durable push-token enumeration failed:", error);
      // In a durable deployment the local JSON file is only a diagnostic copy.
      // Do not send a partial/stale broadcast and report it as successful when
      // the authoritative token lookup is unavailable.
      if (durableStateRequired()) return [];
    }
  }
  return [...result].slice(0, 100_000);
}

/** Remove an APNs token from both the local registry and durable device rows. */
export async function forgetTokenEverywhere(token: string): Promise<void> {
  const normalized = String(token || "").trim();
  if (!normalized) return;
  forgetToken(normalized);
  if (!isDurable()) return;
  try {
    // New registrations are indexed by device id. Read those rows directly so
    // an invalid APNs token does not turn every failed broadcast into a full
    // table scan. Fall back to a scan only for legacy installations created
    // before the index existed; this path is bounded to one migration/cleanup
    // operation and is not used by normal broadcasts.
    const [tokenIndex, nudgeIndex] = await Promise.all([
      storeGet<{ ids?: unknown }>(TOKEN_INDEX_KEY, { ids: [] }),
      storeGet<{ ids?: unknown }>("nudges:index", { ids: [] })
    ]);
    const deviceIds = [...new Set([
      ...(Array.isArray(tokenIndex?.ids) ? tokenIndex.ids : []),
      ...(Array.isArray(nudgeIndex?.ids) ? nudgeIndex.ids : [])
    ].filter((id): id is string => typeof id === "string" && /^\d{8}$/.test(id)))].slice(-100_000);
    const indexedValues = await storeGetMany<string>(deviceIds.map((deviceId) => `push:token:${deviceId}`));
    let matches: Array<{ key: string; value: unknown }> = [...indexedValues.entries()]
      .filter(([, value]) => typeof value === "string" && value.trim() === normalized)
      .map(([key, value]) => ({ key, value }));
    if (!deviceIds.length) {
      matches = (await storeEntries()).filter((entry) =>
        /^push(?::|_)token(?::|_)\d{8}$/.test(entry.key) && entry.value === normalized
      );
    }
    await Promise.all(matches.map((entry) => storeDelete(entry.key)));
    const removedDevices = new Set(matches.map((entry) => entry.key.split(":").pop() || ""));
    await storeUpdate<{ ids?: unknown }, void>(TOKEN_INDEX_KEY, { ids: [] }, (stored) => ({
      value: {
        ids: (Array.isArray(stored?.ids) ? stored.ids : [])
          .filter((id): id is string => typeof id === "string" && !removedDevices.has(id))
      },
      result: undefined
    }));
  } catch (error) {
    console.error("durable push-token removal failed:", error);
  }
}

// Broadcast to every registered device. Prunes tokens Apple reports as dead.
export async function broadcast(msg: PushMessage): Promise<PushResult[]> {
  const targets = await getRegisteredTokens();
  const results: PushResult[] = [];
  // Bound provider concurrency. Launching one HTTP/2 stream per token made a
  // large admin broadcast exhaust sockets and event-loop memory, which then
  // surfaced to the dashboard as a generic 501/502 failure.
  for (let start = 0; start < targets.length; start += 50) {
    const batch = await Promise.all(targets.slice(start, start + 50).map((token) => sendPush(token, msg)));
    results.push(...batch);
  }
  for (const r of results) {
    // 410 Gone / BadDeviceToken => the app was removed; stop pushing to it.
    if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") {
      await forgetTokenEverywhere(r.token);
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
  deviceId: string; // physical owner; prevents another device replacing this id
  kind: string;     // "finance" | "sports" | "commute"
  meta: Record<string, any>; // kind-specific: {query} or commute route params
  token: string;    // ActivityKit push token (hex)
  startedAt: number;
  environment?: "sandbox" | "production";
}

const LA_STORE_PATH = path.join(__dirname, "..", "la-tokens.json");
const LA_STORE_KEY = "live-activity-registrations:v2";
const laKey = (deviceId: string, id: string) => `${deviceId}:${id}`;

function readLA(): Map<string, LARegistration> {
  if (durableStateRequired() && !isDurable()) return new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(LA_STORE_PATH, "utf8"));
    const normalized = normalizeLA(arr, isDurable() || process.env.NODE_ENV === "production");
    return new Map(normalized.map((r) => [laKey(r.deviceId || "legacy", r.id), r]));
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
  const durable = normalizeLA(await storeGet<unknown>(LA_STORE_KEY, []), isDurable() || process.env.NODE_ENV === "production");
  if (durable.length) laRegs = new Map(durable.map((registration) => [laKey(registration.deviceId || "legacy", registration.id), registration]));
  else if (laRegs.size) await storeSet(LA_STORE_KEY, [...laRegs.values()]);
})().catch((error) => {
  // A missing/unavailable production database must not create an unhandled
  // top-level rejection that takes down the entire API process. Live Activity
  // state simply starts empty and each mutating call reports its storage error.
  console.error("Live Activity store initialization failed:", error);
  if (durableStateRequired() && !isDurable()) laRegs.clear();
});

async function persistLocalLA() {
  const encoded = JSON.stringify([...laRegs.values()]);
  const temporary = `${LA_STORE_PATH}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, LA_STORE_PATH);
  } catch {
    /* best effort */
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

function normalizeLA(value: unknown, strictToken = false): LARegistration[] {
  return (Array.isArray(value) ? value : []).flatMap((raw: any): LARegistration[] => {
    if (!raw || typeof raw !== "object") return [];
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 128) : "";
    const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim().slice(0, 16) : "";
    const token = typeof raw.token === "string" ? raw.token.trim().slice(0, 256) : "";
    const kind = typeof raw.kind === "string" ? raw.kind.trim().slice(0, 32) : "";
    // The HTTP route validates real ActivityKit hex tokens before this helper
    // is called. Keep local/in-memory tests and older development registrations
    // readable, while production durable state is restricted to provider tokens.
    const tokenShape = strictToken ? validProviderToken(token) : /^[a-zA-Z0-9_.:-]{1,256}$/.test(token);
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !/^\d{8}$/.test(deviceId) || !tokenShape || !kind) return [];
    const meta: Record<string, any> = {};
    if (raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)) {
      for (const [key, value] of Object.entries(raw.meta).slice(0, 24)) {
        const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
        if (!safeKey) continue;
        if (typeof value === "string") meta[safeKey] = value.slice(0, 400);
        else if (typeof value === "number" && Number.isFinite(value)) meta[safeKey] = value;
        else if (typeof value === "boolean") meta[safeKey] = value;
      }
    }
    const startedAt = Number(raw.startedAt);
    return [{
      id,
      deviceId,
      kind,
      meta,
      token,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
      ...(raw.environment === "sandbox" || raw.environment === "production" ? { environment: raw.environment } : {})
    }];
  }).slice(-10_000);
}

export async function registerLiveActivity(reg: { id: string; deviceId: string; kind: string; meta: Record<string, any>; token: string; environment?: "sandbox" | "production" }): Promise<void> {
  await laReady;
  if (!reg.id || !reg.deviceId || !reg.token) return;
  // ActivityKit push tokens are opaque hexadecimal bytes. Never persist a
  // synthetic or malformed token in durable/production state, even when this
  // helper is called by an internal job instead of the HTTP route.
  if ((isDurable() || process.env.NODE_ENV === "production") && !validProviderToken(String(reg.token).trim())) return;
  const safeRegistration = normalizeLA([{ ...reg, startedAt: Date.now() }])[0];
  if (!safeRegistration) return;
  await mutateLiveActivities(async () => {
    const next = await storeUpdate<LARegistration[], LARegistration[]>(LA_STORE_KEY, [], (stored) => {
      const current = normalizeLA(stored, isDurable() || process.env.NODE_ENV === "production");
      const key = laKey(safeRegistration.deviceId, safeRegistration.id);
      const existing = current.find((item) => laKey(item.deviceId, item.id) === key);
      const merged = current.filter((item) => laKey(item.deviceId, item.id) !== key && laKey(item.deviceId, item.id) !== laKey("legacy", safeRegistration.id));
      merged.push({ ...safeRegistration, startedAt: existing?.startedAt ?? Date.now() });
      const owned = merged.filter((item) => item.deviceId === safeRegistration.deviceId).sort((a, b) => a.startedAt - b.startedAt);
      const remove = new Set(owned.slice(0, Math.max(0, owned.length - 12)).map((item) => laKey(item.deviceId, item.id)));
      const kept = merged.filter((item) => !remove.has(laKey(item.deviceId, item.id)));
      return { value: kept, result: kept };
    });
    laRegs = new Map(next.map((registration) => [laKey(registration.deviceId || "legacy", registration.id), registration]));
    await persistLocalLA();
  });
}

export async function unregisterLiveActivity(id: string, deviceId: string): Promise<void> {
  await laReady;
  await mutateLiveActivities(async () => {
    const next = await storeUpdate<LARegistration[], LARegistration[]>(LA_STORE_KEY, [], (stored) => {
      const current = normalizeLA(stored, isDurable() || process.env.NODE_ENV === "production").filter((registration) => laKey(registration.deviceId, registration.id) !== laKey(deviceId, id));
      return { value: current, result: current };
    });
    laRegs = new Map(next.map((registration) => [laKey(registration.deviceId || "legacy", registration.id), registration]));
    await persistLocalLA();
  });
}

export async function getLiveActivities(): Promise<LARegistration[]> {
  await laReady;
  try {
    const durable = normalizeLA(await storeGet<LARegistration[]>(LA_STORE_KEY, []), isDurable() || process.env.NODE_ENV === "production");
    laRegs = new Map(durable.map((registration) => [laKey(registration.deviceId || "legacy", registration.id), registration]));
  } catch (error) {
    console.error("Live Activity store read failed:", error);
    // A durable-store outage must not make an old local diagnostic copy look
    // authoritative and push stale data to a lock screen. Local development
    // may still use the file-backed registrations, where the copy is the
    // authoritative store.
    if (durableStateRequired() && !isDurable()) return [];
    if (isDurable()) return [];
  }
  return [...laRegs.values()];
}

export async function clearPushStateForReset(): Promise<void> {
  await laReady;
  tokens.clear();
  persist();
  if (isDurable()) {
    try {
      const tokenEntries = (await storeEntries()).filter((entry) => entry.key === TOKEN_INDEX_KEY || /^push(?::|_)token(?::|_)\d{8}$/.test(entry.key));
      await Promise.all(tokenEntries.map((entry) => storeDelete(entry.key)));
    } catch (error) {
      console.error("durable push-token reset failed:", error);
      throw error;
    }
  }
  await mutateLiveActivities(async () => {
    await storeUpdate<LARegistration[], void>(LA_STORE_KEY, [], () => ({ value: [], result: undefined }));
    laRegs.clear();
    await persistLocalLA();
  });
}

/** Remove all Live Activities owned by one physical installation. */
export async function clearLiveActivitiesForDevice(deviceId: string): Promise<void> {
  if (!deviceId) return;
  await laReady;
  await mutateLiveActivities(async () => {
    const next = await storeUpdate<LARegistration[], LARegistration[]>(LA_STORE_KEY, [], (stored) => {
      const current = normalizeLA(stored, isDurable() || process.env.NODE_ENV === "production").filter((registration) => registration.deviceId !== deviceId);
      return { value: current, result: current };
    });
    laRegs = new Map(next.map((registration) => [laKey(registration.deviceId || "legacy", registration.id), registration]));
    await persistLocalLA();
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
    const normalizedToken = String(token || "").trim();
    if (!validProviderToken(normalizedToken)) {
      resolve({ token: normalizedToken, ok: false, status: 400, reason: "InvalidDeviceToken" });
      return;
    }
    if (!isPushConfigured()) {
      resolve({ token: normalizedToken, ok: false, status: 0, reason: "apns-not-configured" });
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
    if (event === "update") aps["stale-date"] = now + 5 * 60;
    if (event === "end") aps["dismissal-date"] = Math.floor(Date.now() / 1000);
    let payload = JSON.stringify({ aps });
    if (Buffer.byteLength(payload, "utf8") > MAX_PUSH_PAYLOAD_BYTES) {
      const compactState = contentState
        ? Object.fromEntries(Object.entries(contentState).filter(([, value]) => typeof value !== "string" || String(value).length <= 300).slice(0, 16))
        : null;
      payload = JSON.stringify({ aps: { ...aps, ...(compactState ? { "content-state": compactState } : {}) } });
    }

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${normalizedToken}`,
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
    req.on("data", (chunk) => {
      if (bodyText.length < 8_000) bodyText += String(chunk).slice(0, 8_000 - bodyText.length);
    });
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
