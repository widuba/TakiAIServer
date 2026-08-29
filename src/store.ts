import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

/* ============================================================================
 * Durable blob store. Used by the proactive-alert engine (and anything else that
 * must survive a redeploy).
 *
 *  - DEFAULT (no DATABASE_URL): a JSON file per key under the server dir. Works
 *    within a single Render deploy's lifetime but RESETS on every redeploy —
 *    acceptable for short-lived alerts (a price/score alert usually resolves in
 *    hours), NOT for long-lived subscriptions.
 *  - DURABLE (DATABASE_URL set, e.g. Render Postgres): persists across
 *    redeploys. Database errors fail closed so stale local data can never grant
 *    credits or acknowledge a payment that was not durably recorded.
 *
 * The interface is a tiny async get/set of a JSON blob per key, so callers keep
 * an in-memory copy and persist the whole thing on change (same shape push.ts
 * already uses for its token set).
 * ==========================================================================*/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(__dirname, "..");
const DATABASE_URL = process.env.DATABASE_URL || "";
const REQUIRE_DURABLE_STORAGE = process.env.NODE_ENV === "production" || process.env.RENDER === "true" || process.env.REQUIRE_DURABLE_STORAGE === "1";

function assertStorageConfigured(): void {
  if (REQUIRE_DURABLE_STORAGE && !DATABASE_URL) throw new Error("DATABASE_URL is required for durable production storage");
}

// --- Postgres backend (lazy, only when DATABASE_URL is set). Typed loosely so we
// don't need @types/pg, and so the dependency is only touched when configured. ---
let pgPool: any = null;
let pgReady: Promise<void> | null = null;
let pgInit: Promise<any> | null = null;
let writesBlockedForReset = false;
type PgTransactionContext = { client: any };
// A number of account updates also maintain a small index (for example
// `noteUser` updates the user row, IP index, and users index). Re-opening a
// second pool connection from inside the first transaction can exhaust the
// small Render pool under concurrent traffic and deadlock. Reuse the current
// transaction client for nested store operations instead.
const pgTransaction = new AsyncLocalStorage<PgTransactionContext>();

function currentPgClient(): any | null {
  return pgTransaction.getStore()?.client || null;
}

async function ensurePg(): Promise<any> {
  if (!DATABASE_URL) return null;
  if (pgPool) {
    await pgReady;
    return pgPool;
  }
  if (!pgInit) {
    const init = (async () => {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: DATABASE_URL,
        // Render Postgres requires SSL; allow self-signed.
        ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
        max: 3,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 15_000,
        query_timeout: 15_000
      });
      const ready = pool
        .query("CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz DEFAULT now())")
        .then(() => undefined);
      pgPool = pool;
      pgReady = ready;
      await ready;
      return pool;
    })();
    pgInit = init;
  }
  const init = pgInit;
  try {
    return await init;
  } catch (error) {
    // Do not cache a rejected initialization promise forever.  A transient
    // database restart should recover on the next request instead of making
    // every subsequent operation fail until the process is redeployed.
    pgReady = null;
    try { await pgPool?.end(); } catch { /* best effort */ }
    pgPool = null;
    throw error;
  } finally {
    if (pgInit === init) pgInit = null;
  }
}

function filePath(key: string): string {
  const safe = key.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(STORE_DIR, `store-${safe}.json`);
}

/** Write a local KV record atomically so a process crash cannot leave a
 * truncated JSON document that would be interpreted as a missing account. */
function writeLocalValue(key: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`Cannot persist undefined store value for ${key}`);
  const target = filePath(key);
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}

function localStoreFiles(): string[] {
  return fs.readdirSync(STORE_DIR)
    .filter((name) => name.startsWith("store-") && name.endsWith(".json"))
    .map((name) => path.join(STORE_DIR, name));
}

export type StoreEntry = { key: string; value: unknown; updatedAt?: string };

export function storeCategory(key: string): string {
  if (/^(?:user:|users:index$|userip:|devicecredential:|webauth:|signup:ip:|user_|users_index$|userip_|devicecredential_|webauth_)/.test(key)) return "accounts";
  if (/^(?:credits:|devnum:used:|credits_|devnum_used_)/.test(key)) return "credits";
  if (/^(?:stripe:|stripe_|iap(?:map|identity|primary|credit|creditidentity|period):|iap(?:map|identity|primary|credit|creditidentity|period)_)/.test(key)) return "billing";
  if (/^(?:safety:|safety_)/.test(key)) return "safety";
  if (/^(?:email:|email_)/.test(key)) return "connected_email";
  if (/^(?:knowledge:|knowledge_)/.test(key)) return "connected_knowledge";
  if (/^(?:routines:|routines_)/.test(key)) return "routines";
  if (key.startsWith("engagement") || key.startsWith("marketing")) return "engagement";
  if (/^(?:push:|nudges:|live-activity-|push_|nudges_|live-activity_)/.test(key)) return "notifications";
  if (key === "feedback") return "feedback";
  if (/^(?:alerts$|ship24:|ship24_)/.test(key)) return "trackers";
  if (/^(?:system:|system_)/.test(key)) return "system";
  return "other";
}

// Enumeration is intentionally fail-closed. A destructive operation must never
// mistake a temporary Postgres outage for an empty database and clear only the
// fallback files while leaving production records behind.
export async function storeEntries(): Promise<StoreEntry[]> {
  assertStorageConfigured();
  if (DATABASE_URL) {
    const client = currentPgClient();
    const pool = client ? null : await ensurePg();
    const result = await (client || pool).query("SELECT k, v, updated_at FROM kv ORDER BY k");
    return result.rows.map((row: any) => ({
      key: String(row.k),
      value: row.v,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined
    }));
  }

  return localStoreFiles().map((file) => {
    const name = path.basename(file);
    return {
      key: name.slice("store-".length, -".json".length),
      value: JSON.parse(fs.readFileSync(file, "utf8"))
    };
  });
}

export async function storeResetAll(preserve: Record<string, unknown>): Promise<number> {
  assertStorageConfigured();
  if (writesBlockedForReset) throw new Error("Store reset is already in progress");
  writesBlockedForReset = true;
  try {
    // Requests that began before the reset gate was raised may still be inside
    // a local read/modify/write chain. Let those chains settle before taking
    // the file snapshot or deleting records; otherwise an older write can land
    // after the wipe and resurrect an account or notification.
    if (!DATABASE_URL && localUpdateChains.size) {
      await Promise.allSettled([...localUpdateChains.values()]);
    }
    const files = localStoreFiles();
    let deleted = files.length;
    if (DATABASE_URL) {
      const pool = await ensurePg();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query("DELETE FROM kv");
        deleted = Number(result.rowCount || 0);
        for (const [key, value] of Object.entries(preserve)) {
          await client.query(
            "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now())",
            [key, JSON.stringify(value)]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // The database transaction above is authoritative in production. Remove
    // local diagnostic blobs only after it commits; deleting them first could
    // turn a transient Postgres outage into irreversible local data loss.
    // In the file-backed fallback, write the preserved records first and then
    // remove everything else so a failed preserve write leaves the old store
    // intact rather than an empty one.
    const preservedPaths = new Set(Object.keys(preserve).map(filePath));
    for (const [key, value] of Object.entries(preserve)) {
      try { writeLocalValue(key, value); }
      catch (error) {
        if (DATABASE_URL) console.error("Could not refresh local diagnostic reset marker:", error);
        else throw error;
      }
    }
    for (const file of files) {
      if (preservedPaths.has(file)) continue;
      try { fs.unlinkSync(file); }
      catch (error: any) {
        if (error?.code !== "ENOENT") {
          if (DATABASE_URL) console.error("Could not remove local diagnostic store file:", file, error);
          else throw error;
        }
      }
    }
    // Keep writes blocked until the process restarts. Otherwise a timer or a
    // request that was already running could repopulate deleted state.
    return deleted;
  } catch (error) {
    writesBlockedForReset = false;
    throw error;
  }
}

export async function storeGet<T>(key: string, fallback: T): Promise<T> {
  assertStorageConfigured();
  if (DATABASE_URL) {
    try {
      const client = currentPgClient();
      const pool = client ? null : await ensurePg();
      const res = await (client || pool).query("SELECT v FROM kv WHERE k = $1", [key]);
      if (res.rows.length && res.rows[0].v != null) return res.rows[0].v as T;
      return fallback;
    } catch (e) {
      console.error("storeGet pg error:", e);
      throw e;
    }
  }
  try {
    const raw = fs.readFileSync(filePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    // A corrupt local record is not equivalent to an empty record. Returning
    // the fallback here could reset a balance or replay a payment grant.
    console.error("storeGet local error:", key, error);
    throw error;
  }
}

// Fetch many independent blobs in one database round trip. Admin and cleanup
// paths can involve thousands of accounts; issuing one SELECT per identity was
// both slow and capable of exceeding the hosting request timeout.
export async function storeGetMany<T>(keys: string[]): Promise<Map<string, T>> {
  assertStorageConfigured();
  const unique = [...new Set(keys.filter(Boolean))];
  const values = new Map<string, T>();
  if (!unique.length) return values;
  if (DATABASE_URL) {
    const client = currentPgClient();
    const pool = client ? null : await ensurePg();
    const result = await (client || pool).query("SELECT k, v FROM kv WHERE k = ANY($1::text[])", [unique]);
    for (const row of result.rows) if (row?.v != null) values.set(String(row.k), row.v as T);
    return values;
  }
  for (const key of unique) {
    try {
      const raw = fs.readFileSync(filePath(key), "utf8");
      values.set(key, JSON.parse(raw) as T);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.error("storeGetMany local error:", key, error);
        throw error;
      }
    }
  }
  return values;
}

export async function storeSet(key: string, value: unknown): Promise<void> {
  assertStorageConfigured();
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  let wrotePg = false;
  if (DATABASE_URL) {
    try {
      const client = currentPgClient();
      const pool = client ? null : await ensurePg();
      await (client || pool).query(
        "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = $2, updated_at = now()",
        [key, JSON.stringify(value)]
      );
      wrotePg = true;
    } catch (e) {
      console.error("storeSet pg error:", e);
      throw e;
    }
  }
  // Keep a local diagnostic copy after a successful durable write. It is not
  // read while Postgres is configured, because it may lag the authoritative DB.
  try {
    writeLocalValue(key, value);
  } catch (error) {
    if (!wrotePg) {
      console.error("storeSet: failed to persist", key, error);
      throw error;
    }
  }
}

// Atomically read, mutate, and persist one record. In production the KV row is
// locked inside a Postgres transaction, so concurrent server instances cannot
// both spend or grant the same balance. The file-backed development store uses
// a per-key promise chain with the same semantics.
const localUpdateChains = new Map<string, Promise<unknown>>();

async function updateOnPgClient<T, R>(
  key: string,
  fallback: T,
  update: (value: T) => Promise<{ value: T; result: R }> | { value: T; result: R },
  client: any
): Promise<{ value: T; result: R }> {
  await client.query(
    "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now()) ON CONFLICT (k) DO NOTHING",
    [key, JSON.stringify(fallback)]
  );
  const selected = await client.query("SELECT v FROM kv WHERE k = $1 FOR UPDATE", [key]);
  const current = (selected.rows[0]?.v ?? fallback) as T;
  const next = await update(current);
  await client.query("UPDATE kv SET v = $2, updated_at = now() WHERE k = $1", [key, JSON.stringify(next.value)]);
  return next;
}

async function updatePairOnPgClient<A, B, R>(
  first: { key: string; fallback: A },
  second: { key: string; fallback: B },
  update: (values: { first: A; second: B }) => Promise<{ first: A; second: B; result: R }> | { first: A; second: B; result: R },
  client: any
): Promise<{ first: A; second: B; result: R }> {
  const entries = [first, second].sort((a, b) => a.key.localeCompare(b.key));
  const values = new Map<string, unknown>();
  for (const entry of entries) {
    await client.query(
      "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now()) ON CONFLICT (k) DO NOTHING",
      [entry.key, JSON.stringify(entry.fallback)]
    );
    const selected = await client.query("SELECT v FROM kv WHERE k = $1 FOR UPDATE", [entry.key]);
    values.set(entry.key, selected.rows[0]?.v ?? entry.fallback);
  }
  const next = await update({
    first: values.get(first.key) as A,
    second: values.get(second.key) as B
  });
  for (const entry of [first, second]) {
    await client.query("UPDATE kv SET v = $2, updated_at = now() WHERE k = $1", [entry.key, JSON.stringify(entry.key === first.key ? next.first : next.second)]);
  }
  return next;
}

/**
 * Atomically update two independent blobs.  A few account operations (most
 * notably merging an anonymous device into a Sign in with Apple ledger) move
 * state between two keys.  Updating those keys one at a time lets a second
 * Render instance observe the half-moved state and either lose a turn or
 * duplicate a grant.  Postgres locks both rows in stable key order; the local
 * fallback uses the same per-key promise chains so single-process tests and
 * development behave identically.
 */
export async function storeUpdatePair<A, B, R>(
  first: { key: string; fallback: A },
  second: { key: string; fallback: B },
  update: (values: { first: A; second: B }) => Promise<{ first: A; second: B; result: R }> | { first: A; second: B; result: R }
): Promise<R> {
  assertStorageConfigured();
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  if (first.key === second.key) throw new Error("storeUpdatePair requires two different keys");

  if (DATABASE_URL) {
    const activeClient = currentPgClient();
    if (activeClient) {
      const next = await updatePairOnPgClient(first, second, update, activeClient);
      try {
        writeLocalValue(first.key, next.first);
        writeLocalValue(second.key, next.second);
      } catch { /* diagnostic copies only */ }
      return next.result;
    }
    const pool = await ensurePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const next = await pgTransaction.run({ client }, () => updatePairOnPgClient(first, second, update, client));
      await client.query("COMMIT");
      try {
        writeLocalValue(first.key, next.first);
        writeLocalValue(second.key, next.second);
      } catch { /* diagnostic copies only */ }
      return next.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const keys = [first.key, second.key].sort();
  const prior = keys.map((key) => localUpdateChains.get(key) ?? Promise.resolve());
  const run = Promise.all(prior).then(async () => {
    const currentFirst = await storeGet(first.key, first.fallback);
    const currentSecond = await storeGet(second.key, second.fallback);
    const next = await update({ first: currentFirst as A, second: currentSecond as B });
    await storeSet(first.key, next.first);
    await storeSet(second.key, next.second);
    return next.result;
  }, async () => {
    const currentFirst = await storeGet(first.key, first.fallback);
    const currentSecond = await storeGet(second.key, second.fallback);
    const next = await update({ first: currentFirst as A, second: currentSecond as B });
    await storeSet(first.key, next.first);
    await storeSet(second.key, next.second);
    return next.result;
  });
  const marker = run.then(() => undefined, () => undefined);
  for (const key of keys) localUpdateChains.set(key, marker);
  return run;
}

export async function storeUpdate<T, R>(
  key: string,
  fallback: T,
  update: (value: T) => Promise<{ value: T; result: R }> | { value: T; result: R }
): Promise<R> {
  assertStorageConfigured();
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  if (DATABASE_URL) {
    const activeClient = currentPgClient();
    if (activeClient) {
      const next = await updateOnPgClient(key, fallback, update, activeClient);
      try { writeLocalValue(key, next.value); } catch { /* diagnostic copy only */ }
      return next.result;
    }
    const pool = await ensurePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const next = await pgTransaction.run({ client }, () => updateOnPgClient(key, fallback, update, client));
      await client.query("COMMIT");
      try { writeLocalValue(key, next.value); } catch { /* diagnostic copy only */ }
      return next.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const prior = localUpdateChains.get(key) ?? Promise.resolve();
  const run = prior.then(async () => {
    const current = await storeGet(key, fallback);
    const next = await update(current);
    await storeSet(key, next.value);
    return next.result;
  }, async () => {
    const current = await storeGet(key, fallback);
    const next = await update(current);
    await storeSet(key, next.value);
    return next.result;
  });
  localUpdateChains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export async function storeDelete(key: string): Promise<void> {
  assertStorageConfigured();
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  const remove = async (): Promise<void> => {
    let deletionError: unknown = null;
    try {
      const client = currentPgClient();
      const pool = client ? null : await ensurePg();
      if (client || pool) await (client || pool).query("DELETE FROM kv WHERE k = $1", [key]);
    } catch (e) {
      console.error("storeDelete pg error:", e);
      deletionError = e;
    }
    try {
      fs.unlinkSync(filePath(key));
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        console.error("storeDelete file error:", e);
        deletionError ||= e;
      }
    }
    if (deletionError) throw deletionError;
  };

  // A local delete must wait behind an in-flight read/modify/write for the
  // same key. Otherwise account deletion or tracker cleanup can be followed
  // by the older update writing the deleted value back to disk.
  if (!DATABASE_URL) {
    const prior = localUpdateChains.get(key) ?? Promise.resolve();
    const run = prior.then(remove, remove);
    localUpdateChains.set(key, run.then(() => undefined, () => undefined));
    return run;
  }
  await remove();
}

// Used when a feature that stored sensitive authorization data is retired.
// Enumerate the authoritative store and remove every record in that category,
// including OAuth state records that were never exchanged.
export async function storeDeleteCategory(category: string): Promise<number> {
  const keys = (await storeEntries())
    .map((entry) => entry.key)
    .filter((key) => storeCategory(key) === category);
  for (const key of keys) await storeDelete(key);
  return keys.length;
}

// Whether durable (cross-redeploy) persistence is active.
export function isDurable(): boolean {
  return !!DATABASE_URL;
}
