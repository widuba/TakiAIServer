import { randomUUID } from "node:crypto";
import { getPushToken } from "./nudges.js";
import { sendPush } from "./push.js";
import { storeGet, storeSet } from "./store.js";
import type { UserRecord } from "./users.js";

export type EngagementChannel = "push" | "email";
export type EngagementCategory = "planning" | "communication" | "health" | "nearby" | "home" | "research" | "reminders";

export interface EngagementCampaign {
  id: string;
  identity: string;
  channel: EngagementChannel;
  category: EngagementCategory;
  title: string;
  body: string;
  sentAt: number;
  openedAt?: number;
  sessionSeconds?: number;
  status: "sent" | "failed";
  source: "automatic" | "admin";
  error?: string;
}

type CategoryPerformance = { sent: number; opened: number; sessionSeconds?: number; lastSentAt?: number };
type EngagementState = {
  campaigns: EngagementCampaign[];
  performance: Partial<Record<EngagementCategory, Partial<Record<EngagementChannel, CategoryPerformance>>>>;
};

const CATEGORIES: EngagementCategory[] = ["planning", "communication", "health", "nearby", "home", "research", "reminders"];
const EMAIL_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = (process.env.ENGAGEMENT_FROM_EMAIL || "").trim();
const SERVER_BASE_URL = (process.env.SERVER_BASE_URL || "https://takiaiserver.onrender.com").replace(/\/$/, "");

const CONTENT: Record<EngagementCategory, { title: string; body: string; emailSubject: string; emailBody: string }> = {
  planning: {
    title: "Make today easier",
    body: "Turn the things on your mind into a clear plan with Taki.",
    emailSubject: "A clearer plan for your day",
    emailBody: "Open Taki and turn your priorities into a practical plan you can adjust as the day changes."
  },
  communication: {
    title: "Say it the way you mean it",
    body: "Taki can help draft your next text or email in your voice.",
    emailSubject: "A little help with the message",
    emailBody: "Open Taki when you want help drafting a text or email that sounds natural and gets to the point."
  },
  health: {
    title: "Check in with your day",
    body: "Ask Taki about the health and activity information available on your device.",
    emailSubject: "A quick health check-in",
    emailBody: "Open Taki to make sense of the health and activity information you choose to share from your device."
  },
  nearby: {
    title: "Find what is nearby",
    body: "Ask Taki for places, directions, or useful stops around you.",
    emailSubject: "Find the right place nearby",
    emailBody: "Open Taki to find nearby places, compare options, and get directions when you need them."
  },
  home: {
    title: "Get something done at home",
    body: "Use Taki for a timer, reminder, routine, or a connected-home request.",
    emailSubject: "One less thing to manage at home",
    emailBody: "Open Taki to set a timer or reminder, run a routine, or work with supported connected-home controls."
  },
  research: {
    title: "Get a sourced answer",
    body: "Ask Taki to look something up and keep the exact sources with the answer.",
    emailSubject: "Research without losing the sources",
    emailBody: "Open Taki for a current answer with sources you can inspect and revisit."
  },
  reminders: {
    title: "Keep the next thing from slipping",
    body: "Ask Taki to set the reminder, alarm, or timer you have in mind.",
    emailSubject: "Keep the next thing on track",
    emailBody: "Open Taki to set a reminder, alarm, or timer while it is still on your mind."
  }
};

function safeIdentity(identity: string): string {
  return identity.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function stateKey(identity: string): string {
  return `engagement:${safeIdentity(identity)}`;
}

function campaignKey(id: string): string {
  return `engagement_campaign:${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function loadState(identity: string): Promise<EngagementState> {
  const state = await storeGet<EngagementState>(stateKey(identity), { campaigns: [], performance: {} });
  if (!Array.isArray(state.campaigns)) state.campaigns = [];
  if (!state.performance || typeof state.performance !== "object") state.performance = {};
  return state;
}

async function saveCampaign(campaign: EngagementCampaign, countAsSent: boolean): Promise<void> {
  const state = await loadState(campaign.identity);
  const existingIndex = state.campaigns.findIndex((item) => item.id === campaign.id);
  if (existingIndex >= 0) state.campaigns[existingIndex] = campaign;
  else state.campaigns.push(campaign);
  state.campaigns = state.campaigns.slice(-100);
  if (countAsSent) {
    const category = state.performance[campaign.category] || {};
    const prior = category[campaign.channel] || { sent: 0, opened: 0 };
    category[campaign.channel] = { ...prior, sent: prior.sent + 1, lastSentAt: campaign.sentAt };
    state.performance[campaign.category] = category;
  }
  await storeSet(stateKey(campaign.identity), state);
  await storeSet(campaignKey(campaign.id), campaign);
}

function categoryForFeature(feature: string): EngagementCategory | null {
  const value = feature.toLowerCase();
  if (/calendar|day_plan|cooking_schedule/.test(value)) return "planning";
  if (/message|email|call|contact|share/.test(value)) return "communication";
  if (/health|habit/.test(value)) return "health";
  if (/maps|weather|location|nearby|service_handoff/.test(value)) return "nearby";
  if (/home|timer|alarm|cooking|routine/.test(value)) return "home";
  if (/search|source|photo|file|attachment|youtube|chat/.test(value)) return "research";
  if (/reminder|alert/.test(value)) return "reminders";
  return null;
}

export async function recommendedEngagement(user: UserRecord, channel: EngagementChannel): Promise<{
  category: EngagementCategory;
  title: string;
  body: string;
  reason: string;
}> {
  const state = await loadState(user.identity);
  const scores = new Map<EngagementCategory, number>(CATEGORIES.map((category) => [category, 1]));
  for (const interest of user.engagement.interests) {
    if (CATEGORIES.includes(interest as EngagementCategory)) scores.set(interest as EngagementCategory, (scores.get(interest as EngagementCategory) || 0) + 4);
  }
  for (const [feature, count] of Object.entries(user.analytics.featureUsage)) {
    const category = categoryForFeature(feature);
    if (category) scores.set(category, (scores.get(category) || 0) + Math.min(4, Math.log2(count + 1)));
  }
  for (const category of CATEGORIES) {
    const performance = state.performance[category]?.[channel];
    if (performance) {
      const learnedResponse = (performance.opened + 1) / (performance.sent + 3);
      scores.set(category, (scores.get(category) || 0) + learnedResponse * 5);
    }
  }
  const recent = [...state.campaigns].reverse().find((campaign) => campaign.channel === channel && campaign.status === "sent");
  if (recent && Date.now() - recent.sentAt < 14 * 86400_000) {
    scores.set(recent.category, (scores.get(recent.category) || 0) - 3);
  }
  const category = [...scores.entries()].sort((a, b) => b[1] - a[1] || CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]))[0]?.[0] || "planning";
  const copy = CONTENT[category];
  const reason = user.engagement.interests.includes(category)
    ? "Selected during onboarding"
    : Object.entries(user.analytics.featureUsage).some(([feature]) => categoryForFeature(feature) === category)
      ? "Matches frequently used features"
      : "Exploration candidate";
  return {
    category,
    title: channel === "email" ? copy.emailSubject : copy.title,
    body: channel === "email" ? copy.emailBody : copy.body,
    reason
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] || character));
}

export function isEngagementEmailConfigured(): boolean {
  return Boolean(EMAIL_API_KEY && EMAIL_FROM);
}

export async function sendPersonalizedEngagement(
  user: UserRecord,
  channel: EngagementChannel,
  deviceIds: string[],
  source: "automatic" | "admin" = "admin"
): Promise<{ ok: boolean; campaign: EngagementCampaign; reason?: string }> {
  const recommendation = await recommendedEngagement(user, channel);
  const campaign: EngagementCampaign = {
    id: randomUUID(),
    identity: user.identity,
    channel,
    category: recommendation.category,
    title: recommendation.title,
    body: recommendation.body,
    sentAt: Date.now(),
    status: "failed",
    source
  };

  if (channel === "push") {
    const tokens = [...new Set((await Promise.all(deviceIds.map(getPushToken))).filter(Boolean))];
    if (!tokens.length) {
      campaign.error = "No registered push token";
      await saveCampaign(campaign, false);
      return { ok: false, campaign, reason: campaign.error };
    }
    const results = await Promise.all(tokens.map((token) => sendPush(token, {
      title: campaign.title,
      body: campaign.body,
      threadId: "taki-helpful-updates",
      data: { engagementCampaign: campaign.id, engagementCategory: campaign.category }
    })));
    const delivered = results.some((result) => result.ok);
    campaign.status = delivered ? "sent" : "failed";
    campaign.error = delivered ? undefined : results.map((result) => result.reason).filter(Boolean).join(", ") || "Push failed";
    await saveCampaign(campaign, delivered);
    return { ok: delivered, campaign, reason: campaign.error };
  }

  const email = String(user.apple?.email || "").trim();
  if (!email || !isEngagementEmailConfigured()) {
    campaign.error = !email ? "No connected email" : "Email provider is not configured";
    await saveCampaign(campaign, false);
    return { ok: false, campaign, reason: campaign.error };
  }
  const clickUrl = `${SERVER_BASE_URL}/api/engagement/click?campaign=${encodeURIComponent(campaign.id)}`;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${EMAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email],
        subject: campaign.title,
        text: `${campaign.body}\n\nOpen Taki: ${clickUrl}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;line-height:1.55;max-width:560px"><h1 style="font-size:24px;letter-spacing:0">${escapeHtml(campaign.title)}</h1><p>${escapeHtml(campaign.body)}</p><p><a href="${escapeHtml(clickUrl)}" style="display:inline-block;background:#171719;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Open Taki</a></p><p style="color:#6e6e73;font-size:12px">You enabled personalized email in Taki Settings. You can turn it off there at any time.</p></div>`
      })
    });
    campaign.status = response.ok ? "sent" : "failed";
    if (!response.ok) campaign.error = `Email provider returned ${response.status}`;
  } catch (error) {
    campaign.error = error instanceof Error ? error.message : "Email failed";
  }
  await saveCampaign(campaign, campaign.status === "sent");
  return { ok: campaign.status === "sent", campaign, reason: campaign.error };
}

export async function recordEngagementOpen(campaignId: string, identity?: string): Promise<boolean> {
  const campaign = await storeGet<EngagementCampaign | null>(campaignKey(campaignId), null);
  if (!campaign || campaign.status !== "sent" || (identity && campaign.identity !== identity)) return false;
  if (campaign.openedAt) return true;
  campaign.openedAt = Date.now();
  const state = await loadState(campaign.identity);
  const index = state.campaigns.findIndex((item) => item.id === campaign.id);
  if (index >= 0) state.campaigns[index] = campaign;
  const category = state.performance[campaign.category] || {};
  const performance = category[campaign.channel] || { sent: 0, opened: 0 };
  category[campaign.channel] = { ...performance, opened: performance.opened + 1 };
  state.performance[campaign.category] = category;
  await storeSet(stateKey(campaign.identity), state);
  await storeSet(campaignKey(campaign.id), campaign);
  return true;
}

export async function recordEngagementSession(
  campaignId: string,
  identity: string,
  durationSeconds: number
): Promise<boolean> {
  const campaign = await storeGet<EngagementCampaign | null>(campaignKey(campaignId), null);
  if (!campaign || campaign.identity !== identity || campaign.status !== "sent") return false;
  const duration = Math.max(1, Math.min(6 * 3600, Math.round(Number(durationSeconds) || 0)));
  campaign.sessionSeconds = (campaign.sessionSeconds || 0) + duration;
  const state = await loadState(campaign.identity);
  const index = state.campaigns.findIndex((item) => item.id === campaign.id);
  if (index >= 0) state.campaigns[index] = campaign;
  const category = state.performance[campaign.category] || {};
  const performance = category[campaign.channel] || { sent: 0, opened: 0 };
  category[campaign.channel] = {
    ...performance,
    sessionSeconds: (performance.sessionSeconds || 0) + duration
  };
  state.performance[campaign.category] = category;
  await storeSet(stateKey(campaign.identity), state);
  await storeSet(campaignKey(campaign.id), campaign);
  return true;
}

export async function engagementSummary(user: UserRecord): Promise<{
  performance: EngagementState["performance"];
  recentCampaigns: EngagementCampaign[];
  recommendedPush: Awaited<ReturnType<typeof recommendedEngagement>>;
  recommendedEmail: Awaited<ReturnType<typeof recommendedEngagement>>;
}> {
  const state = await loadState(user.identity);
  return {
    performance: state.performance,
    recentCampaigns: [...state.campaigns].reverse().slice(0, 25),
    recommendedPush: await recommendedEngagement(user, "push"),
    recommendedEmail: await recommendedEngagement(user, "email")
  };
}

export async function shouldSendAutomatic(user: UserRecord, channel: EngagementChannel, now = Date.now()): Promise<boolean> {
  if (channel === "push" ? !user.engagement.pushEnabled : !user.engagement.emailEnabled) return false;
  if (!user.lastSeenAt || now - user.lastSeenAt > 45 * 86400_000) return false;
  const inactiveFor = now - user.lastSeenAt;
  if (inactiveFor < (channel === "push" ? 36 : 72) * 3600_000) return false;
  const state = await loadState(user.identity);
  const latest = [...state.campaigns].reverse().find((campaign) => campaign.channel === channel && campaign.status === "sent");
  const minimumGap = channel === "push" ? 4 * 86400_000 : 10 * 86400_000;
  return !latest || now - latest.sentAt >= minimumGap;
}
