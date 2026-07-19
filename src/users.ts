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
export interface QuestionEvent {
  at: number;
  channel: "text" | "voice";
  feature: string;
  credits: number;
  costUsd: number;
}
export interface UsageAnalytics {
  textQuestions: number;
  voiceQuestions: number;
  textCostUsd: number;
  voiceCostUsd: number;
  featureUsage: Record<string, number>;
  recentQuestions: QuestionEvent[];
  lastQuestionAt?: number;
  sessions: number;
  totalSessionSeconds: number;
  recentSessions: { at: number; durationSeconds: number; campaign?: string }[];
}
export interface EngagementPreferences {
  interests: string[];
  pushEnabled: boolean;
  emailEnabled: boolean;
  updatedAt: number;
}
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
  activeDays: string[];
  analytics: UsageAnalytics;
  engagement: EngagementPreferences;
}

const USERS_INDEX = "users:index";
const keyify = (s: string) => s.replace(/[^a-zA-Z0-9_:.-]/g, "_");
const uKey = (id: string) => `user:${keyify(id)}`;
const ipKey = (ip: string) => `userip:${keyify(ip)}`;

async function loadUser(identity: string): Promise<UserRecord> {
  const u = await storeGet<UserRecord>(uKey(identity), {
    identity, firstSeenAt: 0, lastSeenAt: 0, requestCount: 0, creditsUsed: 0,
    tier: "free", tierHistory: [], ips: [], revenueUsd: 0, purchases: [], activeDays: [],
    analytics: { textQuestions: 0, voiceQuestions: 0, textCostUsd: 0, voiceCostUsd: 0, featureUsage: {}, recentQuestions: [], sessions: 0, totalSessionSeconds: 0, recentSessions: [] },
    engagement: { interests: [], pushEnabled: false, emailEnabled: false, updatedAt: 0 }
  });
  u.identity = identity;
  if (!Array.isArray(u.ips)) u.ips = [];
  if (!Array.isArray(u.tierHistory)) u.tierHistory = [];
  if (!Array.isArray(u.purchases)) u.purchases = [];
  if (!Array.isArray(u.activeDays)) u.activeDays = [];
  if (!u.analytics || typeof u.analytics !== "object") {
    u.analytics = { textQuestions: 0, voiceQuestions: 0, textCostUsd: 0, voiceCostUsd: 0, featureUsage: {}, recentQuestions: [], sessions: 0, totalSessionSeconds: 0, recentSessions: [] };
  }
  u.analytics.textQuestions = Number(u.analytics.textQuestions || 0);
  u.analytics.voiceQuestions = Number(u.analytics.voiceQuestions || 0);
  u.analytics.textCostUsd = Number(u.analytics.textCostUsd || 0);
  u.analytics.voiceCostUsd = Number(u.analytics.voiceCostUsd || 0);
  if (!u.analytics.featureUsage || typeof u.analytics.featureUsage !== "object") u.analytics.featureUsage = {};
  if (!Array.isArray(u.analytics.recentQuestions)) u.analytics.recentQuestions = [];
  u.analytics.sessions = Number(u.analytics.sessions || 0);
  u.analytics.totalSessionSeconds = Number(u.analytics.totalSessionSeconds || 0);
  if (!Array.isArray(u.analytics.recentSessions)) u.analytics.recentSessions = [];
  if (!u.engagement || typeof u.engagement !== "object") {
    u.engagement = { interests: [], pushEnabled: false, emailEnabled: false, updatedAt: 0 };
  }
  if (!Array.isArray(u.engagement.interests)) u.engagement.interests = [];
  return u;
}
async function saveUser(u: UserRecord): Promise<void> { await storeSet(uKey(u.identity), u); }
const userChains = new Map<string, Promise<unknown>>();
function withUser<T>(identity: string, update: (user: UserRecord) => Promise<T>): Promise<T> {
  const prior = userChains.get(identity) || Promise.resolve();
  const current = prior.then(async () => update(await loadUser(identity)), async () => update(await loadUser(identity)));
  userChains.set(identity, current.then(() => undefined, () => undefined));
  return current;
}
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
  try { await withUser(identity, async (u) => {
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
    const day = new Date(now).toISOString().slice(0, 10);
    if (!u.activeDays.includes(day)) u.activeDays = [...u.activeDays, day].slice(-120);
    await saveUser(u);
    await addToIndex(identity);
  }); } catch (e) { console.error("noteUser:", e); }
}

export async function noteSpend(identity: string, credits: number): Promise<void> {
  if (!identity || !(credits > 0)) return;
  try { await withUser(identity, async (u) => { u.creditsUsed += credits; await saveUser(u); }); } catch (e) { console.error("noteSpend:", e); }
}

export async function noteTier(identity: string, tier: string, source: string): Promise<void> {
  if (!identity) return;
  try {
    await withUser(identity, async (u) => {
    if (u.tier !== tier || u.tierHistory.length === 0) {
      u.tierHistory.push({ tier, at: Date.now(), source });
      if (u.tierHistory.length > 50) u.tierHistory = u.tierHistory.slice(-50);
    }
    u.tier = tier;
    await saveUser(u); await addToIndex(identity);
    });
  } catch (e) { console.error("noteTier:", e); }
}

export async function noteRevenue(identity: string, p: Purchase): Promise<void> {
  if (!identity) return;
  try {
    await withUser(identity, async (u) => {
    u.revenueUsd = Math.round((u.revenueUsd + p.amountUsd) * 100) / 100;
    u.purchases.push(p); if (u.purchases.length > 100) u.purchases = u.purchases.slice(-100);
    await saveUser(u); await addToIndex(identity);
    });
  } catch (e) { console.error("noteRevenue:", e); }
}

export async function noteApple(identity: string, apple: { sub?: string; email?: string; name?: string }): Promise<void> {
  if (!identity) return;
  try { await withUser(identity, async (u) => { u.apple = { ...(u.apple || {}), ...apple }; await saveUser(u); await addToIndex(identity); }); } catch (e) { console.error("noteApple:", e); }
}

export async function noteDevice(identity: string, device: { name?: string; model?: string; identifier?: string; takiName?: string }): Promise<void> {
  if (!identity) return;
  try {
    await withUser(identity, async (u) => {
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
    });
  } catch (e) { console.error("noteDevice:", e); }
}

export async function noteInteraction(identity: string, event: Omit<QuestionEvent, "at"> & { at?: number }): Promise<void> {
  if (!identity) return;
  try { await withUser(identity, async (u) => {
    const at = event.at || Date.now();
    const channel = event.channel === "voice" ? "voice" : "text";
    const feature = String(event.feature || "chat").replace(/[^a-z0-9_-]/gi, "_").slice(0, 50) || "chat";
    const costUsd = Math.max(0, Number(event.costUsd) || 0);
    const credits = Math.max(0, Math.round(Number(event.credits) || 0));
    if (channel === "voice") {
      u.analytics.voiceQuestions += 1;
      u.analytics.voiceCostUsd = Math.round((u.analytics.voiceCostUsd + costUsd) * 1_000_000) / 1_000_000;
    } else {
      u.analytics.textQuestions += 1;
      u.analytics.textCostUsd = Math.round((u.analytics.textCostUsd + costUsd) * 1_000_000) / 1_000_000;
    }
    u.analytics.featureUsage[feature] = (u.analytics.featureUsage[feature] || 0) + 1;
    u.analytics.lastQuestionAt = at;
    u.analytics.recentQuestions.push({ at, channel, feature, credits, costUsd });
    u.analytics.recentQuestions = u.analytics.recentQuestions.slice(-100);
    const day = new Date(at).toISOString().slice(0, 10);
    if (!u.activeDays.includes(day)) u.activeDays = [...u.activeDays, day].slice(-120);
    await saveUser(u);
    await addToIndex(identity);
  }); } catch (e) { console.error("noteInteraction:", e); }
}

export async function noteChannelCost(identity: string, channel: "text" | "voice", costUsd: number): Promise<void> {
  if (!identity || !(costUsd > 0)) return;
  try { await withUser(identity, async (u) => {
    const key = channel === "voice" ? "voiceCostUsd" : "textCostUsd";
    u.analytics[key] = Math.round((u.analytics[key] + costUsd) * 1_000_000) / 1_000_000;
    await saveUser(u);
  }); } catch (e) { console.error("noteChannelCost:", e); }
}

export async function noteSession(identity: string, durationSeconds: number, campaign?: string): Promise<void> {
  if (!identity) return;
  const duration = Math.max(1, Math.min(6 * 3600, Math.round(Number(durationSeconds) || 0)));
  if (!duration) return;
  try { await withUser(identity, async (u) => {
    u.analytics.sessions += 1;
    u.analytics.totalSessionSeconds += duration;
    u.analytics.recentSessions.push({
      at: Date.now(),
      durationSeconds: duration,
      ...(campaign ? { campaign: String(campaign).slice(0, 80) } : {})
    });
    u.analytics.recentSessions = u.analytics.recentSessions.slice(-100);
    await saveUser(u);
    await addToIndex(identity);
  }); } catch (e) { console.error("noteSession:", e); }
}

export async function noteEngagementPreferences(
  identity: string,
  preferences: Partial<Omit<EngagementPreferences, "updatedAt">>
): Promise<void> {
  if (!identity) return;
  try { await withUser(identity, async (u) => {
    if (Array.isArray(preferences.interests)) {
      u.engagement.interests = preferences.interests.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 3);
    }
    if (typeof preferences.pushEnabled === "boolean") u.engagement.pushEnabled = preferences.pushEnabled;
    if (typeof preferences.emailEnabled === "boolean") u.engagement.emailEnabled = preferences.emailEnabled;
    u.engagement.updatedAt = Date.now();
    await saveUser(u);
    await addToIndex(identity);
  }); } catch (e) { console.error("noteEngagementPreferences:", e); }
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
