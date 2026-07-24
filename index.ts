import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PORT, MAIN_MODEL, PLANNER_MODEL, RESEARCH_MODEL, ServiceError, VOICE_UNAVAILABLE_SPOKEN } from "./src/ai.js";
import type { DeviceLocation } from "./src/types.js";
import { buildConversationState } from "./src/context.js";
import { planAssistantResponse } from "./src/planner.js";
import { finalizeResponse } from "./src/validators.js";
import { getGeneralAnswer, styleInCharacter, getWeatherSnapshot, inferEventDestination, matchEventToQuery, getTravelTime, answerAboutImage, answerAboutAttachments, fitVoiceResponse } from "./src/tools.js";
// getTravelTime (above) also powers the background commute push loop.
import { briefForVoice, withTimeout } from "./src/util.js";
import { parseIncomingStyleProfiles } from "./src/messageStyle.js";
import { parseUserPersona } from "./src/persona.js";
import {
  registerToken, forgetToken, broadcast, getTokens, isPushConfigured,
  registerLiveActivity, unregisterLiveActivity, getLiveActivities, sendLiveActivityUpdate, clearPushStateForReset
} from "./src/push.js";
import { cachedTrackerSnapshot } from "./src/tracker.js";
import { extractFlightCode, normalizeTrackerKind } from "./src/entityClassifier.js";
import { clearPushToken, getPushToken, setPushToken, syncNudges, tickNudges } from "./src/nudges.js";
import { addAlert, listAlerts, cancelAlerts, pollAlerts, clearAlertsForReset, type Alert } from "./src/alerts.js";
import { isDurable, storeDelete, storeGet, storeSet } from "./src/store.js";
import { summary as creditSummary, spendUsageUsd, reset as resetCredits, isFreeVoice, noteFreeVoice, tierCatalog, grantForTransaction, activateSubscriptionTier, grantForConsumableTransaction, grantWebTopup, downgradeToFree, revokeSubscription, revokeMergedSubscriptionCredits, clearRetiredSubscription, mergeCredits, noteVoiceQuestion, topupPriceCents, topupCentsPerCredit, inAppCreditsForProduct, IN_APP_CREDIT_PRODUCTS, attachmentBaseCostCredits, ATTACHMENT_BASE_CREDITS, CREDIT_TOPUP_MIN, CREDIT_TOPUP_MAX, MIN_REQUEST_CREDITS, CREDIT_USD, type Tier } from "./src/credits.js";
import { measureUsage, sttCostUsd, totalUsageUsd, ttsCostUsd } from "./src/metering.js";
import { decideAssistantCharge, planCorrectionSynthesis, usageBlockFor, usageBlockedPayload, voiceTurnEstimateCredits } from "./src/usage.js";
import { verifyTransaction, verifyCreditTransaction, claimCreditTransaction, transferCreditTransaction, rebindCreditTransactions, linkTransactionIdentity, transferSubscriptionIdentity, claimSubscriptionPeriod, transactionIdsForIdentity, setTransactionRole, getTransactionBinding, primarySubscriptionForIdentity, claimPrimarySubscription, subscriptionMergeDecision, verifyNotification } from "./src/iap.js";
import { revokeAppleAuthorizationCode, verifyAppleIdentityToken } from "./src/appleauth.js";
import { purgeAppleAccount } from "./src/accountDeletion.js";
import { recordAssoc, isBanned, isTestRestricted, setTestRestriction, clearTestRestriction, previewTermination, getSafetyAccount, recordViolation, classifyHarm, looksLikePromptExtraction, reinstate, terminateAndBan, reviewQueue, linkApple, devicesForApple, appleForDevice, SUSPENDED_MSG, BANNED_MSG, promptExtractionMessageForMode } from "./src/safety.js";
import { noteUser, noteSpend, noteTier, noteRevenue, noteApple, noteDevice, noteInteraction, noteChannelCost, noteSession, noteEngagementPreferences, userForIdentity, identitiesForIp, allUsers, deleteUser, type UserRecord } from "./src/users.js";
import { TIERS } from "./src/credits.js";
import { billableAudioDurationMs, transcribe, synthesize, listVoices, isVoiceConfigured, speechCharacterCount } from "./src/voice.js";
import { emailProviderConfigured, createOAuthState, buildAuthUrl, completeOAuth, loadConnection, disconnectEmail, moveEmailConnection, sendEmail, saveDraft, searchConnectedEmail, type EmailProvider } from "./src/email.js";
import { extractDurableMemories } from "./src/userMemory.js";
import { createChatTitle } from "./src/chatTitle.js";
import { engagementSummary, isEngagementEmailConfigured, recordEngagementOpen, recordEngagementSession, recommendedEngagement, sendPersonalizedEngagement, shouldSendAutomatic, type EngagementChannel } from "./src/engagement.js";
import { backfillApplePromotionalSubscribers, enrollApplePromotionalSubscriber, promotionalSummary, sendPromotionalCampaign, unsubscribePromotionalEmail } from "./src/promotional.js";
import { performFullReset, previewFullReset, type FullResetPreview } from "./src/fullReset.js";
import { bypassResetGeneration, hasCurrentResetGeneration, RESET_EPOCH_HEADER } from "./src/resetGeneration.js";
import { isKnownIdentity, markWebAuthenticated } from "./src/identity.js";
import { googleWebClientId, isGoogleWebAuthConfigured, verifyGoogleIdToken } from "./src/webauth.js";

// Admin secret guarding the dev credits-reset endpoint. Set ADMIN_SECRET on
// Render. (The purchase-simulating grant endpoint was removed when real
// StoreKit IAP shipped — grants only happen via verified transactions now.)
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();

type PendingVoiceSynthesis = { deviceId: string; included: boolean; expiresAt: number };
const pendingVoiceSyntheses = new Map<string, PendingVoiceSynthesis>();
const FULL_RESET_PHRASE = "DELETE EVERY TAKI ACCOUNT AND ALL DATA";
const fullResetPreviews = new Map<string, { expiresAt: number; fingerprint: string }>();
let fullResetInProgress = false;
let activeRequests = 0;

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
  // Long enough to survive the phone leaving Taki to run the action (opening
  // Messages, granting a permission) — the token is the only thing that can
  // grant included speech, so an early expiry would silently start charging.
  pendingVoiceSyntheses.set(token, { deviceId, included, expiresAt: now + 5 * 60_000 });
  return token;
}

function takeVoiceSynthesisToken(token: string, deviceId: string): PendingVoiceSynthesis | null {
  const pending = pendingVoiceSyntheses.get(token);
  if (!pending || pending.deviceId !== deviceId) return null;
  if (pending.expiresAt <= Date.now()) {
    pendingVoiceSyntheses.delete(token);
    return null;
  }
  pendingVoiceSyntheses.delete(token);
  return pending;
}

async function chargeMeasuredUsage(deviceId: string, usage: { geminiUsd: number; searchUsd: number }): Promise<number> {
  if (!deviceId) throw new Error("Cannot meter usage without an account identity");
  const charged = await spendUsageUsd(deviceId, usage.geminiUsd + usage.searchUsd);
  await noteSpend(deviceId, charged.spent);
  return charged.spent;
}

function assistantFeature(response: any): string {
  const actions = [response?.action, ...(Array.isArray(response?.actions) ? response.actions : [])].filter(Boolean);
  const actionType = String(actions[0]?.type || "");
  if (actionType && actionType !== "answer_only") return actionType;
  if (Array.isArray(response?.sources) && response.sources.length) return "web_search";
  return "chat";
}

function attachmentFeature(attachments: any[]): string {
  const kinds = new Set(attachments.map((item) => String(item?.kind || "")));
  if (kinds.size > 1) return "attachments";
  if (kinds.has("image")) return "photo";
  if (kinds.has("file")) return "file";
  if (kinds.has("url")) return attachments.some((item) => /(?:youtube\.com|youtu\.be)/i.test(String(item?.url || "")))
    ? "youtube_source"
    : "web_source";
  return kinds.has("text") ? "pasted_text" : "attachments";
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
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use((_req, res, next) => {
  if (fullResetInProgress) {
    res.status(503).json({ error: "Taki AI is completing an administrative reset. Try again shortly." });
    return;
  }
  activeRequests += 1;
  let finished = false;
  const release = () => {
    if (finished) return;
    finished = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  res.once("finish", release);
  res.once("close", release);
  next();
});

// --- Stripe (web credit top-ups). Gated on env; endpoints 503 when unset. ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WEB_BASE_URL = process.env.WEB_BASE_URL || "https://takiai.app";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;
const PURCHASE_LINK_SECRET = process.env.PURCHASE_LINK_SECRET || STRIPE_WEBHOOK_SECRET || STRIPE_KEY;

type PurchaseLinkPayload = { identity: string; exp: number; nonce: string; purpose: "credits" };
function signPurchaseLink(payload: PurchaseLinkPayload): string {
  if (!PURCHASE_LINK_SECRET) return "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", PURCHASE_LINK_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function verifyPurchaseLink(token: unknown): PurchaseLinkPayload | null {
  if (!PURCHASE_LINK_SECRET || typeof token !== "string") return null;
  const [body, suppliedSignature] = token.split(".");
  if (!body || !suppliedSignature) return null;
  const expectedSignature = createHmac("sha256", PURCHASE_LINK_SECRET).update(body).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PurchaseLinkPayload;
    if (payload.purpose !== "credits" || !payload.identity || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

app.get("/health", async (_req, res) => {
  const reset = await storeGet<{ epoch?: number }>("system:reset", {});
  res.json({
    ok: true,
    app: "Taki AI server",
    mode: "planner-first-modular-v3",
    version: "2026-07-23-no-comparison-v1",
    durableStorage: isDurable(),
    models: { main: MAIN_MODEL, planner: PLANNER_MODEL, research: RESEARCH_MODEL },
    // Live Activity background updates require APNs config (APNS_KEY_P8 or
    // APNS_KEY_PATH + KEY_ID + TEAM_ID). Surfaced here so a missing key on the
    // host is a one-curl diagnosis instead of "trackers silently never update".
    pushConfigured: isPushConfigured(),
    resetEpoch: Number(reset.epoch || 0)
  });
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(fileURLToPath(new URL("./admin.html", import.meta.url)));
});

function unsubscribePage(message: string, form = ""): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taki AI email preferences</title><style>body{box-sizing:border-box;margin:0;background:#181819;color:#f5f5f2;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.box{max-width:430px;text-align:center}.mark{font-size:22px;font-weight:800;margin-bottom:18px}h1{font-size:24px;line-height:1.25;margin:0 0 10px}p{color:#bbb9b2;margin:0 0 22px}button{border:0;border-radius:8px;padding:12px 16px;background:#e6e3dc;color:#171719;font:700 15px inherit;cursor:pointer}</style></head><body><main class="box"><div class="mark">Taki AI</div>${message}${form}</main></body></html>`;
}

app.get("/unsubscribe", (req, res) => {
  const token = typeof req.query?.token === "string" ? req.query.token : "";
  if (!token) { res.status(400).send(unsubscribePage("<h1>This link is invalid.</h1><p>Use the unsubscribe link from a Taki AI promotional email.</p>")); return; }
  const action = `/unsubscribe?token=${encodeURIComponent(token)}&show=1`;
  res.send(unsubscribePage("<h1>Stop promotional emails?</h1><p>You will no longer receive Taki AI product news and offers. Account, billing, and security messages are unaffected.</p>", `<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`));
});

app.post("/unsubscribe", async (req, res) => {
  const token = typeof req.query?.token === "string" ? req.query.token : typeof req.body?.token === "string" ? req.body.token : "";
  const unsubscribed = await unsubscribePromotionalEmail(token);
  // RFC 8058 one-click requests expect a blank successful response. The normal
  // browser flow adds show=1 so people still receive a useful confirmation.
  if (req.query?.show !== "1") { res.status(unsubscribed ? 200 : 400).type("text/plain").send(""); return; }
  res.status(unsubscribed ? 200 : 400).send(unsubscribePage(
    unsubscribed
      ? "<h1>You are unsubscribed.</h1><p>Taki AI will stop sending promotional emails to this address.</p>"
      : "<h1>This link is invalid or expired.</h1><p>Use the newest unsubscribe link from a Taki AI email.</p>"
  ));
});

let resetEpochCache = { value: 0, readAt: 0 };
async function currentResetEpoch(): Promise<number> {
  if (Date.now() - resetEpochCache.readAt < 5_000) return resetEpochCache.value;
  const reset = await storeGet<{ epoch?: number }>("system:reset", {});
  resetEpochCache = { value: Math.floor(Number(reset.epoch || 0)), readAt: Date.now() };
  return resetEpochCache.value;
}

// A full reset invalidates every prior installation generation. External
// callbacks and the web checkout stay available, while app/API traffic must
// prove it has observed the current reset epoch before any route can write.
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || bypassResetGeneration(req.path)) { next(); return; }
  try {
    const requiredEpoch = await currentResetEpoch();
    if (hasCurrentResetGeneration(requiredEpoch, req.headers[RESET_EPOCH_HEADER])) { next(); return; }
    res.status(428).json({
      error: "This Taki AI installation must be updated and reopened after the account reset.",
      code: "reset_required",
      resetEpoch: requiredEpoch
    });
  } catch (error) {
    console.error("Reset generation check failed:", error);
    res.status(503).json({ error: "Taki AI could not verify this installation yet. Try again shortly." });
  }
});

// --- Push (APNs) --------------------------------------------------------------
// The device registers its APNs token here so the server can send proactive
// alerts (commute "leave now", fresh morning briefing, breaking updates).
app.post("/api/register-push", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  if (!token || !/^\d{8}$/.test(deviceId)) {
    res.status(400).json({ error: "token and valid deviceId required" });
    return;
  }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  registerToken(token);
  // Tie the token to the device id so the nudge engine can target this device.
  await setPushToken(deviceId, token);
  res.json({ ok: true, configured: isPushConfigured(), devices: getTokens().length });
});

// The device syncs its upcoming nudge manifest on every foreground; the cron
// loop below fires each when due (so nudges arrive with the app closed).
app.post("/api/nudges/sync", async (req, res) => {
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "valid deviceId required" }); return; }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const count = await syncNudges(deviceId, Array.isArray(req.body?.nudges) ? req.body.nudges : []);
  res.json({ ok: true, count, pushConfigured: isPushConfigured() });
});

// Let a device unsubscribe (e.g. notifications turned off).
app.post("/api/unregister-push", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  if (!/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
  }
  const registeredToken = await getPushToken(deviceId);
  if (token && token === registeredToken) forgetToken(token);
  await clearPushToken(deviceId);
  res.json({ ok: true });
});

// Fire a push to every registered device — used to verify the .p8 pipeline
// end-to-end, and the building block every proactive trigger calls.
app.post("/api/test-push", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
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
  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 4000) : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text required" });
    return;
  }
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res);
  if (!deviceId) return;
  try {
    const persona = parseUserPersona(req.body?.profile);
    const measured = await measureUsage(() => withTimeout(styleInCharacter(text, persona), 8000, "Style"));
    const styled = measured.value;
    await chargeMeasuredUsage(deviceId, measured.usage);
    res.json({ text: (styled || text).trim() });
  } catch (error) {
    console.error("Style error:", error);
    res.status(503).json({ error: "style unavailable", text });
  }
});

// The device registers a running Live Activity's push token here so the server
// can update it in the BACKGROUND (app closed) via ActivityKit push.
app.post("/api/register-la", async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  if (!id || !token || !/^\d{8}$/.test(deviceId)) {
    res.status(400).json({ error: "id, token, and valid deviceId required" });
    return;
  }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};
  const requestedKind = typeof req.body?.kind === "string" ? req.body.kind : "finance";
  const query = typeof meta?.query === "string" ? meta.query : "";
  const environment = req.body?.environment === "production" ? "production" : req.body?.environment === "sandbox" ? "sandbox" : undefined;
  try {
    await registerLiveActivity({ id, deviceId, kind: normalizeTrackerKind(requestedKind, query), meta, token, environment });
    res.json({ ok: true, configured: isPushConfigured() });
  } catch (error) {
    console.error("Live Activity registration failed:", error);
    res.status(503).json({ error: "Live Activity registration could not be saved" });
  }
});

app.post("/api/unregister-la", async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  if (!id || !/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
  }
  try {
    await unregisterLiveActivity(id, deviceId);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Live Activity registration could not be removed" });
  }
});

// Background engine: re-fetch each live tracker's data and push a
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
const livePushKey = (registration: { id: string; deviceId?: string }) => `${registration.deviceId || "legacy"}:${registration.id}`;

// Data trackers: re-fetch (cached) and push every 15s. Product prices use a
// much longer cache TTL than market/game data.
// but only when the content changed. So the lock screen updates within ~15s of
// any change, app open OR closed.
let trackerPushBusy = false;
setInterval(async () => {
  if (!isPushConfigured() || trackerPushBusy) return;
  trackerPushBusy = true;
  try {
    for (const reg of await getLiveActivities()) {
      if (Date.now() - reg.startedAt > LA_MAX_MS) {
        await sendLiveActivityUpdate(reg.token, null, "end", reg.environment);
        await unregisterLiveActivity(reg.id, reg.deviceId || "legacy");
        lastPushed.delete(livePushKey(reg));
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
        const pushKey = livePushKey(reg);
        if (lastPushed.get(pushKey) === sig) continue;
        const result = await sendLiveActivityUpdate(reg.token, content, "update", reg.environment);
        if (deadToken(result)) { await unregisterLiveActivity(reg.id, reg.deviceId || "legacy"); lastPushed.delete(pushKey); }
        else lastPushed.set(pushKey, sig);
      } catch (error) {
        console.error("Live Activity push error:", error);
      }
    }
  } finally {
    trackerPushBusy = false;
  }
}, 15 * 1000);

// Commute: re-check live traffic and push an updated departure time every 3 min
// (slower than finance — traffic drifts gradually, and this hits the Directions
// API). Ends the activity once the event has started.
const modeWord = (m: string) => (m === "walking" ? "walk" : m === "bicycling" ? "bike" : m === "transit" ? "transit" : "drive");
let commutePushBusy = false;
setInterval(async () => {
  if (!isPushConfigured() || commutePushBusy) return;
  commutePushBusy = true;
  try {
    for (const reg of await getLiveActivities()) {
      if (reg.kind !== "commute") continue;
      const meta = reg.meta || {};
      const startEpoch = Number(meta.eventStartEpoch);
      if (Number.isFinite(startEpoch) && startEpoch * 1000 < Date.now()) {
        await sendLiveActivityUpdate(reg.token, null, "end", reg.environment);
        await unregisterLiveActivity(reg.id, reg.deviceId || "legacy");
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
        }, "update", reg.environment);
        if (deadToken(r)) await unregisterLiveActivity(reg.id, reg.deviceId || "legacy");
      } catch (error) {
        console.error("Commute push error:", error);
      }
    }
  } finally {
    commutePushBusy = false;
  }
}, 3 * 60 * 1000);

/* ---- Batch B proactive alerts (price / score) -------------------------- */

// Register an alert the server will watch and push when it fires. The device
// sends the alert spec it got back from the planner's alert_create action.
app.post("/api/alerts", async (req, res) => {
  const b = req.body || {};
  const deviceId = normalizeTopupIdentity(typeof b.deviceId === "string" ? b.deviceId : "");
  const kind = b.kind === "price" || b.kind === "score" ? b.kind : "";
  const query = typeof b.query === "string" ? b.query.trim() : "";
  if (!/^\d{8}$/.test(deviceId) || !kind || !query) { res.status(400).json({ error: "deviceId, kind, and query required" }); return; }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const base = { id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, deviceId, createdAt: Date.now(), query, label: typeof b.label === "string" && b.label ? b.label : query };
  let alert: Alert;
  if (kind === "price") {
    const target = Number(b.target);
    if (!Number.isFinite(target)) { res.status(400).json({ error: "target required" }); return; }
    alert = { ...base, kind: "price", target, direction: b.direction === "below" ? "below" : "above" };
  } else {
    alert = { ...base, kind: "score", trigger: b.trigger === "final" ? "final" : "any" };
  }
  const result = await addAlert(alert);
  res.status(result.ok ? 200 : 409).json({ ...result, durable: isDurable() });
});

app.get("/api/alerts", async (req, res) => {
  const deviceId = normalizeTopupIdentity(typeof req.query.deviceId === "string" ? req.query.deviceId : "");
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "deviceId required" }); return; }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  res.json({ alerts: await listAlerts(deviceId), durable: isDurable() });
});

app.post("/api/alerts/cancel", async (req, res) => {
  const b = req.body || {};
  const deviceId = normalizeTopupIdentity(typeof b.deviceId === "string" ? b.deviceId : "");
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "deviceId required" }); return; }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const filter = (b.id || b.kind || b.query)
    ? { id: typeof b.id === "string" ? b.id : undefined, kind: typeof b.kind === "string" ? b.kind : undefined, query: typeof b.query === "string" ? b.query : undefined }
    : undefined;
  const removed = await cancelAlerts(deviceId, filter);
  res.json({ ok: true, removed });
});

// Background engine: sweep all alerts every 90s and deliver any that fire, via
// APNs push if configured, otherwise by email (Resend). Skips entirely only when
// NEITHER channel is configured — then alerts just sit until one is.
setInterval(() => {
  if (!isPushConfigured() && !isEngagementEmailConfigured()) return;
  void pollAlerts(process.env.ALERT_TZ || "America/New_York");
}, 90 * 1000);

// Fire any due proactive nudges (server-push tier) every minute.
setInterval(() => { void tickNudges(); }, 60 * 1000);

// Live tracker snapshot for an active Live Activity. The device polls
// this to keep the lock-screen / Dynamic Island tracker fresh.
app.get("/api/track", async (req, res) => {
  const deviceId = normalizeTopupIdentity(typeof req.query.deviceId === "string" ? req.query.deviceId : "");
  const requestedKind = typeof req.query.kind === "string" ? req.query.kind : "";
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const kind = normalizeTrackerKind(requestedKind, query);
  const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
  if ((kind !== "finance" && kind !== "product" && kind !== "sports" && kind !== "flight" && kind !== "package") || !query) {
    res.status(400).json({ error: "kind (finance|product|sports|flight|package) and q are required" });
    return;
  }
  if (!/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
  }
  try {
    const safeQuery = kind === "flight" ? extractFlightCode(query) || query : query;
    const timeout = kind === "sports" || kind === "flight" ? 42000 : 25000;
    const snap = await withTimeout(cachedTrackerSnapshot(kind, safeQuery, tz), timeout, "Track snapshot");
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
  const deviceId = normalizeTopupIdentity(typeof req.query.deviceId === "string" ? req.query.deviceId : "");
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  if (!/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
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
  const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 500) : "";
  const location = typeof req.body?.location === "string" ? req.body.location.slice(0, 1000) : "";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 4000) : "";
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!title && !location) {
    res.status(400).json({ error: "title or location is required" });
    return;
  }
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res);
  if (!deviceId) return;
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
    await chargeMeasuredUsage(deviceId, measured.usage);
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
  const query = typeof req.body?.query === "string" ? req.body.query.slice(0, 2000) : "";
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [];
  const events = rawEvents.slice(0, 50).map((e: any) => ({
    title: typeof e?.title === "string" ? e.title.slice(0, 500) : "",
    when: typeof e?.when === "string" ? e.when.slice(0, 200) : "",
    location: typeof e?.location === "string" ? e.location.slice(0, 1000) : ""
  }));
  if (!query || events.length === 0) {
    res.json({ index: -1 });
    return;
  }
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res);
  if (!deviceId) return;
  try {
    const measured = await measureUsage(() => withTimeout(matchEventToQuery(query, events), 10000, "Match event"));
    const index = measured.value;
    await chargeMeasuredUsage(deviceId, measured.usage);
    res.json({ index });
  } catch (error) {
    console.error("Match event error:", error);
    res.status(502).json({ error: "event matching unavailable" });
  }
});

// Vision: answer a question about a photo (base64) the user took/picked.
app.post("/api/vision", async (req, res) => {
  const image = typeof req.body?.image === "string" ? req.body.image : "";
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "image/jpeg";
  const question = typeof req.body?.question === "string" ? req.body.question.slice(0, 8000) : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!image) {
    res.status(400).json({ error: "image is required" });
    return;
  }
  if (!(await requireCreditIdentity(deviceId, res))) return;
  const visionGate = await safetyGate(deviceId, question, req);
  if (visionGate) { res.json({ spokenText: visionGate.message, blocked: true, ...(visionGate.block ? { access: visionGate.block, accessMessage: visionGate.message } : {}) }); return; }
  let tier: Tier = "free";
  let visionBaseCredits = 0;
  let visionVoiceUsed = 0;
  let visionVoiceLifetimeUsed = 0;
  const sum = await creditSummary(deviceId);
  tier = sum.tier;
  visionBaseCredits = sum.baseCredits;
  visionVoiceUsed = sum.voiceCycleUsed;
  visionVoiceLifetimeUsed = sum.voiceUsed;
  const block = usageBlockFor(sum, ATTACHMENT_BASE_CREDITS, voiceMode);
  if (block) { res.status(402).json(usageBlockedPayload(block)); return; }
  try {
    const measured = await measureUsage(() => withTimeout(answerAboutImage(image, mime, question, userProfile, timeZone), 28000, "Vision"));
    const spokenText = measured.value;
    const speechUsd = voiceMode ? ttsCostUsd(speechCharacterCount(spokenText || "")) : 0;
    const ownerCostUsd = totalUsageUsd(measured.usage) + speechUsd;
    const fresh = await creditSummary(deviceId);
    const charge = decideAssistantCharge({
      summary: fresh,
      tier,
      voiceMode,
      includedVoice: voiceMode && isFreeVoice(tier, visionBaseCredits, visionVoiceUsed, visionVoiceLifetimeUsed),
      baseUsd: totalUsageUsd(measured.usage) + ATTACHMENT_BASE_CREDITS * CREDIT_USD,
      voiceOutputUsd: speechUsd
    });
    if (charge.block) { res.status(402).json(usageBlockedPayload(charge.block)); return; }
    if (charge.consumeIncludedVoice) await noteFreeVoice(deviceId);
    const s = await spendUsageUsd(deviceId, charge.usageUsd);
    if (voiceMode && tier === "free") await noteVoiceQuestion(deviceId);
    await noteSpend(deviceId, s.spent);
    await noteInteraction(deviceId, {
      channel: voiceMode ? "voice" : "text",
      feature: "photo",
      credits: s.spent,
      costUsd: ownerCostUsd
    });
    res.json({ spokenText, credits: { ...s, cost: s.spent } });
  } catch (error) {
    console.error("Vision error:", error);
    res.status(502).json({ error: "vision unavailable" });
  }
});

app.post("/api/attachments", async (req, res) => {
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 6) : [];
  const attachmentCredits = attachmentBaseCostCredits(attachments);
  const question = typeof req.body?.question === "string" ? req.body.question.slice(0, 8000) : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!attachments.length) { res.status(400).json({ error: "attachment is required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res))) return;

  const gate = await safetyGate(deviceId, question, req);
  if (gate) { res.json({ spokenText: gate.message, blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) }); return; }

  let tier: Tier = "free";
  let baseCredits = 0;
  let voiceUsed = 0;
  let voiceLifetimeUsed = 0;
  const attachmentSummary = await creditSummary(deviceId);
  tier = attachmentSummary.tier;
  baseCredits = attachmentSummary.baseCredits;
  voiceUsed = attachmentSummary.voiceCycleUsed;
  voiceLifetimeUsed = attachmentSummary.voiceUsed;
  const attachmentBlock = usageBlockFor(attachmentSummary, Math.max(MIN_REQUEST_CREDITS, attachmentCredits), voiceMode);
  if (attachmentBlock) { res.status(402).json(usageBlockedPayload(attachmentBlock)); return; }

  try {
    const measured = await measureUsage(() => answerAboutAttachments(attachments, question, userProfile, timeZone));
    const answer = measured.value;
    const speechUsd = voiceMode ? ttsCostUsd(speechCharacterCount(answer.text)) : 0;
    const ownerCostUsd = totalUsageUsd(measured.usage) + speechUsd;
    const fresh = await creditSummary(deviceId);
    const charge = decideAssistantCharge({
      summary: fresh,
      tier,
      voiceMode,
      includedVoice: voiceMode && isFreeVoice(tier, baseCredits, voiceUsed, voiceLifetimeUsed),
      baseUsd: totalUsageUsd(measured.usage) + attachmentCredits * CREDIT_USD,
      voiceOutputUsd: speechUsd
    });
    if (charge.block) { res.status(402).json(usageBlockedPayload(charge.block)); return; }
    if (charge.consumeIncludedVoice) await noteFreeVoice(deviceId);
    const spent = await spendUsageUsd(deviceId, charge.usageUsd);
    if (voiceMode && tier === "free") await noteVoiceQuestion(deviceId);
    await noteSpend(deviceId, spent.spent);
    await noteInteraction(deviceId, {
      channel: voiceMode ? "voice" : "text",
      feature: attachmentFeature(attachments),
      credits: spent.spent,
      costUsd: ownerCostUsd
    });
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
    // Registration creates the account record and starter ledger together. A
    // device ID can therefore never exist only on the phone or be invisible in
    // the admin dashboard.
    await noteUser(deviceId, clientIp(req), String(req.headers?.["user-agent"] || ""));
    const credits = await creditSummary(deviceId);
    res.json({ deviceId, credits });
  } catch (e) {
    console.error("register-device error:", e);
    res.status(502).json({ error: "could not register device" });
  }
});

/* ---- Web sign-in (takiai.app/app) -------------------------------------- */
// Chat on the web requires a verified Apple or Google account: the monthly free
// credits attach to the provider's stable `sub`, not to clearable browser
// storage, so wiping the cache or reinstalling never mints a fresh allowance.

// Which providers the static page should offer (client ids are public by design).
app.get("/api/web/auth/config", (_req, res) => {
  const appleServicesId = (process.env.APPLE_WEB_SERVICES_ID || "").trim();
  res.json({
    google: isGoogleWebAuthConfigured() ? { clientId: googleWebClientId() } : null,
    apple: appleServicesId ? { servicesId: appleServicesId } : null
  });
});

// Shared tail: record the verified account, ensure its ledger, return identity+credits.
async function finishWebSignIn(req: any, res: any, identity: string, email?: string, name?: string) {
  await markWebAuthenticated(identity);
  await noteUser(identity, clientIp(req), String(req.headers?.["user-agent"] || ""));
  if (identity.startsWith("apple:")) {
    const appleSub = identity.slice("apple:".length);
    await noteApple(identity, { sub: appleSub, email, name });
    await enrollApplePromotionalSubscriber({ email, appleSub, identity });
  }
  const ip = clientIp(req);
  if ((await isBanned(identity, undefined, ip)) || (await isTestRestricted(identity))) {
    res.status(403).json({ error: "This account is restricted." });
    return;
  }
  const credits = await creditSummary(identity);
  res.json({ identity, email: email || "", name: name || "", credits });
}

app.post("/api/web/auth/google", async (req, res) => {
  if (!isGoogleWebAuthConfigured()) { res.status(503).json({ error: "Google sign-in is not configured." }); return; }
  const verified = await verifyGoogleIdToken(String(req.body?.idToken || ""));
  if (!verified) { res.status(401).json({ error: "Google sign-in could not be verified." }); return; }
  await finishWebSignIn(req, res, `google:${verified.sub}`, verified.email, verified.name);
});

app.post("/api/web/auth/apple", async (req, res) => {
  const verified = await verifyAppleIdentityToken(String(req.body?.idToken || ""));
  if (!verified) { res.status(401).json({ error: "Apple sign-in could not be verified." }); return; }
  await finishWebSignIn(req, res, `apple:${verified.sub}`, verified.email);
});

app.post("/api/device/info", async (req, res) => {
  const b = req.body || {};
  const deviceId = typeof b.deviceId === "string" ? normalizeTopupIdentity(b.deviceId) : "";
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "valid deviceId required" }); return; }
  if (!(await storeGet<boolean>(`devnum:used:${deviceId}`, false))) {
    res.status(404).json({ error: "unknown device" }); return;
  }
  // Repair accounts created by older builds that issued an ID without adding a
  // complete dashboard record. Validation runs whenever the app launches.
  await noteUser(deviceId, clientIp(req), String(req.headers?.["user-agent"] || ""));
  await noteDevice(deviceId, {
    name: typeof b.name === "string" ? b.name : "",
    model: typeof b.model === "string" ? b.model : "",
    identifier: typeof b.identifier === "string" ? b.identifier : "",
    takiName: typeof b.takiName === "string" ? b.takiName : ""
  });
  res.json({ ok: true });
});

const PROFILE_INTERESTS = new Set(["planning", "communication", "health", "nearby", "home", "research", "reminders"]);
app.post("/api/analytics/profile", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const physicalDeviceId = typeof req.body?.deviceId === "string" ? normalizeTopupIdentity(req.body.deviceId) : "";
  if (!identity || !/^\d{8}$/.test(physicalDeviceId)) {
    res.status(400).json({ error: "identity and deviceId required" });
    return;
  }
  if (identity.startsWith("apple:")) {
    const appleSub = identity.slice("apple:".length);
    if (!(await devicesForApple(appleSub)).includes(physicalDeviceId)) {
      res.status(403).json({ error: "device is not linked to this account" });
      return;
    }
  } else if (normalizeTopupIdentity(identity) !== physicalDeviceId) {
    res.status(403).json({ error: "identity mismatch" });
    return;
  }
  const interests = (Array.isArray(req.body?.interests) ? req.body.interests : [])
    .map((value: unknown) => String(value).trim().toLowerCase())
    .filter((value: string) => PROFILE_INTERESTS.has(value))
    .slice(0, 3);
  await noteEngagementPreferences(identity, {
    interests,
    pushEnabled: req.body?.engagementPush === true,
    emailEnabled: req.body?.engagementEmail === true
  });
  await noteUser(identity, clientIp(req), String(req.headers?.["user-agent"] || ""));
  const profile = await userForIdentity(identity);
  res.json({ ok: true, engagement: profile.engagement, emailAvailable: !!profile.apple?.email });
});

app.post("/api/analytics/session", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const physicalDeviceId = typeof req.body?.deviceId === "string" ? normalizeTopupIdentity(req.body.deviceId) : "";
  const durationSeconds = Math.max(1, Math.min(6 * 3600, Math.round(Number(req.body?.durationSeconds) || 0)));
  if (!identity || !/^\d{8}$/.test(physicalDeviceId) || !durationSeconds) {
    res.status(400).json({ error: "identity, deviceId, and duration required" });
    return;
  }
  if (identity.startsWith("apple:")) {
    if (!(await devicesForApple(identity.slice("apple:".length))).includes(physicalDeviceId)) {
      res.status(403).json({ error: "device is not linked to this account" });
      return;
    }
  } else if (normalizeTopupIdentity(identity) !== physicalDeviceId) {
    res.status(403).json({ error: "identity mismatch" });
    return;
  }
  const campaign = typeof req.body?.campaign === "string" ? req.body.campaign.trim().slice(0, 80) : "";
  await noteSession(identity, durationSeconds, campaign || undefined);
  if (campaign) await recordEngagementSession(campaign, identity, durationSeconds);
  res.json({ ok: true });
});

app.post("/api/engagement/open", async (req, res) => {
  const campaign = typeof req.body?.campaign === "string" ? req.body.campaign.trim() : "";
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!campaign || !identity) { res.status(400).json({ error: "campaign and identity required" }); return; }
  const recorded = await recordEngagementOpen(campaign, identity);
  res.status(recorded ? 200 : 404).json({ ok: recorded });
});

app.get("/api/engagement/click", async (req, res) => {
  const campaign = typeof req.query?.campaign === "string" ? req.query.campaign.trim() : "";
  if (campaign) await recordEngagementOpen(campaign);
  res.redirect(302, process.env.ENGAGEMENT_CLICK_DESTINATION || "https://takiai.app");
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
  if (!deviceId.startsWith("apple:") && !deviceId.startsWith("google:") && !/^\d{8}$/.test(deviceId)) {
    res.status(400).json({ error: "registered deviceId required" }); return;
  }
  if (!(await isKnownIdentity(deviceId))) {
    res.status(404).json({ error: "device account not found; register this installation again" }); return;
  }
  // Report access status so the app can hard-block a banned/suspended account on
  // launch (full-screen), not just when the user asks something.
  let access: "active" | "suspended" | "banned" = "active";
  let accessMessage = "";
  try {
    const ip = clientIp(req);
    // Only 8-digit physical-device ids participate in device association;
    // apple:/google: account identities have no hardware id.
    const dev = /^\d{8}$/.test(deviceId) ? deviceId : undefined;
    await recordAssoc(deviceId, dev, ip);
    const acct = await getSafetyAccount(deviceId);
    if (acct.status === "terminated" || (await isBanned(deviceId, dev, ip)) || (await isTestRestricted(deviceId))) { access = "banned"; accessMessage = BANNED_MSG; }
    else if (acct.status === "suspended") { access = "suspended"; accessMessage = SUSPENDED_MSG; }
  } catch (e) { console.error("credits access check:", e); }
  res.json({ ...(await creditSummary(deviceId)), tiers: tierCatalog(), access, accessMessage });
});

// Fast, non-AI affordability check. The app calls this immediately before text,
// attachment, or voice work so blocked requests never reach Gemini or ElevenLabs.
app.post("/api/credits/preflight", async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId is required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res))) return;
  const kind = req.body?.kind === "voice" ? "voice" : req.body?.kind === "attachment" ? "attachment" : "text";
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 6) : [];
  const summary = await creditSummary(deviceId);
  // A voice turn commits to STT + a planning call + TTS the moment it starts,
  // so preflight has to ask for what the whole turn can cost — not the floor.
  const requiredCredits = kind === "attachment"
    ? Math.max(MIN_REQUEST_CREDITS, attachmentBaseCostCredits(attachments))
    : kind === "voice"
      ? voiceTurnEstimateCredits(isFreeVoice(summary.tier, summary.baseCredits, summary.voiceCycleUsed, summary.voiceUsed))
      : MIN_REQUEST_CREDITS;
  const block = usageBlockFor(summary, requiredCredits, kind === "voice");
  if (block) { res.status(402).json(usageBlockedPayload(block)); return; }
  res.json({ allowed: true, requiredCredits, credits: { ...summary, cost: 0 } });
});

/* ---- Web credit top-ups (Stripe Checkout) ------------------------------- */
// Whether web top-ups are available (so the buy page can show/hide itself) + the
// price rules the buyer page mirrors (the server stays authoritative on charge).
app.get("/api/credits/topup-config", (_req, res) => {
  res.json({
    enabled: !!stripe,
    min: CREDIT_TOPUP_MIN,
    max: CREDIT_TOPUP_MAX,
    centsPerCredit: topupCentsPerCredit("free"),
    plusVoiceCentsPerCredit: topupCentsPerCredit("plus_voice"),
    proCentsPerCredit: topupCentsPerCredit("pro"),
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

async function requireCreditIdentity(rawIdentity: unknown, res: any): Promise<string | null> {
  const identity = typeof rawIdentity === "string" ? rawIdentity.trim() : "";
  if (!identity || !(await isKnownIdentity(identity)) || !(await hasCreditsAccount(identity))) {
    res.status(401).json({ error: "A registered Taki AI account is required." });
    return null;
  }
  return identity;
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
  if (!issued && !deviceUser.firstSeenAt && !appleSub) {
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

function publicPurchaseAccount(v: PurchaseAccount) {
  return {
    valid: v.valid,
    reason: v.reason || "",
    identity: v.publicId,
    isPro: v.isPro,
    tier: v.tier,
    appleSynced: v.appleSynced,
    email: v.email,
    displayName: v.displayName,
    devices: v.devices,
    min: CREDIT_TOPUP_MIN,
    max: CREDIT_TOPUP_MAX,
    centsPerCredit: topupCentsPerCredit(v.tier)
  };
}

// U.S.-storefront app handoff: exchange the current account for a short-lived,
// signed URL token. Storefront is fetched from StoreKit immediately before this
// request and is deliberately not persisted as profile or marketing data.
app.post("/api/credits/purchase-link", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const storefront = typeof req.body?.storefront === "string" ? req.body.storefront.toUpperCase() : "";
  if (storefront !== "USA" && storefront !== "US") { res.status(403).json({ error: "Web purchase links are unavailable in this storefront" }); return; }
  const account = await validateTopupAccount(identity);
  if (!account.valid) { res.status(400).json({ error: account.reason || "Account unavailable" }); return; }
  const token = signPurchaseLink({ identity: account.publicId, exp: Date.now() + 10 * 60_000, nonce: randomUUID(), purpose: "credits" });
  if (!token) { res.status(503).json({ error: "Secure purchase links are not configured" }); return; }
  res.json({ url: `${WEB_BASE_URL}/buy/?plan=credits&handoff=${encodeURIComponent(token)}`, expiresIn: 600 });
});

app.post("/api/credits/handoff", async (req, res) => {
  const payload = verifyPurchaseLink(req.body?.token);
  if (!payload) { res.status(401).json({ valid: false, reason: "This purchase link expired. Open Membership in Taki and try again." }); return; }
  const account = await validateTopupAccount(payload.identity);
  if (!account.valid) { res.status(400).json(publicPurchaseAccount(account)); return; }
  res.json(publicPurchaseAccount(account));
});

const purchaseLookupWindows = new Map<string, { at: number; count: number }>();

// Step 1 of the buy flow: check an Account ID and return a limited confirmation
// summary. Email is masked because an eight-digit ID is not authentication.
app.post("/api/credits/account-check", async (req, res) => {
  const ip = clientIp(req);
  if (purchaseLookupWindows.size > 5_000) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, value] of purchaseLookupWindows) {
      if (value.at < cutoff) purchaseLookupWindows.delete(key);
    }
  }
  const prior = purchaseLookupWindows.get(ip);
  const windowState = !prior || Date.now() - prior.at > 5 * 60_000 ? { at: Date.now(), count: 0 } : prior;
  if (windowState.count >= 12) { res.status(429).json({ valid: false, reason: "Too many account checks. Try again in a few minutes." }); return; }
  windowState.count += 1;
  purchaseLookupWindows.set(ip, windowState);
  const identity = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  if (!identity) { res.status(400).json({ valid: false, reason: "Enter your Account ID." }); return; }
  const v = await validateTopupAccount(identity);
  res.json(publicPurchaseAccount(v));
});

// Step 2: start a checkout for `credits` credits toward `identity`. Re-validates
// the account and computes the price server-side from the real Pro tier (client-
// sent prices/Pro flags are never trusted).
app.post("/api/credits/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "top-ups are not available yet" }); return; }
  const handoff = verifyPurchaseLink(req.body?.handoffToken);
  const identity = handoff?.identity || (typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "");
  const credits = Math.floor(Number(req.body?.credits));
  if (!identity) { res.status(400).json({ error: "account ID required" }); return; }
  const v = await validateTopupAccount(identity);
  if (!v.valid) { res.status(403).json({ error: v.reason || "This account can't purchase credits." }); return; }
  const cents = topupPriceCents(credits, v.tier);
  if (cents == null) { res.status(400).json({ error: `Choose between ${CREDIT_TOPUP_MIN.toLocaleString()} and ${CREDIT_TOPUP_MAX.toLocaleString()} credits.` }); return; }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name: `${credits.toLocaleString()} Taki AI credits${v.tier === "pro" ? " (Pro price)" : v.tier === "plus_voice" ? " (Plus Voice price)" : ""}` } } }],
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
      } catch (e) {
        console.error("Stripe subscription grant error:", e);
        res.status(500).json({ error: "webhook processing failed" });
        return;
      }
      res.json({ received: true });
      return;
    }
    const credits = parseInt(s.metadata?.credits || "0", 10);
    try {
      if (identity && credits > 0 && s.payment_status === "paid") {
        const grant = await grantWebTopup(identity, credits, s.id);
        if (grant.granted) {
          await noteRevenue(identity, { at: Date.now(), kind: "topup", amountUsd: (s.amount_total || 0) / 100, credits });
        }
      }
    } catch (e) {
      console.error("Stripe grant error:", e);
      res.status(500).json({ error: "webhook processing failed" });
      return;
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
      } catch (e) {
        console.error("Stripe renewal grant error:", e);
        res.status(500).json({ error: "webhook processing failed" });
        return;
      }
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
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
  const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  const page = (title: string, body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title><style>body{box-sizing:border-box;margin:0;background:#1c1c1e;color:#f5f5f7;font:16px/1.6 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}a{display:inline-block;margin-top:20px;padding:13px 22px;border-radius:12px;background:#f5f5f7;color:#171719;text-decoration:none;font-weight:700}h1{font-size:22px;margin:0 0 8px}p{color:#c7c7cc;max-width:340px}</style></head><body><div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(body)}</p><a href="takiai://email-connected">Return to Taki AI</a></div><script>setTimeout(function(){location.href="takiai://email-connected"},900)</script></body></html>`;
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
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
app.get("/api/iap/credit-packs", async (req, res) => {
  const identity = typeof req.query.identity === "string" ? req.query.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  if (!(await requireCreditIdentity(identity, res))) return;
  const account = await creditSummary(identity);
  const packs = Object.entries(IN_APP_CREDIT_PRODUCTS).map(([productId, pack]) => ({
    productId,
    priceCents: pack.priceCents,
    credits: inAppCreditsForProduct(productId, account.tier),
    tier: account.tier,
    discount: TIERS[account.tier]?.extraCreditDiscount || 0
  }));
  res.json({ tier: account.tier, packs });
});

// The device sends its verified signed transaction(s) (JWS). We read the product,
// map it to a tier, and grant that cycle's credits to the caller's identity
// (device id, or the Apple account id when signed in). Idempotent per billing
// period, so relaunch/restore won't double-grant.
app.post("/api/iap/verify", async (req, res) => {
  const b = req.body || {};
  const identity = typeof b.identity === "string" ? b.identity.trim() : (typeof b.deviceId === "string" ? b.deviceId.trim() : "");
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  if (!(await requireCreditIdentity(identity, res))) return;
  const jwsList: string[] = Array.isArray(b.transactions)
    ? b.transactions.filter((t: unknown) => typeof t === "string")
    : (typeof b.transaction === "string" ? [b.transaction] : []);
  if (jwsList.length === 0) { res.status(400).json({ error: "transaction(s) required" }); return; }

  let tier: Tier | null = null;
  let anyGranted = false;
  let consumableGranted = false;
  let ownershipConflict = false;
  for (const jws of jwsList) {
    const creditInfo = await verifyCreditTransaction(jws);
    if (creditInfo) {
      const claim = await claimCreditTransaction(creditInfo.transactionId, identity);
      if (claim === "conflict") {
        // The verified JWS proves this device owns the Apple purchase, so a
        // binding to a prior identity (same person, new device / signed in with
        // Apple) transfers instead of walling with "already linked". The credits
        // were already issued once to the original owner, so don't re-grant —
        // just move ownership and report the current entitlement.
        console.warn("IAP credit transaction transferring to reclaiming account", creditInfo.transactionId);
        await transferCreditTransaction(creditInfo.transactionId, identity);
        tier = (await creditSummary(identity)).tier;
        continue;
      }
      const purchase = await grantForConsumableTransaction(identity, creditInfo.transactionId, creditInfo.productId);
      if (purchase.granted) {
        await noteRevenue(identity, {
          at: Date.now(), kind: "iap_topup", amountUsd: purchase.priceCents / 100, credits: purchase.credits
        });
      }
      anyGranted = anyGranted || purchase.granted;
      consumableGranted = consumableGranted || purchase.granted;
      tier = purchase.summary.tier;
      continue;
    }
    const info = await verifyTransaction(jws);
    if (!info) continue;
    // Remember who owns this subscription so server notifications (renewals,
    // refunds) can find the right ledger later.
    const subscriptionClaim = await linkTransactionIdentity(info.originalTransactionId, identity);
    if (subscriptionClaim === "conflict") {
      // Same Apple ID reclaiming its subscription on a new device: the verified
      // JWS proves ownership, so transfer the binding instead of refusing.
      console.warn("IAP subscription transferring to reclaiming account", info.originalTransactionId);
      await transferSubscriptionIdentity(info.originalTransactionId, identity);
    }
    // Skip clearly-expired auto-renewables (a stale entitlement).
    if (info.expiresDate && info.expiresDate < Date.now()) continue;
    const role = identity.startsWith("apple:")
      ? await claimPrimarySubscription(identity, info.originalTransactionId)
      : "primary";
    if (role === "secondary") {
      tier = (await creditSummary(identity)).tier;
      continue;
    }
    // Grant this cycle's credits only if no identity has claimed it yet; either
    // way the entitlement (tier) applies to the presenting device.
    const periodIsNew = await claimSubscriptionPeriod(info.periodKey);
    const r = periodIsNew
      ? await grantForTransaction(identity, info.tier, info.periodKey)
      : { granted: false, summary: await activateSubscriptionTier(identity, info.tier) };
    if (r.granted) {
      // Analytics: record the plan + gross revenue for this billing period.
      await noteTier(identity, info.tier, "subscription");
      const conf = TIERS[info.tier];
      if (conf) await noteRevenue(identity, { at: Date.now(), kind: "subscription", amountUsd: conf.priceUsd, credits: conf.creditsPerCycle, tier: info.tier });
    }
    anyGranted = anyGranted || r.granted;
    tier = r.summary.tier;
  }
  if (!tier) {
    res.status(ownershipConflict ? 409 : 400).json({ error: ownershipConflict ? "This App Store purchase is already linked to another Taki account." : "no valid StoreKit transaction" });
    return;
  }
  res.json({ ...(await creditSummary(identity)), granted: anyGranted, consumableGranted });
});

/* ---- Sign in with Apple (optional account) ------------------------------ */
// Verify the identity token, derive the stable Apple account id, and merge the
// device's existing credits into that account so they follow the user across
// devices. The Apple ledger identity is private sync state; the public Account
// ID remains the permanent eight-digit device number.
app.post("/api/account/apple", async (req, res) => {
  const b = req.body || {};
  const idToken = typeof b.identityToken === "string" ? b.identityToken : "";
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const identdata = await verifyAppleIdentityToken(idToken);
  if (!identdata) { res.status(401).json({ error: "invalid Apple identity token" }); return; }
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  if (!/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
  }
  const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
  const hasEntitlementSnapshot = Array.isArray(b.transactions);
  const entitlementJWS: string[] = hasEntitlementSnapshot
    ? b.transactions.filter((value: unknown) => typeof value === "string")
    : [];
  const ledgerIdentity = `apple:${identdata.sub}`;
  let duplicateSubscriptionNeedsCancellation = false;
  try {
    await linkApple(identdata.sub, deviceId);
    const priorDeviceUser = await userForIdentity(deviceId);
    const appleProfile = {
      sub: identdata.sub,
      email: identdata.email || priorDeviceUser.apple?.email,
      name: fullName || priorDeviceUser.apple?.name || undefined
    };
    await noteApple(deviceId, appleProfile);
    await noteApple(ledgerIdentity, appleProfile);
    await enrollApplePromotionalSubscriber({
      email: appleProfile.email,
      appleSub: identdata.sub,
      identity: ledgerIdentity
    });
    const priorAccountUser = await userForIdentity(ledgerIdentity);
    if (priorDeviceUser.engagement.updatedAt > priorAccountUser.engagement.updatedAt) {
      await noteEngagementPreferences(ledgerIdentity, priorDeviceUser.engagement);
    }
    await noteUser(deviceId, clientIp(req), String(req.headers?.["user-agent"] || ""));
    await noteUser(ledgerIdentity, clientIp(req), String(req.headers?.["user-agent"] || ""));
    const activeTransactionIds: string[] = [];
    for (const jws of entitlementJWS) {
      const info = await verifyTransaction(jws);
      if (!info || (info.expiresDate && info.expiresDate < Date.now())) continue;
      const claim = await linkTransactionIdentity(info.originalTransactionId, deviceId);
      if (claim === "conflict") {
        const binding = await getTransactionBinding(info.originalTransactionId);
        if (binding.identity === ledgerIdentity) activeTransactionIds.push(info.originalTransactionId);
        continue;
      }
      activeTransactionIds.push(info.originalTransactionId);
      await grantForTransaction(deviceId, info.tier, info.periodKey);
    }
    const deviceTransactions = hasEntitlementSnapshot
      ? [...new Set(activeTransactionIds)]
      : await transactionIdsForIdentity(deviceId);
    if (hasEntitlementSnapshot) {
      const historicalTransactions = await transactionIdsForIdentity(deviceId);
      for (const transactionId of historicalTransactions) {
        if (!deviceTransactions.includes(transactionId)) await clearRetiredSubscription(ledgerIdentity, transactionId);
      }
    }
    let primary = await primarySubscriptionForIdentity(ledgerIdentity);
    let subscriptionMode: "keep" | "convert" | "discard" = "keep";
    let secondaryTransactionId = "";

    if (!primary && deviceTransactions.length) {
      primary = deviceTransactions[0];
      await claimPrimarySubscription(ledgerIdentity, primary);
    } else {
      const decision = subscriptionMergeDecision(primary, deviceTransactions);
      subscriptionMode = decision.mode;
      secondaryTransactionId = decision.secondaryTransactionId;
      duplicateSubscriptionNeedsCancellation = decision.mode === "convert";
    }

    await mergeCredits(deviceId, ledgerIdentity, { subscriptionMode, secondaryTransactionId });
    await moveEmailConnection(deviceId, ledgerIdentity);
    await rebindCreditTransactions(deviceId, ledgerIdentity);
    for (const transactionId of deviceTransactions) {
      const role = transactionId === primary ? "primary" : "secondary";
      await setTransactionRole(transactionId, ledgerIdentity, role);
    }
  } catch (e) {
    console.error("apple link:", e);
    res.status(502).json({ error: "Taki couldn't finish connecting this Apple account. Please try again." });
    return;
  }
  const linkedDevices = (await devicesForApple(identdata.sub)).filter((d) => d !== deviceId);
  const accountUser = await userForIdentity(ledgerIdentity);
  res.json({ ledgerIdentity, deviceId, email: identdata.email || accountUser.apple?.email, linkedDevices, duplicateSubscriptionNeedsCancellation, engagement: accountUser.engagement, ...(await creditSummary(ledgerIdentity)), tiers: tierCatalog() });
});

app.post("/api/account/delete", async (req, res) => {
  const identityToken = typeof req.body?.identityToken === "string" ? req.body.identityToken : "";
  const authorizationCode = typeof req.body?.authorizationCode === "string" ? req.body.authorizationCode : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const expectedLedgerIdentity = typeof req.body?.expectedLedgerIdentity === "string"
    ? req.body.expectedLedgerIdentity.trim()
    : typeof req.body?.expectedAccountId === "string" ? req.body.expectedAccountId.trim() : "";
  const apple = await verifyAppleIdentityToken(identityToken);
  if (!apple || !authorizationCode) { res.status(401).json({ error: "Apple reauthentication required" }); return; }
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }

  const accountId = `apple:${apple.sub}`;
  if (!expectedLedgerIdentity || expectedLedgerIdentity !== accountId) {
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
// Set this URL in App Store Connect (Production + Sandbox). Return a non-2xx
// response when persistence fails so Apple retries an unhandled notification.
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
    res.status(500).json({ error: "notification processing failed" });
    return;
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

function resetPreviewForAdmin(preview: FullResetPreview) {
  const { fingerprint: _fingerprint, activeStripeSubscriptionIds: _subscriptionIds, ...safe } = preview;
  return safe;
}

async function fullResetPreviewWithStripe(): Promise<FullResetPreview> {
  const preview = await previewFullReset();
  if (!stripe) return preview;

  const candidates = new Set(preview.activeStripeSubscriptionIds);
  for await (const session of stripe.checkout.sessions.list({ limit: 100 })) {
    if (session.mode !== "subscription" || session.metadata?.purchaseType !== "plan") continue;
    const id = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (id) candidates.add(id);
  }

  const active: string[] = [];
  for (const id of candidates) {
    try {
      const subscription = await stripe.subscriptions.retrieve(id);
      if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") active.push(id);
    } catch (error: any) {
      if (error?.code !== "resource_missing") throw error;
    }
  }
  active.sort();
  preview.activeStripeSubscriptionIds = active;
  preview.activeStripeSubscriptions = active.length;
  preview.fingerprint = `${preview.fingerprint}:stripe:${active.join(",")}`;
  return preview;
}

async function waitForOtherRequests(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (activeRequests > 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (activeRequests > 1) throw new Error("Other requests are still running. Wait a moment and retry the reset.");
}

async function cancelStripeSubscriptionsForFullReset(ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (!stripe) throw new Error("Stripe is not configured, so active subscriptions cannot be canceled safely.");
  const failures: string[] = [];
  for (const id of ids) {
    try {
      const subscription = await stripe.subscriptions.retrieve(id);
      if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
        await stripe.subscriptions.cancel(id);
      }
    } catch (error: any) {
      // A deleted Stripe object cannot continue billing and is safe to treat as
      // already canceled. Every other error blocks the data reset.
      if (error?.code !== "resource_missing") failures.push(id);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} Stripe subscription${failures.length === 1 ? "" : "s"} could not be canceled.`);
  }
}

// Generates a short-lived snapshot. The destructive request must present this
// token and the database must still match it, preventing a reset based on stale
// counts or a confirmation copied from an earlier session.
app.post("/api/admin/full-reset-preview", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    const preview = await fullResetPreviewWithStripe();
    const previewToken = randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    fullResetPreviews.clear();
    fullResetPreviews.set(previewToken, { expiresAt, fingerprint: preview.fingerprint });
    res.json({
      ok: true,
      preview: resetPreviewForAdmin(preview),
      previewToken,
      expiresAt,
      confirmationPhrase: FULL_RESET_PHRASE,
      appleSubscriptionWarning: "Apple subscriptions are managed by the App Store and are not canceled by this reset."
    });
  } catch (error) {
    console.error("Full reset preview failed:", error);
    res.status(503).json({ error: "Production storage could not be enumerated. Nothing was deleted." });
  }
});

app.post("/api/admin/full-reset", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const previewToken = typeof req.body?.previewToken === "string" ? req.body.previewToken : "";
  const pending = fullResetPreviews.get(previewToken);
  if (!pending || pending.expiresAt < Date.now()) {
    res.status(409).json({ error: "The reset preview expired. Run a new preview." });
    return;
  }
  if (req.body?.confirmation !== FULL_RESET_PHRASE) {
    res.status(400).json({ error: "The reset confirmation phrase did not match." });
    return;
  }

  let resetCommitted = false;
  try {
    fullResetInProgress = true;
    await waitForOtherRequests();
    const current = await fullResetPreviewWithStripe();
    if (current.fingerprint !== pending.fingerprint) {
      fullResetInProgress = false;
      fullResetPreviews.delete(previewToken);
      res.status(409).json({ error: "Production data changed after the preview. Review a fresh preview before resetting." });
      return;
    }
    if (current.activeStripeSubscriptionIds.length && req.body?.cancelStripeSubscriptions !== true) {
      fullResetInProgress = false;
      res.status(409).json({ error: "Active Stripe subscriptions must be canceled before their account records can be deleted." });
      return;
    }

    await cancelStripeSubscriptionsForFullReset(current.activeStripeSubscriptionIds);
    await clearPushStateForReset();
    clearAlertsForReset();
    const resetEpoch = Date.now();
    const result = await performFullReset(resetEpoch);
    resetCommitted = true;
    fullResetPreviews.clear();
    pendingVoiceSyntheses.clear();
    res.on("finish", () => setTimeout(() => process.exit(0), 750));
    res.json({ ok: true, resetEpoch, canceledStripeSubscriptions: current.activeStripeSubscriptionIds.length, ...result });
  } catch (error) {
    if (!resetCommitted) fullResetInProgress = false;
    console.error("Full reset failed:", error);
    res.status(503).json({ error: error instanceof Error ? error.message : "The full reset failed. Nothing else was attempted." });
  }
});

function money(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function canonicalAccountIdentity(identity: string): Promise<string> {
  if (identity.startsWith("apple:")) return identity;
  const record = await userForIdentity(identity);
  const sub = record.apple?.sub || await appleForDevice(identity);
  return sub ? `apple:${sub}` : identity;
}

function combineAdminUsers(identity: string, records: UserRecord[]): UserRecord {
  const activeDays = [...new Set(records.flatMap((record) => record.activeDays || []))].sort().slice(-120);
  const featureUsage: Record<string, number> = {};
  for (const record of records) {
    for (const [feature, count] of Object.entries(record.analytics.featureUsage || {})) {
      featureUsage[feature] = (featureUsage[feature] || 0) + Number(count || 0);
    }
  }
  const engagementRecord = [...records]
    .sort((a, b) => Number(b.engagement?.updatedAt || 0) - Number(a.engagement?.updatedAt || 0))[0];
  const firstSeen = records.map((record) => record.firstSeenAt).filter((value) => value > 0);
  const apple = records.map((record) => record.apple).find((value) => value?.email)
    || records.map((record) => record.apple).find(Boolean);
  return {
    identity,
    firstSeenAt: firstSeen.length ? Math.min(...firstSeen) : 0,
    lastSeenAt: Math.max(0, ...records.map((record) => record.lastSeenAt || 0)),
    requestCount: records.reduce((sum, record) => sum + Number(record.requestCount || 0), 0),
    creditsUsed: records.reduce((sum, record) => sum + Number(record.creditsUsed || 0), 0),
    tier: records.find((record) => record.identity === identity)?.tier || records[0]?.tier || "free",
    tierHistory: records.flatMap((record) => record.tierHistory || []).sort((a, b) => a.at - b.at).slice(-100),
    deviceType: records.map((record) => record.deviceType).find(Boolean),
    ips: [...new Set(records.flatMap((record) => record.ips || []))].slice(-50),
    apple,
    revenueUsd: records.reduce((sum, record) => sum + Number(record.revenueUsd || 0), 0),
    purchases: records.flatMap((record) => record.purchases || []).sort((a, b) => b.at - a.at).slice(0, 200),
    device: records.map((record) => record.device).find((value) => value?.takiName)
      || records.map((record) => record.device).find(Boolean),
    activeDays,
    analytics: {
      textQuestions: records.reduce((sum, record) => sum + Number(record.analytics.textQuestions || 0), 0),
      voiceQuestions: records.reduce((sum, record) => sum + Number(record.analytics.voiceQuestions || 0), 0),
      textCostUsd: records.reduce((sum, record) => sum + Number(record.analytics.textCostUsd || 0), 0),
      voiceCostUsd: records.reduce((sum, record) => sum + Number(record.analytics.voiceCostUsd || 0), 0),
      featureUsage,
      recentQuestions: records.flatMap((record) => record.analytics.recentQuestions || []).sort((a, b) => b.at - a.at).slice(0, 100),
      lastQuestionAt: Math.max(0, ...records.map((record) => record.analytics.lastQuestionAt || 0)) || undefined,
      sessions: records.reduce((sum, record) => sum + Number(record.analytics.sessions || 0), 0),
      totalSessionSeconds: records.reduce((sum, record) => sum + Number(record.analytics.totalSessionSeconds || 0), 0),
      recentSessions: records.flatMap((record) => record.analytics.recentSessions || []).sort((a, b) => b.at - a.at).slice(0, 100)
    },
    engagement: engagementRecord?.engagement || { interests: [], pushEnabled: false, emailEnabled: false, updatedAt: 0 }
  };
}

async function buildAdminAccount(requestedIdentity: string) {
  const identity = await canonicalAccountIdentity(requestedIdentity);
  const appleSub = identity.startsWith("apple:") ? identity.slice("apple:".length) : "";
  const deviceIds = appleSub ? await devicesForApple(appleSub) : [identity];
  const memberIds = [...new Set([identity, ...deviceIds])];
  const records = await Promise.all(memberIds.map(userForIdentity));
  const user = combineAdminUsers(identity, records);
  const credit = await creditSummary(identity);
  user.tier = credit.tier;
  const safetyAccounts = await Promise.all(memberIds.map(getSafetyAccount));
  const status = safetyAccounts.some((account) => account.status === "terminated")
    ? "terminated"
    : safetyAccounts.some((account) => account.status === "suspended") ? "suspended" : "active";
  const strikes = Math.max(0, ...safetyAccounts.map((account) => Number(account.strikes || 0)));
  const trackedTextCostUsd = money(user.analytics.textCostUsd, 6);
  const trackedVoiceCostUsd = money(user.analytics.voiceCostUsd, 6);
  const trackedCostUsd = trackedTextCostUsd + trackedVoiceCostUsd;
  const chargedCostBaseline = user.creditsUsed * CREDIT_USD;
  const legacyUnallocatedCostUsd = money(Math.max(0, chargedCostBaseline - trackedCostUsd), 6);
  const costUsd = money(trackedCostUsd + legacyUnallocatedCostUsd, 2);
  let netRevenueUsd = 0;
  for (const purchase of user.purchases) {
    netRevenueUsd += purchase.kind === "topup" || purchase.kind === "web_subscription"
      ? Math.max(0, purchase.amountUsd * 0.971 - 0.30)
      : purchase.amountUsd * 0.85;
  }
  netRevenueUsd = money(netRevenueUsd);
  const grossRevenueUsd = money(user.revenueUsd);
  const profitUsd = money(netRevenueUsd - costUsd);
  const activeDays30 = user.activeDays.filter((day) => Date.now() - Date.parse(`${day}T00:00:00Z`) < 30 * 86400_000).length;
  const highValue = (netRevenueUsd >= 25 && profitUsd >= 8) || (user.purchases.length >= 3 && profitUsd > 10) || grossRevenueUsd >= 75;
  const paid = credit.tier !== "free" || grossRevenueUsd > 0;
  const inactiveDays = user.lastSeenAt ? Math.floor((Date.now() - user.lastSeenAt) / 86400_000) : 9999;
  const segment = status !== "active" ? status
    : highValue ? "high_value"
    : paid && inactiveDays >= 14 ? "at_risk"
    : paid ? "growing"
    : activeDays30 >= 5 ? "engaged"
    : user.firstSeenAt && Date.now() - user.firstSeenAt < 7 * 86400_000 ? "new"
    : "standard";
  const neighbors = new Set<string>();
  for (const ip of user.ips) {
    for (const neighbor of await identitiesForIp(ip)) if (!memberIds.includes(neighbor)) neighbors.add(neighbor);
  }
  const devices = records
    .filter((record) => !record.identity.startsWith("apple:"))
    .map((record) => ({
      id: record.identity,
      name: record.device?.name || "",
      model: record.device?.model || record.deviceType || "Unknown device",
      identifier: record.device?.identifier || "",
      takiName: record.device?.takiName || "",
      lastSeenAt: record.device?.lastSeenAt || record.lastSeenAt
    }));
  const engagement = await engagementSummary(user);
  const displayName = user.apple?.name || user.device?.takiName || devices.map((device) => ownerNameFromDeviceName(device.name)).find(Boolean) || "Taki user";
  const common = {
    identity,
    displayName,
    email: user.apple?.email || "",
    tier: credit.tier,
    balance: credit.balance,
    status,
    strikes,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
    activeDays30,
    textQuestions: user.analytics.textQuestions,
    voiceQuestions: user.analytics.voiceQuestions,
    totalQuestions: user.analytics.textQuestions + user.analytics.voiceQuestions,
    sessions: user.analytics.sessions,
    averageSessionSeconds: user.analytics.sessions ? Math.round(user.analytics.totalSessionSeconds / user.analytics.sessions) : 0,
    textCostUsd: trackedTextCostUsd,
    voiceCostUsd: trackedVoiceCostUsd,
    legacyUnallocatedCostUsd,
    costUsd,
    grossRevenueUsd,
    netRevenueUsd,
    profitUsd,
    highValue,
    segment,
    deviceCount: devices.length,
    topFeatures: Object.entries(user.analytics.featureUsage).sort((a, b) => b[1] - a[1]).slice(0, 5),
    engagementPreferences: user.engagement
  };
  return {
    row: common,
    detail: {
      ...common,
      credits: credit,
      featureUsage: user.analytics.featureUsage,
      recentQuestions: user.analytics.recentQuestions,
      activeDays: user.activeDays,
      purchases: user.purchases,
      tierHistory: user.tierHistory,
      devices,
      ips: user.ips,
      ipNeighbors: [...neighbors],
      linkedIdentities: memberIds,
      engagement
    },
    user,
    deviceIds
  };
}

async function canonicalAdminIdentities(): Promise<string[]> {
  const users = await allUsers();
  const identities = new Set<string>();
  for (const user of users) identities.add(await canonicalAccountIdentity(user.identity));
  return [...identities];
}

// Account-level feed: linked devices roll into one customer, while detail pages
// retain device, feature, cost, purchase, engagement, and safety information.
app.post("/api/admin/users", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const accounts = await Promise.all((await canonicalAdminIdentities()).map(buildAdminAccount));
  const rows = accounts.map((account) => account.row).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const totals = rows.reduce((total, row) => ({
    users: total.users + 1,
    highValue: total.highValue + (row.highValue ? 1 : 0),
    questions: total.questions + row.totalQuestions,
    gross: total.gross + row.grossRevenueUsd,
    net: total.net + row.netRevenueUsd,
    cost: total.cost + row.costUsd,
    profit: total.profit + row.profitUsd
  }), { users: 0, highValue: 0, questions: 0, gross: 0, net: 0, cost: 0, profit: 0 });
  res.json({ users: rows, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, typeof value === "number" ? money(value) : value])), emailConfigured: isEngagementEmailConfigured(), pushConfigured: isPushConfigured() });
});

// Promotional email is intentionally separate from the optional personalized
// engagement setting. Every account that supplied an Apple Sign-in email is
// enrolled once, while an unsubscribe is permanent unless the person opts back
// in through a future account setting.
app.post("/api/admin/promotional/summary", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  await backfillApplePromotionalSubscribers(await allUsers());
  res.json(await promotionalSummary());
});

app.post("/api/admin/promotional/send", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  if (req.body?.confirmation !== "SEND PROMOTIONAL EMAIL") {
    res.status(400).json({ error: "Enter the confirmation phrase before sending a promotional email." });
    return;
  }
  try {
    await backfillApplePromotionalSubscribers(await allUsers());
    const campaign = await sendPromotionalCampaign({
      subject: req.body?.subject,
      body: req.body?.body,
      ctaLabel: req.body?.ctaLabel,
      ctaUrl: req.body?.ctaUrl
    });
    res.json({ ok: campaign.failed === 0, campaign, summary: await promotionalSummary() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Promotional email could not be sent." });
  }
});

app.post("/api/admin/account", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  res.json({ account: (await buildAdminAccount(identity)).detail });
});

app.post("/api/admin/engagement-preview", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const channel: EngagementChannel = req.body?.channel === "email" ? "email" : "push";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const account = await buildAdminAccount(identity);
  res.json({ preview: await recommendedEngagement(account.user, channel), enabled: channel === "push" ? account.user.engagement.pushEnabled : account.user.engagement.emailEnabled });
});

app.post("/api/admin/engagement-send", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const channel: EngagementChannel = req.body?.channel === "email" ? "email" : "push";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const account = await buildAdminAccount(identity);
  const enabled = channel === "push" ? account.user.engagement.pushEnabled : account.user.engagement.emailEnabled;
  if (!enabled) { res.status(409).json({ error: `The user has not enabled personalized ${channel}.` }); return; }
  const result = await sendPersonalizedEngagement(account.user, channel, account.deviceIds, "admin");
  res.status(result.ok ? 200 : 502).json(result);
});

let engagementTickBusy = false;
async function tickPersonalizedEngagement(): Promise<void> {
  if (engagementTickBusy || (!isPushConfigured() && !isEngagementEmailConfigured())) return;
  engagementTickBusy = true;
  try {
    for (const identity of await canonicalAdminIdentities()) {
      const account = await buildAdminAccount(identity);
      let sentPush = false;
      if (isPushConfigured() && await shouldSendAutomatic(account.user, "push")) {
        sentPush = (await sendPersonalizedEngagement(account.user, "push", account.deviceIds, "automatic")).ok;
      }
      if (!sentPush && isEngagementEmailConfigured() && await shouldSendAutomatic(account.user, "email")) {
        await sendPersonalizedEngagement(account.user, "email", account.deviceIds, "automatic");
      }
    }
  } catch (error) {
    console.error("Personalized engagement tick:", error);
  } finally {
    engagementTickBusy = false;
  }
}
setInterval(() => { void tickPersonalizedEngagement(); }, 60 * 60 * 1000);

// Travel time for the commute Live Activity, by mode (driving w/ traffic,
// walking, bicycling, transit) via Google Directions. 502 if no key/route so
// the device can fall back to MapKit for driving/walking.
app.post("/api/travel-time", async (req, res) => {
  const deviceId = normalizeTopupIdentity(typeof req.body?.deviceId === "string" ? req.body.deviceId : "");
  const fromLat = Number(req.body?.fromLat);
  const fromLon = Number(req.body?.fromLon);
  const toLat = Number(req.body?.toLat);
  const toLon = Number(req.body?.toLon);
  const mode = typeof req.body?.mode === "string" ? req.body.mode : "driving";
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) {
    res.status(400).json({ error: "from/to coordinates required" });
    return;
  }
  if (!/^\d{8}$/.test(deviceId) || !(await isKnownIdentity(deviceId))) {
    res.status(401).json({ error: "registered device required" }); return;
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
  voiceInputUsd = 0,
  beforeUsageCommit?: (details: { response: any; deferVoiceSynthesis: boolean; includedVoice: boolean }) => Promise<void>
): Promise<any> {
  let tier: Tier = "free";
  let baseCredits = 0;     // remaining base-subscription credits (for free-voice check)
  let voiceCycleUsed = 0;  // free voice turns used this cycle
  let voiceLifetimeUsed = 0;
  let usageSummary: Awaited<ReturnType<typeof creditSummary>> | null = null;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    usageSummary = sum;
    tier = sum.tier;
    baseCredits = sum.baseCredits;
    voiceCycleUsed = sum.voiceCycleUsed;
    voiceLifetimeUsed = sum.voiceUsed;
    const block = usageBlockFor(sum, MIN_REQUEST_CREDITS, voiceMode);
    if (block) return usageBlockedPayload(block);
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
    const modelAndSearchUsd = totalUsageUsd(measured.usage);
    const voiceOutputUsd = voiceMode && !deferVoiceSynthesis
      ? ttsCostUsd(speechCharacterCount(finalized.spokenText || ""))
      : 0;
    const ownerCostUsd = modelAndSearchUsd + (voiceMode ? Math.max(0, voiceInputUsd) + voiceOutputUsd : 0);
    // Voice: free within the per-cycle allowance on Plus Voice / Pro (base credits
    // only); beyond that, or on top-ups / other tiers, pay per spoken character.
    const charge = decideAssistantCharge({
      summary: usageSummary,
      tier,
      voiceMode,
      includedVoice: voiceMode && isFreeVoice(tier, baseCredits, voiceCycleUsed, voiceLifetimeUsed),
      baseUsd: modelAndSearchUsd,
      voiceInputUsd,
      voiceOutputUsd
    });
    // The block check comes first: a refused turn must not burn an included
    // voice turn the user never got to hear.
    if (charge.block) return usageBlockedPayload(charge.block);
    if (beforeUsageCommit) {
      await beforeUsageCommit({ response: finalized, deferVoiceSynthesis, includedVoice: charge.includedVoice });
    }
    if (charge.consumeIncludedVoice) await noteFreeVoice(deviceId);
    const voiceSynthesisIncluded = charge.includedVoice;
    const s = await spendUsageUsd(deviceId, charge.usageUsd);
    await noteSpend(deviceId, s.spent);
    await noteInteraction(deviceId, {
      channel: voiceMode ? "voice" : "text",
      feature: assistantFeature(finalized),
      credits: s.spent,
      costUsd: ownerCostUsd
    });
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
  const userMessage = String(req.body?.message || "").slice(0, 12_000);
  const rawContext = typeof req.body?.context === "string" ? req.body.context.slice(-120_000) : "";
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
    const result = await runAssistant(state, deviceId, voiceMode);
    if (result?.usageBlocked) { res.status(402).json(result); return; }
    res.json(result);
  } catch (error) {
    // Vendor outage (Gemini quota/auth/down): reply immediately with a spoken
    // message instead of a bare 502 the app can't voice.
    if (error instanceof ServiceError) {
      res.status(503).json({
        ...finalizeResponse({ spokenText: error.spoken, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
        serviceUnavailable: true,
        serviceError: error.kind
      });
      return;
    }
    console.error("Assistant route error:", error);
    // Do not make a second model call here: the first request may have completed
    // before persistence failed, and retrying would double provider cost.
    res.status(502).json({ error: "assistant unavailable" });
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
  const rawContext = typeof req.body?.context === "string" ? req.body.context.slice(-120_000) : "";
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!(await requireCreditIdentity(deviceId, res))) return;
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  if (voiceId && !(await listVoices()).some((voice) => voice.id === voiceId)) {
    res.status(400).json({ error: "voice is not available" }); return;
  }
  const voiceVariability = typeof req.body?.voiceVariability === "number"
    ? Math.max(0, Math.min(1, req.body.voiceVariability))
    : 0.5;
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  await captureRequestDeviceInfo(req, userProfile.name);
  if (!audioBase64 && !deviceTranscript) { res.status(400).json({ error: "audioBase64 or transcript required" }); return; }

  // The first five Free-tier turns include speech. Later turns continue normally
  // and charge STT/TTS against credits instead of hard-blocking Voice.
  let freeTier = false;
  const voiceSummary = await creditSummary(deviceId);
  freeTier = voiceSummary.tier === "free";
  const voiceBlock = usageBlockFor(voiceSummary, MIN_REQUEST_CREDITS, true);
  if (voiceBlock) { res.status(402).json(usageBlockedPayload(voiceBlock)); return; }

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
    const state = buildConversationState(transcript, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, true, deviceId);
    let audio = "";
    const result = await runAssistant(
      state,
      deviceId,
      true,
      req.body?.deferredActionSynthesis === true,
      usedCloudTranscription ? sttCostUsd(audioDurationMs) : 0,
      async ({ response, deferVoiceSynthesis }) => {
        if (deferVoiceSynthesis) return;
        audio = await synthesize(response.spokenText || "", voiceId, voiceVariability);
        if (!audio && (response.spokenText || "").trim()) {
          throw new ServiceError("voice_unavailable", VOICE_UNAVAILABLE_SPOKEN);
        }
      }
    );
    if (result?.usageBlocked) { res.status(402).json(result); return; }
    let voiceUsed: number | undefined;
    if (freeTier && deviceId) {
      voiceUsed = await noteVoiceQuestion(deviceId);
      if (result.credits) {
        const updated = await creditSummary(deviceId);
        result.credits = { ...result.credits, ...updated, cost: result.credits.cost };
      }
    }
    res.json({ ...result, transcript, transcriptionSource: deviceTranscript ? "device" : "cloud", audioBase64: audio, mime: "audio/mpeg", voiceUsed });
  } catch (error) {
    // Vendor outage: speak the message right away. For an AI (Gemini) outage
    // ElevenLabs is usually fine, so voice it in the user's selected voice; for
    // a voice outage there's nothing to synthesize with, so return text and let
    // the phone read it aloud.
    if (error instanceof ServiceError) {
      let audio = "";
      if (error.kind !== "voice_unavailable") {
        try { audio = await synthesize(error.spoken, voiceId, voiceVariability); } catch { /* text-only fallback */ }
      }
      res.status(503).json({
        transcript: deviceTranscript || "",
        spokenText: error.spoken,
        action: null,
        actions: null,
        audioBase64: audio,
        mime: "audio/mpeg",
        serviceUnavailable: true,
        serviceError: error.kind
      });
      return;
    }
    console.error("Voice route error:", error);
    res.status(502).json({ error: "voice unavailable" });
  }
});

const memoryExtractWindows = new Map<string, { startedAt: number; count: number }>();
app.post("/api/memory/extract", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 2000) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
  if (memoryExtractWindows.size > 5_000) {
    for (const [key, value] of memoryExtractWindows) {
      if (now - value.startedAt >= 60_000) memoryExtractWindows.delete(key);
    }
  }
  const currentFacts = Array.isArray(req.body?.currentFacts) ? req.body.currentFacts : [];
  const measured = await measureUsage(() => extractDurableMemories(message, currentFacts, req.body?.teen === true));
  await chargeMeasuredUsage(deviceId, measured.usage);
  res.json(measured.value);
});

app.post("/api/chat/title", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1200) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res))) return;
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
app.get("/api/voices", async (req, res) => {
  if (!(await requireCreditIdentity(req.query?.deviceId, res))) return;
  res.json({ voices: await listVoices() });
});

// Re-synthesize a corrected voice result after the phone attempts an action.
// Used when native execution returns a more accurate success line or an error.
const correctionSynthWindows = new Map<string, { startedAt: number; count: number }>();
app.post("/api/voice/synthesize", async (req, res) => {
  if (!isVoiceConfigured()) { res.status(503).json({ error: "voice not configured" }); return; }
  const rawText = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 4000) : "";
  const text = briefForVoice(rawText);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  const deferredToken = typeof req.body?.deferredVoiceSynthesisToken === "string"
    ? req.body.deferredVoiceSynthesisToken.trim()
    : "";
  const variability = typeof req.body?.voiceVariability === "number"
    ? Math.max(0, Math.min(1, req.body.voiceVariability))
    : 0.5;
  if (!text || !deviceId) { res.status(400).json({ error: "text and deviceId required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res))) return;
  if (voiceId && !(await listVoices()).some((voice) => voice.id === voiceId)) {
    res.status(400).json({ error: "voice is not available" }); return;
  }
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
    // Included speech comes only from the single-use token issued with the
    // deferred answer. A missing or expired token means this synthesis is paid
    // for — and must clear the affordability check BEFORE ElevenLabs runs.
    const pending = deferredToken ? takeVoiceSynthesisToken(deferredToken, deviceId) : null;
    const account = await creditSummary(deviceId);
    const plan = planCorrectionSynthesis(pending, account, speechCharacterCount(text));
    if (!plan.allowed) { res.status(402).json({ error: plan.message }); return; }
    const audio = await synthesize(text, voiceId, variability);
    if (!audio) throw new Error("Voice synthesis returned no audio");
    const speechUsd = ttsCostUsd(speechCharacterCount(text));
    await noteChannelCost(deviceId, "voice", speechUsd);
    if (!plan.included) {
      const charged = await spendUsageUsd(deviceId, speechUsd);
      await noteSpend(deviceId, charged.spent);
    }
    res.json({ audioBase64: audio, mime: "audio/mpeg", spokenText: text });
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
const voiceSampleWindows = new Map<string, { startedAt: number; count: number }>();
app.get("/api/voice/sample", async (req, res) => {
  if (!isVoiceConfigured()) { res.status(503).json({ error: "voice not configured" }); return; }
  const deviceId = await requireCreditIdentity(req.query?.deviceId, res);
  if (!deviceId) return;
  const voiceId = typeof req.query?.voiceId === "string" ? req.query.voiceId.trim() : "";
  if (voiceId && !(await listVoices()).some((voice) => voice.id === voiceId)) {
    res.status(400).json({ error: "voice is not available" });
    return;
  }
  const now = Date.now();
  const rateKey = `${deviceId}:${clientIp(req)}`;
  const prior = voiceSampleWindows.get(rateKey);
  const windowState = !prior || now - prior.startedAt >= 60_000 ? { startedAt: now, count: 0 } : prior;
  if (windowState.count >= 20) { res.status(429).json({ error: "voice preview limit reached" }); return; }
  windowState.count += 1;
  voiceSampleWindows.set(rateKey, windowState);
  if (voiceSampleWindows.size > 5_000) {
    for (const [key, value] of voiceSampleWindows) {
      if (now - value.startedAt >= 60_000) voiceSampleWindows.delete(key);
    }
  }
  res.set("Cache-Control", "private, max-age=604800, immutable");
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
