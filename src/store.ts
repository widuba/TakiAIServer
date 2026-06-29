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
 *  - DURABLE (DATABASE_URL set, e.g. a free Render Postgres): persists across
 *    redeploys. Required for standing subscriptions (favorite-team auto-track).
 *
 * The interface is a tiny async get/set of a JSON blob per key, so callers keep
 * an in-memory copy and persist the whole thing on change (same shape push.ts
 * already uses for its token set).
 * ==========================================================================*/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || "";

// --- Postgres backend (lazy, only when DATABASE_URL is set). Typed loosely so we
// don't need @types/pg, and so the dependency is only touched when configured. ---
let pgPool: any = null;
let pgReady: Promise<void> | null = null;

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
  return path.join(__dirname, "..", `store-${safe}.json`);
}

export async function storeGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const pool = await ensurePg();
    if (pool) {
      const res = await pool.query("SELECT v FROM kv WHERE k = $1", [key]);
      if (res.rows.length && res.rows[0].v != null) return res.rows[0].v as T;
      return fallback;
    }
  } catch (e) {
    console.error("storeGet pg error:", e);
    // fall through to the file backend on any DB hiccup
  }
  try {
    const raw = fs.readFileSync(filePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function storeSet(key: string, value: unknown): Promise<void> {
  let wrotePg = false;
  try {
    const pool = await ensurePg();
    if (pool) {
      await pool.query(
        "INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = $2, updated_at = now()",
        [key, JSON.stringify(value)]
      );
      wrotePg = true;
    }
  } catch (e) {
    console.error("storeSet pg error:", e);
  }
  // Always keep a local file copy too (cheap; also a fallback if the DB blips).
  try {
    fs.writeFileSync(filePath(key), JSON.stringify(value));
  } catch {
    if (!wrotePg) console.error("storeSet: failed to persist", key);
  }
}

// Whether durable (cross-redeploy) persistence is active.
export function isDurable(): boolean {
  return !!DATABASE_URL;
}
