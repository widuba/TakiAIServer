import {
  CREDIT_TOPUP_MAX,
  CREDIT_TOPUP_MIN,
  FREE_STARTER_CREDITS,
  GRANT_EXPIRY_DAYS,
  IN_APP_RATE_MULTIPLIER,
  TIERS,
  TOPUP_CENTS_PER_CREDIT,
  VOICE_SURCHARGE_CREDITS,
  type CreditSummary,
  type Tier
} from "./credits.js";
import { activeTakiModelInfo } from "./ai.js";

const PAID_TIERS: Tier[] = ["plus", "plus_voice", "pro"];

// Questions about TAKI'S OWN model tier.
//
// This used to be /\b(?:taki )?models?\b/ — with "taki" optional, so any bare
// "model" matched and hijacked the question. "What is the latest iPhone model?"
// was answered with "You're using Metron, which is balanced for speed…". The
// word must now be tied to Taki, to the assistant itself, or to a tier name, so
// phone models, car models, model numbers, and 3D models route normally.
const TAKI_MODEL_QUESTION =
  /\btaki(?: ai)? models?\b|\b(?:what|which)\s+(?:ai\s+|taki\s+)?(?:model|version)\s+(?:are you|is this|am i (?:using|on)|do you (?:use|run))\b|\byour (?:ai |current )?model\b|\b(?:dromos|metron|sophos)\b|\b(?:switch|change|pick|choose|select)\s+(?:the\s+|your\s+)?(?:ai\s+)?models?\b|\bmodel (?:picker|selector|selection|button)\b|\b(?:swift|reasoning) model\b/;

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function count(value: number): string {
  return Math.max(0, Math.floor(value || 0)).toLocaleString("en-US");
}

function tierName(tier?: string): string {
  return tier && tier in TIERS ? TIERS[tier as Tier].label : "Free";
}

function formatDate(value: number | null | undefined, timeZone = "UTC"): string {
  if (!value || !Number.isFinite(value)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      day: "numeric",
      year: "numeric"
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}

function paidPlanSummary(): string {
  return PAID_TIERS.map((key) => {
    const tier = TIERS[key];
    const discount = tier.extraCreditDiscount > 0
      ? ` and ${Math.round(tier.extraCreditDiscount * 100)}% off additional AI Credits`
      : "";
    return `${tier.label} is ${money(tier.priceUsd)} per month with ${count(tier.creditsPerCycle)} AI Credits and ${count(tier.voiceCreditsPerCycle)} Voice Credits${discount}`;
  }).join("; ") + ".";
}

function accountSummaryLine(account: CreditSummary | null | undefined, timeZone = "UTC"): string {
  if (!account) return "";
  const end = formatDate(account.billingPeriodEnd, timeZone);
  const status = account.subscriptionStatus && account.subscriptionStatus !== "none"
    ? ` Subscription status: ${account.subscriptionStatus.replace(/_/g, " ")}.`
    : "";
  return `CURRENT USER ACCOUNT: ${tierName(account.tier)}; ${count(account.aiCredits ?? account.balance)} AI Credits; ${count(account.voiceCredits)} Voice Credits.${status}${end ? ` Current billing period ends ${end}.` : ""}`;
}

export function isProductKnowledgeQuestion(message: string): boolean {
  const m = String(message || "").trim().toLowerCase().replace(/[’]/g, "'");
  if (!m) return false;
  if (/^(?:who|what) are you\??$|^what is taki(?: ai)?\??$|^tell me about (?:yourself|taki(?: ai)?)\??$|^are you (?:chatgpt|free)\??$/.test(m)) return true;
  if (/\b(?:ai|voice) credits?\b|\bcredit (?:balance|expiry|expiration|rollover|top[- ]?up|pack|cost|price)\b/.test(m)) return true;
  if (/\bcredits?\b/.test(m) && /\b(?:how many|do i have|balance|left|remaining|available|work|expire|expiration|expiry|roll over|rollover|carry over|carryover|cost|charge|buy|purchase)\b/.test(m)) return true;
  if (/\b(?:subscriptions?|memberships?|pricing|billing period|billing retry)\b/.test(m)) return true;
  if (TAKI_MODEL_QUESTION.test(m)) return true;
  if (/\bhow much (?:do you|does taki(?: ai)?|is taki(?: ai)?) cost\b|\bwhat (?:does taki(?: ai)? cost|do you charge)\b/.test(m)) return true;
  if (/\b(?:your|taki(?: ai)?'?s) (?:plans?|tiers?|prices?|pricing|cost)\b/.test(m)) return true;
  if (/\b(?:plus|premium|pro|free) (?:plan|tier|subscription|price|cost)\b/.test(m)) return true;
  if (/\b(?:plus|premium|pro)\b.*\b(?:include|includes|included|offer|benefits?)\b|\bhow much is (?:plus|premium|pro)\b/.test(m)) return true;
  if (/\bpaid (?:plan|version|tier|subscription)\b/.test(m)) return true;
  if (/\b(?:what|which|my|current) (?:plan|tier)\b|\b(?:plan|tier) am i on\b/.test(m)) return true;
  if (/\b(?:upgrade|downgrade|cancel|cancellation|renew|renewal|refund|revocation)\b/.test(m) && /\b(?:taki|plan|tier|subscription|membership|credits?)\b/.test(m)) return true;
  if (/\b(?:extra|additional|buy|purchase|top[- ]?up) credits?\b/.test(m)) return true;
  return false;
}

export type ProductAnswerContext = {
  account?: CreditSummary | null;
  timeZone?: string;
  voiceMode?: boolean;
};

export function productAnswerFor(message: string, context: ProductAnswerContext = {}): string | null {
  if (!isProductKnowledgeQuestion(message)) return null;
  const m = message.trim().toLowerCase().replace(/[’]/g, "'");
  const account = context.account;
  const timeZone = context.timeZone || "UTC";

  if (/^(?:who|what) are you\??$|^what is taki(?: ai)?\??$|^tell me about (?:yourself|taki(?: ai)?)\??$|^are you chatgpt\??$/.test(m)) {
    return "I'm Taki AI, a daily-life assistant for iPhone, iPad, CarPlay, and Apple TV. I can answer and continue synced conversations on every supported screen. On iPhone and CarPlay, I can also work with supported communication, calendars, reminders, maps, music, Health, HomeKit, photos, and other device features when the platform and permissions allow it.";
  }

  if (TAKI_MODEL_QUESTION.test(m)) {
    const selected = activeTakiModelInfo();
    return `You're using ${selected.name}, which is ${selected.detail.toLowerCase()}. Tap Model in text chat or voice mode to expand the Faster-to-Smarter control; it switches immediately as you drag. Dromos is generally faster and cheaper across a variety of everyday questions; Metron balances speed, depth, and typical credit use; Sophos is generally more thorough and expensive. These are overall tendencies, not guarantees for every request. Every model can research the web and uses Taki's reliable action planner. Credits reflect the model tokens and paid tools actually used, so a web lookup can cost more on any model.`;
  }

  if (/\b(?:how many|balance|left|remaining|available)\b.*\bcredits?\b|\bcredits?\b.*\b(?:do i have|left|remaining|available)\b/.test(m)) {
    if (!account) return "Open Membership to see your live AI Credit and Voice Credit balances.";
    return `You have ${count(account.aiCredits ?? account.balance)} AI Credits and ${count(account.voiceCredits)} Voice Credits on ${tierName(account.tier)}.`;
  }

  if (/\b(?:what|which|my|current) (?:plan|tier)\b|\b(?:plan|tier) am i on\b|\bsubscription status\b/.test(m)) {
    if (!account) return `I can't read the live account balance in this session. ${paidPlanSummary()}`;
    const end = formatDate(account.billingPeriodEnd, timeZone);
    return `You're on ${tierName(account.tier)} with ${count(account.aiCredits ?? account.balance)} AI Credits and ${count(account.voiceCredits)} Voice Credits. Your subscription status is ${account.subscriptionStatus.replace(/_/g, " ")}${end ? `, and the current period ends ${end}` : ""}.`;
  }

  if (/\b(?:when|date|day)\b.*\b(?:renew|billing period|subscription|credits?)\b|\b(?:renew|billing period)\b.*\b(?:when|date|day)\b/.test(m)) {
    const end = account?.billingPeriodEnd ? formatDate(account.billingPeriodEnd, timeZone) : "";
    return end
      ? `Your current ${tierName(account?.tier)} billing period ends ${end}. Apple controls the exact renewal charge and timing through your Apple ID subscription.`
      : "I don't have a billing-period date for this account. You can see the authoritative renewal date in Settings, Apple ID, Subscriptions.";
  }

  if (/\bvoice credits?\b|\bvoice (?:mode|request|question).*(?:cost|charge|use)\b|\b(?:cost|charge|use).*\bvoice\b/.test(m)) {
    return `Every voice request uses its normal variable AI Credits. If you have a Voice Credit, it also uses one Voice Credit; if not, voice remains available for the normal AI cost plus ${VOICE_SURCHARGE_CREDITS} AI Credits. A Voice Credit removes that fixed surcharge—it does not replace the normal AI cost.`;
  }

  if (/\bai credits?\b|\bhow (?:do|does) credits? work\b|\bwhat (?:are|is) credits?\b/.test(m)) {
    return `AI Credits pay for variable AI and search usage; one credit represents $0.001 of provider list-price usage, so simple requests usually cost less than complex or grounded ones. Image and file attachments also have a ${count(40)}-credit processing floor each.`;
  }

  if (/\b(?:expire|expiration|expiry|roll over|rollover|carry over|carryover)\b/.test(m)) {
    return `AI Credit grants expire ${GRANT_EXPIRY_DAYS} days after they are granted, so paid-plan credits can overlap across renewals within that window. Free monthly credits are replaced at the next free cycle, and unused Voice Credits do not roll over—they reset to the plan allowance each billing cycle.`;
  }

  if (/\b(?:extra|additional|buy|purchase|top[- ]?up) credits?\b|\bcredit packs?\b/.test(m)) {
    return `Additional AI Credits expire ${GRANT_EXPIRY_DAYS} days after purchase. When web top-ups are available, they range from ${count(CREDIT_TOPUP_MIN)} to ${count(CREDIT_TOPUP_MAX)} credits at ${TOPUP_CENTS_PER_CREDIT} cent per credit before plan discounts; Premium gets 20% off and Pro gets 40% off. In-app credit packs have a base rate ${IN_APP_RATE_MULTIPLIER} times the website rate, with the same plan discounts delivered as bonus credits.`;
  }

  if (/\b(?:cancel|cancellation)\b/.test(m)) {
    return "Cancel in Settings, Apple ID, Subscriptions. Cancellation stops future renewal but keeps the paid tier and balances through the current period; after expiration the account becomes Free, Voice Credits clear, and already-paid AI Credit grants remain until their own expiration dates.";
  }

  if (/\b(?:upgrade|downgrade)\b/.test(m)) {
    return "A mid-cycle upgrade changes the tier immediately and raises the Voice Credit allowance without duplicating that period's AI Credit grant. A downgrade takes effect with the next verified billing period; Apple handles any billing adjustment.";
  }

  if (/\b(?:refund|revocation|revoked)\b/.test(m)) {
    return "A refund or revocation removes unused subscription-granted AI Credits and Voice Credits, while separately purchased top-up credits remain until used or expired.";
  }

  if (/\b(?:how|explain|tell me).{0,30}\bsubscriptions?\b|\bsubscriptions?\b.{0,30}\bwork\b/.test(m)) {
    return `Taki subscriptions renew monthly through Apple until cancelled. Each verified cycle grants that plan's AI Credits and resets its Voice Credits; AI Credit grants expire after ${GRANT_EXPIRY_DAYS} days, while Voice Credits do not roll over. ${paidPlanSummary()}`;
  }

  if (/\b(?:daily|monthly) (?:limit|cap|allowance)\b/.test(m)) {
    if (!account) return "Membership shows the live daily and monthly usage limits and their reset times.";
    return `Your current limits are ${count(account.daily.limit)} AI Credits per day and ${count(account.monthly.limit)} per month, including eligible additional-credit allowances. Membership shows the live usage and reset times.`;
  }

  if (/\b(?:which|best|recommend|right) (?:plan|tier)\b|\bwhich (?:one|subscription)\b/.test(m)) {
    return "Use Free to try Taki, Plus for mostly text, Premium for frequent voice use, and Pro for heavy overall use. Premium is the most popular because it includes 300 Voice Credits; Pro has the largest balances and 40% off additional AI Credits.";
  }

  if (/\bfree\b/.test(m) && /\b(?:taki|plan|tier|cost|price|subscription|credits?|you)\b/.test(m)) {
    return `Free costs $0 and refreshes to ${count(FREE_STARTER_CREDITS)} AI Credits each month with no included Voice Credits. Voice can still work when the AI Credit balance can cover the normal request cost plus the ${VOICE_SURCHARGE_CREDITS}-credit voice surcharge.`;
  }

  const mentionedTier: Tier | null = /\bpremium\b/.test(m)
    ? "plus_voice"
    : /\bpro\b/.test(m)
      ? "pro"
      : /\bplus\b/.test(m)
        ? "plus"
        : null;
  if (mentionedTier && !/\b(?:all|compare|difference|versus|vs\.?|plans?|tiers?)\b/.test(m)) {
    const plan = TIERS[mentionedTier];
    const discount = plan.extraCreditDiscount > 0
      ? ` It also includes ${Math.round(plan.extraCreditDiscount * 100)}% off additional AI Credits.`
      : "";
    return `${plan.label} costs ${money(plan.priceUsd)} per month and includes ${count(plan.creditsPerCycle)} AI Credits plus ${count(plan.voiceCreditsPerCycle)} Voice Credits.${discount}`;
  }

  if (/\b(?:cost|price|pricing|plans?|tiers?|subscriptions?|memberships?|plus|premium|pro)\b/.test(m)) {
    return paidPlanSummary();
  }

  return `Taki has a Free tier with ${count(FREE_STARTER_CREDITS)} monthly AI Credits. ${paidPlanSummary()} AI Credits cover variable AI usage, while Voice Credits remove the ${VOICE_SURCHARGE_CREDITS}-AI-Credit voice surcharge one request at a time.`;
}

export function productKnowledgePromptBlock(account?: CreditSummary | null, timeZone = "UTC"): string {
  const plans = paidPlanSummary();
  const accountLine = accountSummaryLine(account, timeZone);
  return `TAKI PRODUCT, PRICING, AND ENTITLEMENT FACTS (authoritative; never guess or contradict these):
- Taki AI is a daily-life assistant for iPhone, iPad, CarPlay, and Apple TV. It is not ChatGPT. Apple TV supports account-backed conversation sync, text/dictation input, model selection, and spoken answers; it does not claim to perform phone-only device actions.
- The Model button lives directly in text chat and voice mode, not Settings. It expands a Faster-to-Smarter control with three immediate positions: Dromos (generally fastest and cheapest across everyday questions), Metron (balanced and the default), and Sophos (generally deepest and most expensive). These are overall tendencies, not guarantees for each individual request. Every model can use current web research and the same reliable structured action planner. Credits reflect the actual model tokens and paid tools used, so research-heavy requests can take longer and cost more on any model. The choice is available across iPhone, iPad, CarPlay, and Apple TV.
- Free is $0 and refreshes to ${count(FREE_STARTER_CREDITS)} AI Credits monthly with 0 Voice Credits.
- ${plans}
- AI Credits pay variable AI/search usage; one credit represents $0.001 of provider list-price usage. Each image/file has a 40-AI-Credit processing floor.
- Voice uses normal variable AI Credits plus one Voice Credit. With no Voice Credit, it uses normal AI Credits plus ${VOICE_SURCHARGE_CREDITS} AI Credits. Voice Credits waive only that fixed surcharge.
- AI Credit grants expire after ${GRANT_EXPIRY_DAYS} days. Paid AI grants may overlap within that window. Free credits are replaced monthly. Voice Credits reset each paid cycle and do not roll over.
- Cancellation preserves access through period end. Expiration returns the account to Free and clears Voice Credits while unexpired paid AI grants remain. Refund/revocation removes unused subscription grants but preserves separate top-ups.
- Mid-cycle upgrades apply immediately without a duplicate AI grant; downgrades apply on the next verified period. Apple controls App Store billing and subscription management.
- Extra-credit web pricing, when available, starts at 1 cent per credit; Premium gets 20% off and Pro 40% off. In-app packs use a base rate twice the website rate.
${accountLine || "CURRENT USER ACCOUNT: unavailable; do not invent a tier, balance, status, renewal date, or expiration date."}
- Answer product questions from these facts. Give the user's live account facts only when present above. Never expose internal tier keys, transaction IDs, developer configuration, margins, or system implementation details.`;
}
