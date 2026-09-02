import { storeDelete, storeGet, storeGetMany, storeUpdate } from "./store.js";
import { mergeIpLocations, normalizeStoredIpLocation, type IpLocation } from "./ipLocation.js";

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
  billingEvents: BillingEvent[];
}
export interface BillingEvent {
  at: number;
  name: string;
  properties: Record<string, string | number | boolean | null>;
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
  ipLocations?: IpLocation[];        // approximate Cloudflare IP geolocation, admin-only
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

function normalizeUser(identity: string, stored?: UserRecord): UserRecord {
  // Store values are JSON blobs and may have been written by an older build or
  // partially corrupted by an interrupted manual edit. Never mutate a scalar
  // (or an array) as though it were a UserRecord.
  const u = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {
    identity, firstSeenAt: 0, lastSeenAt: 0, requestCount: 0, creditsUsed: 0,
    tier: "free", tierHistory: [], ips: [], ipLocations: [], revenueUsd: 0, purchases: [], activeDays: [],
    analytics: { textQuestions: 0, voiceQuestions: 0, textCostUsd: 0, voiceCostUsd: 0, featureUsage: {}, recentQuestions: [], sessions: 0, totalSessionSeconds: 0, recentSessions: [], billingEvents: [] },
    engagement: { interests: [], pushEnabled: false, emailEnabled: false, updatedAt: 0 }
  };
  u.identity = identity;
  for (const key of ["firstSeenAt", "lastSeenAt", "requestCount", "creditsUsed", "revenueUsd"] as const) {
    const value = Number(u[key]);
    u[key] = Number.isFinite(value) ? Math.max(0, key.endsWith("At") ? value : Math.floor(value)) as never : 0 as never;
  }
  if (!Array.isArray(u.ips)) u.ips = [];
  u.ipLocations = mergeIpLocations(Array.isArray(u.ipLocations) ? u.ipLocations : []);
  if (!Array.isArray(u.tierHistory)) u.tierHistory = [];
  if (!Array.isArray(u.purchases)) u.purchases = [];
  if (!Array.isArray(u.activeDays)) u.activeDays = [];
  if (!u.analytics || typeof u.analytics !== "object" || Array.isArray(u.analytics)) {
    u.analytics = { textQuestions: 0, voiceQuestions: 0, textCostUsd: 0, voiceCostUsd: 0, featureUsage: {}, recentQuestions: [], sessions: 0, totalSessionSeconds: 0, recentSessions: [], billingEvents: [] };
  }
  u.analytics.textQuestions = Number(u.analytics.textQuestions || 0);
  u.analytics.voiceQuestions = Number(u.analytics.voiceQuestions || 0);
  u.analytics.textCostUsd = Number(u.analytics.textCostUsd || 0);
  u.analytics.voiceCostUsd = Number(u.analytics.voiceCostUsd || 0);
  u.analytics.textQuestions = Number.isFinite(u.analytics.textQuestions) ? Math.max(0, Math.floor(u.analytics.textQuestions)) : 0;
  u.analytics.voiceQuestions = Number.isFinite(u.analytics.voiceQuestions) ? Math.max(0, Math.floor(u.analytics.voiceQuestions)) : 0;
  u.analytics.textCostUsd = Number.isFinite(u.analytics.textCostUsd) ? Math.max(0, u.analytics.textCostUsd) : 0;
  u.analytics.voiceCostUsd = Number.isFinite(u.analytics.voiceCostUsd) ? Math.max(0, u.analytics.voiceCostUsd) : 0;
  if (!u.analytics.featureUsage || typeof u.analytics.featureUsage !== "object" || Array.isArray(u.analytics.featureUsage)) u.analytics.featureUsage = {};
  u.analytics.featureUsage = Object.fromEntries(Object.entries(u.analytics.featureUsage)
    .filter(([key, value]) => key && typeof value === "number" && Number.isFinite(value))
    .slice(0, 200)
    .map(([key, value]) => [key.slice(0, 60), Math.max(0, Math.floor(value as number))]));
  if (!Array.isArray(u.analytics.recentQuestions)) u.analytics.recentQuestions = [];
  u.analytics.recentQuestions = u.analytics.recentQuestions
    .filter((event) => event && typeof event === "object")
    .map((event: any) => ({
      at: Number.isFinite(Number(event.at)) ? Math.max(0, Number(event.at)) : 0,
      channel: (event.channel === "voice" ? "voice" : "text") as "text" | "voice",
      feature: String(event.feature || "chat").replace(/[^a-z0-9_-]/gi, "_").slice(0, 50) || "chat",
      credits: Math.max(0, Math.floor(Number(event.credits) || 0)),
      costUsd: Math.max(0, Number(event.costUsd) || 0)
    }))
    .slice(-100);
  u.analytics.sessions = Number(u.analytics.sessions || 0);
  u.analytics.totalSessionSeconds = Number(u.analytics.totalSessionSeconds || 0);
  u.analytics.sessions = Number.isFinite(u.analytics.sessions) ? Math.max(0, Math.floor(u.analytics.sessions)) : 0;
  u.analytics.totalSessionSeconds = Number.isFinite(u.analytics.totalSessionSeconds) ? Math.max(0, Math.floor(u.analytics.totalSessionSeconds)) : 0;
  if (!Array.isArray(u.analytics.recentSessions)) u.analytics.recentSessions = [];
  u.analytics.recentSessions = u.analytics.recentSessions
    .filter((event) => event && typeof event === "object")
    .map((event: any) => ({
      at: Number.isFinite(Number(event.at)) ? Math.max(0, Number(event.at)) : 0,
      durationSeconds: Math.max(1, Math.min(6 * 3600, Math.floor(Number(event.durationSeconds) || 1))),
      ...(typeof event.campaign === "string" && event.campaign.trim() ? { campaign: event.campaign.trim().slice(0, 80) } : {})
    }))
    .slice(-100);
  if (!Array.isArray(u.analytics.billingEvents)) u.analytics.billingEvents = [];
  u.analytics.billingEvents = u.analytics.billingEvents
    .filter((event) => event && typeof event === "object")
    .map((event: any) => ({
      at: Number.isFinite(Number(event.at)) ? Math.max(0, Number(event.at)) : 0,
      name: String(event.name || "event").replace(/[^a-z0-9_]/gi, "_").slice(0, 80),
      properties: event.properties && typeof event.properties === "object"
        ? Object.fromEntries(Object.entries(event.properties).slice(0, 20).flatMap(([key, value]) =>
          value === null || ["string", "number", "boolean"].includes(typeof value)
            ? [[key.slice(0, 50), value]]
            : [])) as Record<string, string | number | boolean | null>
        : {}
    }))
    .slice(-250);
  if (!u.engagement || typeof u.engagement !== "object" || Array.isArray(u.engagement)) {
    u.engagement = { interests: [], pushEnabled: false, emailEnabled: false, updatedAt: 0 };
  }
  if (!Array.isArray(u.engagement.interests)) u.engagement.interests = [];
  u.engagement.interests = u.engagement.interests.map(String).map((value) => value.trim().slice(0, 40)).filter(Boolean).slice(0, 3);
  u.engagement.pushEnabled = u.engagement.pushEnabled === true;
  u.engagement.emailEnabled = u.engagement.emailEnabled === true;
  u.engagement.updatedAt = Number.isFinite(Number(u.engagement.updatedAt)) ? Math.max(0, Number(u.engagement.updatedAt)) : 0;
  return u;
}
async function loadUser(identity: string): Promise<UserRecord> {
  const stored = await storeGet<UserRecord | null>(uKey(identity), null);
  return normalizeUser(identity, stored || undefined);
}
function withUser<T>(identity: string, update: (user: UserRecord) => Promise<T>): Promise<T> {
  // The previous process-local promise chain lost increments whenever two
  // Render instances handled the same account.  storeUpdate locks the record
  // in Postgres (and retains serialized semantics in the local store).
  return storeUpdate<UserRecord | null, T>(uKey(identity), null, async (stored) => {
    const user = normalizeUser(identity, stored || undefined);
    const result = await update(user);
    return { value: user, result };
  });
}
async function addToIndex(identity: string): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(USERS_INDEX, { ids: [] }, (idx) => {
    const ids = Array.isArray(idx.ids)
      ? idx.ids.filter((id): id is string => typeof id === "string" && (/^\d{8}$/.test(id) || /^(?:apple|google):[^:\s]{1,256}$/.test(id)))
      : [];
    if (!ids.includes(identity)) ids.push(identity);
    return { value: { ids: ids.slice(-100_000) }, result: undefined };
  });
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
// Registration uses the strict variant below so a failed durable write cannot
// still return a new device id that later appears as an empty "Taki user" row.
async function writeUser(identity: string, ip: string, ua: string, location?: IpLocation | null): Promise<void> {
  if (!identity) return;
  await withUser(identity, async (u) => {
    const now = Date.now();
    if (!u.firstSeenAt) u.firstSeenAt = now;
    u.lastSeenAt = now;
    u.requestCount += 1;
    if (ip && ip !== "unknown" && !u.ips.includes(ip)) {
      u.ips.push(ip); if (u.ips.length > 25) u.ips = u.ips.slice(-25);
      await storeUpdate<{ ids: string[] }, void>(ipKey(ip), { ids: [] }, (ik) => {
        const ids = Array.isArray(ik.ids)
          ? ik.ids.filter((id): id is string => typeof id === "string" && (/^\d{8}$/.test(id) || /^(?:apple|google):[^:\s]{1,256}$/.test(id)))
          : [];
        if (!ids.includes(identity)) ids.push(identity);
        return { value: { ids: ids.slice(-100_000) }, result: undefined };
      });
    }
    const safeLocation = normalizeStoredIpLocation(location);
    if (safeLocation && safeLocation.ip === ip) {
      u.ipLocations = mergeIpLocations([...(u.ipLocations || []), safeLocation]);
    }
    const dt = parseDeviceType(ua); if (dt) u.deviceType = dt;
    const day = new Date(now).toISOString().slice(0, 10);
    if (!u.activeDays.includes(day)) u.activeDays = [...u.activeDays, day].slice(-120);
    await addToIndex(identity);
  });
}

export async function noteUser(identity: string, ip: string, ua: string, location?: IpLocation | null): Promise<void> {
  try { await writeUser(identity, ip, ua, location); } catch (e) { console.error("noteUser:", e); }
}

/** Durable registration path: propagate storage failures to the caller. */
export async function noteUserStrict(identity: string, ip: string, ua: string, location?: IpLocation | null): Promise<void> {
  await writeUser(identity, ip, ua, location);
}

export async function noteSpend(identity: string, credits: number): Promise<void> {
  if (!identity || !(credits > 0)) return;
  try { await withUser(identity, async (u) => { u.creditsUsed += credits; }); } catch (e) { console.error("noteSpend:", e); }
}

// Billing telemetry deliberately accepts only scalar metadata. Never attach
// prompts, transcripts, contacts, chat titles, or other user content here.
export async function noteBillingEvent(
  identity: string,
  name: string,
  properties: Record<string, string | number | boolean | null | undefined> = {}
): Promise<void> {
  if (!identity || !name) return;
  const safe: BillingEvent["properties"] = {};
  for (const [key, value] of Object.entries(properties).slice(0, 20)) {
    if (value === undefined) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) safe[key.slice(0, 50)] = value as any;
  }
  try { await withUser(identity, async (u) => {
    u.analytics.billingEvents.push({ at: Date.now(), name: name.replace(/[^a-z0-9_]/gi, "_").slice(0, 80), properties: safe });
    u.analytics.billingEvents = u.analytics.billingEvents.slice(-250);
    await addToIndex(identity);
  }); } catch (e) { console.error("noteBillingEvent:", e); }
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
    await addToIndex(identity);
    });
  } catch (e) { console.error("noteTier:", e); }
}

export async function noteRevenue(identity: string, p: Purchase): Promise<void> {
  if (!identity) return;
  try {
    await withUser(identity, async (u) => {
    u.revenueUsd = Math.round((u.revenueUsd + p.amountUsd) * 100) / 100;
    u.purchases.push(p); if (u.purchases.length > 100) u.purchases = u.purchases.slice(-100);
    await addToIndex(identity);
    });
  } catch (e) { console.error("noteRevenue:", e); }
}

export async function noteApple(identity: string, apple: { sub?: string; email?: string; name?: string }): Promise<void> {
  if (!identity) return;
  try { await withUser(identity, async (u) => { u.apple = { ...(u.apple || {}), ...apple }; await addToIndex(identity); }); } catch (e) { console.error("noteApple:", e); }
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
    await addToIndex(identity);
  }); } catch (e) { console.error("noteInteraction:", e); }
}

export async function noteChannelCost(identity: string, channel: "text" | "voice", costUsd: number): Promise<void> {
  if (!identity || !(costUsd > 0)) return;
  try { await withUser(identity, async (u) => {
    const key = channel === "voice" ? "voiceCostUsd" : "textCostUsd";
    u.analytics[key] = Math.round((u.analytics[key] + costUsd) * 1_000_000) / 1_000_000;
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
    await addToIndex(identity);
  }); } catch (e) { console.error("noteEngagementPreferences:", e); }
}

export async function userForIdentity(identity: string): Promise<UserRecord> {
  return loadUser(identity);
}

export async function identitiesForIp(ip: string): Promise<string[]> {
  if (typeof ip !== "string" || !ip.trim() || ip.length > 120) return [];
  const ik = await storeGet<{ ids: string[] }>(ipKey(ip), { ids: [] });
  return Array.isArray(ik.ids)
    ? [...new Set(ik.ids.filter((id): id is string => typeof id === "string" && (/^\d{8}$/.test(id) || /^(?:apple|google):[^:\s]{1,256}$/.test(id))))].slice(-100_000)
    : [];
}

export async function allUsers(): Promise<UserRecord[]> {
  const idx = await storeGet<{ ids: string[] }>(USERS_INDEX, { ids: [] });
  const ids = Array.isArray(idx.ids)
    ? [...new Set(idx.ids.filter((id): id is string => typeof id === "string" && (/^\d{8}$/.test(id) || /^(?:apple|google):[^:\s]{1,256}$/.test(id))))].slice(-100_000)
    : [];
  const stored = await storeGetMany<UserRecord>(ids.map(uKey));
  const validIds = ids.filter((id) => stored.has(uKey(id)));
  if (validIds.length !== ids.length) {
    // Self-heal the registry so deleted/expired account rows do not reappear
    // as phantom "Taki user" accounts in the dashboard.
    try {
      await storeUpdate<{ ids: string[] }, void>(USERS_INDEX, { ids: [] }, (current) => {
        const currentIds = Array.isArray(current?.ids) ? current.ids : [];
        const allowed = new Set(validIds);
        const snapshotIds = new Set(ids);
        // Preserve a user that was registered after the read above.  Only
        // remove entries that belonged to this snapshot and were proven stale;
        // otherwise dashboard cleanup could erase a concurrent registration.
        return { value: { ids: currentIds.filter((id) => !snapshotIds.has(id) || allowed.has(id)) }, result: undefined };
      });
    } catch (error) {
      console.error("allUsers: failed to prune stale registry entries:", error);
    }
  }
  return validIds.map((id) => normalizeUser(id, stored.get(uKey(id))));
}

// Remove a user from the registry (dashboard). Leaves credits/safety untouched.
export async function deleteUser(identity: string): Promise<void> {
  const existing = await loadUser(identity);
  // Keep the per-IP association index honest when a failed registration or an
  // operator removes only the dashboard row. Leaving the identity behind made
  // the signup limiter count a deleted/empty account forever and made it look
  // like more anonymous "Taki user" accounts still existed.
  await Promise.all(existing.ips
    .filter((ip): ip is string => typeof ip === "string" && ip.length <= 120)
    .map((ip) => storeUpdate<{ ids: string[] }, void>(ipKey(ip), { ids: [] }, (stored) => ({
      value: { ids: (Array.isArray(stored?.ids) ? stored.ids : []).filter((id) => id !== identity) },
      result: undefined
    }))));
  await storeUpdate<{ ids: string[] }, void>(USERS_INDEX, { ids: [] }, (idx) => ({
    value: { ids: (Array.isArray(idx.ids) ? idx.ids : []).filter((i) => i !== identity) },
    result: undefined
  }));
  await storeDelete(uKey(identity));
}
