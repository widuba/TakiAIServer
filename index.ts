import express from "express";
import cors from "cors";

import { PORT } from "./src/ai.js";
import type { DeviceLocation } from "./src/types.js";
import { buildConversationState } from "./src/context.js";
import { planAssistantResponse } from "./src/planner.js";
import { finalizeResponse } from "./src/validators.js";
import { getGeneralAnswer, styleInCharacter, getWeatherSnapshot, inferEventDestination, matchEventToQuery, getTravelTime, answerAboutImage } from "./src/tools.js";
// getTravelTime (above) also powers the background commute push loop.
import { withTimeout } from "./src/util.js";
import { parseIncomingStyleProfiles } from "./src/messageStyle.js";
import { parseUserPersona } from "./src/persona.js";
import {
  registerToken, forgetToken, broadcast, getTokens, isPushConfigured,
  registerLiveActivity, unregisterLiveActivity, getLiveActivities, sendLiveActivityUpdate
} from "./src/push.js";
import { cachedTrackerSnapshot } from "./src/tracker.js";
import { addAlert, listAlerts, cancelAlerts, pollAlerts, type Alert } from "./src/alerts.js";
import { isDurable } from "./src/store.js";
import { summary as creditSummary, grantTier, spend, reset as resetCredits, costForRequest, tierCatalog, type Tier } from "./src/credits.js";

// Dev-only shared secret guarding the credit-grant endpoints (which simulate a
// purchase until real Apple IAP lands). Set ADMIN_SECRET on Render to lock it
// down; the app sends the matching value. TODO: remove when StoreKit IAP ships.
const ADMIN_SECRET = process.env.ADMIN_SECRET || "taki-dev-grant-2026";
const VALID_TIERS = new Set(["free", "plus", "plus_voice", "pro"]);
const OUT_OF_CREDITS_MSG = "You're out of credits — top up or upgrade in Membership to keep asking.";

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
app.use(express.json({ limit: "12mb" })); // room for base64 photos (vision)

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
  let tier: Tier = "free";
  if (deviceId) {
    const sum = await creditSummary(deviceId);
    tier = sum.tier;
    if (sum.balance <= 0) {
      res.json({ spokenText: OUT_OF_CREDITS_MSG, credits: { ...sum, cost: 0, outOfCredits: true } });
      return;
    }
  }
  try {
    const spokenText = await withTimeout(answerAboutImage(image, mime, question, userProfile, timeZone), 28000, "Vision");
    if (deviceId) {
      const s = await spend(deviceId, costForRequest("vision", voiceMode, tier));
      res.json({ spokenText, credits: { balance: s.balance, cost: s.spent, tier } });
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
app.get("/api/credits", async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  if (!deviceId) { res.status(400).json({ error: "deviceId required" }); return; }
  res.json({ ...(await creditSummary(deviceId)), tiers: tierCatalog() });
});

// Grant a tier's credits — simulates a purchase/renewal until Apple IAP. Guarded
// by ADMIN_SECRET. TODO: replace with StoreKit receipt validation.
app.post("/api/credits/grant", async (req, res) => {
  const b = req.body || {};
  if (b.secret !== ADMIN_SECRET) { res.status(403).json({ error: "forbidden" }); return; }
  const deviceId = typeof b.deviceId === "string" ? b.deviceId.trim() : "";
  const tier = typeof b.tier === "string" && VALID_TIERS.has(b.tier) ? (b.tier as Tier) : null;
  if (!deviceId || !tier) { res.status(400).json({ error: "deviceId and valid tier required" }); return; }
  res.json(await grantTier(deviceId, tier));
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

  const state = buildConversationState(userMessage, rawContext, deviceLocation, timeZone, styleProfiles, userProfile);

  try {
    // Gate on credits before spending any AI: out of credits → an upsell reply,
    // no model call.
    let tier: Tier = "free";
    if (deviceId) {
      const sum = await creditSummary(deviceId);
      tier = sum.tier;
      if (sum.balance <= 0) {
        res.json({
          ...finalizeResponse({ spokenText: OUT_OF_CREDITS_MSG, action: null, memoryPatch: { pendingClarification: null }, needsExecution: false }, state),
          credits: { ...sum, cost: 0, outOfCredits: true }
        });
        return;
      }
    }
    // Allow headroom for grounded web research on event lookups, including the
    // multi-event "add the next N games" path (research + extraction).
    const plan = await withTimeout(planAssistantResponse(state), 45000, "Assistant plan");
    const finalized = finalizeResponse(plan, state);
    // Preset/deterministic confirmations + clarifications bypass the personality,
    // so rephrase them in character here (facts preserved). No-op for "plain".
    if (finalized.spokenText && (finalized.action || finalized.memory?.pendingClarification)) {
      finalized.spokenText = await styleInCharacter(finalized.spokenText, state.userProfile);
    }
    // Meter: charge for the question (cost scales with the model that ran it) and
    // report the new balance back to the app.
    if (deviceId) {
      const cost = costForRequest(finalized.memory?.lastIntent, voiceMode, tier);
      const s = await spend(deviceId, cost);
      res.json({ ...finalized, credits: { balance: s.balance, cost: s.spent, tier } });
    } else {
      res.json(finalized);
    }
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Taki AI server (planner-first, modular) listening on http://0.0.0.0:${PORT}`);
});
