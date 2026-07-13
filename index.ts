import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { PORT, MAIN_MODEL, PLANNER_MODEL, RESEARCH_MODEL } from "./src/ai.js";
import type { DeviceLocation } from "./src/types.js";
import { buildConversationState } from "./src/context.js";
import { planAssistantResponse } from "./src/planner.js";
import { finalizeResponse } from "./src/validators.js";
import { getGeneralAnswer, styleInCharacter, getWeatherSnapshot, inferEventDestination, matchEventToQuery, getTravelTime, answerAboutImage, answerAboutAttachments, fitVoiceResponse } from "./src/tools.js";
// getTravelTime (above) also powers the background commute push loop.
import { withTimeout } from "./src/util.js";
import { parseIncomingStyleProfiles } from "./src/messageStyle.js";
import { parseUserPersona } from "./src/persona.js";
import {
  registerToken, forgetToken, broadcast, getTokens, isPushConfigured,
  registerLiveActivity, unregisterLiveActivity, getLiveActivities, sendLiveActivityUpdate
} from "./src/push.js";
import { cachedTrackerSnapshot } from "./src/tracker.js";
import { extractFlightCode, normalizeTrackerKind } from "./src/entityClassifier.js";
import { setPushToken, syncNudges, tickNudges } from "./src/nudges.js";
import { addAlert, listAlerts, cancelAlerts, pollAlerts, type Alert } from "./src/alerts.js";
import { isDurable, storeDelete, storeGet, storeSet } from "./src/store.js";
import { summary as creditSummary, spendUsageUsd, reset as resetCredits, isFreeVoice, noteFreeVoice, tierCatalog, grantForTransaction, downgradeToFree, revokeSubscription, revokeMergedSubscriptionCredits, clearRetiredSubscription, mergeCredits, noteVoiceQuestion, grantCredits, topupPriceCents, topupCentsPerCredit, CREDIT_TOPUP_MIN, CREDIT_TOPUP_MAX, MIN_REQUEST_CREDITS, FREE_VOICE_LIMIT, FREE_VOICE_PER_CYCLE, CREDIT_USD, type Tier } from "./src/credits.js";
import { measureUsage, sttCostUsd, totalUsageUsd, ttsCostUsd } from "./src/metering.js";
import { verifyTransaction, linkTransactionIdentity, transactionIdsForIdentity, setTransactionRole, getTransactionBinding, primarySubscriptionForIdentity, claimPrimarySubscription, subscriptionMergeDecision, verifyNotification } from "./src/iap.js";
import { revokeAppleAuthorizationCode, verifyAppleIdentityToken } from "./src/appleauth.js";
import { purgeAppleAccount } from "./src/accountDeletion.js";
import { recordAssoc, isBanned, isTestRestricted, setTestRestriction, clearTestRestriction, previewTermination, getSafetyAccount, recordViolation, classifyHarm, looksLikePromptExtraction, reinstate, terminateAndBan, reviewQueue, linkApple, devicesForApple, appleForDevice, SUSPENDED_MSG, BANNED_MSG, promptExtractionMessageForMode } from "./src/safety.js";
import { noteUser, noteSpend, noteTier, noteRevenue, noteApple, noteDevice, userForIdentity, identitiesForIp, allUsers, deleteUser } from "./src/users.js";
import { TIERS } from "./src/credits.js";
import { billableAudioDurationMs, transcribe, synthesize, listVoices, isVoiceConfigured, speechCharacterCount } from "./src/voice.js";
import { emailProviderConfigured, createOAuthState, buildAuthUrl, completeOAuth, loadConnection, disconnectEmail, sendEmail, saveDraft, searchConnectedEmail, type EmailProvider } from "./src/email.js";
import { extractDurableMemories } from "./src/userMemory.js";
import { createChatTitle } from "./src/chatTitle.js";

// Admin secret guarding the dev credits-reset endpoint. Set ADMIN_SECRET on
// Render. (The purchase-simulating grant endpoint was removed when real
// StoreKit IAP shipped — grants only happen via verified transactions now.)
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();
const OUT_OF_CREDITS_MSG = "You're out of credits — top up or upgrade in Membership to keep asking.";
const DAILY_LIMIT_MSG = "You've reached today's usage limit. You can ask again after the daily reset shown in Membership.";
const MONTHLY_LIMIT_MSG = "You've reached this month's usage limit. You can ask again after the monthly reset shown in Membership.";
const FREE_VOICE_LIMIT_MSG = "You've reached the Voice limit for the Free tier. Upgrade to Plus for full access.";

type PendingVoiceSynthesis = { deviceId: string; included: boolean; expiresAt: number };
const pendingVoiceSyntheses = new Map<string, PendingVoiceSynthesis>();

function isAdminAuthorized(value: unknown): boolean {
  if (!ADMIN_SECRET || typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ADMIN_SECRET);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function createVoiceSynthesisToken(deviceId: string, included: boolean): string {
  const now = Date.now();
  if (pendingVoiceSyntheses.size > 5_000) {
    for (const [token, pending] of pendingVoiceSyntheses) {
      if (pending.expiresAt <= now) pendingVoiceSyntheses.delete(token);
    }
  }
  const token = randomUUID();
  pendingVoiceSyntheses.set(token, { deviceId, included, expiresAt: now + 2 * 60_000 });
  return token;
}

function takeVoiceSynthesisToken(token: string, deviceId: string): PendingVoiceSynthesis | null {
  const pending = pendingVoiceSyntheses.get(token);
  if (!pending || pending.deviceId !== deviceId || pending.expiresAt <= Date.now()) return null;
  pendingVoiceSyntheses.delete(token);
  return pending;
}

function usageLimitMessage(summary: { limitReached?: boolean; limitReason?: string | null }): string | null {
  if (!summary.limitReached) return null;
  return summary.limitReason === "monthly" ? MONTHLY_LIMIT_MSG : DAILY_LIMIT_MSG;
}

function usageLimitForCost(summary: any, cost: number): "daily" | "monthly" | null {
  if (summary?.daily && summary.daily.used + cost > summary.daily.limit) return "daily";
  if (summary?.monthly && summary.monthly.used + cost > summary.monthly.limit) return "monthly";
  return null;
}

function usageMessageForReason(reason: "daily" | "monthly"): string {
  return reason === "monthly" ? MONTHLY_LIMIT_MSG : DAILY_LIMIT_MSG;
}

async function chargeMeasuredUsage(deviceId: string, usage: { geminiUsd: number; searchUsd: number }): Promise<void> {
  if (!deviceId) return;
  const charged = await spendUsageUsd(deviceId, usage.geminiUsd + usage.searchUsd);
  await noteSpend(deviceId, charged.spent);
}

/* ============================================================================
 * Taki AI server — planner-first architecture (entrypoint).
 *
 * Pipeline (see server/src):
 *   context.ts    -> buildConversationState  (normalize request + transcript)
 *   planner.ts    -> planAssistantResponse   (the single brain / source of truth)
 *   validators.ts -> finalizeResponse        (validate + sync spoken/action + memory)
 *   tools.ts      -> weather/web/events/location/general answer
 *   memory.ts     -> structured event/contact/place memory
 *
 * Invariants enforced in finalizeResponse:
 *   - If action exists, spokenText describes that exact action.
 *   - "I'll add X" is only spoken when action.type === calendar_create for X.
 *   - No spoken promise without a matching action.
 *   - Current transcript outranks saved memory; "Added ..." lines never become
 *     new events; events do not leak between chats (transcript is per-chat).
 * ==========================================================================*/

const app = express();
app.use(cors());
// Keep the raw body around so the Stripe webhook can verify its signature (Stripe
// signs the exact bytes, not the parsed JSON).
app.use(express.json({ limit: "16mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

// --- Stripe (web credit top-ups). Gated on env; endpoints 503 when unset. ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WEB_BASE_URL = process.env.WEB_BASE_URL || "https://takiai.app";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Taki AI server",
    mode: "planner-first-modular-v3",
    version: "2026-07-12-intelligence-v3",
    models: { main: MAIN_MODEL, planner: PLANNER_MODEL, research: RESEARCH_MODEL }
  });
});

// --- Push (APNs) --------------------------------------------------------------
// The device registers its APNs token here so the server can send proactive
// alerts (commute "leave now", fresh morning briefing, breaking updates).
app.post("/api/register-push", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!token) {
    res.status(400).json({ error: "token required" });
    return;
  }
  registerToken(token);
  // Tie the token to the device id so the nudge engine can target this device.
  if (deviceId) void setPushToken(deviceId, token);
  res.json({ ok: true, configured: isPushConfigured(), devices: getTokens().length });
});

// The device syncs its upcoming nudge manifest on every foreground; the cron
// loop below fires each when due (so nudges arrive with the app closed).
app.post("/api/nudges/sync", async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  const count = await syncNudges(deviceId, Array.isArray(req.body?.nudges) ? req.body.nudges : []);
  res.json({ ok: true, count, pushConfigured: isPushConfigured() });
});

// Let a device unsubscribe (e.g. notifications turned off).
app.post("/api/unregister-push", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token) forgetToken(token);
  res.json({ ok: true });
});

// Fire a push to every registered device — used to verify the .p8 pipeline
// end-to-end, and the building block every proactive trigger calls.
app.post("/api/test-push", async (req, res) => {
  if (!isPushConfigured()) {
    res.status(503).json({ error: "APNs not configured — set APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID in .env" });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title : "Taki AI";
  const body = typeof req.body?.body === "string" ? req.body.body : "Push is working. 🎉";
  try {
    const results = await broadcast({ title, body });
    res.json({ ok: true, sent: results.length, results });
  } catch (error) {
    console.error("test-push error:", error);
    res.status(502).json({ error: "push failed" });
  }
});

// Style an arbitrary line in the user's chosen personality. The device uses this
// for messages IT generates (replace confirmations, permission prompts) so every
// word the assistant says matches the selected persona — not just server replies.
app.post("/api/style", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text required" });
    return;
  }
  try {
    const persona = parseUserPersona(req.body?.profile);
    const measured = await measureUsage(() => withTimeout(styleInCharacter(text, persona), 8000, "Style"));
    const styled = measured.value;
    await chargeMeasuredUsage(typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "", measured.usage);
    res.json({ text: (styled || text).trim() });
  } catch (error) {
    console.error("Style error:", error);
    res.json({ text }); // fall back to plain text
  }
});

// The device registers a running Live Activity's push token here so the server
// can update it in the BACKGROUND (app closed) via ActivityKit push.
app.post("/api/register-la", (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!id || !token) {
    res.status(400).json({ error: "id and token required" });
    return;
  }
  const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};
  const requestedKind = typeof req.body?.kind === "string" ? req.body.kind : "finance";
  const query = typeof meta?.query === "string" ? meta.query : "";
  registerLiveActivity({
    id,
    kind: normalizeTrackerKind(requestedKind, query),
    meta,
    token
  });
  res.json({ ok: true, configured: isPushConfigured() });
});

app.post("/api/unregister-la", (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (id) unregisterLiveActivity(id);
  res.json({ ok: true });
});

// Background engine: every minute, re-fetch each live tracker's data and push a
// content-state update straight to its Live Activity — no app needed. Ends
// activities past their max lifetime and prunes dead tokens.
// Stay just inside ActivityKit's eight-hour active lifetime while allowing a
// full game, trading session, long flight, or delivery window to remain useful.
const LA_MAX_MS = (7 * 60 + 45) * 60 * 1000;
const deadToken = (r: { status: number; reason?: string }) =>
  r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "ExpiredProviderToken";

// Last content-state we pushed per activity — so we only push when something
// actually changed (pushing identical frames every 15s wastes Apple's Live
// Activity budget and invites throttling).
const lastPushed = new Map<string, string>();

// Data trackers: re-fetch (cached) and push every 15s. Product prices use a
// much longer cache TTL than market/game data.
// but only when the content changed. So the lock screen updates within ~15s of
// any change, app open OR closed.
setInterval(async () => {
  if (!isPushConfigured()) return;
  for (const reg of getLiveActivities()) {
    if (Date.now() - reg.startedAt > LA_MAX_MS) {
      await sendLiveActivityUpdate(reg.token, null, "end");
      unregisterLiveActivity(reg.id);
      lastPushed.delete(reg.id);
      continue;
    }
    if (reg.kind !== "finance" && reg.kind !== "product" && reg.kind !== "sports" && reg.kind !== "flight" && reg.kind !== "package") continue;
    try {
      const snap = await cachedTrackerSnapshot(reg.kind, String(reg.meta?.query || ""), reg.meta?.tz ? String(reg.meta.tz) : undefined);
      if (!snap) continue;
      const content: Record<string, unknown> = {
        line1: snap.line1, line2: snap.line2, trend: snap.trend,
        progress: -1, targetEpoch: 0, status: snap.status,
        depColor: snap.depColor, arrColor: snap.arrColor
      };
      // Package activities keep their "Open <carrier>" button across pushes.
      if (reg.kind === "package" && reg.meta?.url) {
        content.actionLabel = `Open ${reg.meta?.carrier || "carrier"}`;
        content.actionURL = String(reg.meta.url);
      }
      const sig = JSON.stringify(content);
      if (lastPushed.get(reg.id) === sig) continue; // unchanged → don't spend a push
      const r = await sendLiveActivityUpdate(reg.token, content);
      if (deadToken(r)) { unregisterLiveActivity(reg.id); lastPushed.delete(reg.id); }
      else lastPushed.set(reg.id, sig);
    } catch (error) {
      console.error("Live Activity push error:", error);
    }
  }
}, 15 * 1000);

// Commute: re-check live traffic and push an updated departure time every 3 min
// (slower than finance — traffic drifts gradually, and this hits the Directions
// API). Ends the activity once the event has started.
const modeWord = (m: string) => (m === "walking" ? "walk" : m === "bicycling" ? "bike" : m === "transit" ? "transit" : "drive");
setInterval(async () => {
  if (!isPushConfigured()) return;
  for (const reg of getLiveActivities()) {
    if (reg.kind !== "commute") continue;
    const meta = reg.meta || {};
    const startEpoch = Number(meta.eventStartEpoch);
    if (Number.isFinite(startEpoch) && startEpoch * 1000 < Date.now()) {
      await sendLiveActivityUpdate(reg.token, null, "end");
      unregisterLiveActivity(reg.id);
      continue;
    }
    try {
      const eta = await getTravelTime(Number(meta.originLat), Number(meta.originLon), Number(meta.destLat), Number(meta.destLon), String(meta.mode || "driving"));
      if (!eta) continue;
      const etaMin = Math.max(1, Math.round(eta.seconds / 60));
      const departEpoch = Math.floor(startEpoch - eta.seconds - (Number(meta.leaveBufferMin) || 0) * 60);
      const r = await sendLiveActivityUpdate(reg.token, {
        line1: `${etaMin} min ${modeWord(eta.mode)}`,
        line2: meta.destName ? `to ${meta.destName}` : "",
        trend: "flat", progress: -1, targetEpoch: departEpoch, status: "Leave in"
      });
      if (deadToken(r)) unregisterLiveActivity(reg.id);
    } catch (error) {
      console.error("Commute push error:", error);
    }
  }
}, 3 * 60 * 1000);

/* ---- Batch B proactive alerts (price / score) -------------------------- */

// Register an alert the server will watch and push when it fires. The device
// sends the alert spec it got back from the planner's alert_create action.
app.post("/api/alerts", async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === "price" || b.kind === "score" ? b.kind : "";
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (!kind || !query) { res.status(400).json({ error: "kind and query required" }); return; }
  const base = { id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), query, label: typeof b.label === "string" && b.label ? b.label : query };
  let alert: Alert;
  if (kind === "price") {
    const target = Number(b.target);
    if (!Number.isFinite(target)) { res.status(400).json({ error: "target required" }); return; }
    alert = { ...base, kind: "price", target, direction: b.direction === "below" ? "below" : "above" };
  } else {
    alert = { ...base, kind: "score", trigger: b.trigger === "final" ? "final" : "any" };
  }
  const result = await addAlert(alert);
  res.json({ ...result, durable: isDurable() });
});

app.get("/api/alerts", async (_req, res) => {
  res.json({ alerts: await listAlerts(), durable: isDurable() });
});

app.post("/api/alerts/cancel", async (req, res) => {
  const b = req.body || {};
  const filter = (b.id || b.kind || b.query)
    ? { id: typeof b.id === "string" ? b.id : undefined, kind: typeof b.kind === "string" ? b.kind : undefined, query: typeof b.query === "string" ? b.query : undefined }
    : undefined;
  const removed = await cancelAlerts(filter);
  res.json({ ok: true, removed });
});

// Background engine: sweep all alerts every 90s and push any that fire. Skips
// entirely when push isn't configured (no APNs key) — alerts just sit until it is.
setInterval(() => {
  if (!isPushConfigured()) return;
  void pollAlerts(process.env.ALERT_TZ || "America/New_York");
}, 90 * 1000);

// Fire any due proactive nudges (server-push tier) every minute.
setInterval(() => { void tickNudges(); }, 60 * 1000);

// Live tracker snapshot for an active Live Activity. The device polls
// this to keep the lock-screen / Dynamic Island tracker fresh.
app.get("/api/track", async (req, res) => {
  const requestedKind = typeof req.query.kind === "string" ? req.query.kind : "";
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const kind = normalizeTrackerKind(requestedKind, query);
  const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
  if ((kind !== "finance" && kind !== "product" && kind !== "sports" && kind !== "flight" && kind !== "package") || !query) {
    res.status(400).json({ error: "kind (finance|product|sports|flight|package) and q are required" });
    return;
  }
  try {
    const safeQuery = kind === "flight" ? extractFlightCode(query) || query : query;
    const snap = await withTimeout(cachedTrackerSnapshot(kind, safeQuery, tz), 25000, "Track snapshot");
    if (!snap) {
      res.status(502).json({ error: "tracker unavailable" });
      return;
    }
    res.json(snap);
  } catch (error) {
    console.error("Track snapshot error:", error);
    res.status(502).json({ error: "tracker unavailable" });
  }
});

// Compact weather for the home-screen widget (used by the app to push a snapshot).
app.get("/api/widget-weather", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  try {
    const snap = await withTimeout(getWeatherSnapshot(lat, lon, tz), 20000, "Widget weather");
    if (!snap) {
      res.status(502).json({ error: "weather unavailable" });
      return;
    }
    res.json(snap);
  } catch (error) {
    console.error("Widget weather error:", error);
    res.status(502).json({ error: "weather unavailable" });
  }
});

// Resolve where a calendar event is happening, for the "time to leave" Live
// Activity. The device sends the event title/location/notes + its coordinates;
// we return a navigable place (calendar location geocoded, or a venue inferred
// via grounded web search). Returns 404 when no real place can be pinned.
app.post("/api/resolve-destination", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : "";
  const location = typeof req.body?.location === "string" ? req.body.location : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes : "";
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!title && !location) {
    res.status(400).json({ error: "title or location is required" });
    return;
  }
  try {
    const measured = await measureUsage(() => withTimeout(
      inferEventDestination({
        title,
        location,
        notes,
        lat: Number.isFinite(lat) ? lat : undefined,
        lon: Number.isFinite(lon) ? lon : undefined
      }),
      22000,
      "Resolve destination"
    ));
    const dest = measured.value;
    await chargeMeasuredUsage(typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "", measured.usage);
    if (!dest) {
      res.status(404).json({ error: "could not resolve a destination" });
      return;
    }
    res.json(dest);
  } catch (error) {
    console.error("Resolve destination error:", error);
    res.status(502).json({ error: "destination unavailable" });
  }
});

// Given the user's phrasing + their upcoming events, let the model pick which
// event they mean (for the "time to leave" / countdown Live Activity).
app.post("/api/match-event", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
  const events = rawEvents.slice(0, 50).map((e: any) => ({
    title: typeof e?.title === "string" ? e.title : "",
    when: typeof e?.when === "string" ? e.when : "",
    location: typeof e?.location === "string" ? e.location : ""
  }));
  if (!query || events.length === 0) {
    res.json({ index: -1 });
    return;
  }
  try {
    const measured = await measureUsage(() => withTimeout(matchEventToQuery(query, events), 10000, "Match event"));
    const index = measured.value;
    await chargeMeasuredUsage(typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "", measured.usage);
    res.json({ index });
  } catch (error) {
    console.error("Match event error:", error);
    res.json({ index: -1 });
  }
});

// Vision: answer a question about a photo (base64) the user took/picked.
app.post("/api/vision", async (req, res) => {
  const image = typeof req.body?.image === "string" ? req.body.image : "";
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "image/jpeg";
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!image) {
    res.status(400).json({ error: "image is required" });
    return;
  }
  const visionGate = await safetyGate(deviceId, question, req);
  if (visionGate) { res.json({ spokenText: visionGate.message, blocked: true, ...(visionGate.block ? { access: visionGate.block, accessMessage: visionGate.message } : {}) }); return; }
  let tier: Tier = "free";
  let visionBaseCredits = 0;
  let visionVoiceUsed = 0;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    tier = sum.tier;
    visionBaseCredits = sum.baseCredits;
    visionVoiceUsed = sum.voiceCycleUsed;
    const usageMessage = usageLimitMessage(sum);
    if (sum.balance < MIN_REQUEST_CREDITS || usageMessage) {
      res.json({ spokenText: usageMessage || OUT_OF_CREDITS_MSG, credits: { ...sum, cost: 0, outOfCredits: !usageMessage, limitReached: !!usageMessage } });
      return;
    }
  }
  try {
    const measured = await measureUsage(() => withTimeout(answerAboutImage(image, mime, question, userProfile, timeZone), 28000, "Vision"));
    const spokenText = measured.value;
    if (deviceId) {
      let usageUsd = totalUsageUsd(measured.usage);
      if (voiceMode) {
        if (isFreeVoice(tier, visionBaseCredits, visionVoiceUsed)) await noteFreeVoice(deviceId);
        else usageUsd += ttsCostUsd(speechCharacterCount(spokenText || ""));
      }
      const fresh = await creditSummary(deviceId);
      const limitReason = usageLimitForCost(fresh, Math.ceil(usageUsd / CREDIT_USD));
      if (limitReason) {
        res.json({ spokenText: usageMessageForReason(limitReason), credits: { ...fresh, cost: 0 } });
        return;
      }
      const s = await spendUsageUsd(deviceId, usageUsd);
      await noteSpend(deviceId, s.spent);
      res.json({ spokenText, credits: { ...s, cost: s.spent } });
    } else {
      res.json({ spokenText });
    }
  } catch (error) {
    console.error("Vision error:", error);
    res.status(502).json({ error: "vision unavailable" });
  }
});

app.post("/api/attachments", async (req, res) => {
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 6) : [];
  const question = typeof req.body?.question === "string" ? req.body.question : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!attachments.length) { res.status(400).json({ error: "attachment is required" }); return; }

  const gate = await safetyGate(deviceId, question, req);
  if (gate) { res.json({ spokenText: gate.message, blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) }); return; }

  let tier: Tier = "free";
  let baseCredits = 0;
  let voiceUsed = 0;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    tier = sum.tier;
    baseCredits = sum.baseCredits;
    voiceUsed = sum.voiceCycleUsed;
    const usageMessage = usageLimitMessage(sum);
    if (sum.balance < MIN_REQUEST_CREDITS || usageMessage) {
      res.json({ spokenText: usageMessage || OUT_OF_CREDITS_MSG, credits: { ...sum, cost: 0, outOfCredits: !usageMessage, limitReached: !!usageMessage } });
      return;
    }
  }

  try {
    const measured = await measureUsage(() => answerAboutAttachments(attachments, question, userProfile, timeZone));
    const answer = measured.value;
    if (!deviceId) { res.json({ spokenText: answer.text, sources: answer.sources }); return; }
    let usageUsd = totalUsageUsd(measured.usage);
    if (voiceMode) {
      if (isFreeVoice(tier, baseCredits, voiceUsed)) await noteFreeVoice(deviceId);
      else usageUsd += ttsCostUsd(speechCharacterCount(answer.text));
    }
    const fresh = await creditSummary(deviceId);
    const limitReason = usageLimitForCost(fresh, Math.ceil(usageUsd / CREDIT_USD));
    if (limitReason) {
      res.json({ spokenText: usageMessageForReason(limitReason), sources: answer.sources, credits: { ...fresh, cost: 0 } });
      return;
    }
    const spent = await spendUsageUsd(deviceId, usageUsd);
    await noteSpend(deviceId, spent.spent);
    res.json({ spokenText: answer.text, sources: answer.sources, credits: { ...spent, cost: spent.spent } });
  } catch (error) {
    console.error("Attachment answer failed:", error);
    res.status(502).json({ error: error instanceof Error ? error.message : "attachment unavailable" });
  }
});

/* ---- Credits / subscriptions ------------------------------------------- */

// Current balance + tier for a device (also gives a fresh device its starter grant).
/* ---- Short 8-digit device ids ------------------------------------------- */
// Assigns a unique 8-digit number per device: 1st digit = country (1 = USA, 0 =
// other), remaining 7 = a per-country registration sequence. Server-tracked so
// numbers are unique + never reused; the device saves it in the Keychain so it
// persists across reinstall. Serialized so concurrent registrations don't collide.
let deviceSeqChain: Promise<unknown> = Promise.resolve();
async function assignDeviceNumber(region: string): Promise<string> {
  const country = region.toUpperCase() === "US" ? "1" : "0";
  const run = deviceSeqChain.then(async () => {
    // Random 7 digits (so the id doesn't reveal how many devices exist), checked
    // against a used-set for uniqueness and marked so it's never reused.
    for (let attempt = 0; attempt < 25; attempt++) {
      const rnd = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
      const id = country + rnd;
      if (!(await storeGet<boolean>(`devnum:used:${id}`, false))) {
        await storeSet(`devnum:used:${id}`, true);
        return id;
      }
    }
    // Astronomically unlikely fallback (would need the number space near-full).
    const id = country + String(Date.now()).slice(-7);
    await storeSet(`devnum:used:${id}`, true);
    return id;
  });
  deviceSeqChain = run.then(() => {}, () => {});
  return run;
}

app.post("/api/register-device", async (req, res) => {
  const region = typeof req.body?.region === "string" ? req.body.region : "";
  try {
    const deviceId = await assignDeviceNumber(region);
    res.json({ deviceId });
  } catch (e) {
    console.error("register-device error:", e);
    res.status(502).json({ error: "could not register device" });
  }
});

app.post("/api/device/info", async (req, res) => {
  const b = req.body || {};
  const deviceId = typeof b.deviceId === "string" ? normalizeTopupIdentity(b.deviceId) : "";
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "valid deviceId required" }); return; }
  if (!(await storeGet<boolean>(`devnum:used:${deviceId}`, false)) && !(await hasCreditsAccount(deviceId))) {
    res.status(404).json({ error: "unknown device" }); return;
  }
  await noteDevice(deviceId, {
    name: typeof b.name === "string" ? b.name : "",
    model: typeof b.model === "string" ? b.model : "",
    identifier: typeof b.identifier === "string" ? b.identifier : "",
    takiName: typeof b.takiName === "string" ? b.takiName : ""
  });
  res.json({ ok: true });
});

async function captureRequestDeviceInfo(req: any, takiName: string): Promise<void> {
  const deviceId = typeof req.body?.physicalDeviceId === "string" ? normalizeTopupIdentity(req.body.physicalDeviceId) : "";
  if (!/^\d{8}$/.test(deviceId)) return;
  if (!(await storeGet<boolean>(`devnum:used:${deviceId}`, false)) && !(await hasCreditsAccount(deviceId))) return;
  const info = req.body?.deviceInfo || {};
  await noteDevice(deviceId, {
    name: typeof info.name === "string" ? info.name : "",
    model: typeof info.model === "string" ? info.model : "",
    identifier: typeof info.identifier === "string" ? info.identifier : "",
    takiName
  });
}

app.get("/api/credits", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  // Report access status so the app can hard-block a banned/suspended account on
  // launch (full-screen), not just when the user asks something.
  let access: "active" | "suspended" | "banned" = "active";
  let accessMessage = "";
  try {
    const ip = clientIp(req);
    const dev = deviceId.startsWith("apple:") ? undefined : deviceId;
    await recordAssoc(deviceId, dev, ip);
    const acct = await getSafetyAccount(deviceId);
    if (acct.status === "terminated" || (await isBanned(deviceId, dev, ip)) || (await isTestRestricted(deviceId))) { access = "banned"; accessMessage = BANNED_MSG; }
    else if (acct.status === "suspended") { access = "suspended"; accessMessage = SUSPENDED_MSG; }
  } catch (e) { console.error("credits access check:", e); }
  res.json({ ...(await creditSummary(deviceId)), tiers: tierCatalog(), access, accessMessage });
});

/* ---- Web credit top-ups (Stripe Checkout) ------------------------------- */
// Whether web top-ups are available (so the buy page can show/hide itself) + the
// price rules the buyer page mirrors (the server stays authoritative on charge).
app.get("/api/credits/topup-config", (_req, res) => {
  res.json({
    enabled: !!stripe,
    min: CREDIT_TOPUP_MIN,
    max: CREDIT_TOPUP_MAX,
    centsPerCredit: topupCentsPerCredit(false),
    proCentsPerCredit: topupCentsPerCredit(true),
    plans: tierCatalog().filter((plan) => plan.key !== "free")
  });
});

function normalizeTopupIdentity(identity: string): string {
  return identity.replace(/\D/g, "").slice(0, 8);
}

function creditsKeyForIdentity(identity: string): string {
  return `credits:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function hasCreditsAccount(identity: string): Promise<boolean> {
  const acct = await storeGet<any | null>(creditsKeyForIdentity(identity), null);
  return !!acct && acct.deviceId === identity && Number(acct.updatedAt || 0) > 0;
}

type PurchaseAccount = {
  valid: boolean;
  reason?: string;
  publicId: string;
  ledgerIdentity: string;
  isPro: boolean;
  tier: Tier;
  appleSynced: boolean;
  email: string;
  displayName: string;
  devices: string[];
};

function maskedEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}${"•".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
}

function purchaseDeviceLabel(record: Awaited<ReturnType<typeof userForIdentity>>): string {
  const model = String(record.device?.model || "").trim();
  if (model && model !== "iPhone" && model !== "iPad") return model;
  return "";
}

function numberDuplicateDevices(labels: string[]): string[] {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) || 0) + 1);
  return labels.map((label) => {
    const number = (seen.get(label) || 0) + 1;
    seen.set(label, number);
    return (totals.get(label) || 0) > 1 && number > 1 ? `${label} ${number}` : label;
  });
}

function ownerNameFromDeviceName(value: string | undefined): string {
  const match = String(value || "").trim().match(/^(.+?)[’']s\s+(?:iPhone|iPad|Mac)\b/i);
  return match?.[1]?.trim().slice(0, 60) || "";
}

async function validateTopupAccount(identity: string): Promise<PurchaseAccount> {
  const id = normalizeTopupIdentity(identity);
  if (!/^\d{8}$/.test(id)) {
    return { valid: false, reason: "That doesn't look like a valid 8-digit Account ID. You'll find it in the app under Settings → Account ID.", publicId: id, ledgerIdentity: id, isPro: false, tier: "free", appleSynced: false, email: "", displayName: "", devices: [] };
  }
  const issued = await storeGet<boolean>(`devnum:used:${id}`, false);
  const deviceUser = await userForIdentity(id);
  const appleSub = await appleForDevice(id);
  if (!issued && !(await hasCreditsAccount(id)) && !deviceUser.firstSeenAt && !appleSub) {
    return { valid: false, reason: "We couldn't find an account with that ID.", publicId: id, ledgerIdentity: id, isPro: false, tier: "free", appleSynced: false, email: "", displayName: "", devices: [] };
  }
  const ledgerIdentity = appleSub ? `apple:${appleSub}` : id;
  // Warnings/strikes alone do not block payment. Only an active suspension,
  // temporary test restriction, termination, or permanent ban does.
  try {
    const identities = [...new Set([id, ledgerIdentity])];
    const safetyAccounts = await Promise.all(identities.map((value) => getSafetyAccount(value)));
    const temporarilyRestricted = (await Promise.all(identities.map((value) => isTestRestricted(value)))).some(Boolean);
    const restricted = safetyAccounts.some((account) => account.status !== "active")
      || temporarilyRestricted
      || (await isBanned(ledgerIdentity, id));
    if (restricted) {
      return { valid: false, reason: "This account isn't eligible for purchases. If you believe this is a mistake, contact Taki AI Support.", publicId: id, ledgerIdentity, isPro: false, tier: "free", appleSynced: !!appleSub, email: "", displayName: "", devices: [] };
    }
  } catch (e) {
    console.error("topup account safety check:", e);
    return { valid: false, reason: "We couldn't verify that account right now — please try again.", publicId: id, ledgerIdentity, isPro: false, tier: "free", appleSynced: !!appleSub, email: "", displayName: "", devices: [] };
  }
  const deviceIds = appleSub ? await devicesForApple(appleSub) : [id];
  const records = await Promise.all(deviceIds.map((deviceId) => userForIdentity(deviceId)));
  const apple = records.map((record) => record.apple).find((value) => value?.sub === appleSub) || deviceUser.apple;
  const devices = numberDuplicateDevices(records.map(purchaseDeviceLabel).filter(Boolean));
  const takiName = records.map((record) => record.device?.takiName).find(Boolean) || deviceUser.device?.takiName || "";
  const deviceOwnerName = records.map((record) => ownerNameFromDeviceName(record.device?.name)).find(Boolean) || "";
  const summary = await creditSummary(ledgerIdentity);
  return {
    valid: true,
    publicId: id,
    ledgerIdentity,
    isPro: summary.tier === "pro",
    tier: summary.tier,
    appleSynced: !!appleSub,
    email: maskedEmail(apple?.email || ""),
    displayName: (appleSub ? apple?.name : "") || takiName || deviceOwnerName || `Account ${id}`,
    devices: devices.slice(0, 8)
  };
}

const purchaseLookupWindows = new Map<string, { at: number; count: number }>();

// Step 1 of the buy flow: check an Account ID and return a limited confirmation
// summary. Email is masked because an eight-digit ID is not authentication.
app.post("/api/credits/account-check", async (req, res) => {
  const ip = clientIp(req);
  const prior = purchaseLookupWindows.get(ip);
  const windowState = !prior || Date.now() - prior.at > 5 * 60_000 ? { at: Date.now(), count: 0 } : prior;
  if (windowState.count >= 12) { res.status(429).json({ valid: false, reason: "Too many account checks. Try again in a few minutes." }); return; }
  windowState.count += 1;
  purchaseLookupWindows.set(ip, windowState);
  const identity = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  if (!identity) { res.status(400).json({ valid: false, reason: "Enter your Account ID." }); return; }
  const v = await validateTopupAccount(identity);
  res.json({
    valid: v.valid,
    reason: v.reason || "",
    isPro: v.isPro,
    tier: v.tier,
    appleSynced: v.appleSynced,
    email: v.email,
    displayName: v.displayName,
    devices: v.devices,
    min: CREDIT_TOPUP_MIN,
    max: CREDIT_TOPUP_MAX,
    centsPerCredit: topupCentsPerCredit(v.isPro)
  });
});

// Step 2: start a checkout for `credits` credits toward `identity`. Re-validates
// the account and computes the price server-side from the real Pro tier (client-
// sent prices/Pro flags are never trusted).
app.post("/api/credits/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "top-ups are not available yet" }); return; }
  const identity = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  const credits = Math.floor(Number(req.body?.credits));
  if (!identity) { res.status(400).json({ error: "account ID required" }); return; }
  const v = await validateTopupAccount(identity);
  if (!v.valid) { res.status(403).json({ error: v.reason || "This account can't purchase credits." }); return; }
  const cents = topupPriceCents(credits, v.isPro);
  if (cents == null) { res.status(400).json({ error: `Choose between ${CREDIT_TOPUP_MIN.toLocaleString()} and ${CREDIT_TOPUP_MAX.toLocaleString()} credits.` }); return; }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name: `${credits.toLocaleString()} Taki AI credits${v.isPro ? " (Pro price)" : ""}` } } }],
      metadata: { identity: v.ledgerIdentity, publicId: identity, credits: String(credits), purchaseType: "credits" },
      success_url: `${WEB_BASE_URL}/buy?status=success&kind=credits&account=${encodeURIComponent(identity)}`,
      cancel_url: `${WEB_BASE_URL}/buy?status=canceled`
    });
    res.json({ url: session.url, priceUsd: (cents / 100).toFixed(2) });
  } catch (e) {
    console.error("Stripe checkout error:", e);
    res.status(502).json({ error: "could not start checkout" });
  }
});

type WebSubscription = { id: string; identity: string; publicId: string; tier: Tier; active: boolean; updatedAt: number };
const webSubKey = (id: string) => `stripe:subscription:${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const webSubsForIdentityKey = (identity: string) => `stripe:identity-subs:${identity.replace(/[^a-zA-Z0-9_:-]/g, "_")}`;

async function saveWebSubscription(record: WebSubscription): Promise<void> {
  await storeSet(webSubKey(record.id), record);
  const key = webSubsForIdentityKey(record.identity);
  const list = await storeGet<{ ids: string[] }>(key, { ids: [] });
  if (!list.ids.includes(record.id)) { list.ids.push(record.id); await storeSet(key, list); }
}

async function hasOtherActiveWebSubscription(identity: string, excluding: string): Promise<boolean> {
  const list = await storeGet<{ ids: string[] }>(webSubsForIdentityKey(identity), { ids: [] });
  for (const id of list.ids) {
    if (id === excluding) continue;
    const record = await storeGet<WebSubscription | null>(webSubKey(id), null);
    if (record?.active) return true;
  }
  return false;
}

async function retireOtherWebSubscriptions(identity: string, keeping: string): Promise<void> {
  if (!stripe) return;
  const list = await storeGet<{ ids: string[] }>(webSubsForIdentityKey(identity), { ids: [] });
  for (const id of list.ids) {
    if (id === keeping) continue;
    const record = await storeGet<WebSubscription | null>(webSubKey(id), null);
    if (!record?.active) continue;
    try { await stripe.subscriptions.cancel(id); } catch (error) { console.error("retire prior Stripe subscription:", error); }
    record.active = false;
    record.updatedAt = Date.now();
    await storeSet(webSubKey(id), record);
  }
}

async function cancelWebSubscriptionsForDeletion(identity: string): Promise<void> {
  const key = webSubsForIdentityKey(identity);
  const list = await storeGet<{ ids: string[] }>(key, { ids: [] });
  for (const id of list.ids) {
    const record = await storeGet<WebSubscription | null>(webSubKey(id), null);
    if (!record) continue;
    if (record.active) {
      if (!stripe) throw new Error("Stripe is unavailable");
      await stripe.subscriptions.cancel(id);
    }
    record.active = false;
    record.identity = "";
    record.publicId = "";
    record.updatedAt = Date.now();
    await storeSet(webSubKey(id), record);
  }
  await storeDelete(key);
}

app.post("/api/plans/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "subscriptions are not available yet" }); return; }
  const publicId = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  const tier = String(req.body?.tier || "") as Tier;
  if (!(["plus", "plus_voice", "pro"] as string[]).includes(tier)) { res.status(400).json({ error: "choose a valid plan" }); return; }
  const account = await validateTopupAccount(publicId);
  if (!account.valid) { res.status(403).json({ error: account.reason || "This account can't purchase a plan." }); return; }
  const config = TIERS[tier];
  const unitAmount = Math.round(config.priceUsd * 100);
  const metadata = { identity: account.ledgerIdentity, publicId, tier, purchaseType: "plan" };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: unitAmount,
          recurring: { interval: "month" },
          product_data: { name: `Taki AI ${config.label}`, description: `${config.creditsPerCycle.toLocaleString()} credits each month` }
        }
      }],
      metadata,
      subscription_data: { metadata },
      success_url: `${WEB_BASE_URL}/buy?status=plan-success&account=${encodeURIComponent(publicId)}&plan=${encodeURIComponent(tier)}`,
      cancel_url: `${WEB_BASE_URL}/buy?status=canceled`
    });
    res.json({ url: session.url, priceUsd: config.priceUsd.toFixed(2) });
  } catch (e) {
    console.error("Stripe subscription checkout error:", e);
    res.status(502).json({ error: "could not start subscription checkout" });
  }
});

// Stripe webhook — grants credits after a completed payment. Verifies the
// signature against the raw body, and dedupes by session id.
app.post("/api/stripe/webhook", async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) { res.status(503).end(); return; }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent((req as any).rawBody, String(req.headers["stripe-signature"] || ""), STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("Stripe webhook signature error:", (e as Error).message);
    res.status(400).send("bad signature");
    return;
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const identity = s.metadata?.identity || "";
    const purchaseType = s.metadata?.purchaseType || "credits";
    if (purchaseType === "plan") {
      const tier = String(s.metadata?.tier || "") as Tier;
      const subscriptionId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id || "";
      const dedupeKey = `stripe:session:${s.id}`;
      try {
        if (identity && subscriptionId && (["plus", "plus_voice", "pro"] as string[]).includes(tier) && !(await storeGet<boolean>(dedupeKey, false))) {
          await saveWebSubscription({ id: subscriptionId, identity, publicId: s.metadata?.publicId || "", tier, active: true, updatedAt: Date.now() });
          await retireOtherWebSubscriptions(identity, subscriptionId);
          const granted = await grantForTransaction(identity, tier, `stripe:first:${s.id}`);
          await storeSet(dedupeKey, true);
          if (granted.granted) {
            await noteTier(identity, tier, "stripe_subscription");
            await noteRevenue(identity, { at: Date.now(), kind: "web_subscription", amountUsd: (s.amount_total || TIERS[tier].priceUsd * 100) / 100, credits: TIERS[tier].creditsPerCycle, tier });
          }
        }
      } catch (e) { console.error("Stripe subscription grant error:", e); }
      res.json({ received: true });
      return;
    }
    const credits = parseInt(s.metadata?.credits || "0", 10);
    const dedupeKey = `stripe:session:${s.id}`;
    try {
      if (identity && credits > 0 && s.payment_status === "paid" && !(await storeGet<boolean>(dedupeKey, false))) {
        await grantCredits(identity, credits, "web_topup");
        await storeSet(dedupeKey, true);
        await noteRevenue(identity, { at: Date.now(), kind: "topup", amountUsd: (s.amount_total || 0) / 100, credits });
      }
    } catch (e) {
      console.error("Stripe grant error:", e);
    }
  }
  if (event.type === "invoice.paid") {
    const invoice: any = event.data.object;
    const billingReason = String(invoice.billing_reason || "");
    if (billingReason !== "subscription_create") {
      const rawSub = invoice.subscription || invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof rawSub === "string" ? rawSub : rawSub?.id || "";
      const dedupeKey = `stripe:invoice:${invoice.id}`;
      try {
        const record = subscriptionId ? await storeGet<WebSubscription | null>(webSubKey(subscriptionId), null) : null;
        if (record?.active && !(await storeGet<boolean>(dedupeKey, false))) {
          const granted = await grantForTransaction(record.identity, record.tier, `stripe:renewal:${invoice.id}`);
          await storeSet(dedupeKey, true);
          if (granted.granted) {
            await noteTier(record.identity, record.tier, "stripe_renewal");
            await noteRevenue(record.identity, { at: Date.now(), kind: "web_subscription", amountUsd: Number(invoice.amount_paid || 0) / 100, credits: TIERS[record.tier].creditsPerCycle, tier: record.tier });
          }
        }
      } catch (e) { console.error("Stripe renewal grant error:", e); }
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription: any = event.data.object;
    const record = await storeGet<WebSubscription | null>(webSubKey(String(subscription.id || "")), null);
    if (record) {
      record.active = false;
      record.updatedAt = Date.now();
      await storeSet(webSubKey(record.id), record);
      if (!(await hasOtherActiveWebSubscription(record.identity, record.id)) && !(await primarySubscriptionForIdentity(record.identity))) {
        await downgradeToFree(record.identity);
        await noteTier(record.identity, "free", "stripe_subscription_ended");
      }
    }
  }
  res.json({ received: true });
});

/* ---- Email inbox integration (Gmail + Outlook OAuth) -------------------- */
// Start the OAuth flow for a provider: returns the consent URL the app opens in
// the system browser. State carries the device identity so the callback can
// store the connection against it.
app.get("/api/email/connect", async (req, res) => {
  const provider = String(req.query.provider || "").toLowerCase() as EmailProvider;
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  if (provider !== "gmail" && provider !== "outlook") { res.status(400).json({ error: "provider must be gmail or outlook" }); return; }
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  if (!emailProviderConfigured(provider)) { res.status(503).json({ error: `${provider} isn't configured yet` }); return; }
  const state = await createOAuthState(deviceId, provider);
  const url = buildAuthUrl(provider, state);
  if (!url) { res.status(503).json({ error: "could not build auth URL" }); return; }
  res.json({ url });
});

// OAuth redirect target (must match the provider's registered redirect URI).
// Exchanges the code, stores the connection, then bounces the browser back to
// the app via the takiai:// deep link.
app.get("/api/email/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const err = typeof req.query.error === "string" ? req.query.error : "";
  const page = (title: string, body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#07070e;color:#ececf6;font:16px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}a{display:inline-block;margin-top:20px;padding:13px 22px;border-radius:12px;background:linear-gradient(120deg,#8b5cf6,#4b8cff);color:#fff;text-decoration:none;font-weight:700}h1{font-size:22px;margin:0 0 8px}p{color:#9a9ab6;max-width:340px}</style></head><body><div><h1>${title}</h1><p>${body}</p><a href="takiai://email-connected">Return to Taki AI</a></div><script>setTimeout(function(){location.href="takiai://email-connected"},900)</script></body></html>`;
  if (err || !code || !state) {
    res.status(400).send(page("Couldn't connect", "The sign-in was cancelled or failed. You can try again from Settings → Email."));
    return;
  }
  try {
    const done = await completeOAuth(code, state);
    if (!done) { res.status(400).send(page("Couldn't connect", "That sign-in link expired or was invalid. Please try again from the app.")); return; }
    res.send(page("Email connected 🎉", `${done.email || "Your account"} is now linked to Taki AI. You can head back to the app.`));
  } catch (e) {
    console.error("email callback:", e);
    res.status(500).send(page("Something went wrong", "Please try connecting again from Settings → Email."));
  }
});

// Whether this device has a connected inbox (for Settings + polling after OAuth).
app.get("/api/email/status", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  const conn = await loadConnection(deviceId);
  res.json({
    connected: !!(conn && conn.refreshToken),
    provider: conn?.provider || null,
    email: conn?.email || "",
    gmailAvailable: emailProviderConfigured("gmail"),
    outlookAvailable: emailProviderConfigured("outlook")
  });
});

app.get("/api/email/search", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!deviceId || !query) { res.status(400).json({ error: "deviceId and q required" }); return; }
  try {
    res.json(await searchConnectedEmail(deviceId, query, 5));
  } catch (error) {
    console.error("email search:", error);
    res.status(502).json({ connected: true, messages: [], error: "email search unavailable" });
  }
});

app.post("/api/email/disconnect", async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  await disconnectEmail(deviceId);
  res.json({ connected: false });
});

// Send an email from the connected account (device already resolved the address
// and the user confirmed). Body: {deviceId, to, subject, body}.
app.post("/api/email/send", async (req, res) => {
  const b = req.body || {};
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const to = typeof b.to === "string" ? b.to.trim() : "";
  const subject = typeof b.subject === "string" ? b.subject.slice(0, 300) : "";
  const body = typeof b.body === "string" ? b.body.slice(0, 20000) : "";
  if (!deviceId || !to || !body) { res.status(400).json({ ok: false, error: "deviceId, to, and body are required" }); return; }
  const gate = await safetyGate(deviceId, `${subject}\n${body}`, req);
  if (gate) { res.status(403).json({ ok: false, error: "blocked" }); return; }
  const asDraft = b.draft === true;
  const r = asDraft
    ? await saveDraft(deviceId, to, subject || "(no subject)", body)
    : await sendEmail(deviceId, to, subject || "(no subject)", body);
  if (!r.ok && (r.error === "not_connected" || r.error === "auth")) {
    res.status(409).json({ ok: false, error: "reconnect", message: "Reconnect your email in Settings to enable sending." });
    return;
  }
  res.json(r);
});

// The dev grant stub that simulated purchases was REMOVED once real StoreKit
// IAP shipped — subscriptions now grant exclusively through /api/iap/verify
// (cryptographically verified transactions), so there is no secret-guarded
// free-credits path left in production.

/* ---- Apple In-App Purchase (StoreKit 2) --------------------------------- */
// The device sends its verified signed transaction(s) (JWS). We read the product,
// map it to a tier, and grant that cycle's credits to the caller's identity
// (device id, or the Apple account id when signed in). Idempotent per billing
// period, so relaunch/restore won't double-grant.
app.post("/api/iap/verify", async (req, res) => {
  const b = req.body || {};
  const identity = typeof b.identity === "string" ? b.identity.trim() : (typeof b.deviceId === "string" ? b.deviceId.trim() : "");
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const jwsList: string[] = Array.isArray(b.transactions)
    ? b.transactions.filter((t: unknown) => typeof t === "string")
    : (typeof b.transaction === "string" ? [b.transaction] : []);
  if (jwsList.length === 0) { res.status(400).json({ error: "transaction(s) required" }); return; }

  let tier: Tier | null = null;
  let anyGranted = false;
  for (const jws of jwsList) {
    const info = await verifyTransaction(jws);
    if (!info) continue;
    // Remember who owns this subscription so server notifications (renewals,
    // refunds) can find the right ledger later.
    await linkTransactionIdentity(info.originalTransactionId, identity);
    // Skip clearly-expired auto-renewables (a stale entitlement).
    if (info.expiresDate && info.expiresDate < Date.now()) continue;
    const role = identity.startsWith("apple:")
      ? await claimPrimarySubscription(identity, info.originalTransactionId)
      : "primary";
    if (role === "secondary") {
      tier = (await creditSummary(identity)).tier;
      continue;
    }
    const r = await grantForTransaction(identity, info.tier, info.periodKey);
    if (r.granted) {
      // Analytics: record the plan + gross revenue for this billing period.
      await noteTier(identity, info.tier, "subscription");
      const conf = TIERS[info.tier];
      if (conf) await noteRevenue(identity, { at: Date.now(), kind: "subscription", amountUsd: conf.priceUsd, credits: conf.creditsPerCycle, tier: info.tier });
    }
    anyGranted = anyGranted || r.granted;
    tier = r.summary.tier;
  }
  if (!tier) { res.status(400).json({ error: "no valid subscription transaction" }); return; }
  res.json({ ...(await creditSummary(identity)), granted: anyGranted });
});

/* ---- Sign in with Apple (optional account) ------------------------------ */
// Verify the identity token, derive the stable Apple account id, and merge the
// device's existing credits into that account so they follow the user across
// devices. Returns the account identity the app should use from now on.
app.post("/api/account/apple", async (req, res) => {
  const b = req.body || {};
  const idToken = typeof b.identityToken === "string" ? b.identityToken : "";
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const identdata = await verifyAppleIdentityToken(idToken);
  if (!identdata) { res.status(401).json({ error: "invalid Apple identity token" }); return; }
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
  const hasEntitlementSnapshot = Array.isArray(b.transactions);
  const entitlementJWS: string[] = hasEntitlementSnapshot
    ? b.transactions.filter((value: unknown) => typeof value === "string")
    : [];
  const accountId = `apple:${identdata.sub}`;
  let duplicateSubscriptionNeedsCancellation = false;
  try {
    await linkApple(identdata.sub, deviceId);
    await noteApple(deviceId, { sub: identdata.sub, email: identdata.email, name: fullName || undefined });
    await noteUser(deviceId, clientIp(req), String(req.headers?.["user-agent"] || ""));
    const activeTransactionIds: string[] = [];
    for (const jws of entitlementJWS) {
      const info = await verifyTransaction(jws);
      if (!info || (info.expiresDate && info.expiresDate < Date.now())) continue;
      activeTransactionIds.push(info.originalTransactionId);
      await linkTransactionIdentity(info.originalTransactionId, deviceId);
      await grantForTransaction(deviceId, info.tier, info.periodKey);
    }
    const deviceTransactions = hasEntitlementSnapshot
      ? [...new Set(activeTransactionIds)]
      : await transactionIdsForIdentity(deviceId);
    if (hasEntitlementSnapshot) {
      const historicalTransactions = await transactionIdsForIdentity(deviceId);
      for (const transactionId of historicalTransactions) {
        if (!deviceTransactions.includes(transactionId)) await clearRetiredSubscription(accountId, transactionId);
      }
    }
    let primary = await primarySubscriptionForIdentity(accountId);
    let subscriptionMode: "keep" | "convert" | "discard" = "keep";
    let secondaryTransactionId = "";

    if (!primary && deviceTransactions.length) {
      primary = deviceTransactions[0];
      await claimPrimarySubscription(accountId, primary);
    } else {
      const decision = subscriptionMergeDecision(primary, deviceTransactions);
      subscriptionMode = decision.mode;
      secondaryTransactionId = decision.secondaryTransactionId;
      duplicateSubscriptionNeedsCancellation = decision.mode === "convert";
    }

    await mergeCredits(deviceId, accountId, { subscriptionMode, secondaryTransactionId });
    for (const transactionId of deviceTransactions) {
      const role = transactionId === primary ? "primary" : "secondary";
      await setTransactionRole(transactionId, accountId, role);
    }
  } catch (e) { console.error("apple link:", e); }
  const linkedDevices = (await devicesForApple(identdata.sub)).filter((d) => d !== deviceId);
  res.json({ accountId, deviceId, email: identdata.email, linkedDevices, duplicateSubscriptionNeedsCancellation, ...(await creditSummary(accountId)), tiers: tierCatalog() });
});

app.post("/api/account/delete", async (req, res) => {
  const identityToken = typeof req.body?.identityToken === "string" ? req.body.identityToken : "";
  const authorizationCode = typeof req.body?.authorizationCode === "string" ? req.body.authorizationCode : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const expectedAccountId = typeof req.body?.expectedAccountId === "string" ? req.body.expectedAccountId.trim() : "";
  const apple = await verifyAppleIdentityToken(identityToken);
  if (!apple || !authorizationCode) { res.status(401).json({ error: "Apple reauthentication required" }); return; }
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }

  const accountId = `apple:${apple.sub}`;
  if (!expectedAccountId || expectedAccountId !== accountId) {
    res.status(403).json({ error: "The confirmed Apple account does not match this Taki account" });
    return;
  }
  const linkedDevices = await devicesForApple(apple.sub);
  if (!linkedDevices.includes(deviceId)) {
    res.status(403).json({ error: "This device is not linked to that Taki account" });
    return;
  }
  if (!(await revokeAppleAuthorizationCode(authorizationCode))) {
    res.status(503).json({ error: "Apple could not verify the deletion. Please try again." });
    return;
  }

  try {
    for (const identity of [accountId, ...linkedDevices]) {
      await cancelWebSubscriptionsForDeletion(identity);
    }
    const deleted = await purgeAppleAccount(apple.sub);
    res.json({ ok: true, deleted });
  } catch (error) {
    console.error("Account deletion failed:", error);
    res.status(502).json({ error: "The account could not be completely deleted. Please contact Taki AI Support." });
  }
});

// App Store Server Notifications V2 — Apple POSTs {signedPayload} on renewals,
// refunds, cancellations, expirations, etc. We verify it, find the owning
// identity (by originalTransactionId), and update credits/tier automatically.
// Set this URL in App Store Connect (Production + Sandbox). Always 200 on a
// verified notification so Apple doesn't retry a handled one.
app.post("/api/iap/notifications", async (req, res) => {
  const signedPayload = typeof req.body?.signedPayload === "string" ? req.body.signedPayload : "";
  if (!signedPayload) { res.status(400).json({ error: "signedPayload required" }); return; }
  const note = await verifyNotification(signedPayload);
  if (!note) { res.status(400).json({ error: "invalid notification" }); return; }
  try {
    const tx = note.tx;
    if (tx) {
      const binding = await getTransactionBinding(tx.originalTransactionId);
      const identity = binding.identity;
      if (identity) {
        const t = note.notificationType;
        if (binding.role === "secondary") {
          if (t === "REFUND" || t === "REVOKE") {
            await revokeMergedSubscriptionCredits(identity, tx.originalTransactionId);
          } else if (t === "EXPIRED" || t === "GRACE_PERIOD_EXPIRED") {
            await clearRetiredSubscription(identity, tx.originalTransactionId);
          }
        } else if (t === "SUBSCRIBED" || t === "DID_RENEW" || t === "OFFER_REDEEMED") {
          await grantForTransaction(identity, tx.tier, tx.periodKey);
        } else if (t === "REFUND" || t === "REVOKE") {
          await revokeSubscription(identity);
        } else if (t === "EXPIRED" || t === "GRACE_PERIOD_EXPIRED") {
          await downgradeToFree(identity);
        }
        // Other types (DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW grace, TEST,
        // etc.) need no ledger change.
      } else {
        console.warn("IAP notification: no identity mapped for", tx.originalTransactionId, note.notificationType);
      }
    }
  } catch (e) {
    console.error("IAP notification handling error:", e);
  }
  res.status(200).json({ ok: true });
});

// User feedback on an answer / composed message / the app. Stored durably so the
// owner can review what people flag. kind = "answer" | "message" | "app" | "report".
app.post("/api/feedback", async (req, res) => {
  const b = req.body || {};
  const entry = {
    at: Date.now(),
    deviceId: typeof b.deviceId === "string" ? b.deviceId.slice(0, 64) : "",
    kind: typeof b.kind === "string" ? b.kind.slice(0, 20) : "answer",
    rating: b.rating === "up" || b.rating === "down" ? b.rating : null,
    note: typeof b.note === "string" ? b.note.slice(0, 1000) : "",
    message: typeof b.message === "string" ? b.message.slice(0, 500) : "",
    answer: typeof b.answer === "string" ? b.answer.slice(0, 1000) : "",
    category: typeof b.category === "string" ? b.category.slice(0, 100) : "",
    reportMessageId: typeof b.reportMessageId === "string" ? b.reportMessageId.slice(0, 100) : "",
    chatId: typeof b.chatId === "string" ? b.chatId.slice(0, 100) : "",
    chatTranscript: b.consent === true && typeof b.chatTranscript === "string" ? b.chatTranscript.slice(0, 20000) : "",
    consent: b.consent === true
  };
  try {
    const list = await storeGet<any[]>("feedback", []);
    list.push(entry);
    await storeSet("feedback", list.slice(-500)); // keep the most recent 500
  } catch (e) {
    console.error("Feedback store error:", e);
  }
  res.json({ ok: true });
});

// Dev: reset a device's credits.
app.post("/api/credits/reset", async (req, res) => {
  const b = req.body || {};
  if (!isAdminAuthorized(b.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  await resetCredits(deviceId);
  res.json({ ok: true });
});

/* ---- Safety review + enforcement (ADMIN_SECRET) ------------------------- */
// The human-review queue: every currently-suspended account and the retained
// flagged messages that triggered it (the only point that content is visible).
app.post("/api/admin/flagged", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  res.json({ queue: await reviewQueue() });
});

// Reinstate a suspended account (clears strikes + retained flagged messages).
app.post("/api/admin/reinstate", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  await reinstate(identity);
  res.json({ ok: true, identity, status: "active" });
});

// Read-only preview of the exact permanent-ban cascade.
app.post("/api/admin/terminate-preview", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  res.json({ ok: true, identity, impact: await previewTermination(identity) });
});

// Temporary identity-only restriction for safely testing the blocked app state.
app.post("/api/admin/test-restrict", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const restriction = await setTestRestriction(identity, Number(req.body?.minutes) || 5);
  res.json({ ok: true, identity, testOnly: true, expiresAt: restriction.expiresAt });
});

app.post("/api/admin/test-restrict-clear", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  await clearTestRestriction(identity);
  res.json({ ok: true, identity, testOnly: true, cleared: true });
});

// Terminate + permanently ban the identity, its devices/IPs, and any other
// identities seen on the same device(s). No appeal.
app.post("/api/admin/terminate", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const banned = await terminateAndBan(identity);
  res.json({ ok: true, identity, status: "terminated", banned });
});

// Remove a user from the dashboard registry (e.g. test accounts).
app.post("/api/admin/delete-user", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  await deleteUser(identity);
  res.json({ ok: true, identity, deleted: true });
});

// Full admin dashboard feed: every user + plan/history, IPs, device, credit
// usage, cost-to-serve, revenue, profit, safety status, Apple identity, and the
// other identities seen on their IP(s).
app.post("/api/admin/users", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const users = await allUsers();
  const rows = await Promise.all(users.map(async (u) => {
    const acct = await getSafetyAccount(u.identity);
    const summary = await creditSummary(u.identity);
    const costUsd = Math.round(u.creditsUsed * CREDIT_USD * 100) / 100;
    // Net revenue estimate (subscriptions ≈ 85% after Apple; top-ups ≈ Stripe fee).
    let netUsd = 0;
    for (const p of u.purchases) netUsd += p.kind === "topup" || p.kind === "web_subscription"
      ? Math.max(0, p.amountUsd * 0.971 - 0.30)
      : p.amountUsd * 0.85;
    netUsd = Math.round(netUsd * 100) / 100;
    const neighbors = new Set<string>();
    for (const ip of u.ips) for (const i of await identitiesForIp(ip)) if (i !== u.identity) neighbors.add(i);
    // Other device numbers signed into the same Apple account.
    const linkedDevices = u.apple?.sub ? (await devicesForApple(u.apple.sub)).filter((d) => d !== u.identity) : [];
    return {
      ...u,
      balance: summary.balance,
      status: acct.status,
      strikes: acct.strikes,
      costUsd,
      grossRevenueUsd: u.revenueUsd,
      netRevenueUsd: netUsd,
      profitUsd: Math.round((netUsd - costUsd) * 100) / 100,
      ipNeighbors: Array.from(neighbors),
      linkedDevices
    };
  }));
  // Totals for the header.
  const totals = rows.reduce((t, r) => ({
    users: t.users + 1,
    gross: t.gross + r.grossRevenueUsd,
    net: t.net + r.netRevenueUsd,
    cost: t.cost + r.costUsd,
    profit: t.profit + r.profitUsd
  }), { users: 0, gross: 0, net: 0, cost: 0, profit: 0 });
  res.json({ users: rows, totals });
});

// Travel time for the commute Live Activity, by mode (driving w/ traffic,
// walking, bicycling, transit) via Google Directions. 502 if no key/route so
// the device can fall back to MapKit for driving/walking.
app.post("/api/travel-time", async (req, res) => {
  const fromLat = Number(req.body?.fromLat);
  const fromLon = Number(req.body?.fromLon);
  const toLat = Number(req.body?.toLat);
  const toLon = Number(req.body?.toLon);
  const mode = typeof req.body?.mode === "string" ? req.body.mode : "driving";
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) {
    res.status(400).json({ error: "from/to coordinates required" });
    return;
  }
  try {
    const result = await withTimeout(getTravelTime(fromLat, fromLon, toLat, toLon, mode), 11000, "Travel time");
    if (!result) {
      res.status(502).json({ error: "travel time unavailable" });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error("Travel time error:", error);
    res.status(502).json({ error: "travel time unavailable" });
  }
});

// Best-effort client IP (Render sits behind a proxy → prefer X-Forwarded-For).
function clientIp(req: any): string {
  const xf = String(req.headers?.["x-forwarded-for"] || "");
  return (xf.split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "unknown");
}

// Safety gate: records the identity↔device↔IP association, blocks banned or
// suspended accounts, and flags (and retains) messages that solicit clearly
// illegal/harmful content — auto-suspending at the strike limit for human review.
// Returns a result when the request must be stopped, else null. `block` is set
// only for banned/suspended accounts (→ the app hard-blocks full-screen); a plain
// message (no `block`) is a normal refusal (e.g. prompt-extraction).
type GateResult = { message: string; block?: "banned" | "suspended" };
async function safetyGate(identity: string, message: string, req: any, voiceMode = false): Promise<GateResult | null> {
  // Prompt-extraction is refused for EVERYONE (even legacy clients with no id).
  const isExtraction = looksLikePromptExtraction(message);
  const extractionMessage = promptExtractionMessageForMode(voiceMode);
  if (!identity) return isExtraction ? { message: extractionMessage } : null;
  const ip = clientIp(req);
  const dev = identity.startsWith("apple:") ? undefined : identity;
  try {
    await recordAssoc(identity, dev, ip);
    await noteUser(identity, ip, String(req.headers?.["user-agent"] || ""));
    if ((await isBanned(identity, dev, ip)) || (await isTestRestricted(identity))) return { message: BANNED_MSG, block: "banned" };
    const acct = await getSafetyAccount(identity);
    if (acct.status !== "active") return { message: SUSPENDED_MSG, block: "suspended" };
    // Prompt/instruction extraction: never help, break character with a fixed
    // reply, and count a strike (repeated attempts → suspension = "restriction").
    if (isExtraction) {
      const a = await recordViolation(identity, { text: String(message).slice(0, 2000), category: "prompt_extraction", at: Date.now(), ip, deviceId: dev });
      return a.status !== "active" ? { message: SUSPENDED_MSG, block: "suspended" } : { message: extractionMessage };
    }
    const category = classifyHarm(message);
    if (category) {
      const a = await recordViolation(identity, { text: String(message).slice(0, 2000), category, at: Date.now(), ip, deviceId: dev });
      if (a.status !== "active") return { message: SUSPENDED_MSG, block: "suspended" };
    }
  } catch (e) {
    console.error("safetyGate error:", e);
  }
  return null;
}

// The shared assistant core: credit gate → plan → finalize → style → meter.
// Returns the JSON payload (finalized response + credits). Used by both
// /api/assistant and /api/voice (which passes voiceMode=true).
async function runAssistant(
  state: ReturnType<typeof buildConversationState>,
  deviceId: string,
  voiceMode: boolean,
  supportsDeferredActionSynthesis = false,
  voiceInputUsd = 0
): Promise<any> {
  let tier: Tier = "free";
  let baseCredits = 0;     // remaining base-subscription credits (for free-voice check)
  let voiceCycleUsed = 0;  // free voice turns used this cycle
  let usageSummary: Awaited<ReturnType<typeof creditSummary>> | null = null;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    usageSummary = sum;
    tier = sum.tier;
    baseCredits = sum.baseCredits;
    voiceCycleUsed = sum.voiceCycleUsed;
    // Cut users off BEFORE they hit 0 — they need at least a standard request's
    // worth of credits to ask anything.
    const usageMessage = usageLimitMessage(sum);
    if (sum.balance < MIN_REQUEST_CREDITS || usageMessage) {
      return {
        ...finalizeResponse({ spokenText: usageMessage || OUT_OF_CREDITS_MSG, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
        credits: { ...sum, cost: 0, outOfCredits: !usageMessage, limitReached: !!usageMessage }
      };
    }
  }
  const measured = await measureUsage(async () => {
    const plan = await withTimeout(planAssistantResponse(state), 45000, "Assistant plan");
    const response = finalizeResponse(plan, state);
    // Voice action confirmations already come from the capability-aware planner.
    if (!voiceMode && response.spokenText && (response.action || response.memory?.pendingClarification)) {
      response.spokenText = await styleInCharacter(response.spokenText, state.userProfile, voiceMode);
    }
    if (voiceMode && response.spokenText) {
      response.spokenText = await fitVoiceResponse(response.spokenText, state.userProfile);
    }
    return response;
  });
  const finalized = measured.value;
  const hasActions = !!finalized.action || (Array.isArray(finalized.actions) && finalized.actions.length > 0);
  const deferVoiceSynthesis = voiceMode && supportsDeferredActionSynthesis && hasActions && !!deviceId;
  if (deviceId) {
    let usageUsd = totalUsageUsd(measured.usage);
    // Voice: free within the per-cycle allowance on Plus Voice / Pro (base credits
    // only); beyond that, or on top-ups / other tiers, pay per spoken character.
    let voiceSynthesisIncluded = false;
    if (voiceMode) {
      voiceSynthesisIncluded = isFreeVoice(tier, baseCredits, voiceCycleUsed);
      if (voiceSynthesisIncluded) await noteFreeVoice(deviceId);
      else {
        usageUsd += Math.max(0, voiceInputUsd);
        if (!deferVoiceSynthesis) usageUsd += ttsCostUsd(speechCharacterCount(finalized.spokenText || ""));
      }
    }
    const limitReason = usageLimitForCost(usageSummary, Math.ceil(usageUsd / CREDIT_USD));
    if (limitReason) {
      const spokenText = usageMessageForReason(limitReason);
      return {
        ...finalizeResponse({ spokenText, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
        credits: { ...usageSummary, cost: 0 }
      };
    }
    const s = await spendUsageUsd(deviceId, usageUsd);
    await noteSpend(deviceId, s.spent);
    const deferredVoiceSynthesisToken = deferVoiceSynthesis
      ? createVoiceSynthesisToken(deviceId, voiceSynthesisIncluded)
      : undefined;
    return {
      ...finalized,
      ...(deferVoiceSynthesis ? { deferVoiceSynthesis: true, deferredVoiceSynthesisToken } : {}),
      credits: { ...s, cost: s.spent }
    };
  }
  return finalized;
}

app.post("/api/assistant", async (req, res) => {
  const userMessage = String(req.body?.message || "");
  const rawContext = typeof req.body?.context === "string" ? req.body.context : "";
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  // Credits metering: only when the app identifies itself (older builds without a
  // deviceId are unmetered so they keep working).
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  // Privacy: only the style vectors for recipients named in this message arrive
  // here — never a contact list or message history.
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  // Personalization lives on-device. The account-confirmation name is the only
  // profile field retained, and only because the user opted to show it on /buy.
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  await captureRequestDeviceInfo(req, userProfile.name);

  const state = buildConversationState(userMessage, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, voiceMode, deviceId);

  const gate = await safetyGate(deviceId, userMessage, req, voiceMode);
  if (gate) {
    res.json({
      ...finalizeResponse({ spokenText: gate.message, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
      ...(gate.block ? { blocked: true, access: gate.block, accessMessage: gate.message } : {})
    });
    return;
  }

  try {
    res.json(await runAssistant(state, deviceId, voiceMode));
  } catch (error) {
    console.error("Assistant route error:", error);
    // Last resort: a plain answer that still respects the wire shape.
    try {
      const measured = await measureUsage(() => getGeneralAnswer(state));
      const general = measured.value;
      await chargeMeasuredUsage(deviceId, measured.usage);
      res.json(
        finalizeResponse(
          { spokenText: general.text, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false },
          state
        )
      );
    } catch {
      res.json({
        spokenText: "I had trouble thinking through that. Try saying it a little more simply.",
        action: null,
        memory: state.priorMemory,
        followUpEvent: state.priorMemory.lastMentionedEvent || null
      });
    }
  }
});

// Voice mode: a recorded clip in, the spoken answer (audio) out. Transcribe via
// ElevenLabs → the normal assistant brain (voiceMode=true so the credits voice
// surcharge applies) → synthesize the reply. The device still executes the
// returned action; only the extra STT/TTS is voice-specific.
app.post("/api/voice", async (req, res) => {
  if (!isVoiceConfigured()) { res.status(503).json({ error: "voice not configured (set ELEVENLABS_API_KEY)" }); return; }
  const audioBase64 = typeof req.body?.audioBase64 === "string" ? req.body.audioBase64 : "";
  if (audioBase64.length > 3_000_000) { res.status(413).json({ error: "voice recording too large" }); return; }
  const deviceTranscript = typeof req.body?.transcript === "string" ? req.body.transcript.trim().slice(0, 4000) : "";
  const audioDurationMs = billableAudioDurationMs(audioBase64, req.body?.audioDurationMs);
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "audio/m4a";
  const rawContext = typeof req.body?.context === "string" ? req.body.context : "";
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  const voiceVariability = typeof req.body?.voiceVariability === "number"
    ? Math.max(0, Math.min(1, req.body.voiceVariability))
    : 0.5;
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  await captureRequestDeviceInfo(req, userProfile.name);
  if (!audioBase64 && !deviceTranscript) { res.status(400).json({ error: "audioBase64 or transcript required" }); return; }

  // Free tier: hard cap of voice questions regardless of credits.
  let freeTier = false;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    freeTier = sum.tier === "free";
    const usageMessage = usageLimitMessage(sum);
    if (sum.balance < MIN_REQUEST_CREDITS || usageMessage) {
      res.json({
        transcript: "", spokenText: usageMessage || OUT_OF_CREDITS_MSG,
        action: null, actions: null, audioBase64: "", mime: "audio/mpeg",
        credits: { ...sum, cost: 0, outOfCredits: !usageMessage, limitReached: !!usageMessage }
      });
      return;
    }
    if (freeTier && sum.voiceUsed >= FREE_VOICE_LIMIT) {
      res.json({ transcript: "", spokenText: FREE_VOICE_LIMIT_MSG, action: null, actions: null, audioBase64: "", mime: "audio/mpeg", voiceLimitReached: true, voiceUsed: sum.voiceUsed });
      return;
    }
  }

  try {
    // Prefer Apple's on-device transcription when the phone supplied one. This
    // removes an entire sequential cloud STT request from normal voice turns;
    // audio remains the fallback for unsupported devices or uncertain results.
    const usedCloudTranscription = !deviceTranscript;
    const transcript = deviceTranscript || await transcribe(audioBase64, mime);
    if (!transcript) {
      // Nothing intelligible (silence) — let the device re-listen or end.
      res.json({ transcript: "", spokenText: "", action: null, actions: null, empty: true });
      return;
    }
    const gate = await safetyGate(deviceId, transcript, req, true);
    if (gate) {
      let audio = "";
      try { audio = await synthesize(gate.message, voiceId, voiceVariability); } catch { /* text still returns if TTS is temporarily unavailable */ }
      res.json({ transcript, spokenText: gate.message, action: null, actions: null, audioBase64: audio, mime: "audio/mpeg", blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) });
      return;
    }
    // Count this voice question toward the free-tier cap.
    let voiceUsed: number | undefined;
    if (freeTier && deviceId) voiceUsed = await noteVoiceQuestion(deviceId);
    const state = buildConversationState(transcript, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, true, deviceId);
    const result = await runAssistant(
      state,
      deviceId,
      true,
      req.body?.deferredActionSynthesis === true,
      usedCloudTranscription ? sttCostUsd(audioDurationMs) : 0
    );
    const audio = result.deferVoiceSynthesis
      ? ""
      : await synthesize(result.spokenText || "", voiceId, voiceVariability);
    res.json({ ...result, transcript, transcriptionSource: deviceTranscript ? "device" : "cloud", audioBase64: audio, mime: "audio/mpeg", voiceUsed });
  } catch (error) {
    console.error("Voice route error:", error);
    res.status(502).json({ error: "voice unavailable" });
  }
});

const memoryExtractWindows = new Map<string, { startedAt: number; count: number }>();
app.post("/api/memory/extract", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 2000) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  const ip = clientIp(req);
  if ((await isBanned(deviceId, deviceId, ip)) || (await isTestRestricted(deviceId))) {
    res.status(403).json({ error: "access restricted" }); return;
  }
  const now = Date.now();
  const rateKey = `${deviceId}:${ip}`;
  const prior = memoryExtractWindows.get(rateKey);
  const windowState = !prior || now - prior.startedAt >= 60_000 ? { startedAt: now, count: 0 } : prior;
  if (windowState.count >= 10) { res.status(429).json({ error: "memory extraction limit reached" }); return; }
  windowState.count += 1;
  memoryExtractWindows.set(rateKey, windowState);
  const currentFacts = Array.isArray(req.body?.currentFacts) ? req.body.currentFacts : [];
  const measured = await measureUsage(() => extractDurableMemories(message, currentFacts, req.body?.teen === true));
  await chargeMeasuredUsage(deviceId, measured.usage);
  res.json(measured.value);
});

app.post("/api/chat/title", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1200) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  const ip = clientIp(req);
  if ((await isBanned(deviceId, deviceId, ip)) || (await isTestRestricted(deviceId))) {
    res.status(403).json({ error: "access restricted" }); return;
  }
  const rateKey = `title:${deviceId}:${ip}`;
  const now = Date.now();
  const prior = memoryExtractWindows.get(rateKey);
  const windowState = !prior || now - prior.startedAt >= 60_000 ? { startedAt: now, count: 0 } : prior;
  if (windowState.count >= 6) { res.status(429).json({ error: "chat title limit reached" }); return; }
  windowState.count += 1;
  memoryExtractWindows.set(rateKey, windowState);
  const measured = await measureUsage(() => createChatTitle(message, req.body?.teen === true));
  await chargeMeasuredUsage(deviceId, measured.usage);
  res.json({ title: measured.value });
});

// The account's available voices, for the app's voice picker.
app.get("/api/voices", async (_req, res) => {
  res.json({ voices: await listVoices() });
});

// Re-synthesize a corrected voice result after the phone attempts an action.
// Used when native execution returns a more accurate success line or an error.
const correctionSynthWindows = new Map<string, { startedAt: number; count: number }>();
app.post("/api/voice/synthesize", async (req, res) => {
  if (!isVoiceConfigured()) { res.status(503).json({ error: "voice not configured" }); return; }
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 140) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  const deferredToken = typeof req.body?.deferredVoiceSynthesisToken === "string"
    ? req.body.deferredVoiceSynthesisToken.trim()
    : "";
  const variability = typeof req.body?.voiceVariability === "number"
    ? Math.max(0, Math.min(1, req.body.voiceVariability))
    : 0.5;
  if (!text || !deviceId) { res.status(400).json({ error: "text and deviceId required" }); return; }
  try {
    const ip = clientIp(req);
    if ((await isBanned(deviceId, deviceId, ip)) || (await isTestRestricted(deviceId))) {
      res.status(403).json({ error: "access restricted" }); return;
    }
    const now = Date.now();
    const rateKey = `${deviceId}:${ip}`;
    const prior = correctionSynthWindows.get(rateKey);
    const windowState = !prior || now - prior.startedAt >= 60_000
      ? { startedAt: now, count: 0 }
      : prior;
    if (windowState.count >= 12) { res.status(429).json({ error: "voice correction limit reached" }); return; }
    windowState.count += 1;
    correctionSynthWindows.set(rateKey, windowState);
    if (correctionSynthWindows.size > 5_000) {
      for (const [key, value] of correctionSynthWindows) {
        if (now - value.startedAt >= 60_000) correctionSynthWindows.delete(key);
      }
    }
    const pending = deferredToken ? takeVoiceSynthesisToken(deferredToken, deviceId) : null;
    const account = await creditSummary(deviceId);
    const correctionIsIncluded = pending?.included === true || (!pending && account.baseCredits > 0
      && account.voiceCycleUsed > 0
      && account.voiceCycleUsed <= (FREE_VOICE_PER_CYCLE[account.tier] || 0));
    if (pending && !correctionIsIncluded) {
      const cost = Math.ceil(ttsCostUsd(speechCharacterCount(text)) / CREDIT_USD);
      const limitReason = usageLimitForCost(account, cost);
      if (account.balance < cost || limitReason) {
        res.status(402).json({ error: limitReason ? usageMessageForReason(limitReason) : OUT_OF_CREDITS_MSG });
        return;
      }
    }
    const audio = await synthesize(text, voiceId, variability);
    if (!correctionIsIncluded) {
      const charged = await spendUsageUsd(deviceId, ttsCostUsd(speechCharacterCount(text)));
      await noteSpend(deviceId, charged.spent);
    }
    res.json({ audioBase64: audio, mime: "audio/mpeg" });
  } catch (error) {
    console.error("Voice correction synthesis error:", error);
    res.status(502).json({ error: "voice unavailable" });
  }
});

// Voice preview for the full-screen picker: each voice speaks one fixed sample
// line. Cached per voice id (the line never changes) so swiping back and forth
// costs ElevenLabs exactly once per voice, not once per swipe.
const VOICE_SAMPLE_LINE = "The colors of the sky fade with the setting sun.";
const voiceSampleCache = new Map<string, string>();
app.get("/api/voice/sample", async (req, res) => {
  if (!isVoiceConfigured()) { res.status(503).json({ error: "voice not configured" }); return; }
  const voiceId = typeof req.query?.voiceId === "string" ? req.query.voiceId.trim() : "";
  const key = voiceId || "default";
  const cached = voiceSampleCache.get(key);
  if (cached) { res.json({ audioBase64: cached, mime: "audio/mpeg" }); return; }
  const audio = await synthesize(VOICE_SAMPLE_LINE, voiceId || undefined);
  if (!audio) { res.status(502).json({ error: "tts failed" }); return; }
  voiceSampleCache.set(key, audio);
  res.json({ audioBase64: audio, mime: "audio/mpeg" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Taki AI server (planner-first, modular) listening on http://0.0.0.0:${PORT}`);
});
