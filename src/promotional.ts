import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { storeDelete, storeGet, storeSet } from "./store.js";
import type { UserRecord } from "./users.js";

type SubscriberStatus = "subscribed" | "unsubscribed";

export interface PromotionalSubscriber {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: "apple_sign_in";
  enrolledAt: number;
  updatedAt: number;
  unsubscribedAt?: number;
  appleSubs: string[];
  identities: string[];
  lastSentAt?: number;
}

export interface PromotionalCampaign {
  id: string;
  subject: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  sentAt: number;
  requested: number;
  delivered: number;
  failed: number;
  failures: string[];
}

const API_KEY = () => (process.env.RESEND_API_KEY || "").trim();
const FROM = () => (process.env.PROMOTIONAL_FROM_EMAIL || "Taki AI <updates@takiai.app>").trim();
const POSTAL_ADDRESS = () => (process.env.PROMOTIONAL_POSTAL_ADDRESS || "").trim();
const SERVER_BASE_URL = () => (process.env.SERVER_BASE_URL || "https://takiaiserver.onrender.com").replace(/\/$/, "");
const UNSUBSCRIBE_SECRET = () => (process.env.PROMOTIONAL_EMAIL_SECRET || API_KEY()).trim();
const INDEX_KEY = "marketing:subscribers";

function subscriberKey(id: string): string { return `marketing:subscriber:${id}`; }
function campaignKey(id: string): string { return `marketing:campaign:${id}`; }
function emailId(email: string): string { return createHash("sha256").update(email.trim().toLowerCase()).digest("hex"); }
function cleanEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}
function unique(values: string[], limit: number): string[] { return [...new Set(values.filter(Boolean))].slice(-limit); }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] || character));
}
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/`/g, "&#96;"); }

async function indexedIds(): Promise<string[]> {
  const index = await storeGet<{ ids?: unknown }>(INDEX_KEY, { ids: [] });
  return Array.isArray(index.ids) ? index.ids.filter((id): id is string => typeof id === "string") : [];
}

async function addToIndex(id: string): Promise<void> {
  const ids = await indexedIds();
  if (!ids.includes(id)) await storeSet(INDEX_KEY, { ids: [...ids, id] });
}

export function isPromotionalEmailConfigured(): boolean { return Boolean(API_KEY()); }
export function promotionalEmailConfiguration(): { emailConfigured: boolean; from: string; postalAddressConfigured: boolean; readyToSend: boolean } {
  const emailConfigured = isPromotionalEmailConfigured();
  const postalAddressConfigured = Boolean(POSTAL_ADDRESS());
  return { emailConfigured, from: FROM(), postalAddressConfigured, readyToSend: emailConfigured && postalAddressConfigured };
}

// Apple gives the email address on the initial authorization only. Once it has
// reached the account record, preserve the subscription record until the person
// explicitly unsubscribes or deletes their account.
export async function enrollApplePromotionalSubscriber(input: { email?: string; appleSub?: string; identity?: string }): Promise<PromotionalSubscriber | null> {
  const email = cleanEmail(input.email);
  if (!email) return null;
  const id = emailId(email);
  const now = Date.now();
  const prior = await storeGet<PromotionalSubscriber | null>(subscriberKey(id), null);
  const next: PromotionalSubscriber = {
    id,
    email,
    status: prior?.status === "unsubscribed" ? "unsubscribed" : "subscribed",
    source: "apple_sign_in",
    enrolledAt: Number(prior?.enrolledAt || now),
    updatedAt: now,
    ...(prior?.unsubscribedAt ? { unsubscribedAt: prior.unsubscribedAt } : {}),
    appleSubs: unique([...(prior?.appleSubs || []), String(input.appleSub || "").trim()], 20),
    identities: unique([...(prior?.identities || []), String(input.identity || "").trim()], 50),
    ...(prior?.lastSentAt ? { lastSentAt: prior.lastSentAt } : {})
  };
  await storeSet(subscriberKey(id), next);
  await addToIndex(id);
  return next;
}

export async function backfillApplePromotionalSubscribers(users: UserRecord[]): Promise<number> {
  let enrolled = 0;
  for (const user of users) {
    if (!user.apple?.sub || !user.apple?.email) continue;
    if (await enrollApplePromotionalSubscriber({ email: user.apple.email, appleSub: user.apple.sub, identity: user.identity })) enrolled += 1;
  }
  return enrolled;
}

export async function promotionalSubscribers(): Promise<PromotionalSubscriber[]> {
  const ids = await indexedIds();
  const records = await Promise.all(ids.map((id) => storeGet<PromotionalSubscriber | null>(subscriberKey(id), null)));
  return records.filter((record): record is PromotionalSubscriber => Boolean(record));
}

export async function removeApplePromotionalSubscriber(appleSub: string): Promise<void> {
  const sub = String(appleSub || "").trim();
  if (!sub) return;
  const ids = await indexedIds();
  const retainedIds: string[] = [];
  for (const id of ids) {
    const subscriber = await storeGet<PromotionalSubscriber | null>(subscriberKey(id), null);
    if (!subscriber) continue;
    if (!subscriber.appleSubs.includes(sub)) { retainedIds.push(id); continue; }
    subscriber.appleSubs = subscriber.appleSubs.filter((value) => value !== sub);
    subscriber.identities = subscriber.identities.filter((identity) => identity !== `apple:${sub}`);
    if (!subscriber.appleSubs.length) {
      await storeDelete(subscriberKey(id));
      continue;
    }
    subscriber.updatedAt = Date.now();
    await storeSet(subscriberKey(id), subscriber);
    retainedIds.push(id);
  }
  if (retainedIds.length) await storeSet(INDEX_KEY, { ids: retainedIds });
  else await storeDelete(INDEX_KEY);
}

export async function promotionalSummary(): Promise<{
  subscribed: number;
  unsubscribed: number;
  campaigns: PromotionalCampaign[];
  configuration: ReturnType<typeof promotionalEmailConfiguration>;
}> {
  const subscribers = await promotionalSubscribers();
  const campaignIndex = await storeGet<{ ids?: unknown }>("marketing:campaigns", { ids: [] });
  const campaignIds = Array.isArray(campaignIndex.ids)
    ? campaignIndex.ids.filter((id): id is string => typeof id === "string")
    : [];
  const campaigns = (await Promise.all(campaignIds.map((id) => storeGet<PromotionalCampaign | null>(campaignKey(id), null))))
    .filter((campaign): campaign is PromotionalCampaign => Boolean(campaign))
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, 12);
  return {
    subscribed: subscribers.filter((subscriber) => subscriber.status === "subscribed").length,
    unsubscribed: subscribers.filter((subscriber) => subscriber.status === "unsubscribed").length,
    campaigns,
    configuration: promotionalEmailConfiguration()
  };
}

function signToken(id: string): string {
  const secret = UNSUBSCRIBE_SECRET();
  if (!secret) return "";
  const body = Buffer.from(JSON.stringify({ id, exp: Date.now() + 2 * 365 * 86400_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function unsubscribeId(token: unknown): string | null {
  const secret = UNSUBSCRIBE_SECRET();
  if (!secret || typeof token !== "string") return null;
  const [body, suppliedSignature] = token.split(".");
  if (!body || !suppliedSignature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { id?: unknown; exp?: unknown };
    return typeof payload.id === "string" && /^[a-f0-9]{64}$/.test(payload.id) && Number(payload.exp) >= Date.now() ? payload.id : null;
  } catch { return null; }
}

export async function unsubscribePromotionalEmail(token: unknown): Promise<boolean> {
  const id = unsubscribeId(token);
  if (!id) return false;
  const subscriber = await storeGet<PromotionalSubscriber | null>(subscriberKey(id), null);
  if (!subscriber) return false;
  subscriber.status = "unsubscribed";
  subscriber.unsubscribedAt = Date.now();
  subscriber.updatedAt = subscriber.unsubscribedAt;
  await storeSet(subscriberKey(id), subscriber);
  return true;
}

function unsubscribeUrl(subscriber: PromotionalSubscriber): string {
  return `${SERVER_BASE_URL()}/unsubscribe?token=${encodeURIComponent(signToken(subscriber.id))}`;
}

function campaignHtml(input: { subject: string; body: string; ctaLabel?: string; ctaUrl?: string; unsubscribeUrl: string }): string {
  const paragraphs = input.body.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 15px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#d6d6db">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
  const cta = input.ctaLabel && input.ctaUrl
    ? `<p style="margin:24px 0 0"><a href="${escapeAttribute(input.ctaUrl)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:#e9e7e1;color:#171719;text-decoration:none;font:700 15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeHtml(input.ctaLabel)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#131314"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#131314"><tr><td style="padding:32px 16px" align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px"><tr><td style="padding:0 8px 17px;color:#f7f6f2;font:800 20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">Taki AI</td></tr><tr><td style="padding:30px;border:1px solid #353536;border-radius:12px;background:#1c1c1e"><h1 style="margin:0 0 16px;color:#f7f6f2;font:800 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeHtml(input.subject)}</h1>${paragraphs}${cta}</td></tr><tr><td style="padding:19px 8px 0;color:#aaaab0;font:12px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">This is a promotional email from Taki AI. <a href="${escapeAttribute(input.unsubscribeUrl)}" style="color:#e9e7e1">Unsubscribe</a> from promotional emails.<br>${escapeHtml(POSTAL_ADDRESS())}</td></tr></table></td></tr></table></body></html>`;
}

async function addCampaign(campaign: PromotionalCampaign): Promise<void> {
  const index = await storeGet<{ ids?: unknown }>("marketing:campaigns", { ids: [] });
  const ids = Array.isArray(index.ids) ? index.ids.filter((id): id is string => typeof id === "string") : [];
  await storeSet(campaignKey(campaign.id), campaign);
  await storeSet("marketing:campaigns", { ids: [...new Set([campaign.id, ...ids])].slice(0, 100) });
}

async function sendOne(subscriber: PromotionalSubscriber, campaign: PromotionalCampaign): Promise<{ ok: boolean; error?: string }> {
  const url = unsubscribeUrl(subscriber);
  const text = `${campaign.body}${campaign.ctaLabel && campaign.ctaUrl ? `\n\n${campaign.ctaLabel}: ${campaign.ctaUrl}` : ""}\n\nUnsubscribe from promotional emails: ${url}\n${POSTAL_ADDRESS()}`;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY()}`,
        "Content-Type": "application/json",
        "User-Agent": "Taki-AI-Promotional-Email/1.0",
        "Idempotency-Key": `taki-campaign/${campaign.id}/${subscriber.id}`
      },
      body: JSON.stringify({
        from: FROM(), to: [subscriber.email], subject: campaign.subject, text,
        html: campaignHtml({ ...campaign, unsubscribeUrl: url }),
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "X-Entity-Ref-ID": campaign.id
        }
      })
    });
    if (!response.ok) return { ok: false, error: `Resend returned ${response.status}` };
    subscriber.lastSentAt = Date.now();
    subscriber.updatedAt = subscriber.lastSentAt;
    await storeSet(subscriberKey(subscriber.id), subscriber);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Email request failed" };
  }
}

export async function sendPromotionalCampaign(input: { subject: unknown; body: unknown; ctaLabel?: unknown; ctaUrl?: unknown }): Promise<PromotionalCampaign> {
  if (!isPromotionalEmailConfigured()) throw new Error("RESEND_API_KEY is not configured.");
  if (!POSTAL_ADDRESS()) throw new Error("Set PROMOTIONAL_POSTAL_ADDRESS before sending promotional email.");
  const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 160) : "";
  const body = typeof input.body === "string" ? input.body.trim().slice(0, 10_000) : "";
  const ctaLabel = typeof input.ctaLabel === "string" ? input.ctaLabel.trim().slice(0, 60) : "";
  const ctaUrl = typeof input.ctaUrl === "string" ? input.ctaUrl.trim().slice(0, 1_500) : "";
  if (!subject || !body) throw new Error("A subject and message are required.");
  if ((ctaLabel && !ctaUrl) || (ctaUrl && (!/^https:\/\//i.test(ctaUrl) || !ctaLabel))) throw new Error("A call to action needs both a label and an HTTPS URL.");
  const campaign: PromotionalCampaign = { id: randomUUID(), subject, body, ...(ctaLabel ? { ctaLabel } : {}), ...(ctaUrl ? { ctaUrl } : {}), sentAt: Date.now(), requested: 0, delivered: 0, failed: 0, failures: [] };
  const recipients = (await promotionalSubscribers()).filter((subscriber) => subscriber.status === "subscribed");
  campaign.requested = recipients.length;
  // Resend's default API limit is five requests per second. Small concurrent
  // batches keep a campaign moving without turning a temporary limit into loss.
  for (let start = 0; start < recipients.length; start += 5) {
    const results = await Promise.all(recipients.slice(start, start + 5).map((subscriber) => sendOne(subscriber, campaign)));
    for (const result of results) {
      if (result.ok) campaign.delivered += 1;
      else { campaign.failed += 1; if (campaign.failures.length < 8) campaign.failures.push(result.error || "Send failed"); }
    }
    if (start + 5 < recipients.length) await new Promise((resolve) => setTimeout(resolve, 1_050));
  }
  await addCampaign(campaign);
  return campaign;
}
