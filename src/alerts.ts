import { storeGet, storeUpdate } from "./store.js";
import { randomUUID } from "node:crypto";
import { forgetToken, sendPush } from "./push.js";
import { clearPushToken, getPushToken } from "./nudges.js";
import { fetchAssetPrice, fetchTrackerSnapshot } from "./tracker.js";
import { isEngagementEmailConfigured, renderBrandedEmail, sendEmail } from "./engagement.js";
import { userForIdentity } from "./users.js";
import { appleForDevice, devicesForApple } from "./safety.js";

// The email tied to the device that created the alert (its Apple Sign-in
// address). Alerts are user-requested, so delivering them by email needs no
// separate marketing opt-in — only a connected Apple account for the address.
async function recipientEmail(deviceId: string): Promise<string | null> {
  const direct = (await userForIdentity(deviceId)).apple?.email?.trim();
  if (direct) return direct;
  const sub = await appleForDevice(deviceId).catch(() => "");
  if (!sub) return null;
  for (const dev of await devicesForApple(sub)) {
    const rec = await userForIdentity(dev);
    if (rec.apple?.sub === sub && rec.apple?.email?.trim()) return rec.apple.email.trim();
  }
  return null;
}

async function sendAlertEmail(to: string, fire: { title: string; body: string }): Promise<boolean> {
  const html = renderBrandedEmail({
    heading: fire.title,
    bodyText: fire.body,
    preheader: fire.body,
    footnote: "You asked Taki to watch this. Open Taki to see or cancel your alerts."
  });
  return (await sendEmail({ to, subject: fire.title, text: fire.body, html })).ok;
}

/* ============================================================================
 * Batch B — proactive alerts. Standing subscriptions the SERVER watches and
 * pushes to the device (via APNs) when their condition fires, even with the app
 * closed. Persisted via the durable store so they survive a redeploy (when a
 * DATABASE_URL is configured).
 *
 *  - price (#2): "alert me when bitcoin hits 70k" → one-shot, fires on cross.
 *  - score (#3) / favorite-team (#11): "tell me when the Lakers game ends" /
 *    "keep me posted on the Lakers" → fires on score change ("any") and/or at
 *    the final ("final"); "final" alerts are one-shot, "any" runs until final.
 *
 * Every alert is owned by the physical device that created it and is delivered
 * only to that device's APNs token. Account identifiers can change after Sign
 * in with Apple; the physical id remains stable and prevents cross-user pushes.
 * ==========================================================================*/

export type PriceAlert = {
  id: string;
  deviceId: string;
  kind: "price";
  createdAt: number;
  query: string;          // what we re-fetch ("bitcoin", "AAPL")
  target: number;
  direction: "above" | "below";
  label: string;          // display name ("Bitcoin")
  lastValue?: number;
};

export type ScoreAlert = {
  id: string;
  deviceId: string;
  kind: "score";
  createdAt: number;
  query: string;          // team / matchup ("Lakers")
  trigger: "final" | "any";
  label: string;
  lastLine?: string;      // last score line we pushed, to detect changes
  notified?: boolean;     // for "final": whether we've already pushed the final
};

export type Alert = PriceAlert | ScoreAlert;

const KEY = "alerts";
const MAX_ALERTS = 50;
const MAX_ALERT_RECORDS = 10_000;
const ALERT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // auto-expire stale alerts after 7 days
const POLL_LEASE_KEY = "alerts:poll-lease";
const POLL_LEASE_MS = 80_000;

let alerts: Alert[] = [];
let loaded = false;
let alertChain: Promise<unknown> = Promise.resolve();

function withAlertLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = alertChain.then(fn, fn);
  alertChain = run.then(() => undefined, () => undefined);
  return run;
}

export function clearAlertsForReset(): Promise<void> {
  alerts = [];
  loaded = true;
  // Clear the authoritative record as well as the process cache. Without this,
  // a restart after a full reset could reload old alerts and send them to a
  // device that no longer owns the account. Queue the write behind any sweep
  // already in progress so an in-flight evaluation cannot repopulate it.
  const run = alertChain.then(async () => {
    await storeUpdate<Alert[], void>(KEY, [], () => ({ value: [], result: undefined }));
  }, async () => {
    await storeUpdate<Alert[], void>(KEY, [], () => ({ value: [], result: undefined }));
  });
  alertChain = run.then(() => undefined, () => undefined);
  return run;
}

async function load(force = false): Promise<void> {
  if (loaded && !force) return;
  const stored = await storeGet<Alert[]>(KEY, []);
  // Legacy alerts predate ownership and cannot be delivered privately.
  alerts = normalizeAlerts(stored);
  loaded = true;
}

function normalizeAlerts(value: unknown): Alert[] {
  const unique = new Map<string, Alert>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 128) : "";
    const deviceId = typeof item.deviceId === "string" ? item.deviceId.trim() : "";
    const query = typeof item.query === "string" ? item.query.trim().slice(0, 300) : "";
    const label = typeof item.label === "string" ? item.label.trim().slice(0, 200) : query;
    const createdAt = Number(item.createdAt);
    if (!id || !/^\d{8}$/.test(deviceId) || !query || !Number.isFinite(createdAt)) continue;
    const boundedCreatedAt = Math.min(createdAt, Date.now() + 5 * 60_000);
    let alert: Alert | null = null;
    if (item.kind === "price" && Number.isFinite(Number(item.target)) && Number(item.target) > 0 && Number(item.target) <= 1e15) {
      alert = {
        id, deviceId, kind: "price", createdAt: boundedCreatedAt, query, label,
        target: Number(item.target), direction: item.direction === "below" ? "below" : "above",
        ...(Number.isFinite(Number(item.lastValue)) ? { lastValue: Number(item.lastValue) } : {})
      };
    } else if (item.kind === "score") {
      alert = {
        id, deviceId, kind: "score", createdAt: boundedCreatedAt, query, label,
        trigger: item.trigger === "final" ? "final" : "any",
        ...(typeof item.lastLine === "string" ? { lastLine: item.lastLine.slice(0, 500) } : {}),
        ...(item.notified === true ? { notified: true } : {})
      };
    }
    if (alert) unique.set(`${deviceId}:${id}`, alert);
  }
  return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_ALERT_RECORDS);
}

export async function listAlerts(deviceId: string): Promise<Alert[]> {
  return withAlertLock(async () => {
    await load(true);
    return alerts.filter((alert) => alert.deviceId === deviceId);
  });
}

export async function addAlert(a: Alert): Promise<{ ok: boolean; reason?: string }> {
  const normalized = normalizeAlerts([a])[0];
  if (!normalized) return { ok: false, reason: "Invalid alert." };
  return withAlertLock(async () => {
    const result = await storeUpdate<Alert[], { ok: boolean; reason?: string; alerts: Alert[] }>(KEY, [], (stored) => {
    const current = normalizeAlerts(stored);
      if (current.filter((alert) => alert.deviceId === normalized.deviceId).length >= MAX_ALERTS) {
        return { value: current, result: { ok: false, reason: "Too many active alerts.", alerts: current } };
      }
      // De-dupe an identical pending alert.
      const dup = current.find(
        (x) => x.deviceId === normalized.deviceId && x.kind === normalized.kind && x.query.toLowerCase() === normalized.query.toLowerCase() &&
          (x.kind === "price" && normalized.kind === "price"
            ? x.target === normalized.target && x.direction === normalized.direction
            : x.kind === "score" && normalized.kind === "score" ? x.trigger === normalized.trigger : false)
      );
      if (dup) return { value: current, result: { ok: true, alerts: current } };
      const next = [...current, normalized].slice(-MAX_ALERT_RECORDS);
      return { value: next, result: { ok: true, alerts: next } };
    });
    alerts = result.alerts;
    loaded = true;
    return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) };
  });
}

export async function cancelAlerts(deviceId: string, filter?: { id?: string; kind?: string; query?: string }): Promise<number> {
  return withAlertLock(async () => {
    const result = await storeUpdate<Alert[], { removed: number; alerts: Alert[] }>(KEY, [], (stored) => {
      const current = normalizeAlerts(stored);
      const next = current.filter((a) => {
        if (a.deviceId !== deviceId) return true;
        if (!filter) return false; // no filter = cancel all
        if (!filter.id && !filter.kind && !filter.query) return true; // invalid filter = cancel none
        if (filter.id) return a.id !== filter.id; // exact id → remove just that one
        if (filter.kind && a.kind !== filter.kind) return true;
        if (filter.query && !a.query.toLowerCase().includes(filter.query.toLowerCase())) return true;
        return false; // matches the filter → remove
      });
      return { value: next, result: { removed: current.length - next.length, alerts: next } };
    });
    alerts = result.alerts;
    loaded = true;
    return result.removed;
  });
}

// Evaluate one alert. Returns a push message if it should fire, and whether the
// alert is now finished (remove it).
async function evaluate(a: Alert, timeZone: string): Promise<{ fire?: { title: string; body: string }; done: boolean }> {
  if (Date.now() - a.createdAt > ALERT_TTL_MS) return { done: true };

  if (a.kind === "price") {
    const snap = await fetchAssetPrice(a.query);
    if (!snap) return { done: false };
    a.lastValue = snap.price;
    const hit = a.direction === "above" ? snap.price >= a.target : snap.price <= a.target;
    if (hit) {
      const arrow = a.direction === "above" ? "is above" : "is below";
      const fmt = a.target >= 1 ? snap.price.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(snap.price);
      return { fire: { title: `${a.label} alert`, body: `${a.label} ${arrow} $${a.target.toLocaleString("en-US")} — now $${fmt}.` }, done: true };
    }
    return { done: false };
  }

  // score
  const snap = await fetchTrackerSnapshot("sports", a.query, timeZone);
  if (!snap) return { done: false };
  const line = `${snap.line1}${snap.status ? ` · ${snap.status}` : ""}`;
  const isFinal = /\bfinal\b/i.test(snap.status) || /\bfinal\b/i.test(snap.line2);

  if (a.trigger === "final") {
    if (isFinal && !a.notified) {
      a.notified = true;
      return { fire: { title: `${a.label} — Final`, body: `${snap.line1}${snap.line2 ? ` (${snap.line2})` : ""}` }, done: true };
    }
    return { done: false };
  }

  // "any" — push whenever the score line changes; finish at the final.
  if (line !== a.lastLine) {
    a.lastLine = line;
    const body = `${snap.line1}${snap.status ? ` · ${snap.status}` : ""}`;
    return { fire: { title: snap.title, body }, done: isFinal };
  }
  return { done: isFinal };
}

let polling = false;

// One sweep over all alerts. Called by the server's interval loop.
export async function pollAlerts(timeZone: string): Promise<void> {
  if (polling) return; // never overlap sweeps
  const owner = randomUUID();
  let leaseAcquired = false;
  try {
    leaseAcquired = await storeUpdate<{ owner: string; expiresAt: number } | null, boolean>(POLL_LEASE_KEY, null, (lease) => {
      if (lease?.expiresAt && lease.expiresAt > Date.now() && lease.owner !== owner) return { value: lease, result: false };
      return { value: { owner, expiresAt: Date.now() + POLL_LEASE_MS }, result: true };
    });
  } catch (error) {
    console.error("Alert poll lease acquire:", error);
    return;
  }
  if (!leaseAcquired) return;
  polling = true;
  try {
    await withAlertLock(async () => {
      await load(true);
      if (alerts.length === 0) return;
      let changed = false;
      const survivors: Alert[] = [];
      for (const a of alerts) {
      if (Date.now() - a.createdAt > ALERT_TTL_MS) {
        changed = true;
        continue;
      }
      // Deliver via push when a token exists; otherwise fall back to email so
      // alerts still reach the user when APNs isn't configured (email set up).
      const token = await getPushToken(a.deviceId);
      const email = !token && isEngagementEmailConfigured() ? await recipientEmail(a.deviceId) : null;
      if (!token && !email) {
        survivors.push(a);
        continue;
      }
      const before = { ...a } as Alert;
      let res;
      try {
        res = await evaluate(a, timeZone);
      } catch (e) {
        console.error("Alert eval error:", e);
        survivors.push(a);
        continue;
      }
      let stateChanged = false;
      if (a.kind === "price" && before.kind === "price") {
        stateChanged = before.lastValue !== a.lastValue;
      } else if (a.kind === "score" && before.kind === "score") {
        stateChanged = before.lastLine !== a.lastLine || before.notified !== a.notified;
      }
      if (res.fire) {
        let delivered = false;
        if (token) {
          const pushed = await sendPush(token, {
            title: res.fire.title,
            body: res.fire.body,
            threadId: `alert-${a.kind}`,
            data: { alertId: a.id, alertKind: a.kind }
          });
          if (pushed.ok) delivered = true;
          else if (pushed.status === 410 || pushed.reason === "BadDeviceToken" || pushed.reason === "Unregistered") {
            await clearPushToken(a.deviceId);
            forgetToken(token);
          }
        }
        if (!delivered && isEngagementEmailConfigured()) {
          const to = email ?? await recipientEmail(a.deviceId);
          if (to) delivered = await sendAlertEmail(to, res.fire);
        }
        if (!delivered) {
          survivors.push(before);
          continue;
        }
        changed = true;
      }
      if (res.done) changed = true;
      else {
        // Persist the last observed quote/score even when the threshold was not
        // reached. Without this, every poll re-evaluated the same historical
        // value and a restart could replay an old transition.
        if (stateChanged) changed = true;
        survivors.push(a);
      }
      }
      if (changed) {
        const evaluated = new Map(alerts.map((alert) => [alert.id, alert]));
        const survivorIds = new Set(survivors.map((alert) => alert.id));
        const result = await storeUpdate<Alert[], { alerts: Alert[] }>(KEY, [], (stored) => {
          const current = normalizeAlerts(stored);
          const next = current.flatMap((alert) => {
            // Alerts created/cancelled by another instance while this sweep was
            // evaluating are not in `evaluated` and must be preserved.
            if (!evaluated.has(alert.id)) return [alert];
            return survivorIds.has(alert.id) ? [evaluated.get(alert.id)!] : [];
          });
          return { value: next, result: { alerts: next } };
        });
        alerts = result.alerts;
        loaded = true;
      }
    });
  } finally {
    polling = false;
    await storeUpdate<{ owner: string; expiresAt: number } | null, void>(POLL_LEASE_KEY, null, (lease) =>
      lease?.owner === owner ? { value: null, result: undefined } : { value: lease, result: undefined }
    ).catch((error) => console.error("Alert poll lease release:", error));
  }
}
