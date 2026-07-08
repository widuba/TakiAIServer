import { storeGet, storeSet } from "./store.js";
import { sendPush, isPushConfigured, forgetToken } from "./push.js";

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
function keyify(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function tokenKey(deviceId: string): string { return `push:token:${keyify(deviceId)}`; }
function manifestKey(deviceId: string): string { return `nudges:manifest:${keyify(deviceId)}`; }
function sentKey(deviceId: string): string { return `nudges:sent:${keyify(deviceId)}`; }

// Map an APNs token to a device id (set when the device registers for push).
export async function setPushToken(deviceId: string, token: string): Promise<void> {
  if (!deviceId || !token) return;
  await storeSet(tokenKey(deviceId), token);
}
export async function getPushToken(deviceId: string): Promise<string> {
  return await storeGet<string>(tokenKey(deviceId), "");
}

export async function syncNudges(deviceId: string, raw: unknown[]): Promise<number> {
  const now = Date.now();
  const nudges: Nudge[] = (Array.isArray(raw) ? raw : [])
    .map((n: any) => ({
      id: String(n?.id || "").slice(0, 60),
      fireAt: Number(n?.fireAt) || 0,
      title: String(n?.title || "").slice(0, 120),
      body: String(n?.body || "").slice(0, 300)
    }))
    .filter((n) => n.id && n.title && n.fireAt > now - 3600_000 && n.fireAt < now + 30 * 86400_000)
    .slice(0, 50);
  await storeSet(manifestKey(deviceId), { nudges, at: now });
  const idx = await storeGet<{ ids: string[] }>(INDEX, { ids: [] });
  if (!idx.ids.includes(deviceId)) { idx.ids.push(deviceId); await storeSet(INDEX, idx); }
  return nudges.length;
}

// Fire any due nudges across all devices. Called on an interval from index.ts.
export async function tickNudges(): Promise<void> {
  if (!isPushConfigured()) return;
  const idx = await storeGet<{ ids: string[] }>(INDEX, { ids: [] });
  const now = Date.now();
  for (const deviceId of idx.ids) {
    try {
      const man = await storeGet<{ nudges: Nudge[] } | null>(manifestKey(deviceId), null);
      if (!man || !man.nudges?.length) continue;
      const token = await getPushToken(deviceId);
      if (!token) continue;
      const sent = await storeGet<{ keys: string[] }>(sentKey(deviceId), { keys: [] });
      let changed = false;
      for (const n of man.nudges) {
        // Fire once, and only within an hour of the target time (skip very stale).
        if (n.fireAt > now || n.fireAt < now - 3600_000) continue;
        const key = `${n.id}@${n.fireAt}`;
        if (sent.keys.includes(key)) continue;
        const r = await sendPush(token, { title: n.title, body: n.body, data: { nudge: n.id } });
        sent.keys.push(key);
        changed = true;
        if (!r.ok && /410|BadDeviceToken|Unregistered/i.test(r.reason || "")) {
          await storeSet(tokenKey(deviceId), "");
          forgetToken(token);
        }
      }
      if (changed) {
        sent.keys = sent.keys.slice(-300);
        await storeSet(sentKey(deviceId), sent);
      }
    } catch (e) {
      console.error("tickNudges:", deviceId, e);
    }
  }
}
