import { storeGet, storeSet } from "./store.js";

/* ============================================================================
 * User registry / analytics. The credits + safety stores are keyed per identity
 * but can't be enumerated, so this keeps a master index and a per-user record
 * with everything the admin dashboard needs: plan + plan history, IPs, device
 * type, credit usage, revenue, purchases, and Apple identity.
 *
 * Populated passively from existing request data (device type is parsed from the
 * request User-Agent — no app change needed) plus explicit notes on purchases and
 * Apple sign-in. Blob-per-user; fine at early scale (one read per user to list).
 * ==========================================================================*/

export interface Purchase { at: number; kind: string; amountUsd: number; credits?: number; tier?: string }
export interface UserRecord {
  identity: string;
  firstSeenAt: number;
  lastSeenAt: number;
  requestCount: number;
  creditsUsed: number;               // cumulative credits spent
  tier: string;
  tierHistory: { tier: string; at: number; source: string }[];
  deviceType?: string;               // parsed from User-Agent
  ips: string[];
  apple?: { sub?: string; email?: string; name?: string };
  revenueUsd: number;                // cumulative gross paid
  purchases: Purchase[];
  device?: { name?: string; model?: string; identifier?: string; takiName?: string; lastSeenAt: number };
}

const USERS_INDEX = "users:index";
const keyify = (s: string) => s.replace(/[^a-zA-Z0-9_:.-]/g, "_");
const uKey = (id: string) => `user:${keyify(id)}`;
const ipKey = (ip: string) => `userip:${keyify(ip)}`;

async function loadUser(identity: string): Promise<UserRecord> {
  const u = await storeGet<UserRecord>(uKey(identity), {
    identity, firstSeenAt: 0, lastSeenAt: 0, requestCount: 0, creditsUsed: 0,
    tier: "free", tierHistory: [], ips: [], revenueUsd: 0, purchases: []
  });
  u.identity = identity;
  if (!Array.isArray(u.ips)) u.ips = [];
  if (!Array.isArray(u.tierHistory)) u.tierHistory = [];
  if (!Array.isArray(u.purchases)) u.purchases = [];
  return u;
}
async function saveUser(u: UserRecord): Promise<void> { await storeSet(uKey(u.identity), u); }
async function addToIndex(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(USERS_INDEX, { ids: [] });
  if (!idx.ids.includes(identity)) { idx.ids.push(identity); await storeSet(USERS_INDEX, idx); }
}

function parseDeviceType(ua: string): string {
  if (!ua) return "";
  const os = ua.match(/OS (\d+)[_.](\d+)/); // "iPhone OS 18_0"
  const osv = os ? ` · iOS ${os[1]}.${os[2]}` : "";
  if (/iPad/.test(ua)) return `iPad${osv}`;
  if (/iPhone/.test(ua)) return `iPhone${osv}`;
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  return ua.slice(0, 40);
}

// Called on every request: last-seen, request count, IP + IP index, device type.
export async function noteUser(identity: string, ip: string, ua: string): Promise<void> {
  if (!identity) return;
  try {
    const u = await loadUser(identity);
    const now = Date.now();
    if (!u.firstSeenAt) u.firstSeenAt = now;
    u.lastSeenAt = now;
    u.requestCount += 1;
    if (ip && ip !== "unknown" && !u.ips.includes(ip)) {
      u.ips.push(ip); if (u.ips.length > 25) u.ips = u.ips.slice(-25);
      const ik = await storeGet<{ ids: string[] }>(ipKey(ip), { ids: [] });
      if (!ik.ids.includes(identity)) { ik.ids.push(identity); await storeSet(ipKey(ip), ik); }
    }
    const dt = parseDeviceType(ua); if (dt) u.deviceType = dt;
    await saveUser(u);
    await addToIndex(identity);
  } catch (e) { console.error("noteUser:", e); }
}

export async function noteSpend(identity: string, credits: number): Promise<void> {
  if (!identity || !(credits > 0)) return;
  try { const u = await loadUser(identity); u.creditsUsed += credits; await saveUser(u); } catch (e) { console.error("noteSpend:", e); }
}

export async function noteTier(identity: string, tier: string, source: string): Promise<void> {
  if (!identity) return;
  try {
    const u = await loadUser(identity);
    if (u.tier !== tier || u.tierHistory.length === 0) {
      u.tierHistory.push({ tier, at: Date.now(), source });
      if (u.tierHistory.length > 50) u.tierHistory = u.tierHistory.slice(-50);
    }
    u.tier = tier;
    await saveUser(u); await addToIndex(identity);
  } catch (e) { console.error("noteTier:", e); }
}

export async function noteRevenue(identity: string, p: Purchase): Promise<void> {
  if (!identity) return;
  try {
    const u = await loadUser(identity);
    u.revenueUsd = Math.round((u.revenueUsd + p.amountUsd) * 100) / 100;
    u.purchases.push(p); if (u.purchases.length > 100) u.purchases = u.purchases.slice(-100);
    await saveUser(u); await addToIndex(identity);
  } catch (e) { console.error("noteRevenue:", e); }
}

export async function noteApple(identity: string, apple: { sub?: string; email?: string; name?: string }): Promise<void> {
  if (!identity) return;
  try { const u = await loadUser(identity); u.apple = { ...(u.apple || {}), ...apple }; await saveUser(u); await addToIndex(identity); } catch (e) { console.error("noteApple:", e); }
}

export async function noteDevice(identity: string, device: { name?: string; model?: string; identifier?: string; takiName?: string }): Promise<void> {
  if (!identity) return;
  try {
    const u = await loadUser(identity);
    const prior = u.device || { lastSeenAt: 0 };
    u.device = {
      name: String(device.name || "").trim().slice(0, 80) || prior.name,
      model: String(device.model || "").trim().slice(0, 80) || prior.model,
      identifier: String(device.identifier || "").trim().slice(0, 40) || prior.identifier,
      takiName: String(device.takiName || "").trim().slice(0, 60) || prior.takiName,
      lastSeenAt: Date.now()
    };
    await saveUser(u);
    await addToIndex(identity);
  } catch (e) { console.error("noteDevice:", e); }
}

export async function userForIdentity(identity: string): Promise<UserRecord> {
  return loadUser(identity);
}

export async function identitiesForIp(ip: string): Promise<string[]> {
  const ik = await storeGet<{ ids: string[] }>(ipKey(ip), { ids: [] });
  return ik.ids;
}

export async function allUsers(): Promise<UserRecord[]> {
  const idx = await storeGet<{ ids: string[] }>(USERS_INDEX, { ids: [] });
  const out: UserRecord[] = [];
  for (const id of idx.ids) out.push(await loadUser(id));
  return out;
}

// Remove a user from the registry (dashboard). Leaves credits/safety untouched.
export async function deleteUser(identity: string): Promise<void> {
  const idx = await storeGet<{ ids: string[] }>(USERS_INDEX, { ids: [] });
  if (idx.ids.includes(identity)) { idx.ids = idx.ids.filter((i) => i !== identity); await storeSet(USERS_INDEX, idx); }
  await storeSet(uKey(identity), null);
}
