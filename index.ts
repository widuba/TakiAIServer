import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PORT, ACTIVE_AI_PROVIDER, MAIN_MODEL, PLANNER_MODEL, RESEARCH_MODEL, ServiceError, VOICE_UNAVAILABLE_SPOKEN, normalizeTakiModel, withTakiModel } from "./src/ai.js";
import type { DeviceLocation, DeviceWeather } from "./src/types.js";
import { buildConversationState } from "./src/context.js";
import { planAssistantResponse } from "./src/planner.js";
import { finalizeResponse } from "./src/validators.js";
import { styleInCharacter, getWeatherSnapshot, inferEventDestination, matchEventToQuery, getTravelTime, answerAboutImage, answerAboutAttachments, fitVoiceResponse } from "./src/tools.js";
import type { TakiAttachment } from "./src/tools.js";
// getTravelTime (above) also powers the background commute push loop.
import { briefForVoice, withTimeout } from "./src/util.js";
import { parseIncomingStyleProfiles } from "./src/messageStyle.js";
import { parseUserPersona } from "./src/persona.js";
import {
  registerToken, forgetToken, broadcast, getRegisteredTokens, isPushConfigured,
  registerLiveActivity, unregisterLiveActivity, getLiveActivities, sendLiveActivityUpdate, clearPushStateForReset
} from "./src/push.js";
import { cachedTrackerSnapshot } from "./src/tracker.js";
import { extractFlightCode, normalizeTrackerKind } from "./src/entityClassifier.js";
import { clearPushToken, getPushToken, setPushToken, syncNudges, tickNudges } from "./src/nudges.js";
import { addAlert, listAlerts, cancelAlerts, pollAlerts, clearAlertsForReset, type Alert } from "./src/alerts.js";
import { isDurable, storeDelete, storeDeleteCategory, storeGet, storeSet, storeUpdate } from "./src/store.js";
import { summary as creditSummary, chargeUsageUsd, InsufficientCreditsError, reset as resetCredits, tierCatalog, grantForTransaction, activateSubscriptionTier, updateSubscriptionStatus, grantForConsumableTransaction, grantWebTopup, grantAdminCredits, adminCreditAdjustments, MAX_ADMIN_CREDIT_GRANT, downgradeToFree, revokeSubscription, revokeMergedSubscriptionCredits, clearRetiredSubscription, mergeCredits, topupPriceCents, topupCentsPerCredit, inAppCreditsForProduct, IN_APP_CREDIT_PRODUCTS, attachmentBaseCostCredits, ATTACHMENT_BASE_CREDITS, CREDIT_TOPUP_MIN, CREDIT_TOPUP_MAX, MIN_REQUEST_CREDITS, CREDIT_USD, type Tier } from "./src/credits.js";
import { measureUsage, sttCostUsd, totalUsageUsd, ttsCostUsd } from "./src/metering.js";
import { decideAssistantCharge, planCorrectionSynthesis, usageBlockFor, usageBlockedPayload, voiceTurnEstimateCredits } from "./src/usage.js";
import { verifyTransaction, verifyCreditTransaction, claimCreditTransaction, transferCreditTransaction, rebindCreditTransactions, linkTransactionIdentity, transferSubscriptionIdentity, claimSubscriptionPeriod, releaseSubscriptionPeriod, transactionIdsForIdentity, setTransactionRole, getTransactionBinding, primarySubscriptionForIdentity, claimPrimarySubscription, subscriptionMergeDecision, verifyNotification } from "./src/iap.js";
import { revokeAppleAuthorizationCode, verifyAppleIdentityToken } from "./src/appleauth.js";
import { purgeAppleAccount, purgeStandaloneAccount } from "./src/accountDeletion.js";
import { recordAssoc, isBanned, isTestRestricted, setTestRestriction, clearTestRestriction, previewTermination, getSafetyAccount, reinstate, terminateAndBan, unban, warnUser, suspendAccount, acknowledgeNotice, safetyDetailFor, allSafetyAccounts, retireBannedIps, retiredBannedIps, reviewQueue, linkApple, devicesForApple, appleForDevice, SUSPENDED_MSG, BANNED_MSG } from "./src/safety.js";
import { queueContextualSafetyReview } from "./src/safetyReview.js";
import { noteUser, noteUserStrict, noteSpend, noteTier, noteRevenue, noteApple, noteDevice, noteInteraction, noteChannelCost, noteSession, noteEngagementPreferences, noteBillingEvent, userForIdentity, identitiesForIp, allUsers, deleteUser, type UserRecord } from "./src/users.js";
import { TIERS } from "./src/credits.js";
import { billableAudioDurationMs, transcribe, synthesize, splitTextForProgressiveSpeech, listVoices, isVoiceConfigured, PIRATE_MARSHAL_VOICE_ID, speechCharacterCount, shouldAskForVoiceRepeat, VOICE_REPEAT_PROMPT, normalizeSpeechKeyterms } from "./src/voice.js";
import { extractDurableMemories } from "./src/userMemory.js";
import { createChatTitle } from "./src/chatTitle.js";
import { engagementSummary, isEngagementEmailConfigured, recordEngagementOpen, recordEngagementSession, recommendedEngagement, sendPersonalizedEngagement, shouldSendAutomatic, type EngagementChannel } from "./src/engagement.js";
import { backfillApplePromotionalSubscribers, enrollApplePromotionalSubscriber, promotionalSummary, sendPromotionalCampaign, unsubscribePromotionalEmail } from "./src/promotional.js";
import { performFullReset, previewFullReset, type FullResetPreview } from "./src/fullReset.js";
import { bypassResetGeneration, hasCurrentResetGeneration, RESET_EPOCH_HEADER } from "./src/resetGeneration.js";
import { isKnownIdentity, markWebAuthenticated, issueDeviceCredential, verifyDeviceCredential, issueWebSession, verifyWebSession, revokeWebAuthentication } from "./src/identity.js";
import { bypassDeviceAuth } from "./src/deviceAuth.js";
import { googleWebClientId, isGoogleWebAuthConfigured, verifyGoogleIdToken } from "./src/webauth.js";
import { isProductKnowledgeQuestion, productAnswerFor } from "./src/productKnowledge.js";
import { readSyncedChats, syncChats } from "./src/chatSync.js";
import { TurnReplayCache } from "./src/turnReplay.js";
import { commitSignupSlot, MAX_ACCOUNTS_PER_IP, releaseSignupSlot, reserveSignupSlot } from "./src/registration.js";

// Admin secret guarding the dev credits-reset endpoint. Set ADMIN_SECRET on
// Render. (The purchase-simulating grant endpoint was removed when real
// StoreKit IAP shipped — grants only happen via verified transactions now.)
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();
// Browser checkout uses a short-lived signed handoff. Keep this secret
// available before the device-auth middleware so a page that still has an
// older cached script can present a valid handoff token alongside its legacy
// Account ID without being mistaken for an uncredentialed physical device.
const PURCHASE_LINK_SECRET = process.env.PURCHASE_LINK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_SECRET_KEY || "";
const APNS_TOKEN_RE = /^[a-f0-9]{32,256}$/i;

type PendingVoiceSynthesis = { deviceId: string; included: boolean; expiresAt: number; inFlight: boolean };
const pendingVoiceSyntheses = new Map<string, PendingVoiceSynthesis>();
const assistantTurnReplay = new TurnReplayCache<any>();
const FULL_RESET_PHRASE = "DELETE EVERY TAKI ACCOUNT AND ALL DATA";
const FULL_RESET_PREVIEW_KEY = "system:full-reset-preview";
const fullResetPreviews = new Map<string, { expiresAt: number; fingerprint: string }>();
let fullResetInProgress = false;
let activeRequests = 0;

function turnMeteringRequestId(value: unknown, ...fingerprintParts: string[]): string {
  const supplied = typeof value === "string" ? value.trim().slice(0, 128) : "";
  // Request ids come from the signed app bundle but still remain untrusted.
  // Binding the id to the exact turn prevents a modified client from reusing
  // one id for different prompts to evade metering.
  const clientId = /^[a-zA-Z0-9-]{16,128}$/.test(supplied) ? supplied : randomUUID();
  const fingerprint = createHash("sha256");
  for (const part of fingerprintParts) fingerprint.update(part).update("\0");
  return `turn:${clientId}:${fingerprint.digest("hex").slice(0, 24)}`;
}

function isAdminAuthorized(value: unknown): boolean {
  if (!ADMIN_SECRET || typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ADMIN_SECRET);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireAdminSecret(value: unknown, res: express.Response): boolean {
  if (!ADMIN_SECRET) {
    res.status(503).json({ error: "Admin access is not configured on this server." });
    return false;
  }
  if (!isAdminAuthorized(value)) {
    res.status(403).json({ error: "Incorrect admin secret." });
    return false;
  }
  return true;
}

function readAdminIdentity(req: express.Request, res: express.Response): string | null {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!/^(?:\d{8}|(?:apple|google):[^:\s]{1,256})$/.test(identity)) {
    res.status(400).json({ error: "valid account identity required" });
    return null;
  }
  return identity;
}

async function purgeLegacyInboxConnection(identity: string): Promise<void> {
  if (!identity) return;
  const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, "_");
  await storeDelete(`email:conn:${safeIdentity}`);
  if (safeIdentity !== identity) await storeDelete(`email:conn:${identity}`);
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
  pendingVoiceSyntheses.set(token, { deviceId, included, expiresAt: now + 5 * 60_000, inFlight: false });
  return token;
}

function takeVoiceSynthesisToken(token: string, deviceId: string): PendingVoiceSynthesis | null {
  const pending = pendingVoiceSyntheses.get(token);
  if (!pending || pending.deviceId !== deviceId) return null;
  if (pending.expiresAt <= Date.now()) {
    pendingVoiceSyntheses.delete(token);
    return null;
  }
  // Claim the capability before starting ElevenLabs. The previous read-then-
  // consume sequence let two concurrent correction requests both use the same
  // included Voice Credit. The text is intentionally not bound to the token:
  // native action execution can replace the model's original confirmation with
  // a corrected success/error line.
  if (pending.inFlight) return null;
  pending.inFlight = true;
  return pending;
}

function consumeVoiceSynthesisToken(token: string, deviceId: string): void {
  const pending = pendingVoiceSyntheses.get(token);
  if (pending?.deviceId === deviceId) pendingVoiceSyntheses.delete(token);
}

function releaseVoiceSynthesisToken(token: string, deviceId: string): void {
  const pending = pendingVoiceSyntheses.get(token);
  if (pending?.deviceId === deviceId) pending.inFlight = false;
}

async function chargeMeasuredUsage(
  deviceId: string,
  usage: { geminiUsd: number; searchUsd: number },
  requestId?: string
): Promise<number> {
  if (!deviceId) throw new Error("Cannot meter usage without an account identity");
  const charged = await chargeUsageUsd(deviceId, usage.geminiUsd + usage.searchUsd, "text", requestId || randomUUID());
  await noteSpend(deviceId, charged.spent);
  return charged.spent;
}

async function noteCreditCharge(
  identity: string,
  mode: "text" | "voice",
  charge: { spent: number; balance: number; voiceCredits: number; voiceCreditsCharged: number; voiceSurchargeCredits: number }
): Promise<void> {
  if (mode === "voice") {
    await noteBillingEvent(identity,
      charge.voiceCreditsCharged > 0 ? "voice_request_used_credit" : "voice_request_used_ai_surcharge",
      { aiCreditsCharged: charge.spent, voiceCreditsCharged: charge.voiceCreditsCharged, surchargeAiCredits: charge.voiceSurchargeCredits }
    );
    if (charge.voiceCreditsCharged > 0 && charge.voiceCredits === 0) {
      await noteBillingEvent(identity, "voice_credits_exhausted", { balance: 0 });
    }
  }
  if (charge.balance === 0) await noteBillingEvent(identity, "ai_credits_exhausted", { balance: 0 });
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

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 14_000_000; // ~10 MB decoded
const ATTACHMENT_KINDS = new Set(["image", "file", "url", "text"]);

/**
 * Normalize a raw base64 payload before it reaches a provider. Node's
 * Buffer.from(value, "base64") is deliberately permissive: it silently
 * ignores invalid characters and can turn a typo or an attacker-controlled
 * string into a different byte sequence. Keep the wire format strict while
 * accepting harmless line wrapping from older clients.
 */
function normalizeBase64Payload(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS) return "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return "";
  const unpadded = compact.replace(/=+$/, "");
  const padding = compact.length - unpadded.length;
  if (unpadded.length % 4 === 1) return "";
  if (padding > 0 && (compact.length % 4 !== 0 || (padding === 1 && unpadded.length % 4 !== 3) || (padding === 2 && unpadded.length % 4 !== 2))) return "";
  const decoded = Buffer.from(compact, "base64");
  return decoded.length > 0 ? compact : "";
}

function normalizeAttachmentInputs(raw: unknown): TakiAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const kind = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
    if (!ATTACHMENT_KINDS.has(kind)) return [];
    const base64 = typeof item.base64 === "string" ? normalizeBase64Payload(item.base64) : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    // Do not bill or invoke the model for an attachment shell with no actual
    // content.  Empty image/file entries used to fall through as a successful
    // request and could make the model answer from the question alone.
    if ((kind === "image" || kind === "file") && !base64) return [];
    if (kind === "text" && !text) return [];
    if (kind === "url" && !url) return [];
    return [{
      kind: kind as TakiAttachment["kind"],
      name: typeof item.name === "string" ? item.name.trim().slice(0, 160) : "Attachment",
      mime: typeof item.mime === "string" ? item.mime.trim().toLowerCase().slice(0, 128) : "",
      ...(base64 ? { base64 } : {}),
      ...(text ? { text: text.slice(0, 100_000) } : {}),
      ...(url ? { url: url.slice(0, 2_048) } : {})
    }];
  });
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
app.set("trust proxy", 1);
const configuredOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "https://takiai.app,https://www.takiai.app,http://localhost:3000,http://localhost:5173,http://localhost,https://localhost,capacitor://localhost,ionic://localhost")
    .split(",").map((value) => value.trim()).filter(Boolean)
);
app.use(cors({
  origin: (origin, callback) => {
    // Native clients do not send Origin. Browsers must be restricted to the
    // explicitly configured Taki web surfaces instead of receiving wildcard
    // CORS access to account and billing endpoints.
    if (!origin || configuredOrigins.has(origin)) callback(null, true);
    else callback(new Error("Origin is not allowed"));
  },
  credentials: false,
  maxAge: 600
}));
// Keep the raw body around so the Stripe webhook can verify its signature (Stripe
// signs the exact bytes, not the parsed JSON).
app.use(express.json({
  limit: "16mb",
  verify: (req, _res, buf) => {
    // Stripe signs the exact request bytes. Keep that buffer only for the
    // webhook that needs it; retaining a copy for every 16 MB-capable API
    // request needlessly doubles peak memory and made large image requests an
    // easy process-level DoS.
    if ((req as any).path === "/api/stripe/webhook" || String((req as any).originalUrl || "").split("?")[0] === "/api/stripe/webhook") {
      (req as any).rawBody = buf;
    }
  }
}));
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

function requestPhysicalIdentities(req: express.Request): string[] {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const query = req.query && typeof req.query === "object" ? req.query as Record<string, unknown> : {};
  const values = [
    req.headers["x-taki-device-id"], body.deviceId, body.physicalDeviceId,
    body.identity, query.deviceId, query.identity
  ];
  return [...new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => /^\d{8}$/.test(value)))];
}

function requestProviderIdentities(req: express.Request): string[] {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const query = req.query && typeof req.query === "object" ? req.query as Record<string, unknown> : {};
  const values = [body.identity, body.deviceId, query.identity, query.deviceId];
  return [...new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => /^(?:apple|google):[^:\s]{1,256}$/.test(value)))];
}

function requestWebSession(req: express.Request): string {
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const header = typeof req.headers["x-taki-session"] === "string" ? req.headers["x-taki-session"] : "";
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const query = req.query && typeof req.query === "object" ? req.query as Record<string, unknown> : {};
  return (header || bearer || (typeof body.sessionToken === "string" ? body.sessionToken : "") || (typeof query.sessionToken === "string" ? query.sessionToken : "")).trim();
}

async function verifiedPhysicalDevice(req: express.Request): Promise<string | null> {
  const deviceId = typeof req.headers["x-taki-device-id"] === "string" ? req.headers["x-taki-device-id"].trim() : "";
  const credential = typeof req.headers["x-taki-device-credential"] === "string" ? req.headers["x-taki-device-credential"].trim() : "";
  if (!/^\d{8}$/.test(deviceId) || !(await verifyDeviceCredential(deviceId, credential))) return null;
  return deviceId;
}

app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || bypassDeviceAuth(req.path)) {
    next();
    return;
  }
  const identities = requestPhysicalIdentities(req);
  const providerIdentities = requestProviderIdentities(req);
  const expectedHandoffPurpose = req.path === "/api/plans/checkout"
    ? "checkout" as const
    : req.path === "/api/credits/checkout"
      ? "credits" as const
      : null;
  const handoff = expectedHandoffPurpose !== null
    ? verifyPurchaseLink(req.body?.handoffToken, expectedHandoffPurpose)
    : null;
  // A signed browser handoff is sufficient authorization for checkout. If a
  // legacy page also sends the raw ID, it must agree with the signed identity.
  // Invalid/missing tokens still take the normal device-credential path.
  if (handoff && identities.every((identity) => identity === handoff.identity)) {
    next();
    return;
  }
  if (identities.length === 0 && providerIdentities.length === 0) {
    next();
    return;
  }
  const headerId = typeof req.headers["x-taki-device-id"] === "string" ? req.headers["x-taki-device-id"].trim() : "";
  const credential = typeof req.headers["x-taki-device-credential"] === "string" ? req.headers["x-taki-device-credential"].trim() : "";
  const physicalValid = identities.length === 0
    ? true
    : /^\d{8}$/.test(headerId) && identities.every((identity) => identity === headerId) && await verifyDeviceCredential(headerId, credential);
  if (!physicalValid) {
    res.status(401).json({ error: "This Taki installation needs to reconnect securely." });
    return;
  }
  if (providerIdentities.length) {
    const physical = identities.length ? headerId : await verifiedPhysicalDevice(req);
    const session = requestWebSession(req);
    for (const identity of providerIdentities) {
      let allowed = await verifyWebSession(identity, session);
      // Apple-linked native requests may use their installation credential;
      // Google web identities have no physical fallback.
      if (!allowed && physical && identity.startsWith("apple:")) {
        allowed = (await devicesForApple(identity.slice("apple:".length))).includes(physical);
      }
      if (!allowed) {
        res.status(401).json({ error: "This Taki account session has expired. Please sign in again." });
        return;
      }
    }
  }
  next();
});

// --- Stripe (web credit top-ups). Gated on env; endpoints 503 when unset. ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WEB_BASE_URL = process.env.WEB_BASE_URL || "https://takiai.app";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

type PurchaseLinkPayload = { identity: string; exp: number; nonce: string; purpose: "credits" | "checkout" };
function signPurchaseLink(payload: PurchaseLinkPayload): string {
  if (!PURCHASE_LINK_SECRET) return "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", PURCHASE_LINK_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function verifyPurchaseLink(token: unknown, expectedPurpose?: PurchaseLinkPayload["purpose"]): PurchaseLinkPayload | null {
  if (!PURCHASE_LINK_SECRET || typeof token !== "string") return null;
  if (token.length > 4_096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, suppliedSignature] = parts;
  if (!body || !suppliedSignature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(suppliedSignature)) return null;
  const expectedSignature = createHmac("sha256", PURCHASE_LINK_SECRET).update(body).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PurchaseLinkPayload;
    if (!(payload.purpose === "credits" || payload.purpose === "checkout")
      || (expectedPurpose && payload.purpose !== expectedPurpose)
      || !/^\d{8}$/.test(String(payload.identity || ""))
      || typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.nonce)
      || !Number.isSafeInteger(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch { return null; }
}

app.get("/health", async (_req, res) => {
  const durableStorage = isDurable();
  const requiresDurableStorage = process.env.NODE_ENV === "production" || process.env.RENDER === "true" || process.env.REQUIRE_DURABLE_STORAGE === "1";
  let reset: { epoch?: number } = {};
  try { reset = await storeGet<{ epoch?: number }>("system:reset", {}); }
  catch (error) {
    console.error("health storage check failed:", error);
    res.status(503).json({ ok: false, error: "durable storage unavailable", durableStorage });
    return;
  }
  if (requiresDurableStorage && !durableStorage) {
    res.status(503).json({ ok: false, error: "DATABASE_URL is required in production", durableStorage });
    return;
  }
  res.status(200).json({
    ok: true,
    app: "Taki AI server",
    mode: "planner-first-modular-v3",
    version: "2026-07-31-lights-anchor-v36",
    durableStorage,
    aiProvider: ACTIVE_AI_PROVIDER,
    models: { main: MAIN_MODEL, planner: PLANNER_MODEL, research: RESEARCH_MODEL },
    // Live Activity background updates require APNs config (APNS_KEY_P8 or
    // APNS_KEY_PATH + KEY_ID + TEAM_ID). Surfaced here so a missing key on the
    // host is a one-curl diagnosis instead of "trackers silently never update".
    pushConfigured: isPushConfigured(),
    resetEpoch: Number(reset.epoch || 0)
  });
});

// Keep both URLs working. The dashboard used to be documented as
// `/admin.html`, while the server only exposed `/admin`; serving the same
// page at all three paths avoids a confusing login loop/404 when an operator
// follows the documented URL.
app.get(["/admin", "/admin/", "/admin.html"], (_req, res) => {
  res.sendFile(fileURLToPath(new URL("./admin.html", import.meta.url)));
});

// Authentication is intentionally independent from loading account analytics.
// A storage or malformed-account failure must not make a valid secret look
// incorrect or keep the operator trapped on the login screen.
app.post("/api/admin/auth", (req, res) => {
  if (!requireAdminSecret(req.body?.secret, res)) return;
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
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
  if (!APNS_TOKEN_RE.test(token.trim()) || !/^\d{8}$/.test(deviceId)) {
    res.status(400).json({ error: "token and valid deviceId required" });
    return;
  }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  registerToken(token);
  // Tie the token to the device id so the nudge engine can target this device.
  await setPushToken(deviceId, token);
    res.json({ ok: true, configured: isPushConfigured(), devices: (await getRegisteredTokens()).length });
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
    const sent = results.filter((result) => result.ok).length;
    const failed = results.length - sent;
    if (results.length === 0) {
      res.status(409).json({ ok: false, attempted: 0, sent: 0, failed: 0, error: "No registered push tokens are available. Open Taki on a device with notifications enabled first." });
      return;
    }
    if (results.length > 0 && sent === 0) {
      res.status(503).json({ ok: false, attempted: results.length, sent, failed, results, error: "Apple did not accept any registered notification tokens." });
      return;
    }
    res.json({ ok: failed === 0, attempted: results.length, sent, failed, results });
  } catch (error) {
    console.error("test-push error:", error);
    res.status(503).json({ error: "Push delivery is temporarily unavailable." });
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
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res, req);
  if (!deviceId) return;
  try {
    const persona = parseUserPersona(req.body?.profile);
    const measured = await measureUsage(() => withTimeout(styleInCharacter(text, persona), 8000, "Style"));
    const styled = measured.value;
    await chargeMeasuredUsage(deviceId, measured.usage, turnMeteringRequestId(
      req.body?.requestId,
      "style",
      text,
      JSON.stringify(req.body?.profile || {})
    ));
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
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !APNS_TOKEN_RE.test(token.trim()) || !/^\d{8}$/.test(deviceId)) {
    res.status(400).json({ error: "id, token, and valid deviceId required" });
    return;
  }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const rawMeta = req.body?.meta && typeof req.body.meta === "object" && !Array.isArray(req.body.meta) ? req.body.meta as Record<string, unknown> : {};
  // Live Activity metadata is later used by a background worker. Keep it to
  // small JSON primitives so a modified client cannot persist an arbitrarily
  // deep object or a huge string that is replayed on every polling tick.
  const meta: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawMeta).slice(0, 24)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
    if (!safeKey) continue;
    if (typeof value === "string") meta[safeKey] = value.slice(0, 400);
    else if (typeof value === "number" && Number.isFinite(value)) meta[safeKey] = value;
    else if (typeof value === "boolean") meta[safeKey] = value;
  }
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
const lastPushedAt = new Map<string, number>();
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
        lastPushedAt.delete(livePushKey(reg));
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
        const unchanged = lastPushed.get(pushKey) === sig;
        // Send an identical heartbeat at least every four minutes. ActivityKit
        // receives a fresh stale-date even when a score/quote itself has not
        // changed, so an otherwise healthy activity never looks frozen.
        if (unchanged && Date.now() - (lastPushedAt.get(pushKey) || 0) < 4 * 60_000) continue;
        const result = await sendLiveActivityUpdate(reg.token, content, "update", reg.environment);
        if (deadToken(result)) { await unregisterLiveActivity(reg.id, reg.deviceId || "legacy"); lastPushed.delete(pushKey); lastPushedAt.delete(pushKey); }
        else { lastPushed.set(pushKey, sig); lastPushedAt.set(pushKey, Date.now()); }
      } catch (error) {
        console.error("Live Activity push error:", error);
      }
    }
  } finally {
    trackerPushBusy = false;
  }
}, 15 * 1000);

// Commute: re-check live traffic and push an updated departure time every minute
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
        lastPushedAt.delete(livePushKey(reg));
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
}, 60 * 1000);

/* ---- Batch B proactive alerts (price / score) -------------------------- */

// Register an alert the server will watch and push when it fires. The device
// sends the alert spec it got back from the planner's alert_create action.
app.post("/api/alerts", async (req, res) => {
  const b = req.body || {};
  const deviceId = normalizeTopupIdentity(typeof b.deviceId === "string" ? b.deviceId : "");
  const kind = b.kind === "price" || b.kind === "score" ? b.kind : "";
  const query = typeof b.query === "string" ? b.query.trim().slice(0, 300) : "";
  if (!/^\d{8}$/.test(deviceId) || !kind || !query) { res.status(400).json({ error: "deviceId, kind, and query required" }); return; }
  if (!(await isKnownIdentity(deviceId))) { res.status(401).json({ error: "registered device required" }); return; }
  const base = { id: `alert-${randomUUID()}`, deviceId, createdAt: Date.now(), query, label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 200) : query };
  let alert: Alert;
  if (kind === "price") {
    const target = Number(b.target);
    if (!Number.isFinite(target) || target <= 0 || Math.abs(target) > 1e15) { res.status(400).json({ error: "target must be a positive finite number" }); return; }
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
  const filterId = typeof b.id === "string" ? b.id.trim().slice(0, 160) : "";
  const filterKind = b.kind === "price" || b.kind === "score" ? b.kind : "";
  const filterQuery = typeof b.query === "string" ? b.query.trim().slice(0, 300) : "";
  const filter = filterId || filterKind || filterQuery
    ? { id: filterId || undefined, kind: filterKind || undefined, query: filterQuery || undefined }
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
  const requestedKind = typeof req.query.kind === "string" ? req.query.kind.trim().slice(0, 30) : "";
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 300) : "";
  const kind = normalizeTrackerKind(requestedKind, query);
  const tz = typeof req.query.tz === "string" ? req.query.tz.trim().slice(0, 100) : undefined;
  if ((kind !== "finance" && kind !== "product" && kind !== "sports" && kind !== "flight" && kind !== "package") || !query || !validTimeZone(tz)) {
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
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !validTimeZone(tz)) {
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
  const hasLat = Number.isFinite(lat);
  const hasLon = Number.isFinite(lon);
  if ((hasLat !== hasLon) || (hasLat && (lat < -90 || lat > 90 || lon < -180 || lon > 180))) {
    res.status(400).json({ error: "lat and lon must be supplied together within valid ranges" });
    return;
  }
  if (!title && !location) {
    res.status(400).json({ error: "title or location is required" });
    return;
  }
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res, req);
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
    await chargeMeasuredUsage(deviceId, measured.usage, turnMeteringRequestId(
      req.body?.requestId,
      "resolve-destination",
      title,
      location,
      notes,
      String(Number.isFinite(lat) ? lat : ""),
      String(Number.isFinite(lon) ? lon : "")
    ));
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
  const deviceId = await requireCreditIdentity(req.body?.deviceId, res, req);
  if (!deviceId) return;
  try {
    const measured = await measureUsage(() => withTimeout(matchEventToQuery(query, events), 10000, "Match event"));
    const index = measured.value;
    await chargeMeasuredUsage(deviceId, measured.usage, turnMeteringRequestId(
      req.body?.requestId,
      "match-event",
      query,
      JSON.stringify(events)
    ));
    res.json({ index });
  } catch (error) {
    console.error("Match event error:", error);
    res.status(502).json({ error: "event matching unavailable" });
  }
});

// Vision: answer a question about a photo (base64) the user took/picked.
app.post("/api/vision", async (req, res) => {
  const rawImage = typeof req.body?.image === "string" ? req.body.image : "";
  const requestedMime = typeof req.body?.mime === "string" ? req.body.mime.trim().toLowerCase() : "image/jpeg";
  const mime = /^image\/(?:jpeg|jpg|png|webp|gif|heic|heif)$/.test(requestedMime) ? requestedMime : "";
  const question = typeof req.body?.question === "string" ? req.body.question.slice(0, 8000) : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!rawImage) {
    res.status(400).json({ error: "image is required" });
    return;
  }
  if (!mime) {
    res.status(400).json({ error: "a supported image MIME type is required" });
    return;
  }
  if (rawImage.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS) {
    res.status(413).json({ error: "image is too large" });
    return;
  }
  const image = normalizeBase64Payload(rawImage);
  if (!image) {
    res.status(400).json({ error: "image must be valid base64" });
    return;
  }
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
  const visionGate = await safetyGate(deviceId, question, req);
  if (visionGate) { res.status(visionGate.failClosed ? 503 : 200).json({ spokenText: visionGate.message, blocked: true, ...(visionGate.block ? { access: visionGate.block, accessMessage: visionGate.message } : {}) }); return; }
  let tier: Tier = "free";
  const sum = await creditSummary(deviceId);
  tier = sum.tier;
  const block = usageBlockFor(sum, ATTACHMENT_BASE_CREDITS);
  if (block) { res.status(402).json(usageBlockedPayload(block)); return; }
  try {
    const takiModel = normalizeTakiModel(req.body?.profile?.model);
    const measured = await measureUsage(() => withTakiModel(takiModel, () => withTimeout(answerAboutImage(image, mime, question, userProfile, timeZone), 28000, "Vision")));
    const spokenText = measured.value;
    const speechUsd = voiceMode ? ttsCostUsd(speechCharacterCount(spokenText || "")) : 0;
    const ownerCostUsd = totalUsageUsd(measured.usage) + speechUsd;
    const fresh = await creditSummary(deviceId);
    const charge = decideAssistantCharge({
      summary: fresh,
      tier,
      voiceMode,
      includedVoice: voiceMode && fresh.voiceCredits > 0,
      baseUsd: totalUsageUsd(measured.usage) + ATTACHMENT_BASE_CREDITS * CREDIT_USD,
      voiceOutputUsd: speechUsd
    });
    if (charge.block) { res.status(402).json(usageBlockedPayload(charge.block)); return; }
    const s = await chargeUsageUsd(
      deviceId,
      charge.usageUsd,
      voiceMode ? "voice" : "text",
      turnMeteringRequestId(req.body?.requestId, "vision", image, question, mime, voiceMode ? "voice" : "text")
    );
    await noteSpend(deviceId, s.spent);
    await noteCreditCharge(deviceId, voiceMode ? "voice" : "text", s);
    await noteInteraction(deviceId, {
      channel: voiceMode ? "voice" : "text",
      feature: "photo",
      credits: s.spent,
      costUsd: ownerCostUsd
    });
    res.json({ spokenText, credits: { ...s, cost: s.spent } });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      const fresh = await creditSummary(deviceId);
      res.status(402).json(usageBlockedPayload(usageBlockFor(fresh, error.required)!));
      return;
    }
    console.error("Vision error:", error);
    res.status(502).json({ error: "vision unavailable" });
  }
});

app.post("/api/attachments", async (req, res) => {
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const oversized = rawAttachments.some((item: any) => item && typeof item === "object" && typeof item.base64 === "string" && item.base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS);
  if (oversized) { res.status(413).json({ error: "attachment is too large" }); return; }
  const attachments = normalizeAttachmentInputs(rawAttachments);
  const attachmentCredits = attachmentBaseCostCredits(attachments);
  const question = typeof req.body?.question === "string" ? req.body.question.slice(0, 8000) : "";
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceMode = req.body?.voiceMode === true;
  if (!attachments.length) { res.status(400).json({ error: "attachment is required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res, req))) return;

  const gate = await safetyGate(deviceId, question, req);
  if (gate) { res.status(gate.failClosed ? 503 : 200).json({ spokenText: gate.message, blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) }); return; }

  let tier: Tier = "free";
  const attachmentSummary = await creditSummary(deviceId);
  tier = attachmentSummary.tier;
  const attachmentBlock = usageBlockFor(attachmentSummary, Math.max(MIN_REQUEST_CREDITS, attachmentCredits));
  if (attachmentBlock) { res.status(402).json(usageBlockedPayload(attachmentBlock)); return; }

  try {
    const takiModel = normalizeTakiModel(req.body?.profile?.model);
    const measured = await measureUsage(() => withTakiModel(takiModel, () => answerAboutAttachments(attachments, question, userProfile, timeZone)));
    const answer = measured.value;
    const speechUsd = voiceMode ? ttsCostUsd(speechCharacterCount(answer.text)) : 0;
    const ownerCostUsd = totalUsageUsd(measured.usage) + speechUsd;
    const fresh = await creditSummary(deviceId);
    const charge = decideAssistantCharge({
      summary: fresh,
      tier,
      voiceMode,
      includedVoice: voiceMode && fresh.voiceCredits > 0,
      baseUsd: totalUsageUsd(measured.usage) + attachmentCredits * CREDIT_USD,
      voiceOutputUsd: speechUsd
    });
    if (charge.block) { res.status(402).json(usageBlockedPayload(charge.block)); return; }
    const spent = await chargeUsageUsd(
      deviceId,
      charge.usageUsd,
      voiceMode ? "voice" : "text",
      turnMeteringRequestId(req.body?.requestId, "attachments", question, JSON.stringify(attachments), voiceMode ? "voice" : "text")
    );
    await noteSpend(deviceId, spent.spent);
    await noteInteraction(deviceId, {
      channel: voiceMode ? "voice" : "text",
      feature: attachmentFeature(attachments),
      credits: spent.spent,
      costUsd: ownerCostUsd
    });
    res.json({ spokenText: answer.text, sources: answer.sources, credits: { ...spent, cost: spent.spent } });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      const fresh = await creditSummary(deviceId);
      res.status(402).json(usageBlockedPayload(usageBlockFor(fresh, error.required)!));
      return;
    }
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
async function assignDeviceNumber(region: string): Promise<string> {
  const country = region.toUpperCase() === "US" ? "1" : "0";
  // Random ids avoid exposing account volume, while storeUpdate makes the
  // claim atomic across every server instance (the old read-then-write pair
  // could issue the same id during a registration burst).
  for (let attempt = 0; attempt < 100; attempt++) {
    const rnd = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    const id = country + rnd;
    const claimed = await storeUpdate<boolean, boolean>(`devnum:used:${id}`, false, (used) => used
      ? { value: true, result: false }
      : { value: true, result: true });
    if (claimed) return id;
  }
  throw new Error("device id space is temporarily unavailable");
}

app.post("/api/register-device", async (req, res) => {
  const ip = clientIp(req);
  let reservation = "";
  try {
    reservation = await reserveSignupSlot(ip) || "";
  } catch (error) {
    // A durable registration counter is part of the account-creation safety
    // boundary. Fail closed instead of allowing a storage outage to mint an
    // unbounded stream of anonymous accounts.
    console.error("registration limit check failed:", error);
    res.status(503).json({ error: "Signup is temporarily unavailable. Please try again shortly." });
    return;
  }
  if (!reservation) {
    res.set("Cache-Control", "no-store");
    res.status(429).json({
      error: `This network has reached the limit of ${MAX_ACCOUNTS_PER_IP} Taki accounts. Existing accounts can still sign in.`,
      code: "signup_ip_limit",
      limit: MAX_ACCOUNTS_PER_IP
    });
    return;
  }
  const region = typeof req.body?.region === "string" ? req.body.region : "";
  let deviceId = "";
  let registrationCompleted = false;
  try {
    deviceId = await assignDeviceNumber(region);
    // Registration creates the account record and starter ledger together. A
    // device ID can therefore never exist only on the phone or be invisible in
    // the admin dashboard.
    await noteUserStrict(deviceId, ip, String(req.headers?.["user-agent"] || ""));
    const credits = await creditSummary(deviceId);
    const credential = await issueDeviceCredential(deviceId);
    if (!(await commitSignupSlot(ip, reservation))) {
      throw new Error("signup reservation expired before account commit");
    }
    registrationCompleted = true;
    res.json({ deviceId, credential, credits });
  } catch (e) {
    if (!registrationCompleted) await releaseSignupSlot(ip, reservation).catch((error) => console.error("release signup reservation:", error));
    if (deviceId && !registrationCompleted) {
      // A failed response must not leave a permanently issued, otherwise-empty
      // installation that later appears as a ghost account or blocks recovery.
      await Promise.allSettled([
        deleteUser(deviceId),
        storeDelete(`credits:${deviceId}`),
        storeDelete(`devicecredential:${deviceId}`),
        storeDelete(`devnum:used:${deviceId}`)
      ]);
    }
    console.error("register-device error:", e);
    res.status(503).json({ error: "Signup could not be completed. Nothing was charged. Please try again shortly." });
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
  // Check enforcement before persisting a web-auth marker or analytics record.
  // A rejected sign-in must not leave a session that can be replayed later.
  const ip = clientIp(req);
  if ((await isBanned(identity, undefined, ip)) || (await isTestRestricted(identity))) {
    res.status(403).json({ error: "This account is restricted." });
    return;
  }
  await markWebAuthenticated(identity);
  const sessionToken = await issueWebSession(identity);
  if (!sessionToken) {
    res.status(503).json({ error: "Web sign-in is temporarily unavailable. Please try again." });
    return;
  }
  await noteUser(identity, ip, String(req.headers?.["user-agent"] || ""));
  if (identity.startsWith("apple:")) {
    const appleSub = identity.slice("apple:".length);
    await noteApple(identity, { sub: appleSub, email, name });
    await enrollApplePromotionalSubscriber({ email, appleSub, identity });
  }
  const credits = await creditSummary(identity);
  res.set("Cache-Control", "no-store");
  res.json({ identity, email: email || "", name: name || "", sessionToken, expiresIn: 30 * 24 * 60 * 60, credits });
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

app.post("/api/web/auth/logout", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!/^(?:apple|google):[^:\s]{1,256}$/.test(identity) || !(await verifyWebSession(identity, requestWebSession(req)))) {
    res.status(401).json({ error: "valid web session required" });
    return;
  }
  await revokeWebAuthentication(identity);
  res.set("Cache-Control", "no-store").json({ ok: true });
});

app.post("/api/device/info", async (req, res) => {
  const b = req.body || {};
  const deviceId = typeof b.deviceId === "string" ? normalizeTopupIdentity(b.deviceId) : "";
  if (!/^\d{8}$/.test(deviceId)) { res.status(400).json({ error: "valid deviceId required" }); return; }
  const credential = typeof req.headers["x-taki-device-credential"] === "string"
    ? req.headers["x-taki-device-credential"].trim()
    : "";
  if (!(await storeGet<boolean>(`devnum:used:${deviceId}`, false))) {
    res.status(404).json({ error: "unknown device" }); return;
  }
  // This endpoint is reachable without the global device middleware so an
  // installation can recover after a full reset removed its credential. Never
  // return a different response for a known id with a bad credential: the app
  // treats the generic 404 as a signal to provision a fresh installation.
  if (!(await verifyDeviceCredential(deviceId, credential))) {
    res.status(404).json({ error: "unknown device" });
    return;
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
  if (campaign) {
    const candidates = [identity];
    if (/^\d{8}$/.test(identity)) {
      const appleSub = await appleForDevice(identity);
      if (appleSub) candidates.push(`apple:${appleSub}`);
    }
    // The campaign may belong to the linked Apple identity, but it must still
    // match one of this installation's verified identities. This prevents a
    // caller from inflating another account's engagement metrics with a UUID.
    for (const candidate of [...new Set(candidates)]) {
      if (await recordEngagementSession(campaign, candidate, durationSeconds)) break;
    }
  }
  res.json({ ok: true });
});

const CLIENT_BILLING_EVENTS = new Set(["pricing_page_viewed", "plan_selected"]);
app.post("/api/analytics/billing", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const event = typeof req.body?.event === "string" ? req.body.event.trim() : "";
  if (!(await requireCreditIdentity(identity, res, req))) return;
  if (!CLIENT_BILLING_EVENTS.has(event)) { res.status(400).json({ error: "unsupported billing event" }); return; }
  const tier = (["plus", "plus_voice", "pro"] as string[]).includes(String(req.body?.tier || ""))
    ? String(req.body.tier)
    : undefined;
  await noteBillingEvent(identity, event, { tier: tier || null, surface: String(req.body?.surface || "app").slice(0, 30) });
  res.json({ ok: true });
});

app.post("/api/engagement/open", async (req, res) => {
  const campaign = typeof req.body?.campaign === "string" ? req.body.campaign.trim() : "";
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!campaign || !identity) { res.status(400).json({ error: "campaign and identity required" }); return; }
  if (!(await requireCreditIdentity(identity, res, req))) return;
  // A signed-in app can open a campaign sent to its canonical Apple identity
  // while reporting the physical device id. Try the physical identity first,
  // then its verified Apple alias; never accept an arbitrary campaign UUID from
  // an authenticated but unrelated account.
  const candidates = [identity];
  if (/^\d{8}$/.test(identity)) {
    const appleSub = await appleForDevice(identity);
    if (appleSub) candidates.push(`apple:${appleSub}`);
  }
  let recorded = false;
  for (const candidate of [...new Set(candidates)]) {
    if (await recordEngagementOpen(campaign, candidate)) { recorded = true; break; }
  }
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
  // This helper runs in the background after assistant/voice authentication.
  // Do not let an authenticated account write device metadata for a different
  // physical installation by putting another id in `physicalDeviceId`.
  const authenticatedDevice = await verifiedPhysicalDevice(req);
  if (authenticatedDevice !== deviceId) return;
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
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
  // Report access status so the app can hard-block a banned/suspended account on
  // launch (full-screen), not just when the user asks something.
  let access: "active" | "suspended" | "banned" = "active";
  let accessMessage = "";
  let notice: unknown = null;
  try {
    const ip = clientIp(req);
    // Only 8-digit physical-device ids participate in device association;
    // apple:/google: account identities have no hardware id.
    const dev = /^\d{8}$/.test(deviceId) ? deviceId : undefined;
    await recordAssoc(deviceId, dev, ip);
    const acct = await getSafetyAccount(deviceId);
    if (acct.status === "terminated" || (await isBanned(deviceId, dev, ip)) || (await isTestRestricted(deviceId))) { access = "banned"; accessMessage = BANNED_MSG; }
    else if (acct.status === "suspended") { access = "suspended"; accessMessage = SUSPENDED_MSG; }
    // An active account may still owe an acknowledgment: the overview shown after
    // being reinstated, or a warning. The app must present it before continuing.
    else if (acct.pendingNotice) { notice = acct.pendingNotice; }
  } catch (e) { console.error("credits access check:", e); }
  res.json({ ...(await creditSummary(deviceId)), tiers: tierCatalog(), access, accessMessage, ...(notice ? { notice } : {}) });
});

// The user has seen and acknowledged their reinstatement/warning overview.
app.post("/api/account/acknowledge-notice", async (req, res) => {
  const b = req.body || {};
  const identity = typeof b.identity === "string" ? b.identity.trim() : (typeof b.deviceId === "string" ? b.deviceId.trim() : "");
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  if (!(await requireCreditIdentity(identity, res, req))) return;
  await acknowledgeNotice(identity);
  res.json({ ok: true });
});

// Account-backed conversation sync for iPhone, iPad, CarPlay, and web.
// Only text, source links, and chat metadata are retained; photos, files, and
// device-only attachment previews never leave the originating device.
app.get("/api/chats", async (req, res) => {
  if (!(await verifyDeviceCredential(String(req.headers["x-taki-device-id"] || ""), String(req.headers["x-taki-device-credential"] || "")))) { res.status(401).json({ error: "This Taki installation needs to reconnect." }); return; }
  const identity = await requireCreditIdentity(req.query?.deviceId, res, req);
  if (!identity) return;
  res.json(await readSyncedChats(identity));
});

app.post("/api/chats/sync", async (req, res) => {
  if (!(await verifyDeviceCredential(String(req.headers["x-taki-device-id"] || ""), String(req.headers["x-taki-device-credential"] || "")))) { res.status(401).json({ error: "This Taki installation needs to reconnect." }); return; }
  const identity = await requireCreditIdentity(req.body?.deviceId, res, req);
  if (!identity) return;
  const chats = Array.isArray(req.body?.chats) ? req.body.chats : [];
  const activeChatId = typeof req.body?.activeChatId === "string" ? req.body.activeChatId : undefined;
  const deletedChatIds = Array.isArray(req.body?.deletedChatIds)
    ? req.body.deletedChatIds.map((value: unknown) => String(value))
    : [];
  res.json(await syncChats(identity, chats, activeChatId, deletedChatIds));
});

// Fast, non-AI affordability check. The app calls this immediately before text,
// attachment, or voice work so blocked requests never reach Gemini or ElevenLabs.
app.post("/api/credits/preflight", async (req, res) => {
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId is required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
  const kind = req.body?.kind === "voice" ? "voice" : req.body?.kind === "attachment" ? "attachment" : "text";
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 6) : [];
  const summary = await creditSummary(deviceId);
  const supportMessage = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1000) : "";
  if (kind === "text" && supportMessage && isProductKnowledgeQuestion(supportMessage)) {
    // Account, pricing, and renewal help must remain reachable when the reason
    // the user is asking is that their balance has run out.
    res.json({ allowed: true, support: true, requiredCredits: 0, credits: { ...summary, cost: 0 } });
    return;
  }
  // A voice turn commits to STT + a planning call + TTS the moment it starts,
  // so preflight has to ask for what the whole turn can cost — not the floor.
  const requiredCredits = kind === "attachment"
    ? Math.max(MIN_REQUEST_CREDITS, attachmentBaseCostCredits(attachments))
    : kind === "voice"
      ? voiceTurnEstimateCredits(summary.voiceCredits > 0)
      : MIN_REQUEST_CREDITS;
  const block = usageBlockFor(summary, requiredCredits);
  if (block) {
    await noteBillingEvent(deviceId, "insufficient_credits_blocked", { mode: kind, requiredAiCredits: requiredCredits, availableAiCredits: summary.balance });
    res.status(402).json(usageBlockedPayload(block)); return;
  }
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
  const value = String(identity || "").trim();
  return /^\d{8}$/.test(value) ? value : "";
}

function creditsKeyForIdentity(identity: string): string {
  return `credits:${identity.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function hasCreditsAccount(identity: string): Promise<boolean> {
  const acct = await storeGet<any | null>(creditsKeyForIdentity(identity), null);
  return !!acct && acct.deviceId === identity && Number(acct.updatedAt || 0) > 0;
}

async function requireCreditIdentity(rawIdentity: unknown, res: any, req?: express.Request): Promise<string | null> {
  const identity = typeof rawIdentity === "string" ? rawIdentity.trim() : "";
  const canonical = /^\d{8}$/.test(identity) || /^(?:apple|google):[^:\s]{1,256}$/.test(identity);
  let authorized = false;
  if (canonical && req) {
    if (/^\d{8}$/.test(identity)) {
      authorized = (await verifiedPhysicalDevice(req)) === identity;
    } else {
      authorized = await verifyWebSession(identity, requestWebSession(req));
      if (!authorized && identity.startsWith("apple:")) {
        const physical = await verifiedPhysicalDevice(req);
        authorized = !!physical && (await devicesForApple(identity.slice("apple:".length))).includes(physical);
      }
    }
  }
  if (!canonical || !authorized || !(await isKnownIdentity(identity)) || !(await hasCreditsAccount(identity))) {
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

function publicPurchaseAccount(v: PurchaseAccount, checkoutToken = "", includePrivate = false) {
  return {
    valid: v.valid,
    reason: v.reason || "",
    identity: v.publicId,
    isPro: v.isPro,
    tier: v.tier,
    ...(includePrivate ? { appleSynced: v.appleSynced, email: v.email, displayName: v.displayName, devices: v.devices } : {}),
    min: CREDIT_TOPUP_MIN,
    max: CREDIT_TOPUP_MAX,
    centsPerCredit: topupCentsPerCredit(v.tier),
    ...(checkoutToken ? { checkoutToken } : {})
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
  const payload = verifyPurchaseLink(req.body?.token, "credits");
  if (!payload) { res.status(401).json({ valid: false, reason: "This purchase link expired. Open Membership in Taki and try again." }); return; }
  const account = await validateTopupAccount(payload.identity);
  if (!account.valid) { res.status(400).json(publicPurchaseAccount(account)); return; }
  res.json(publicPurchaseAccount(account, "", true));
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
  const checkoutToken = v.valid && PURCHASE_LINK_SECRET
    ? signPurchaseLink({ identity: v.publicId, exp: Date.now() + 10 * 60_000, nonce: randomUUID(), purpose: "checkout" })
    : "";
  res.json(publicPurchaseAccount(v, checkoutToken, false));
});

// Step 2: start a checkout for `credits` credits toward `identity`. Re-validates
// the account and computes the price server-side from the real Pro tier (client-
// sent prices/Pro flags are never trusted).
app.post("/api/credits/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "top-ups are not available yet" }); return; }
  // A plan-checkout handoff is a different capability from a credit top-up
  // handoff.  Accepting any valid signed token here would let a token minted
  // for one flow authorize the other, which is especially easy to trigger
  // from a stale browser tab.  Keep the purpose check at the route boundary
  // as well as in the shared middleware.
  const handoff = verifyPurchaseLink(req.body?.handoffToken, "credits");
  const submittedIdentity = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  if (handoff && submittedIdentity && submittedIdentity !== handoff.identity) {
    res.status(400).json({ error: "The purchase link does not match this account." });
    return;
  }
  const identity = handoff?.identity || submittedIdentity;
  const credits = Math.floor(Number(req.body?.credits));
  if (!identity) { res.status(400).json({ error: "account ID required" }); return; }
  const v = await validateTopupAccount(identity);
  if (!v.valid) { res.status(403).json({ error: v.reason || "This account can't purchase credits." }); return; }
  const cents = topupPriceCents(credits, v.tier);
  if (cents == null) { res.status(400).json({ error: `Choose between ${CREDIT_TOPUP_MIN.toLocaleString()} and ${CREDIT_TOPUP_MAX.toLocaleString()} credits.` }); return; }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name: `${credits.toLocaleString()} Taki AI credits${v.tier === "pro" ? " (Pro price)" : v.tier === "plus_voice" ? " (Premium price)" : ""}` } } }],
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

type WebSubscription = {
  id: string;
  identity: string;
  publicId: string;
  tier: Tier;
  active: boolean;
  status?: string;
  periodStart?: number | null;
  periodEnd?: number | null;
  updatedAt: number;
  /** Stripe event creation time used to ignore an older webhook delivered late. */
  eventCreatedAt?: number;
};
const webSubKey = (id: string) => `stripe:subscription:${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const webSubsForIdentityKey = (identity: string) => `stripe:identity-subs:${identity.replace(/[^a-zA-Z0-9_:-]/g, "_")}`;

async function saveWebSubscription(record: WebSubscription): Promise<{ applied: boolean; record: WebSubscription }> {
  const saved = await storeUpdate<WebSubscription | null, { applied: boolean; record: WebSubscription }>(webSubKey(record.id), null, (stored) => {
    const incomingEventAt = Number(record.eventCreatedAt || 0);
    const priorEventAt = Number(stored?.eventCreatedAt || 0);
    if (stored && incomingEventAt > 0 && priorEventAt > incomingEventAt) {
      // Stripe can deliver subscription events out of order. Keep the newest
      // authoritative state instead of allowing a late cancellation/update to
      // roll the record back.
      return { value: stored, result: { applied: false, record: stored } };
    }
    const next: WebSubscription = {
      ...(stored || {}),
      ...record,
      ...(incomingEventAt > 0 ? { eventCreatedAt: incomingEventAt } : priorEventAt > 0 ? { eventCreatedAt: priorEventAt } : {})
    };
    return {
      value: next,
      result: { applied: true, record: next }
    };
  });
  if (!saved.record.identity) return saved;
  const key = webSubsForIdentityKey(saved.record.identity);
  await storeUpdate<{ ids: string[] }, void>(key, { ids: [] }, (list) => {
    const ids = Array.isArray(list.ids) ? list.ids : [];
    if (!ids.includes(saved.record.id)) ids.push(saved.record.id);
    return { value: { ids }, result: undefined };
  });
  return saved;
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
    await saveWebSubscription(record);
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
    await saveWebSubscription(record);
  }
  await storeDelete(key);
}

app.post("/api/plans/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "subscriptions are not available yet" }); return; }
  const handoff = verifyPurchaseLink(req.body?.handoffToken, "checkout");
  const submittedIdentity = typeof req.body?.identity === "string" ? normalizeTopupIdentity(req.body.identity) : "";
  if (handoff && submittedIdentity && submittedIdentity !== handoff.identity) {
    res.status(400).json({ error: "The purchase link does not match this account." });
    return;
  }
  const publicId = handoff?.identity || submittedIdentity;
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
          product_data: { name: `Taki AI ${config.label}`, description: `${config.creditsPerCycle.toLocaleString()} AI Credits and ${config.voiceCreditsPerCycle.toLocaleString()} Voice Credits each month` }
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
          const saved = await saveWebSubscription({ id: subscriptionId, identity, publicId: s.metadata?.publicId || "", tier, active: true, status: "active", periodStart: Date.now(), periodEnd: null, updatedAt: Date.now(), eventCreatedAt: Number(event.created || 0) * 1000 || Date.now() });
          if (!saved.applied) {
            // A checkout event delivered after a newer subscription event must
            // not roll the record back or grant a stale first-cycle ledger.
            await storeSet(dedupeKey, true);
            res.json({ received: true });
            return;
          }
          await retireOtherWebSubscriptions(saved.record.identity, subscriptionId);
          const granted = await grantForTransaction(saved.record.identity, saved.record.tier, `stripe:first:${s.id}`, {
            subscriptionId,
            transactionId: s.id,
            productId: `${saved.record.tier}_monthly`,
            periodStart: saved.record.periodStart,
            periodEnd: saved.record.periodEnd,
            reason: "stripe_subscription_started",
            status: "active"
          });
          await storeSet(dedupeKey, true);
          if (granted.granted) {
            await noteTier(saved.record.identity, saved.record.tier, "stripe_subscription");
            await noteBillingEvent(saved.record.identity, "subscription_started", { tier: saved.record.tier, provider: "stripe" });
            await noteRevenue(saved.record.identity, { at: Date.now(), kind: "web_subscription", amountUsd: (s.amount_total || TIERS[saved.record.tier].priceUsd * 100) / 100, credits: TIERS[saved.record.tier].creditsPerCycle, tier: saved.record.tier });
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
        if (!record) throw new Error("Stripe invoice references an unknown subscription; retry after checkout webhook is persisted");
        if (record?.active && !(await storeGet<boolean>(dedupeKey, false))) {
          const periodStart = Number(invoice.period_start || 0) * 1000 || null;
          const periodEnd = Number(invoice.period_end || 0) * 1000 || null;
          record.periodStart = periodStart;
          record.periodEnd = periodEnd;
          record.status = "active";
          record.eventCreatedAt = Number(event.created || 0) * 1000 || Date.now();
          const saved = await saveWebSubscription(record);
          if (saved.applied) {
            const applied = saved.record;
            const granted = await grantForTransaction(applied.identity, applied.tier, `stripe:renewal:${invoice.id}`, {
              subscriptionId,
              transactionId: String(invoice.id || ""),
              productId: `${applied.tier}_monthly`,
              periodStart,
              periodEnd,
              reason: "stripe_subscription_renewed",
              status: "active"
            });
            await storeSet(dedupeKey, true);
            if (granted.granted) {
              await noteTier(applied.identity, applied.tier, "stripe_renewal");
              await noteBillingEvent(applied.identity, "subscription_renewed", { tier: applied.tier, provider: "stripe" });
              await noteRevenue(applied.identity, { at: Date.now(), kind: "web_subscription", amountUsd: Number(invoice.amount_paid || 0) / 100, credits: TIERS[applied.tier].creditsPerCycle, tier: applied.tier });
            }
          } else {
            // A newer subscription event won the atomic row update. Mark this
            // invoice as observed so a replay cannot keep doing ledger work.
            await storeSet(dedupeKey, true);
          }
        }
      } catch (e) {
        console.error("Stripe renewal grant error:", e);
        res.status(500).json({ error: "webhook processing failed" });
        return;
      }
    }
  }
  if (event.type === "customer.subscription.updated") {
    const subscription: any = event.data.object;
    const record = await storeGet<WebSubscription | null>(webSubKey(String(subscription.id || "")), null);
    if (!record) {
      // Delivery can race checkout.session.completed. Ask Stripe to retry
      // instead of acknowledging an update that could otherwise be lost.
      res.status(500).json({ error: "subscription record not available yet" });
      return;
    }
    if (record) {
      const previousTier = record.tier;
      const nextTier = String(subscription.metadata?.tier || record.tier) as Tier;
      if ((["plus", "plus_voice", "pro"] as string[]).includes(nextTier)) record.tier = nextTier;
      const stripeStatus = String(subscription.status || "active").toLowerCase();
      const terminal = ["canceled", "unpaid", "incomplete_expired"].includes(stripeStatus);
      record.active = !terminal && stripeStatus !== "incomplete";
      record.status = subscription.cancel_at_period_end ? "cancelled" : stripeStatus;
      record.periodStart = Number(subscription.current_period_start || 0) * 1000 || record.periodStart || null;
      record.periodEnd = Number(subscription.current_period_end || 0) * 1000 || record.periodEnd || null;
      record.updatedAt = Date.now();
      record.eventCreatedAt = Number(event.created || 0) * 1000 || Date.now();
      const saved = await saveWebSubscription(record);
      if (!saved.applied) {
        // A late delivery must not apply its stale tier/status to the credit
        // ledger after a newer subscription event has already won the row.
        res.json({ received: true });
        return;
      }
      const applied = saved.record;
      if (!applied.identity) {
        // Account deletion blanks the subscription identity. Do not recreate a
        // synthetic empty ledger if a subscription update arrives afterward.
        res.json({ received: true });
        return;
      }
      const ledgerStatus = subscription.cancel_at_period_end
        ? "cancelled"
        : stripeStatus === "past_due" || stripeStatus === "incomplete"
          ? "billing_retry"
          : terminal
            ? "expired"
            : "active";
      await updateSubscriptionStatus(applied.identity,
        ledgerStatus,
        { subscriptionId: applied.id, productId: `${applied.tier}_monthly`, periodStart: applied.periodStart, periodEnd: applied.periodEnd }
      );
      if (terminal && !(await hasOtherActiveWebSubscription(applied.identity, applied.id)) && !(await primarySubscriptionForIdentity(applied.identity))) {
        await downgradeToFree(applied.identity, { subscriptionId: applied.id, productId: `${applied.tier}_monthly`, periodStart: applied.periodStart, periodEnd: applied.periodEnd });
        await noteTier(applied.identity, "free", "stripe_subscription_ended");
        await noteBillingEvent(applied.identity, "subscription_expired", { tier: applied.tier, provider: "stripe" });
      }
      if (nextTier !== previousTier) {
        const rank: Record<string, number> = { plus: 1, plus_voice: 2, pro: 3 };
        if ((rank[nextTier] || 0) > (rank[previousTier] || 0)) await activateSubscriptionTier(applied.identity, nextTier);
        await noteBillingEvent(applied.identity, (rank[nextTier] || 0) > (rank[previousTier] || 0) ? "subscription_upgraded" : "subscription_downgraded", { fromTier: previousTier, toTier: nextTier, provider: "stripe" });
      } else if (subscription.cancel_at_period_end) {
        await noteBillingEvent(applied.identity, "subscription_cancelled", { tier: applied.tier, provider: "stripe", accessUntilPeriodEnd: true });
      }
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const subscription: any = event.data.object;
    const subscriptionId = String(subscription.id || "");
    const outcome = await storeUpdate<WebSubscription | null, { applied: boolean; record: WebSubscription | null }>(webSubKey(subscriptionId), null, (stored) => {
      if (!stored) return { value: null, result: { applied: false, record: null } };
      const eventCreatedAt = Number(event.created || 0) * 1000 || Date.now();
      if (Number(stored.eventCreatedAt || 0) > eventCreatedAt) return { value: stored, result: { applied: false, record: stored } };
      const next = { ...stored, active: false, updatedAt: Date.now(), eventCreatedAt };
      return { value: next, result: { applied: true, record: next } };
    });
    if (outcome.applied && outcome.record) {
      const record = outcome.record;
      // Account deletion intentionally blanks the stored identity. A late
      // Stripe deletion event must not create a blank account or downgrade an
      // empty identity; the deletion path already canceled and scrubbed it.
      if (!record.identity) {
        res.json({ received: true });
        return;
      }
      if (!(await hasOtherActiveWebSubscription(record.identity, record.id)) && !(await primarySubscriptionForIdentity(record.identity))) {
        await downgradeToFree(record.identity, { subscriptionId: record.id, productId: `${record.tier}_monthly`, periodStart: record.periodStart, periodEnd: record.periodEnd });
        await noteTier(record.identity, "free", "stripe_subscription_ended");
        await noteBillingEvent(record.identity, "subscription_expired", { tier: record.tier, provider: "stripe" });
      }
    }
  }
  res.json({ received: true });
});

// The dev grant stub that simulated purchases was REMOVED once real StoreKit
// IAP shipped — subscriptions now grant exclusively through /api/iap/verify
// (cryptographically verified transactions), so there is no secret-guarded
// free-credits path left in production.

/* ---- Apple In-App Purchase (StoreKit 2) --------------------------------- */
app.get("/api/iap/credit-packs", async (req, res) => {
  const identity = typeof req.query.identity === "string" ? req.query.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  if (!(await requireCreditIdentity(identity, res, req))) return;
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
  if (!(await requireCreditIdentity(identity, res, req))) return;
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
    let r;
    if (periodIsNew) {
      try {
        r = await grantForTransaction(identity, info.tier, info.periodKey, {
          subscriptionId: info.originalTransactionId,
          transactionId: info.transactionId,
          productId: info.productId,
          periodStart: info.purchaseDate ?? null,
          periodEnd: info.expiresDate ?? null,
          reason: "storekit_subscription",
          status: "active"
        });
      } catch (error) {
        // The global period reservation is separate from the account ledger.
        // Release it when the ledger write fails so Apple's retry can grant the
        // cycle instead of seeing a phantom "already claimed" period.
        await releaseSubscriptionPeriod(info.periodKey).catch((releaseError) => console.error("IAP period release failed:", releaseError));
        throw error;
      }
    } else {
      r = { granted: false, summary: await (async () => {
        await activateSubscriptionTier(identity, info.tier);
        return updateSubscriptionStatus(identity, "active", {
          subscriptionId: info.originalTransactionId,
          transactionId: info.transactionId,
          productId: info.productId,
          periodStart: info.purchaseDate ?? null,
          periodEnd: info.expiresDate ?? null
        });
      })() };
    }
    if (r.granted) {
      // Analytics: record the plan + gross revenue for this billing period.
      await noteTier(identity, info.tier, "subscription");
      await noteBillingEvent(identity, "subscription_started_or_renewed", { tier: info.tier, provider: "app_store" });
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
    // Inbox connections were removed from Taki. Purge any legacy OAuth token
    // that may still be attached to either pre-sign-in or Apple identities.
    await purgeLegacyInboxConnection(deviceId);
    await purgeLegacyInboxConnection(ledgerIdentity);
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

// Google web accounts do not have an Apple authorization code to revoke. A
// signed, still-live web session is the reauthentication step; all durable
// account, billing, chat, safety, and notification records are then removed.
app.post("/api/account/delete-google", async (req, res) => {
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!/^google:[^:\s]{1,256}$/.test(identity) || !(await verifyWebSession(identity, requestWebSession(req)))) {
    res.status(401).json({ error: "Google reauthentication required" });
    return;
  }
  try {
    await cancelWebSubscriptionsForDeletion(identity);
    const deleted = await purgeStandaloneAccount(identity);
    res.json({ ok: true, deleted });
  } catch (error) {
    console.error("Google account deletion failed:", error);
    res.status(502).json({ error: "The account could not be completely deleted. Please try again." });
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
        const context = {
          subscriptionId: tx.originalTransactionId,
          transactionId: tx.transactionId,
          productId: tx.productId,
          periodStart: tx.purchaseDate ?? null,
          periodEnd: tx.expiresDate ?? null
        };
        if (binding.role === "secondary") {
          if (t === "REFUND" || t === "REVOKE") {
            await revokeMergedSubscriptionCredits(identity, tx.originalTransactionId);
          } else if (t === "EXPIRED" || t === "GRACE_PERIOD_EXPIRED") {
            await clearRetiredSubscription(identity, tx.originalTransactionId);
          }
        } else if (t === "SUBSCRIBED" || t === "DID_RENEW" || t === "OFFER_REDEEMED") {
          const granted = await grantForTransaction(identity, tx.tier, tx.periodKey, {
            ...context,
            reason: t.toLowerCase(),
            status: "active"
          });
          if (granted.granted) {
            await noteTier(identity, tx.tier, t === "DID_RENEW" ? "subscription_renewed" : "subscription_started");
            await noteBillingEvent(identity, t === "DID_RENEW" ? "subscription_renewed" : "subscription_started", { tier: tx.tier, provider: "app_store" });
          }
        } else if (t === "REFUND" || t === "REVOKE") {
          await revokeSubscription(identity, context);
          await noteBillingEvent(identity, "subscription_refunded_or_revoked", { tier: tx.tier, provider: "app_store" });
        } else if (t === "EXPIRED" || t === "GRACE_PERIOD_EXPIRED") {
          await downgradeToFree(identity, context);
          await noteTier(identity, "free", "subscription_expired");
          await noteBillingEvent(identity, "subscription_expired", { tier: tx.tier, provider: "app_store" });
        } else if (t === "DID_FAIL_TO_RENEW") {
          await updateSubscriptionStatus(identity, note.subtype === "GRACE_PERIOD" ? "grace" : "billing_retry", context);
        } else if (t === "DID_CHANGE_RENEWAL_STATUS") {
          await updateSubscriptionStatus(identity, note.subtype === "AUTO_RENEW_DISABLED" ? "cancelled" : "active", context);
          if (note.subtype === "AUTO_RENEW_DISABLED") await noteBillingEvent(identity, "subscription_cancelled", { tier: tx.tier, provider: "app_store", accessUntilPeriodEnd: true });
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
const feedbackWindows = new Map<string, { at: number; count: number }>();
app.post("/api/feedback", async (req, res) => {
  const b = req.body || {};
  const ip = clientIp(req);
  const now = Date.now();
  const priorWindow = feedbackWindows.get(ip);
  const windowState = !priorWindow || now - priorWindow.at > 10 * 60_000 ? { at: now, count: 0 } : priorWindow;
  if (windowState.count >= 30) { res.status(429).json({ error: "feedback rate limit reached" }); return; }
  windowState.count += 1;
  feedbackWindows.set(ip, windowState);
  if (feedbackWindows.size > 5_000) for (const [key, value] of feedbackWindows) if (now - value.at > 10 * 60_000) feedbackWindows.delete(key);
  const submittedIdentity = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  if (submittedIdentity && !(await requireCreditIdentity(submittedIdentity, res, req))) return;
  const entry = {
    at: now,
    deviceId: submittedIdentity.slice(0, 64),
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
    await storeUpdate<any[], void>("feedback", [], (stored) => {
      const list = Array.isArray(stored) ? stored.slice(-499) : [];
      list.push(entry);
      return { value: list, result: undefined };
    });
  } catch (e) {
    console.error("Feedback store error:", e);
    res.status(503).json({ error: "feedback could not be saved" });
    return;
  }
  res.json({ ok: true });
});

// Dev: reset a device's credits.
app.post("/api/credits/reset", async (req, res) => {
  const b = req.body || {};
  if (!isAdminAuthorized(b.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const deviceId = typeof b.deviceId === "string" ? normalizeTopupIdentity(b.deviceId) : "";
  if (!deviceId) { res.status(400).json({ error: "valid deviceId required" }); return; }
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
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  await reinstate(identity);
  res.json({ ok: true, identity, status: "active" });
});

// Lift a permanent ban (the reverse of terminate): removes the identity + its
// own devices from the ban list, reactivates it, and queues the overview.
app.post("/api/admin/unban", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  const lifted = await unban(identity);
  res.json({ ok: true, identity, status: "active", lifted });
});

// Manually suspend an account (counts toward the escalation like an auto-suspend).
app.post("/api/admin/suspend", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  const acct = await suspendAccount(identity, typeof req.body?.reason === "string" ? req.body.reason : undefined);
  res.json({ ok: true, identity, status: acct.status, suspensionCount: acct.suspensionCount });
});

// Issue a warning the user must acknowledge next launch.
app.post("/api/admin/warn", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  const acct = await warnUser(identity, typeof req.body?.message === "string" ? req.body.message : undefined);
  res.json({ ok: true, identity, warnings: acct.warnings });
});

// Every account with any safety history — the "all accounts" management section.
app.post("/api/admin/accounts", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  // retiredBannedIps: IPs that were on the ban list before IP banning was
  // removed. Kept as a record only — they no longer block anyone.
  res.json({ accounts: await allSafetyAccounts(), retiredBannedIps: await retiredBannedIps() });
});

// Full detail for one account: status, escalation, lifetime total, and the whole
// retained flagged-message history (the only place that content is visible).
app.post("/api/admin/account-safety", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  res.json({ ok: true, account: await adminSafetyDetailFor(identity) });
});

// Read-only preview of the exact permanent-ban cascade.
app.post("/api/admin/terminate-preview", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  res.json({ ok: true, identity, impact: await previewTermination(identity) });
});

// Temporary identity-only restriction for safely testing the blocked app state.
app.post("/api/admin/test-restrict", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  const restriction = await setTestRestriction(identity, Number(req.body?.minutes) || 5);
  res.json({ ok: true, identity, testOnly: true, expiresAt: restriction.expiresAt });
});

app.post("/api/admin/test-restrict-clear", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  await clearTestRestriction(identity);
  res.json({ ok: true, identity, testOnly: true, cleared: true });
});

// Terminate + permanently ban the identity, its devices, and any other
// identities seen on the same device(s). No appeal.
app.post("/api/admin/terminate", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  const banned = await terminateAndBan(identity);
  res.json({ ok: true, identity, status: "terminated", banned });
});

// Remove a user from the dashboard registry (e.g. test accounts).
app.post("/api/admin/delete-user", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
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
    // Keep the confirmation capability in the authoritative store as well as
    // memory. Admin preview and commit requests may land on different Render
    // instances; an in-memory-only token made a valid confirmation randomly
    // fail with "preview expired" behind the load balancer.
    await storeSet(FULL_RESET_PREVIEW_KEY, { token: previewToken, expiresAt, fingerprint: preview.fingerprint });
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
  const previewToken = typeof req.body?.previewToken === "string" ? req.body.previewToken.trim().slice(0, 128) : "";
  let pending = fullResetPreviews.get(previewToken);
  if (!pending && previewToken) {
    try {
      const stored = await storeGet<{ token?: unknown; expiresAt?: unknown; fingerprint?: unknown } | null>(FULL_RESET_PREVIEW_KEY, null);
      if (stored?.token === previewToken && typeof stored.fingerprint === "string" && Number.isSafeInteger(Number(stored.expiresAt))) {
        pending = { expiresAt: Number(stored.expiresAt), fingerprint: stored.fingerprint };
      }
    } catch (error) {
      console.error("Full reset preview lookup failed:", error);
      res.status(503).json({ error: "The reset preview could not be verified. Run a new preview." });
      return;
    }
  }
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
    // The preview is informational; it is not a lock on mutable account
    // values. Devices continue to send analytics/profile heartbeats while an
    // administrator reads the confirmation dialogs, so comparing the entire
    // JSON snapshot here made an intentional wipe fail with a false
    // "Production data changed" error. Once fullResetInProgress is set, the
    // request gate above blocks new app traffic. Re-enumerate the authoritative
    // store under that lock and delete exactly what exists at commit time.
    // The admin secret, short-lived preview token, exact phrase, and final
    // confirmation still protect the destructive operation.
    const current = await fullResetPreviewWithStripe();
    if (current.fingerprint !== pending.fingerprint) {
      console.info("Full reset preview changed before confirmation; using the locked current snapshot.");
    }
    if (current.activeStripeSubscriptionIds.length && req.body?.cancelStripeSubscriptions !== true) {
      fullResetInProgress = false;
      res.status(409).json({ error: "Active Stripe subscriptions must be canceled before their account records can be deleted." });
      return;
    }

    await cancelStripeSubscriptionsForFullReset(current.activeStripeSubscriptionIds);
    await clearPushStateForReset();
    await clearAlertsForReset();
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
      recentSessions: records.flatMap((record) => record.analytics.recentSessions || []).sort((a, b) => b.at - a.at).slice(0, 100),
      billingEvents: records.flatMap((record) => record.analytics.billingEvents || []).sort((a, b) => b.at - a.at).slice(0, 250)
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
  const [credit, creditAdjustments] = await Promise.all([
    creditSummary(identity),
    adminCreditAdjustments(identity)
  ]);
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
      creditAdjustments,
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

async function adminSafetyDetailFor(requestedIdentity: string) {
  const identity = await canonicalAccountIdentity(requestedIdentity);
  const appleSub = identity.startsWith("apple:") ? identity.slice("apple:".length) : "";
  const memberIds = [...new Set([identity, ...(appleSub ? await devicesForApple(appleSub) : [])])];
  const details = await Promise.all(memberIds.map(safetyDetailFor));
  const selected = details.find((account) => account.status === "terminated")
    || details.find((account) => account.status === "suspended")
    || [...details].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
  const status = details.some((account) => account.status === "terminated")
    ? "terminated"
    : details.some((account) => account.status === "suspended") ? "suspended" : "active";
  const flaggedHistory = details
    .flatMap((account) => account.flaggedHistory || [])
    .sort((a, b) => a.at - b.at)
    .slice(-500);
  const violations = details
    .flatMap((account) => account.violations || [])
    .sort((a, b) => a.at - b.at)
    .slice(-50);
  const enforcementIdentity = status === "active" ? identity : selected.identity;
  return {
    ...selected,
    status,
    enforcementIdentity,
    strikes: details.reduce((sum, account) => sum + Number(account.strikes || 0), 0),
    suspensionCount: details.reduce((sum, account) => sum + Number(account.suspensionCount || 0), 0),
    flaggedTotal: details.reduce((sum, account) => sum + Number(account.flaggedTotal || 0), 0),
    warnings: details.reduce((sum, account) => sum + Number(account.warnings || 0), 0),
    violations,
    flaggedHistory,
    linkedIdentities: memberIds
  };
}

function buildAdminListRow(identity: string, records: UserRecord[], safetyByIdentity: Map<string, Awaited<ReturnType<typeof allSafetyAccounts>>[number]>) {
  const user = combineAdminUsers(identity, records);
  const memberIds = [...new Set([identity, ...records.map((record) => record.identity)])];
  const safetyAccounts = memberIds.map((id) => safetyByIdentity.get(id)).filter(Boolean);
  const status = safetyAccounts.some((account) => account?.status === "terminated")
    ? "terminated"
    : safetyAccounts.some((account) => account?.status === "suspended") ? "suspended" : "active";
  const strikes = Math.max(0, ...safetyAccounts.map((account) => Number(account?.strikes || 0)));
  const trackedTextCostUsd = money(user.analytics.textCostUsd, 6);
  const trackedVoiceCostUsd = money(user.analytics.voiceCostUsd, 6);
  const trackedCostUsd = trackedTextCostUsd + trackedVoiceCostUsd;
  const legacyUnallocatedCostUsd = money(Math.max(0, user.creditsUsed * CREDIT_USD - trackedCostUsd), 6);
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
  const paid = user.tier !== "free" || grossRevenueUsd > 0;
  const inactiveDays = user.lastSeenAt ? Math.floor((Date.now() - user.lastSeenAt) / 86400_000) : 9999;
  const segment = status !== "active" ? status
    : highValue ? "high_value"
    : paid && inactiveDays >= 14 ? "at_risk"
    : paid ? "growing"
    : activeDays30 >= 5 ? "engaged"
    : user.firstSeenAt && Date.now() - user.firstSeenAt < 7 * 86400_000 ? "new"
    : "standard";
  const devices = records.filter((record) => !record.identity.startsWith("apple:"));
  const displayName = user.apple?.name || user.device?.takiName
    || devices.map((record) => ownerNameFromDeviceName(record.device?.name || "")).find(Boolean)
    || "Taki user";
  return {
    identity,
    displayName,
    email: user.apple?.email || "",
    tier: user.tier || "free",
    balance: 0,
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
}

function isUnclaimedLowActivityUser(user: UserRecord): boolean {
  const messageCount = Number(user.analytics?.textQuestions || 0) + Number(user.analytics?.voiceQuestions || 0);
  const hasHumanName = Boolean(
    String(user.apple?.name || "").trim()
    || String(user.apple?.email || "").trim()
    || String(user.apple?.sub || "").trim()
    || String(user.device?.takiName || "").trim()
    || ownerNameFromDeviceName(user.device?.name)
  );
  const hasMeaningfulAccountActivity = user.tier !== "free"
    || Number(user.revenueUsd || 0) > 0
    || (user.purchases || []).length > 0
    || user.engagement?.pushEnabled === true
    || user.engagement?.emailEnabled === true;
  // These records are retained for account recovery and can be revealed with
  // the dashboard toggle, but they should not bury real customers in the
  // default list. A user-supplied name, verified provider identity, purchase,
  // paid tier, or explicit notification opt-in always keeps the row visible.
  return !hasHumanName && !hasMeaningfulAccountActivity && messageCount <= 2;
}

async function buildAdminListRows(includeUnclaimed = false) {
  const [allRecords, safetyAccounts] = await Promise.all([allUsers(), allSafetyAccounts()]);
  const safetyByIdentity = new Map(safetyAccounts.map((account) => [account.identity, account]));
  const safetyIdentities = new Set(safetyByIdentity.keys());
  const users = includeUnclaimed
    ? allRecords
    : allRecords.filter((user) => !isUnclaimedLowActivityUser(user) || safetyIdentities.has(user.identity));
  const groups = new Map<string, UserRecord[]>();
  for (const user of users) {
    const identity = user.identity.startsWith("apple:")
      ? user.identity
      : user.apple?.sub ? `apple:${user.apple.sub}` : user.identity;
    groups.set(identity, [...(groups.get(identity) || []), user]);
  }
  return {
    rows: [...groups.entries()]
      .map(([identity, records]) => buildAdminListRow(identity, records, safetyByIdentity))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    hiddenUnclaimed: allRecords.length - users.length
  };
}

// Account-level feed: linked devices roll into one customer, while detail pages
// retain device, feature, cost, purchase, engagement, and safety information.
app.post("/api/admin/users", async (req, res) => {
  if (!requireAdminSecret(req.body?.secret, res)) return;
  try {
    const list = await buildAdminListRows(req.body?.includeUnclaimed === true);
    const rows = list.rows;
    const totals = rows.reduce((total, row) => ({
      users: total.users + 1,
      highValue: total.highValue + (row.highValue ? 1 : 0),
      questions: total.questions + row.totalQuestions,
      gross: total.gross + row.grossRevenueUsd,
      net: total.net + row.netRevenueUsd,
      cost: total.cost + row.costUsd,
      profit: total.profit + row.profitUsd
    }), { users: 0, highValue: 0, questions: 0, gross: 0, net: 0, cost: 0, profit: 0 });
    res.set("Cache-Control", "no-store");
    res.json({ users: rows, hiddenUnclaimed: list.hiddenUnclaimed, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, typeof value === "number" ? money(value) : value])), emailConfigured: isEngagementEmailConfigured(), pushConfigured: isPushConfigured() });
  } catch (error) {
    console.error("Admin account list failed:", error);
    res.status(503).json({ error: "The account list could not load. Try Refresh in a moment." });
  }
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
  const identity = readAdminIdentity(req, res);
  if (!identity) return;
  res.json({ account: (await buildAdminAccount(identity)).detail });
});

// Add a one-time credit grant from the authenticated admin dashboard. The
// account identity is canonicalized first so a device selection credits the
// linked Apple account rather than creating a parallel balance. Requiring a
// known identity also prevents a typo from silently creating a new account.
app.post("/api/admin/credits/grant", async (req, res) => {
  if (!requireAdminSecret(req.body?.secret, res)) return;
  const requestedIdentity = readAdminIdentity(req, res);
  if (!requestedIdentity) return;
  const amountValue = typeof req.body?.amount === "number"
    ? req.body.amount
    : typeof req.body?.amount === "string" && /^\d+$/.test(req.body.amount.trim())
      ? Number(req.body.amount.trim())
      : NaN;
  if (!Number.isSafeInteger(amountValue) || amountValue < 1 || amountValue > MAX_ADMIN_CREDIT_GRANT) {
    res.status(400).json({ error: `Credits must be a whole number from 1 to ${MAX_ADMIN_CREDIT_GRANT.toLocaleString()}.` });
    return;
  }
  try {
    const identity = await canonicalAccountIdentity(requestedIdentity);
    if (!(await isKnownIdentity(requestedIdentity)) && !(await isKnownIdentity(identity))) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "Administrative credit grant";
    const result = await grantAdminCredits(identity, amountValue, reason);
    res.set("Cache-Control", "no-store");
    res.status(201).json({
      ok: true,
      identity,
      amount: result.amount,
      reason: result.reason,
      expiresAt: result.expiresAt,
      balance: result.summary.balance,
      credits: result.summary
    });
  } catch (error) {
    console.error("Admin credit grant failed:", error);
    res.status(503).json({ error: "Credits could not be added. Nothing was changed." });
  }
});

app.post("/api/admin/engagement-preview", async (req, res) => {
  if (!isAdminAuthorized(req.body?.secret)) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = readAdminIdentity(req, res);
  const channel: EngagementChannel = req.body?.channel === "email" ? "email" : "push";
  if (!identity) return;
  const account = await buildAdminAccount(identity);
  res.json({ preview: await recommendedEngagement(account.user, channel), enabled: channel === "push" ? account.user.engagement.pushEnabled : account.user.engagement.emailEnabled });
});

function engagementDeliveryFailure(channel: EngagementChannel, reason: string): { status: number; error: string } {
  const normalized = reason.trim();
  if (/no registered push token/i.test(normalized)) {
    return {
      status: 409,
      error: "This account has no registered push token. Have the user allow notifications and open Taki once before sending."
    };
  }
  if (/no connected email|no recipient email/i.test(normalized)) {
    return {
      status: 409,
      error: "This account has no connected email address for personalized messages."
    };
  }
  if (/not configured/i.test(normalized)) {
    return {
      status: 503,
      error: channel === "push"
        ? "Push notifications are not configured on the server."
        : "Email notifications are not configured on the server."
    };
  }
  if (/BadDeviceToken|Unregistered|ExpiredProviderToken/i.test(normalized)) {
    return {
      status: 409,
      error: "Apple rejected this device's notification token. Have the user reopen Taki and allow notifications again."
    };
  }
  if (/InvalidProviderToken|MissingProviderToken|MissingTopic|TopicDisallowed|DeviceTokenNotForTopic|BadCertificate/i.test(normalized)) {
    return {
      status: 503,
      error: "Push notifications are misconfigured on the server. Check the APNs key, team ID, bundle ID, and sandbox/production setting."
    };
  }
  if (/APNs returned HTTP 5\d\d|HTTP 501|HTTP 502|HTTP 503|provider returned 5\d\d/i.test(normalized)) {
    return {
      status: 503,
      error: "Apple's notification service is temporarily unavailable. Try again shortly."
    };
  }
  if (/timed out|ECONN|ENET|socket|fetch failed|connect/i.test(normalized)) {
    return {
      status: 503,
      error: "The notification provider could not be reached. Try again shortly."
    };
  }
  return { status: 503, error: normalized || `The ${channel} notification could not be delivered.` };
}

app.post("/api/admin/engagement-send", async (req, res) => {
  if (!requireAdminSecret(req.body?.secret, res)) return;
  const identity = readAdminIdentity(req, res);
  const channel: EngagementChannel = req.body?.channel === "email" ? "email" : "push";
  if (!identity) return;
  try {
    const account = await buildAdminAccount(identity);
    const enabled = channel === "push" ? account.user.engagement.pushEnabled : account.user.engagement.emailEnabled;
    if (!enabled) { res.status(409).json({ error: `The user has not enabled personalized ${channel}.` }); return; }
    const result = await sendPersonalizedEngagement(account.user, channel, account.deviceIds, "admin");
    if (result.ok) { res.json(result); return; }
    const failure = engagementDeliveryFailure(channel, result.reason || result.campaign.error || "");
    res.status(failure.status).json({ ...result, error: failure.error });
  } catch (error) {
    console.error("Admin engagement send failed:", error);
    res.status(503).json({ error: "The notification could not be sent. Try again shortly." });
  }
});

let engagementTickBusy = false;
async function tickPersonalizedEngagement(): Promise<void> {
  if (engagementTickBusy || (!isPushConfigured() && !isEngagementEmailConfigured())) return;
  engagementTickBusy = true;
  try {
    // Fresh anonymous installs are retained for recovery, but should not enter
    // the proactive-engagement loop until they have either identified
    // themselves, opted in, paid, or meaningfully used Taki.
    const users = (await allUsers()).filter((user) => !isUnclaimedLowActivityUser(user));
    const groups = new Map<string, UserRecord[]>();
    for (const record of users) {
      const identity = record.identity.startsWith("apple:")
        ? record.identity
        : record.apple?.sub ? `apple:${record.apple.sub}` : record.identity;
      groups.set(identity, [...(groups.get(identity) || []), record]);
    }
    for (const [identity, records] of groups) {
      const user = combineAdminUsers(identity, records);
      const deviceIds = records
        .filter((record) => !record.identity.startsWith("apple:"))
        .map((record) => record.identity);
      let sentPush = false;
      if (isPushConfigured() && await shouldSendAutomatic(user, "push")) {
        sentPush = (await sendPersonalizedEngagement(user, "push", deviceIds, "automatic")).ok;
      }
      if (!sentPush && isEngagementEmailConfigured() && await shouldSendAutomatic(user, "email")) {
        await sendPersonalizedEngagement(user, "email", deviceIds, "automatic");
      }
    }
  } catch (error) {
    console.error("Personalized engagement tick:", error);
  } finally {
    engagementTickBusy = false;
  }
}
const firstEngagementTick = setTimeout(() => { void tickPersonalizedEngagement(); }, 90_000);
firstEngagementTick.unref?.();
const engagementInterval = setInterval(() => { void tickPersonalizedEngagement(); }, 60 * 60 * 1000);
engagementInterval.unref?.();

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
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)
    || fromLat < -90 || fromLat > 90 || toLat < -90 || toLat > 90
    || fromLon < -180 || fromLon > 180 || toLon < -180 || toLon > 180) {
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

// Express' trusted-proxy setting normalizes req.ip to the client address.
function clientIp(req: any): string {
  const xf = String(req.headers?.["x-forwarded-for"] || "");
  const forwarded = xf.split(",").map((part) => part.trim()).filter(Boolean);
  const raw = String(req.ip || forwarded.at(-1) || req.socket?.remoteAddress || "unknown").trim().toLowerCase();
  // Keep one stable spelling for IPv4 across Render's proxy and local/native
  // listeners. This is especially important for the per-IP signup cap and the
  // account-association index; otherwise ::ffff:203.0.113.4 and 203.0.113.4
  // would be treated as two different networks.
  return raw.replace(/^::ffff:/, "").replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").slice(0, 120) || "unknown";
}

function validTimeZone(value: string | undefined): boolean {
  if (!value) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

// Safety gate: records identity/device/IP context and blocks accounts whose
// delayed suspension or admin enforcement is already active. New messages are
// reviewed contextually in the background; the user is never shown a special
// keyword/refusal response that reveals whether a strike was recorded.
type GateResult = { message: string; block?: "banned" | "suspended"; failClosed?: boolean };
async function safetyGate(identity: string, message: string, req: any, _voiceMode = false): Promise<GateResult | null> {
  if (!identity) return null;
  const ip = clientIp(req);
  const dev = identity.startsWith("apple:") ? undefined : identity;
  try {
    await Promise.all([
      recordAssoc(identity, dev, ip),
      noteUser(identity, ip, String(req.headers?.["user-agent"] || ""))
    ]);
    const [banned, testRestricted, acct] = await Promise.all([
      isBanned(identity, dev, ip),
      isTestRestricted(identity),
      getSafetyAccount(identity)
    ]);
    if (banned || testRestricted) return { message: BANNED_MSG, block: "banned" };
    if (acct.status !== "active") return { message: SUSPENDED_MSG, block: "suspended" };
    queueContextualSafetyReview(identity, message, { ip, deviceId: dev });
  } catch (e) {
    console.error("safetyGate error:", e);
    return {
      message: "Taki is temporarily unavailable while it verifies account safety. Please try again shortly.",
      failClosed: true
    };
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
  prefersDeviceSpeech = false,
  voiceInputUsd = 0,
  meteringRequestId: string = randomUUID(),
  beforeUsageCommit?: (details: { response: any; deferVoiceSynthesis: boolean; includedVoice: boolean }) => Promise<void>,
  onStableVoiceText?: (text: string) => void | Promise<void>
): Promise<any> {
  let tier: Tier = "free";
  let usageSummary: Awaited<ReturnType<typeof creditSummary>> | null = null;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    usageSummary = sum;
    tier = sum.tier;
    state.accountSummary = sum;
  }

  // Product/support questions are answered from the authoritative catalog and
  // live ledger without an AI call or credit charge. This remains available
  // even when the account is out of credits, which is essential for explaining
  // how to renew, upgrade, or restore access.
  const productAnswer = productAnswerFor(state.message, {
    account: usageSummary,
    timeZone: state.timeZone,
    voiceMode
  });
  if (productAnswer) {
    const response = finalizeResponse({
      spokenText: productAnswer,
      action: null,
      sources: [],
      memoryPatch: { pendingClarification: null },
      needsExecution: false
    }, state);
    if (voiceMode && response.spokenText) response.spokenText = await fitVoiceResponse(response.spokenText, state.userProfile);
    if (beforeUsageCommit) await beforeUsageCommit({ response, deferVoiceSynthesis: false, includedVoice: false });
    return {
      ...response,
      ...(usageSummary ? { credits: { ...usageSummary, cost: 0 } } : {})
    };
  }

  if (deviceId && usageSummary) {
    const sum = usageSummary;
    const estimated = voiceMode ? voiceTurnEstimateCredits(sum.voiceCredits > 0) : MIN_REQUEST_CREDITS;
    const block = usageBlockFor(sum, estimated);
    if (block) return usageBlockedPayload(block);
  }
  const measured = await measureUsage(async () => {
    const plan = await withTimeout(planAssistantResponse(state, onStableVoiceText), 45000, "Assistant plan");
    const response = finalizeResponse(plan, state);
    // Action confirmations and clarification prompts already come from the
    // capability-aware planner. Keep them model-independent so calls, texts,
    // calendar work, and the follow-up questions they need stay instant even
    // during a provider outage.
    if (voiceMode && response.spokenText) {
      response.spokenText = await fitVoiceResponse(response.spokenText, state.userProfile);
    }
    return response;
  });
  const finalized = measured.value;
  const hasActions = !!finalized.action || (Array.isArray(finalized.actions) && finalized.actions.length > 0);
  const deferVoiceSynthesis = voiceMode && !prefersDeviceSpeech && supportsDeferredActionSynthesis && hasActions && !!deviceId;
  if (deviceId) {
    const modelAndSearchUsd = totalUsageUsd(measured.usage);
    const voiceOutputUsd = voiceMode && !prefersDeviceSpeech && !deferVoiceSynthesis
      ? ttsCostUsd(speechCharacterCount(finalized.spokenText || ""))
      : 0;
    const ownerCostUsd = modelAndSearchUsd + (voiceMode ? Math.max(0, voiceInputUsd) + voiceOutputUsd : 0);
    const charge = decideAssistantCharge({
      summary: usageSummary,
      tier,
      voiceMode,
      includedVoice: voiceMode && (usageSummary?.voiceCredits || 0) > 0,
      baseUsd: modelAndSearchUsd,
      voiceInputUsd,
      voiceOutputUsd
    });
    // The block check comes first: a refused turn must not burn an included
    // voice turn the user never got to hear.
    if (charge.block) return usageBlockedPayload(charge.block);
    const voiceSynthesisIncluded = charge.includedVoice;
    let s: Awaited<ReturnType<typeof chargeUsageUsd>>;
    try {
      s = await chargeUsageUsd(deviceId, charge.usageUsd, voiceMode ? "voice" : "text", meteringRequestId);
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        const fresh = await creditSummary(deviceId);
        await noteBillingEvent(deviceId, "insufficient_credits_blocked", { mode: voiceMode ? "voice" : "text", requiredAiCredits: error.required, availableAiCredits: error.available });
        return usageBlockedPayload(usageBlockFor(fresh, error.required)!);
      }
      throw error;
    }
    // Reserve/charge the authoritative ledger before starting any optional
    // provider work (especially ElevenLabs TTS).  This closes the old window
    // where a provider call could succeed while the balance update later lost a
    // race or rejected for insufficient credits.
    if (beforeUsageCommit) {
      await beforeUsageCommit({ response: finalized, deferVoiceSynthesis, includedVoice: charge.includedVoice });
    }
    if (!s.deduplicated) {
      await noteSpend(deviceId, s.spent);
      await noteCreditCharge(deviceId, voiceMode ? "voice" : "text", s);
      await noteInteraction(deviceId, {
        channel: voiceMode ? "voice" : "text",
        feature: assistantFeature(finalized),
        credits: s.spent,
        costUsd: ownerCostUsd
      });
    }
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
  const deviceWeather: DeviceWeather | undefined = req.body?.deviceWeather;
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
  const voiceMode = req.body?.voiceMode === true;
  // Opt-in progressive text. Older installed builds omit the flag and keep
  // receiving a single JSON body, so streaming can ship before the app does.
  const progressiveText = req.body?.progressiveText === true && !voiceMode;
  let textStreamStarted = false;
  // Started lazily on the FIRST partial chunk, so the usage-block (402) and
  // outage (503) paths can still set a status code when nothing has streamed.
  const startTextStream = () => {
    if (!progressiveText || textStreamStarted) return;
    textStreamStarted = true;
    res.status(200);
    res.set("Content-Type", "application/x-ndjson; charset=utf-8");
    res.set("Cache-Control", "no-cache, no-transform");
    res.set("X-Accel-Buffering", "no");
    res.flushHeaders();
  };
  const writeTextEvent = (event: Record<string, unknown>) => {
    if (!textStreamStarted) return;
    res.write(`${JSON.stringify(event)}\n`);
  };
  const finishTextResponse = (payload: Record<string, unknown>, status = 200) => {
    if (textStreamStarted) {
      writeTextEvent({ type: "final", response: payload });
      res.end();
    } else {
      res.status(status).json(payload);
    }
  };
  // Privacy: only the style vectors for recipients named in this message arrive
  // here — never a contact list or message history.
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  // Personalization lives on-device. The account-confirmation name is the only
  // profile field retained, and only because the user opted to show it on /buy.
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  const takiModel = normalizeTakiModel(req.body?.profile?.model);
  const meteringRequestId = turnMeteringRequestId(
    req.body?.requestId,
    "assistant",
    userMessage,
    rawContext,
    takiModel,
    voiceMode ? "voice" : "text"
  );
  void captureRequestDeviceInfo(req, userProfile.name).catch((error) => console.error("device info capture:", error));

  const state = buildConversationState(userMessage, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, voiceMode, deviceId, deviceWeather);

  const gate = await safetyGate(deviceId, userMessage, req, voiceMode);
  if (gate) {
    res.status(gate.failClosed ? 503 : 200).json({
      ...finalizeResponse({ spokenText: gate.message, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
      ...(gate.block ? { blocked: true, access: gate.block, accessMessage: gate.message } : {})
    });
    return;
  }

  try {
    const replayKey = `${deviceId}:${meteringRequestId}`;
    const result = await assistantTurnReplay.run(replayKey, () =>
      withTakiModel(takiModel, () => runAssistant(
        state,
        deviceId,
        voiceMode,
        false,
        false,
        0,
        meteringRequestId,
        undefined,
        progressiveText
          ? (text: string) => { startTextStream(); writeTextEvent({ type: "text", text }); }
          : undefined
      ))
    );
    if (result?.usageBlocked) { finishTextResponse(result, 402); return; }
    finishTextResponse(result);
  } catch (error) {
    // Vendor outage (Gemini quota/auth/down): reply immediately with a spoken
    // message instead of a bare 502 the app can't voice.
    if (error instanceof ServiceError) {
      finishTextResponse({
        ...finalizeResponse({ spokenText: error.spoken, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
        serviceUnavailable: true,
        serviceError: error.kind
      }, 503);
      return;
    }
    console.error("Assistant route error:", error);
    // Do not make a second model call here: the first request may have completed
    // before persistence failed, and retrying would double provider cost.
    finishTextResponse({ error: "assistant unavailable" }, 502);
  }
});

// Voice mode: a recorded clip in, the spoken answer (audio) out. Transcribe via
// ElevenLabs → the normal assistant brain (voiceMode=true so the credits voice
// surcharge applies) → synthesize the reply. The device still executes the
// returned action; only the extra STT/TTS is voice-specific.
app.post("/api/voice", async (req, res) => {
  const audioBase64 = typeof req.body?.audioBase64 === "string" ? req.body.audioBase64 : "";
  if (audioBase64.length > 8_000_000) { res.status(413).json({ error: "voice recording too large" }); return; }
  const deviceTranscript = typeof req.body?.transcript === "string" ? req.body.transcript.trim().slice(0, 4000) : "";
  const prefersDeviceSpeech = req.body?.deviceSpeech === true;
  const progressiveVoice = req.body?.progressiveVoice === true;
  let voiceStreamStarted = false;
  const startVoiceStream = () => {
    if (!progressiveVoice || voiceStreamStarted) return;
    voiceStreamStarted = true;
    res.status(200);
    res.set("Content-Type", "application/x-ndjson; charset=utf-8");
    res.set("Cache-Control", "no-cache, no-transform");
    res.set("X-Accel-Buffering", "no");
    res.flushHeaders();
  };
  const writeVoiceEvent = (event: Record<string, unknown>) => {
    if (!voiceStreamStarted) return;
    res.write(`${JSON.stringify(event)}\n`);
  };
  const finishVoiceResponse = (payload: Record<string, unknown>, status = 200) => {
    if (voiceStreamStarted) {
      writeVoiceEvent({ type: "final", response: payload });
      res.end();
    } else {
      res.status(status).json(payload);
    }
  };
  // CarPlay supplies Apple's transcription and can speak the reply locally, so
  // it does not need to wait for either ElevenLabs request. Other voice clients
  // retain the selected cloud voice and the cloud transcription fallback.
  if (!isVoiceConfigured() && (!deviceTranscript || !prefersDeviceSpeech)) {
    res.status(503).json({ error: "voice not configured (set ELEVENLABS_API_KEY)" }); return;
  }
  const speechHints = normalizeSpeechKeyterms([
    "Taki", "Amicalola", "Amicalola Falls", "Dyckert",
    ...(Array.isArray(req.body?.speechHints) ? req.body.speechHints : [])
  ]);
  const audioDurationMs = billableAudioDurationMs(audioBase64, req.body?.audioDurationMs);
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "audio/m4a";
  const rawContext = typeof req.body?.context === "string" ? req.body.context.slice(-120_000) : "";
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const deviceWeather: DeviceWeather | undefined = req.body?.deviceWeather;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  if (!prefersDeviceSpeech && voiceId && !(await listVoices()).some((voice) => voice.id === voiceId)) {
    res.status(400).json({ error: "voice is not available" }); return;
  }
  const voiceVariability = typeof req.body?.voiceVariability === "number"
    ? Math.max(0, Math.min(1, req.body.voiceVariability))
    : 0.5;
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  const userProfile = parseUserPersona(
    req.body?.profile,
    req.body?.addressUser,
    voiceId === PIRATE_MARSHAL_VOICE_ID
  );
  if (voiceId === PIRATE_MARSHAL_VOICE_ID) {
    userProfile.personality = "pirate";
    userProfile.intensity = 10;
  }
  const takiModel = normalizeTakiModel(req.body?.profile?.model);
  const meteringRequestId = turnMeteringRequestId(
    req.body?.requestId,
    "voice",
    deviceTranscript,
    audioBase64,
    rawContext,
    takiModel,
    prefersDeviceSpeech ? "device-speech" : "cloud-speech"
  );
  void captureRequestDeviceInfo(req, userProfile.name).catch((error) => console.error("device info capture:", error));
  if (!audioBase64 && !deviceTranscript) { res.status(400).json({ error: "audioBase64 or transcript required" }); return; }

  try {
    // Prefer Apple's transcription when the phone supplied a confident one. This
    // removes an entire sequential cloud STT request from normal voice turns;
    // audio remains the fallback for unsupported devices or uncertain results.
    const usedCloudTranscription = !deviceTranscript;
    const transcript = deviceTranscript || await transcribe(audioBase64, mime, speechHints);
    if (!transcript) {
      res.json({ transcript: "", spokenText: VOICE_REPEAT_PROMPT, action: null, actions: null, empty: true, needsRepeat: true });
      return;
    }
    if (shouldAskForVoiceRepeat(transcript)) {
      // A filler/noise-only miss is handled before safety, planning, metering,
      // or TTS. CarPlay speaks this response immediately on-device.
      res.json({ transcript, spokenText: VOICE_REPEAT_PROMPT, action: null, actions: null, needsRepeat: true });
      return;
    }

    const gate = await safetyGate(deviceId, transcript, req, true);
    if (gate) {
      let audio = "";
      if (!prefersDeviceSpeech) {
        try { audio = await synthesize(gate.message, voiceId, voiceVariability); } catch { /* text still returns if TTS is temporarily unavailable */ }
      }
      res.status(gate.failClosed ? 503 : 200).json({ transcript, spokenText: gate.message, action: null, actions: null, audioBase64: audio, mime: "audio/mpeg", blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) });
      return;
    }
    startVoiceStream();
    writeVoiceEvent({ type: "transcript", transcript });
    const state = buildConversationState(transcript, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, true, deviceId, deviceWeather);
    let audio = "";
    let progressiveText = "";
    let progressiveAudioStarted = false;
    let progressiveSpeechStarted = false;
    let progressiveAudioQueue: Promise<void> = Promise.resolve();
    const queueProgressiveText = (rawText: string) => {
      const text = rawText.replace(/\s+/g, " ").trim();
      if (!progressiveVoice || !text) return;
      progressiveText = `${progressiveText}${progressiveText ? " " : ""}${text}`.trim();
      if (prefersDeviceSpeech) {
        progressiveSpeechStarted = true;
        writeVoiceEvent({ type: "speech", text });
        return;
      }
      // Start synthesizing every newly generated bundle immediately. The
      // ordered queue waits only to emit it, so the next audio is prepared
      // while the user is still hearing the previous bundle.
      const audioReady = synthesize(text, voiceId, voiceVariability).then(
        (chunkAudio) => ({ chunkAudio, error: null as unknown }),
        (error) => ({ chunkAudio: "", error })
      );
      progressiveAudioQueue = progressiveAudioQueue.then(async () => {
        const ready = await audioReady;
        if (ready.error) throw ready.error;
        const chunkAudio = ready.chunkAudio;
        if (!chunkAudio) throw new ServiceError("voice_unavailable", VOICE_UNAVAILABLE_SPOKEN);
        progressiveAudioStarted = true;
        writeVoiceEvent({ type: "audio", text, audioBase64: chunkAudio, mime: "audio/mpeg" });
      });
    };
    // runAssistant owns the authoritative entitlement/credit check. Avoiding a
    // duplicate account-store round trip here shortens every CarPlay turn.
    const result = await withTakiModel(takiModel, () => runAssistant(
      state,
      deviceId,
      true,
      req.body?.deferredActionSynthesis === true,
      prefersDeviceSpeech,
      usedCloudTranscription ? sttCostUsd(audioDurationMs) : 0,
      meteringRequestId,
      async ({ response, deferVoiceSynthesis }) => {
        if (deferVoiceSynthesis) return;
        if (progressiveVoice) {
          let finalText = String(response.spokenText || "").replace(/\s+/g, " ").trim();
          if (progressiveText) {
            if (finalText.startsWith(progressiveText)) {
              finalText = finalText.slice(progressiveText.length).trim();
            } else {
              // The final voice clamp should normally preserve the first stable
              // sentence. If it did rewrite it, keep the already-spoken truthful
              // phrase instead of speaking a contradictory duplicate.
              response.spokenText = progressiveText;
              finalText = "";
            }
          }
          for (const chunk of splitTextForProgressiveSpeech(finalText)) queueProgressiveText(chunk);
          await progressiveAudioQueue;
          return;
        }
        if (prefersDeviceSpeech) return;
        audio = await synthesize(response.spokenText || "", voiceId, voiceVariability);
        if (!audio && (response.spokenText || "").trim()) {
          throw new ServiceError("voice_unavailable", VOICE_UNAVAILABLE_SPOKEN);
        }
      },
      progressiveVoice ? queueProgressiveText : undefined
    ));
    if (result?.usageBlocked) { finishVoiceResponse(result, 402); return; }
    finishVoiceResponse({
      ...result,
      transcript,
      transcriptionSource: deviceTranscript ? "device" : "cloud",
      audioBase64: audio,
      mime: "audio/mpeg",
      ...(progressiveAudioStarted ? { progressiveAudioStarted: true } : {}),
      ...(progressiveSpeechStarted ? { progressiveSpeechStarted: true } : {})
    });
  } catch (error) {
    // Vendor outage: speak the message right away. For an AI (Gemini) outage
    // ElevenLabs is usually fine, so voice it in the user's selected voice; for
    // a voice outage there's nothing to synthesize with, so return text and let
    // the phone read it aloud.
    if (error instanceof ServiceError) {
      let audio = "";
      if (!prefersDeviceSpeech && error.kind !== "voice_unavailable") {
        try { audio = await synthesize(error.spoken, voiceId, voiceVariability); } catch { /* text-only fallback */ }
      }
      finishVoiceResponse({
        transcript: deviceTranscript || "",
        spokenText: error.spoken,
        action: null,
        actions: null,
        audioBase64: audio,
        mime: "audio/mpeg",
        serviceUnavailable: true,
        serviceError: error.kind
      }, 503);
      return;
    }
    console.error("Voice route error:", error);
    finishVoiceResponse({ error: "voice unavailable" }, 502);
  }
});

const memoryExtractWindows = new Map<string, { startedAt: number; count: number }>();
app.post("/api/memory/extract", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 2000) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
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
  await chargeMeasuredUsage(deviceId, measured.usage, turnMeteringRequestId(
    req.body?.requestId,
    "memory-extract",
    message,
    JSON.stringify(currentFacts),
    req.body?.teen === true ? "teen" : "adult"
  ));
  res.json(measured.value);
});

app.post("/api/chat/title", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1200) : "";
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (!message || !deviceId) { res.status(400).json({ error: "message and deviceId required" }); return; }
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
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
  await chargeMeasuredUsage(deviceId, measured.usage, turnMeteringRequestId(
    req.body?.requestId,
    "chat-title",
    message,
    req.body?.teen === true ? "teen" : "adult"
  ));
  res.json({ title: measured.value });
});

// The account's available voices, for the app's voice picker.
app.get("/api/voices", async (req, res) => {
  if (!(await requireCreditIdentity(req.query?.deviceId, res, req))) return;
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
  if (!(await requireCreditIdentity(deviceId, res, req))) return;
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
    if (!plan.allowed) {
      if (deferredToken) releaseVoiceSynthesisToken(deferredToken, deviceId);
      res.status(402).json({ error: plan.message });
      return;
    }
    const audio = await synthesize(text, voiceId, variability);
    if (!audio) throw new Error("Voice synthesis returned no audio");
    if (pending && deferredToken) consumeVoiceSynthesisToken(deferredToken, deviceId);
    const speechUsd = ttsCostUsd(speechCharacterCount(text));
    await noteChannelCost(deviceId, "voice", speechUsd);
    if (!plan.included) {
      const charged = await chargeUsageUsd(deviceId, speechUsd, "text", `voice-correction:${randomUUID()}`);
      await noteSpend(deviceId, charged.spent);
    }
    res.json({ audioBase64: audio, mime: "audio/mpeg", spokenText: text });
  } catch (error) {
    if (deferredToken) releaseVoiceSynthesisToken(deferredToken, deviceId);
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
  const deviceId = await requireCreditIdentity(req.query?.deviceId, res, req);
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

// Keep rejected async handlers, malformed JSON, oversized bodies, and CORS
// failures from becoming Express' default HTML/stack-trace response. Native
// clients need a stable JSON error shape, while logs retain the diagnostic.
app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(error); return; }
  const status = Number(error?.status || error?.statusCode);
  console.error("Unhandled request error:", error);
  if (error?.type === "entity.too.large" || status === 413) {
    res.status(413).json({ error: "request too large" });
    return;
  }
  if (/origin is not allowed/i.test(String(error?.message || ""))) {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  res.status(status >= 400 && status < 500 ? status : 500).json({ error: "request failed" });
});

void storeDeleteCategory("connected_knowledge")
  .then((removed) => { if (removed) console.log(`Removed ${removed} retired connected-knowledge record(s).`); })
  .catch((error) => { console.error("Could not purge retired connected-knowledge records:", error); })
  // IP banning was removed; clear any IPs left on the ban list by older
  // terminations (archived to safety:banlist:retired-ips, not destroyed).
  .then(() => retireBannedIps())
  .then((retired) => { if (retired) console.log(`Retired ${retired} stale banned IP(s) from the ban list.`); })
  .catch((error) => { console.error("Could not retire stale banned IPs:", error); })
  .finally(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Taki AI server (planner-first, modular) listening on http://0.0.0.0:${PORT}`);
    });
  });
