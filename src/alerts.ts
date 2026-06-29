import { storeGet, storeSet } from "./store.js";
import { broadcast, getTokens } from "./push.js";
import { fetchAssetPrice, fetchTrackerSnapshot } from "./tracker.js";

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
 * Fires via push.broadcast() — this is a single-user personal app, so every
 * registered device token (effectively the user's phone) gets the alert; no
 * per-alert token plumbing needed.
 * ==========================================================================*/

export type PriceAlert = {
  id: string;
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
const ALERT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // auto-expire stale alerts after 7 days

let alerts: Alert[] = [];
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  alerts = await storeGet<Alert[]>(KEY, []);
  loaded = true;
}

async function persist(): Promise<void> {
  await storeSet(KEY, alerts);
}

export async function listAlerts(): Promise<Alert[]> {
  await load();
  return alerts;
}

export async function addAlert(a: Alert): Promise<{ ok: boolean; reason?: string }> {
  await load();
  if (alerts.length >= MAX_ALERTS) return { ok: false, reason: "Too many active alerts." };
  // De-dupe an identical pending alert.
  const dup = alerts.find(
    (x) => x.kind === a.kind && x.query.toLowerCase() === a.query.toLowerCase() &&
      (x.kind === "price" && a.kind === "price"
        ? x.target === a.target && x.direction === a.direction
        : x.kind === "score" && a.kind === "score" ? x.trigger === a.trigger : false)
  );
  if (dup) return { ok: true };
  alerts.push(a);
  await persist();
  return { ok: true };
}

export async function cancelAlerts(filter?: { kind?: string; query?: string }): Promise<number> {
  await load();
  const before = alerts.length;
  alerts = alerts.filter((a) => {
    if (!filter) return false; // no filter = cancel all
    if (filter.kind && a.kind !== filter.kind) return true;
    if (filter.query && !a.query.toLowerCase().includes(filter.query.toLowerCase())) return true;
    return false; // matches the filter → remove
  });
  const removed = before - alerts.length;
  if (removed) await persist();
  return removed;
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
  polling = true;
  try {
    await load();
    if (alerts.length === 0 || getTokens().length === 0) return;
    let changed = false;
    const survivors: Alert[] = [];
    for (const a of alerts) {
      let res;
      try {
        res = await evaluate(a, timeZone);
      } catch (e) {
        console.error("Alert eval error:", e);
        survivors.push(a);
        continue;
      }
      if (res.fire) {
        changed = true;
        await broadcast({ title: res.fire.title, body: res.fire.body, threadId: `alert-${a.kind}`, data: { alertId: a.id, alertKind: a.kind } });
      }
      if (res.done) changed = true;
      else survivors.push(a);
    }
    if (changed) {
      alerts = survivors;
      await persist();
    }
  } finally {
    polling = false;
  }
}
