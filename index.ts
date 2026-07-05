import express from "express";
import cors from "cors";
import Stripe from "stripe";

import { PORT } from "./src/ai.js";
import type { DeviceLocation } from "./src/types.js";
import { buildConversationState } from "./src/context.js";
import { planAssistantResponse } from "./src/planner.js";
import { finalizeResponse } from "./src/validators.js";
import { getGeneralAnswer, styleInCharacter, getWeatherSnapshot, inferEventDestination, matchEventToQuery, getTravelTime, answerAboutImage } from "./src/tools.js";
// getTravelTime (above) also powers the background commute push loop.
import { withTimeout, briefForVoice } from "./src/util.js";
import { parseIncomingStyleProfiles } from "./src/messageStyle.js";
import { parseUserPersona } from "./src/persona.js";
import {
  registerToken, forgetToken, broadcast, getTokens, isPushConfigured,
  registerLiveActivity, unregisterLiveActivity, getLiveActivities, sendLiveActivityUpdate
} from "./src/push.js";
import { cachedTrackerSnapshot } from "./src/tracker.js";
import { addAlert, listAlerts, cancelAlerts, pollAlerts, type Alert } from "./src/alerts.js";
import { isDurable, storeGet, storeSet } from "./src/store.js";
import { summary as creditSummary, spend, reset as resetCredits, costForRequest, tierCatalog, grantForTransaction, mergeCredits, downgradeToFree, revokeSubscription, noteVoiceQuestion, grantCredits, topupPriceCents, CREDIT_TOPUP_MIN, CREDIT_TOPUP_MAX, MIN_REQUEST_CREDITS, FREE_VOICE_LIMIT, type Tier } from "./src/credits.js";
import { verifyTransaction, linkTransactionIdentity, getTransactionIdentity, verifyNotification } from "./src/iap.js";
import { verifyAppleIdentityToken, appleIdentity } from "./src/appleauth.js";
import { recordAssoc, isBanned, getSafetyAccount, recordViolation, classifyHarm, looksLikePromptExtraction, reinstate, terminateAndBan, reviewQueue, associationsFor, SUSPENDED_MSG, BANNED_MSG, PROMPT_EXTRACTION_MSG } from "./src/safety.js";
import { noteUser, noteSpend, noteTier, noteRevenue, noteApple, identitiesForIp, allUsers, deleteUser } from "./src/users.js";
import { TIERS, CREDIT_USD } from "./src/credits.js";
import { transcribe, synthesize, listVoices, isVoiceConfigured } from "./src/voice.js";

// Admin secret guarding the dev credits-reset endpoint. Set ADMIN_SECRET on
// Render. (The purchase-simulating grant endpoint was removed when real
// StoreKit IAP shipped — grants only happen via verified transactions now.)
const ADMIN_SECRET = process.env.ADMIN_SECRET || "taki-dev-grant-2026";
const OUT_OF_CREDITS_MSG = "You're out of credits — top up or upgrade in Membership to keep asking.";
const FREE_VOICE_LIMIT_MSG = "You've reached the Voice limit for the Free tier. Upgrade to Plus for full access.";

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
app.use(express.json({ limit: "12mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

// --- Stripe (web credit top-ups). Gated on env; endpoints 503 when unset. ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WEB_BASE_URL = process.env.WEB_BASE_URL || "https://takiai.app";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Taki AI server",
    mode: "planner-first-modular-v2",
    version: "2026-06-14"
  });
});

// --- Push (APNs) --------------------------------------------------------------
// The device registers its APNs token here so the server can send proactive
// alerts (commute "leave now", fresh morning briefing, breaking updates).
app.post("/api/register-push", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) {
    res.status(400).json({ error: "token required" });
    return;
  }
  registerToken(token);
  res.json({ ok: true, configured: isPushConfigured(), devices: getTokens().length });
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
    const styled = await withTimeout(styleInCharacter(text, persona), 8000, "Style");
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
  registerLiveActivity({
    id,
    kind: typeof req.body?.kind === "string" ? req.body.kind : "finance",
    meta: req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {},
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
const LA_MAX_MS = 6 * 60 * 60 * 1000;
const deadToken = (r: { status: number; reason?: string }) =>
  r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "ExpiredProviderToken";

// Last content-state we pushed per activity — so we only push when something
// actually changed (pushing identical frames every 15s wastes Apple's Live
// Activity budget and invites throttling).
const lastPushed = new Map<string, string>();

// Data trackers (finance/sports/flight): re-fetch (cached) and push every 15s,
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
    if (reg.kind !== "finance" && reg.kind !== "sports" && reg.kind !== "flight" && reg.kind !== "package") continue;
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

// Live finance/sports snapshot for an active Live Activity. The device polls
// this to keep the lock-screen / Dynamic Island tracker fresh.
app.get("/api/track", async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : "";
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
  if ((kind !== "finance" && kind !== "sports" && kind !== "flight" && kind !== "package") || !query) {
    res.status(400).json({ error: "kind (finance|sports|flight|package) and q are required" });
    return;
  }
  try {
    const snap = await withTimeout(cachedTrackerSnapshot(kind, query, tz), 25000, "Track snapshot");
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
    const dest = await withTimeout(
      inferEventDestination({
        title,
        location,
        notes,
        lat: Number.isFinite(lat) ? lat : undefined,
        lon: Number.isFinite(lon) ? lon : undefined
      }),
      22000,
      "Resolve destination"
    );
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
    const index = await withTimeout(matchEventToQuery(query, events), 10000, "Match event");
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
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    tier = sum.tier;
    if (sum.balance < MIN_REQUEST_CREDITS) {
      res.json({ spokenText: OUT_OF_CREDITS_MSG, credits: { ...sum, cost: 0, outOfCredits: true } });
      return;
    }
  }
  try {
    const spokenText = await withTimeout(answerAboutImage(image, mime, question, userProfile, timeZone), 28000, "Vision");
    if (deviceId) {
      const s = await spend(deviceId, costForRequest("vision", voiceMode, tier));
      await noteSpend(deviceId, s.spent);
      res.json({ spokenText, credits: { balance: s.balance, cost: s.spent, tier, nextExpiry: s.nextExpiry } });
    } else {
      res.json({ spokenText });
    }
  } catch (error) {
    console.error("Vision error:", error);
    res.status(502).json({ error: "vision unavailable" });
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
    const key = `devnum:seq:${country}`;
    const cur = await storeGet<{ n: number }>(key, { n: 0 });
    cur.n = (cur.n || 0) + 1;
    await storeSet(key, cur);
    return country + String(cur.n).padStart(7, "0");
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
    if (acct.status === "terminated" || (await isBanned(deviceId, dev, ip))) { access = "banned"; accessMessage = BANNED_MSG; }
    else if (acct.status === "suspended") { access = "suspended"; accessMessage = SUSPENDED_MSG; }
  } catch (e) { console.error("credits access check:", e); }
  res.json({ ...(await creditSummary(deviceId)), tiers: tierCatalog(), access, accessMessage });
});

/* ---- Web credit top-ups (Stripe Checkout) ------------------------------- */
// Whether web top-ups are available (so the buy page can show/hide itself).
app.get("/api/credits/topup-config", (_req, res) => {
  res.json({ enabled: !!stripe, min: CREDIT_TOPUP_MIN, max: CREDIT_TOPUP_MAX });
});

// Start a checkout for `credits` credits toward `identity`. Price is computed
// server-side from the credit count (client-sent prices are never trusted).
app.post("/api/credits/checkout", async (req, res) => {
  if (!stripe) { res.status(503).json({ error: "top-ups are not available yet" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  const credits = Math.floor(Number(req.body?.credits));
  if (!identity) { res.status(400).json({ error: "account ID required" }); return; }
  const cents = topupPriceCents(credits);
  if (cents == null) { res.status(400).json({ error: `Choose between ${CREDIT_TOPUP_MIN.toLocaleString()} and ${CREDIT_TOPUP_MAX.toLocaleString()} credits.` }); return; }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name: `${credits.toLocaleString()} Taki AI credits` } } }],
      metadata: { identity, credits: String(credits) },
      success_url: `${WEB_BASE_URL}/buy?status=success`,
      cancel_url: `${WEB_BASE_URL}/buy?status=canceled`
    });
    res.json({ url: session.url, priceUsd: (cents / 100).toFixed(2) });
  } catch (e) {
    console.error("Stripe checkout error:", e);
    res.status(502).json({ error: "could not start checkout" });
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
  res.json({ received: true });
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
    const r = await grantForTransaction(identity, info.tier, info.periodKey);
    if (r.granted) {
      // Analytics: record the plan + gross revenue for this billing period.
      await noteTier(identity, info.tier, "subscription");
      const conf = TIERS[info.tier];
      if (conf) await noteRevenue(identity, { at: Date.now(), kind: "subscription", amountUsd: conf.priceUsd, credits: conf.creditsPerCycle, tier: info.tier });
    }
    anyGranted = anyGranted || r.granted;
    tier = info.tier;
  }
  if (!tier) { res.status(400).json({ error: "no valid subscription transaction" }); return; }
  res.json({ ...(await creditSummary(identity)), granted: anyGranted, tier });
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
  const accountId = appleIdentity(identdata.sub);
  const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
  // Link the Apple account to the raw device id + IP so a ban can cascade to
  // every device tied to the Apple ID.
  try { await recordAssoc(accountId, deviceId || undefined, clientIp(req)); } catch { /* best effort */ }
  try {
    await noteUser(accountId, clientIp(req), String(req.headers?.["user-agent"] || ""));
    await noteApple(accountId, { sub: identdata.sub, email: identdata.email, name: fullName || undefined });
  } catch { /* best effort */ }
  const summary = deviceId ? await mergeCredits(deviceId, accountId) : await creditSummary(accountId);
  res.json({ accountId, email: identdata.email, ...summary, tiers: tierCatalog() });
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
      const identity = await getTransactionIdentity(tx.originalTransactionId);
      if (identity) {
        const t = note.notificationType;
        if (t === "SUBSCRIBED" || t === "DID_RENEW" || t === "OFFER_REDEEMED") {
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
// owner can review what people flag. kind = "answer" | "message" | "app".
app.post("/api/feedback", async (req, res) => {
  const b = req.body || {};
  const entry = {
    at: Date.now(),
    deviceId: typeof b.deviceId === "string" ? b.deviceId.slice(0, 64) : "",
    kind: typeof b.kind === "string" ? b.kind.slice(0, 20) : "answer",
    rating: b.rating === "up" || b.rating === "down" ? b.rating : null,
    note: typeof b.note === "string" ? b.note.slice(0, 1000) : "",
    message: typeof b.message === "string" ? b.message.slice(0, 500) : "",
    answer: typeof b.answer === "string" ? b.answer.slice(0, 1000) : ""
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
  if (b.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  await resetCredits(deviceId);
  res.json({ ok: true });
});

/* ---- Safety review + enforcement (ADMIN_SECRET) ------------------------- */
// The human-review queue: every currently-suspended account and the retained
// flagged messages that triggered it (the only point that content is visible).
app.post("/api/admin/flagged", async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  res.json({ queue: await reviewQueue() });
});

// Reinstate a suspended account (clears strikes + retained flagged messages).
app.post("/api/admin/reinstate", async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  await reinstate(identity);
  res.json({ ok: true, identity, status: "active" });
});

// Terminate + permanently ban the identity, its devices/IPs, and any other
// identities seen on the same device(s). No appeal.
app.post("/api/admin/terminate", async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  const banned = await terminateAndBan(identity);
  res.json({ ok: true, identity, status: "terminated", banned });
});

// Remove a user from the dashboard registry (e.g. test accounts).
app.post("/api/admin/delete-user", async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const identity = typeof req.body?.identity === "string" ? req.body.identity.trim() : "";
  if (!identity) { res.status(400).json({ error: "identity required" }); return; }
  await deleteUser(identity);
  res.json({ ok: true, identity, deleted: true });
});

// Full admin dashboard feed: every user + plan/history, IPs, device, credit
// usage, cost-to-serve, revenue, profit, safety status, Apple identity, and the
// other identities seen on their IP(s).
app.post("/api/admin/users", async (req, res) => {
  if (req.body?.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const users = await allUsers();
  const rows = await Promise.all(users.map(async (u) => {
    const acct = await getSafetyAccount(u.identity);
    const summary = await creditSummary(u.identity);
    const costUsd = Math.round(u.creditsUsed * CREDIT_USD * 100) / 100;
    // Net revenue estimate (subscriptions ≈ 85% after Apple; top-ups ≈ Stripe fee).
    let netUsd = 0;
    for (const p of u.purchases) netUsd += p.kind === "topup" ? Math.max(0, p.amountUsd * 0.971 - 0.30) : p.amountUsd * 0.85;
    netUsd = Math.round(netUsd * 100) / 100;
    const neighbors = new Set<string>();
    for (const ip of u.ips) for (const i of await identitiesForIp(ip)) if (i !== u.identity) neighbors.add(i);
    // Devices linked to this identity (e.g. an Apple account's device numbers).
    const assoc = await associationsFor(u.identity);
    const linkedDevices = assoc.devices.filter((d) => d !== u.identity);
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
async function safetyGate(identity: string, message: string, req: any): Promise<GateResult | null> {
  // Prompt-extraction is refused for EVERYONE (even legacy clients with no id).
  const isExtraction = looksLikePromptExtraction(message);
  if (!identity) return isExtraction ? { message: PROMPT_EXTRACTION_MSG } : null;
  const ip = clientIp(req);
  const dev = identity.startsWith("apple:") ? undefined : identity;
  try {
    await recordAssoc(identity, dev, ip);
    await noteUser(identity, ip, String(req.headers?.["user-agent"] || ""));
    if (await isBanned(identity, dev, ip)) return { message: BANNED_MSG, block: "banned" };
    const acct = await getSafetyAccount(identity);
    if (acct.status !== "active") return { message: SUSPENDED_MSG, block: "suspended" };
    // Prompt/instruction extraction: never help, break character with a fixed
    // reply, and count a strike (repeated attempts → suspension = "restriction").
    if (isExtraction) {
      const a = await recordViolation(identity, { text: String(message).slice(0, 2000), category: "prompt_extraction", at: Date.now(), ip, deviceId: dev });
      return a.status !== "active" ? { message: SUSPENDED_MSG, block: "suspended" } : { message: PROMPT_EXTRACTION_MSG };
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
async function runAssistant(state: ReturnType<typeof buildConversationState>, deviceId: string, voiceMode: boolean): Promise<any> {
  let tier: Tier = "free";
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    tier = sum.tier;
    // Cut users off BEFORE they hit 0 — they need at least a standard request's
    // worth of credits to ask anything.
    if (sum.balance < MIN_REQUEST_CREDITS) {
      return {
        ...finalizeResponse({ spokenText: OUT_OF_CREDITS_MSG, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
        credits: { ...sum, cost: 0, outOfCredits: true }
      };
    }
  }
  const plan = await withTimeout(planAssistantResponse(state), 45000, "Assistant plan");
  const finalized = finalizeResponse(plan, state);
  if (finalized.spokenText && (finalized.action || finalized.memory?.pendingClarification)) {
    finalized.spokenText = await styleInCharacter(finalized.spokenText, state.userProfile, voiceMode);
  }
  // Voice replies must be SUPER short — clamp here so it applies to every answer
  // path (general, live/web, lottery, inline), not just getGeneralAnswer.
  if (voiceMode && finalized.spokenText) {
    finalized.spokenText = briefForVoice(finalized.spokenText);
  }
  if (deviceId) {
    let cost = costForRequest(finalized.memory?.lastIntent, voiceMode, tier);
    // Plus tier pays for voice output by length: +1 credit per 10 chars spoken.
    if (voiceMode && tier === "plus") cost += Math.ceil((finalized.spokenText || "").length / 10);
    const s = await spend(deviceId, cost);
    await noteSpend(deviceId, s.spent);
    return { ...finalized, credits: { balance: s.balance, cost: s.spent, tier, nextExpiry: s.nextExpiry } };
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
  // Personalization (name / about / personality) lives on the device and is sent
  // per request; the server stores none of it.
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);

  const state = buildConversationState(userMessage, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, voiceMode);

  const gate = await safetyGate(deviceId, userMessage, req);
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
      const general = await getGeneralAnswer(state);
      res.json(
        finalizeResponse(
          { spokenText: general, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false },
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
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "audio/m4a";
  const rawContext = typeof req.body?.context === "string" ? req.body.context : "";
  const timeZone: string | undefined = typeof req.body?.timeZone === "string" ? req.body.timeZone : undefined;
  const deviceLocation: DeviceLocation | undefined = req.body?.deviceLocation;
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  const voiceId = typeof req.body?.voiceId === "string" ? req.body.voiceId : undefined;
  const styleProfiles = parseIncomingStyleProfiles(req.body?.styleProfiles);
  const userProfile = parseUserPersona(req.body?.profile, req.body?.addressUser);
  if (!audioBase64) { res.status(400).json({ error: "audioBase64 required" }); return; }

  // Free tier: hard cap of voice questions regardless of credits.
  let freeTier = false;
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    freeTier = sum.tier === "free";
    if (freeTier && sum.voiceUsed >= FREE_VOICE_LIMIT) {
      res.json({ transcript: "", spokenText: FREE_VOICE_LIMIT_MSG, action: null, actions: null, audioBase64: "", mime: "audio/mpeg", voiceLimitReached: true, voiceUsed: sum.voiceUsed });
      return;
    }
  }

  try {
    const transcript = await transcribe(audioBase64, mime);
    if (!transcript) {
      // Nothing intelligible (silence) — let the device re-listen or end.
      res.json({ transcript: "", spokenText: "", action: null, actions: null, empty: true });
      return;
    }
    const gate = await safetyGate(deviceId, transcript, req);
    if (gate) {
      res.json({ transcript, spokenText: gate.message, action: null, actions: null, audioBase64: "", mime: "audio/mpeg", blocked: true, ...(gate.block ? { access: gate.block, accessMessage: gate.message } : {}) });
      return;
    }
    // Count this voice question toward the free-tier cap.
    let voiceUsed: number | undefined;
    if (freeTier && deviceId) voiceUsed = await noteVoiceQuestion(deviceId);
    const state = buildConversationState(transcript, rawContext, deviceLocation, timeZone, styleProfiles, userProfile, true);
    const result = await runAssistant(state, deviceId, true); // voice → surcharge applies
    const audio = await synthesize(result.spokenText || "", voiceId);
    res.json({ ...result, transcript, audioBase64: audio, mime: "audio/mpeg", voiceUsed });
  } catch (error) {
    console.error("Voice route error:", error);
    res.status(502).json({ error: "voice unavailable" });
  }
});

// The account's available voices, for the app's voice picker.
app.get("/api/voices", async (_req, res) => {
  res.json({ voices: await listVoices() });
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
