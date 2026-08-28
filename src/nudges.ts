import { storeGet, storeUpdate } from "./store.js";
import { sendPush, isPushConfigured, forgetToken, forgetTokenEverywhere } from "./push.js";

/* ============================================================================
 * Server-push nudge engine. The device knows the on-device state (habits,
 * calendar, packages), so it computes a compact "manifest" of upcoming nudges
 * ({id, fireAt, title, body}) and syncs it here on every foreground. A cron loop
 * fires each nudge via APNs when it comes due — so nudges arrive even when the
 * app is CLOSED. Dedup is by `${id}@${fireAt}` so a re-synced manifest never
 * double-fires. Requires APNs configured (the .p8 on Render) + a real device
 * push token (registered with its deviceId via /api/register-push).
 * ==========================================================================*/

export interface Nudge {
  id: string;
  fireAt: number; // epoch ms
  title: string;
  body: string;
}

const INDEX = "nudges:index"; // list of deviceIds with a manifest (store has no key scan)
const PUSH_TOKEN_INDEX = "push:tokens:index";
const POLL_LEASE_KEY = "nudges:poll-lease";
const POLL_LEASE_MS = 80_000;
let indexChain: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn);
  indexChain = run.then(() => undefined, () => undefined);
  return run;
}
function keyify(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function tokenKey(deviceId: string): string { return `push:token:${keyify(deviceId)}`; }
function manifestKey(deviceId: string): string { return `nudges:manifest:${keyify(deviceId)}`; }
function sentKey(deviceId: string): string { return `nudges:sent:${keyify(deviceId)}`; }

// Map an APNs token to a device id (set when the device registers for push).
export async function setPushToken(deviceId: string, token: string): Promise<void> {
  if (!/^\d{8}$/.test(deviceId) || !/^[a-f0-9]{32,256}$/i.test(token.trim())) return;
  const normalized = token.trim();
  const previous = await storeUpdate<string, string>(tokenKey(deviceId), "", (stored) => ({
    value: normalized,
    result: typeof stored === "string" ? stored.trim() : ""
  }));
  if (previous && previous !== normalized) await forgetTokenEverywhere(previous);
  await storeUpdate<{ ids: string[] }, void>(PUSH_TOKEN_INDEX, { ids: [] }, (stored) => {
    const ids = Array.isArray(stored.ids)
      ? stored.ids.filter((id): id is string => typeof id === "string" && /^\d{8}$/.test(id))
      : [];
    if (!ids.includes(deviceId)) ids.push(deviceId);
    return { value: { ids: ids.slice(-100_000) }, result: undefined };
  });
}
export async function getPushToken(deviceId: string): Promise<string> {
  return await storeGet<string>(tokenKey(deviceId), "");
}
export async function clearPushToken(deviceId: string): Promise<void> {
  if (!/^\d{8}$/.test(deviceId)) return;
  const previous = await storeUpdate<string, string>(tokenKey(deviceId), "", (stored) => ({
    value: "",
    result: typeof stored === "string" ? stored.trim() : ""
  }));
  if (previous) await forgetTokenEverywhere(previous);
  await storeUpdate<{ ids: string[] }, void>(PUSH_TOKEN_INDEX, { ids: [] }, (stored) => ({
    value: {
      ids: (Array.isArray(stored.ids) ? stored.ids : [])
        .filter((id): id is string => typeof id === "string" && id !== deviceId)
    },
    result: undefined
  }));
}

export async function syncNudges(deviceId: string, raw: unknown[]): Promise<number> {
  if (!/^\d{8}$/.test(deviceId)) return 0;
  const now = Date.now();
  const seen = new Set<string>();
  const nudges: Nudge[] = (Array.isArray(raw) ? raw : [])
    .map((n: any) => ({
      id: String(n?.id || "").slice(0, 60),
      fireAt: Number(n?.fireAt) || 0,
      title: String(n?.title || "").slice(0, 120),
      body: String(n?.body || "").slice(0, 300)
    }))
    .filter((n) => n.id && !seen.has(n.id) && n.title && Number.isFinite(n.fireAt) && n.fireAt > now - 3600_000 && n.fireAt < now + 30 * 86400_000)
    .filter((n) => { seen.add(n.id); return true; })
    .slice(0, 50);
  await storeUpdate<{ nudges: Nudge[]; at: number }, void>(manifestKey(deviceId), { nudges: [], at: 0 }, () => ({
    value: { nudges, at: now }, result: undefined
  }));
  await withIndexLock(async () => {
    await storeUpdate<{ ids: string[] }, void>(INDEX, { ids: [] }, (stored) => {
      const ids = Array.isArray(stored.ids)
        ? stored.ids.filter((id): id is string => typeof id === "string" && /^\d{8}$/.test(id))
        : [];
      if (!ids.includes(deviceId)) ids.push(deviceId);
      return { value: { ids: ids.slice(-100_000) }, result: undefined };
    });
  });
  return nudges.length;
}

// Fire any due nudges across all devices. Called on an interval from index.ts.
let ticking = false;
export async function tickNudges(): Promise<void> {
  if (!isPushConfigured() || ticking) return;
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let acquired = false;
  try {
    acquired = await storeUpdate<{ owner: string; expiresAt: number } | null, boolean>(POLL_LEASE_KEY, null, (lease) => {
      if (lease?.expiresAt && lease.expiresAt > Date.now() && lease.owner !== owner) return { value: lease, result: false };
      return { value: { owner, expiresAt: Date.now() + POLL_LEASE_MS }, result: true };
    });
  } catch (error) {
    console.error("Nudge poll lease acquire:", error);
    return;
  }
  if (!acquired) return;
  ticking = true;
  try {
    const idx = await storeGet<{ ids: string[] }>(INDEX, { ids: [] });
    const now = Date.now();
    for (const deviceId of (Array.isArray(idx.ids) ? idx.ids : []).filter((id) => /^\d{8}$/.test(id)).slice(-10_000)) {
      try {
        const man = await storeGet<{ nudges: Nudge[] } | null>(manifestKey(deviceId), null);
        if (!man || !Array.isArray(man.nudges) || !man.nudges.length) continue;
        const token = await getPushToken(deviceId);
        if (!token) continue;
        const sent = await storeGet<{ keys: string[] }>(sentKey(deviceId), { keys: [] });
        if (!Array.isArray(sent.keys)) sent.keys = [];
        sent.keys = sent.keys.filter((key) => typeof key === "string").slice(-300);
        for (const n of man.nudges) {
          // Fire once, and only within an hour of the target time (skip very stale).
          if (n.fireAt > now || n.fireAt < now - 3600_000) continue;
          const key = `${n.id}@${n.fireAt}`;
          if (sent.keys.includes(key)) continue;
          const r = await sendPush(token, { title: n.title, body: n.body, data: { nudge: n.id } });
          if (r.ok) {
            // Persist each successful delivery atomically. A crash between two
            // nudges must not replay an already delivered notification.
            await storeUpdate<{ keys: string[] }, void>(sentKey(deviceId), { keys: [] }, (stored) => {
              const keys = Array.isArray(stored.keys) ? stored.keys : [];
              if (!keys.includes(key)) keys.push(key);
              return { value: { keys: keys.slice(-300) }, result: undefined };
            });
            sent.keys.push(key);
          } else if (r.status === 410 || /BadDeviceToken|Unregistered/i.test(r.reason || "")) {
            await clearPushToken(deviceId);
            forgetToken(token);
          }
        }
      } catch (e) {
        console.error("tickNudges:", deviceId, e);
      }
    }
  } finally {
    ticking = false;
    await storeUpdate<{ owner: string; expiresAt: number } | null, void>(POLL_LEASE_KEY, null, (lease) =>
      lease?.owner === owner ? { value: null, result: undefined } : { value: lease, result: undefined }
    ).catch((error) => console.error("Nudge poll lease release:", error));
  }
}
