import fs from "node:fs";
import path from "node:path";
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

// --- Postgres backend (lazy, only when DATABASE_URL is set). Typed loosely so we
// don't need @types/pg, and so the dependency is only touched when configured. ---
let pgPool: any = null;
let pgReady: Promise<void> | null = null;
let writesBlockedForReset = false;

async function ensurePg(): Promise<any> {
  if (!DATABASE_URL) return null;
  if (!pgPool) {
    const { Pool } = await import("pg");
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      // Render Postgres requires SSL; allow self-signed.
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 3
    });
    pgReady = pgPool
      .query("CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz DEFAULT now())")
      .then(() => undefined);
  }
  await pgReady;
  return pgPool;
}

function filePath(key: string): string {
  const safe = key.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(STORE_DIR, `store-${safe}.json`);
}

function localStoreFiles(): string[] {
  return fs.readdirSync(STORE_DIR)
    .filter((name) => name.startsWith("store-") && name.endsWith(".json"))
    .map((name) => path.join(STORE_DIR, name));
}

export type StoreEntry = { key: string; value: unknown; updatedAt?: string };

export function storeCategory(key: string): string {
  if (/^(?:user:|users:index$|userip:|user_|users_index$|userip_)/.test(key)) return "accounts";
  if (/^(?:credits:|devnum:used:|credits_|devnum_used_)/.test(key)) return "credits";
  if (/^(?:stripe:|stripe_|iap(?:map|identity|primary|credit|creditidentity):|iap(?:map|identity|primary|credit|creditidentity)_)/.test(key)) return "billing";
  if (/^(?:safety:|safety_)/.test(key)) return "safety";
  if (/^(?:email:|email_)/.test(key)) return "connected_email";
  if (/^(?:routines:|routines_)/.test(key)) return "routines";
  if (key.startsWith("engagement")) return "engagement";
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
  if (DATABASE_URL) {
    const pool = await ensurePg();
    const result = await pool.query("SELECT k, v, updated_at FROM kv ORDER BY k");
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
  if (writesBlockedForReset) throw new Error("Store reset is already in progress");
  writesBlockedForReset = true;
  try {
    const files = localStoreFiles();
    for (const file of files) fs.unlinkSync(file);

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

    for (const [key, value] of Object.entries(preserve)) {
      fs.writeFileSync(filePath(key), JSON.stringify(value));
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
  if (DATABASE_URL) {
    try {
      const pool = await ensurePg();
      const res = await pool.query("SELECT v FROM kv WHERE k = $1", [key]);
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
  } catch {
    return fallback;
  }
}

export async function storeSet(key: string, value: unknown): Promise<void> {
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  let wrotePg = false;
  if (DATABASE_URL) {
    try {
      const pool = await ensurePg();
      await pool.query(
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
    fs.writeFileSync(filePath(key), JSON.stringify(value));
  } catch (error) {
    if (!wrotePg) {
      console.error("storeSet: failed to persist", key, error);
      throw error;
    }
  }
}

export async function storeDelete(key: string): Promise<void> {
  if (writesBlockedForReset) throw new Error("Store writes are blocked during a full reset");
  let deletionError: unknown = null;
  try {
    const pool = await ensurePg();
    if (pool) await pool.query("DELETE FROM kv WHERE k = $1", [key]);
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
}

// Whether durable (cross-redeploy) persistence is active.
export function isDurable(): boolean {
  return !!DATABASE_URL;
}
