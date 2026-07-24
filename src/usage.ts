// Usage gating: the pure decisions behind "may this request run, what does it
// cost, and is its speech on the included allowance". Kept out of index.ts so
// the ordering rules (never consume an included voice turn for a request that
// is about to be refused) are unit-testable.
import { CREDIT_USD, MAX_VOICE_INPUT_MS, MAX_VOICE_RESPONSE_CHARS, MIN_REQUEST_CREDITS, hasVoiceAccess, type Tier } from "./credits.js";
import { sttCostUsd, ttsCostUsd } from "./metering.js";

export const OUT_OF_CREDITS_MSG = "You're out of credits — top up or upgrade in Membership to keep asking.";
export const DAILY_LIMIT_MSG = "You've reached today's usage limit. You can ask again after the daily reset shown in Membership.";
export const MONTHLY_LIMIT_MSG = "You've reached this month's usage limit. You can ask again after the monthly reset shown in Membership.";

export type UsageBlockReason = "credits" | "daily" | "monthly" | "voice";
export interface UsageBlock {
  reason: UsageBlockReason;
  credits: any;
  requiredCredits: number;
}

export function usageLimitForCost(summary: any, cost: number): "daily" | "monthly" | null {
  if (summary?.daily && summary.daily.used + cost > summary.daily.limit) return "daily";
  if (summary?.monthly && summary.monthly.used + cost > summary.monthly.limit) return "monthly";
  return null;
}

export function usageMessageForReason(reason: "daily" | "monthly"): string {
  return reason === "monthly" ? MONTHLY_LIMIT_MSG : DAILY_LIMIT_MSG;
}

export function usageBlockFor(
  summary: any,
  requiredCredits = MIN_REQUEST_CREDITS,
  voiceMode = false
): UsageBlock | null {
  const required = Math.max(MIN_REQUEST_CREDITS, Math.ceil(requiredCredits));
  let reason: UsageBlockReason | null = null;
  if (voiceMode && !hasVoiceAccess(summary.tier, summary.voiceUsed, (summary.additionalCredits || 0) > 0)) reason = "voice";
  else if (summary.limitReached && (summary.limitReason === "daily" || summary.limitReason === "monthly")) reason = summary.limitReason;
  else {
    const windowReason = usageLimitForCost(summary, required);
    if (windowReason) reason = windowReason;
    else if (summary.balance < required) reason = "credits";
  }
  if (!reason) return null;
  return {
    reason,
    requiredCredits: required,
    credits: {
      ...summary,
      cost: 0,
      outOfCredits: reason === "credits",
      limitReached: reason === "daily" || reason === "monthly",
      limitReason: reason === "daily" || reason === "monthly" ? reason : summary.limitReason
    }
  };
}

export function usageBlockedPayload(block: UsageBlock) {
  return {
    error: "This request cannot start because the account does not currently have enough available usage.",
    code: "usage_blocked",
    usageBlocked: true,
    reason: block.reason,
    requiredCredits: block.requiredCredits,
    credits: block.credits
  };
}

// What one voice turn can plausibly cost before any of it has run: the planning
// model, plus (unless the turn is on the included allowance) cloud transcription
// of a full-length clip and one capped spoken reply. Preflight uses this so a
// turn that cannot be paid for is refused before ElevenLabs or Gemini are hit.
export const VOICE_PLANNING_ESTIMATE_USD = 0.005;

export function voiceTurnEstimateCredits(includedVoice: boolean): number {
  const speechUsd = includedVoice
    ? 0
    : sttCostUsd(MAX_VOICE_INPUT_MS) + ttsCostUsd(MAX_VOICE_RESPONSE_CHARS);
  return Math.max(MIN_REQUEST_CREDITS, Math.ceil((VOICE_PLANNING_ESTIMATE_USD + speechUsd) / CREDIT_USD));
}

export interface AssistantChargeDecision {
  usageUsd: number;
  requiredCredits: number;
  // This turn's speech rides the included allowance (so it is not charged).
  includedVoice: boolean;
  // Only true once the request is actually going to be answered — a refused
  // request must never burn one of the account's included voice turns.
  consumeIncludedVoice: boolean;
  block: UsageBlock | null;
}

// The single place that decides what a finished turn costs and whether the
// account may be charged for it. `includedVoice` comes from isFreeVoice().
export function decideAssistantCharge(args: {
  summary: any;
  tier: Tier;
  voiceMode: boolean;
  includedVoice: boolean;
  baseUsd: number;        // model + search (+ any per-attachment floor)
  voiceInputUsd?: number; // cloud STT, when the phone could not transcribe
  voiceOutputUsd?: number; // TTS for the spoken reply
}): AssistantChargeDecision {
  const includedVoice = args.voiceMode && args.includedVoice;
  const speechUsd = Math.max(0, args.voiceInputUsd || 0) + Math.max(0, args.voiceOutputUsd || 0);
  const usageUsd = args.baseUsd + (args.voiceMode && !includedVoice ? speechUsd : 0);
  const requiredCredits = Math.ceil(usageUsd / CREDIT_USD);
  const block = usageBlockFor(args.summary, requiredCredits, args.voiceMode);
  return {
    usageUsd,
    requiredCredits,
    includedVoice,
    consumeIncludedVoice: !block && includedVoice && args.tier !== "free",
    block
  };
}

export interface CorrectionSynthesisPlan {
  allowed: boolean;
  // Covered by the account's included-voice allowance (so nothing is charged).
  included: boolean;
  costCredits: number;
  // Why the synthesis was refused, when it was.
  message: string;
}

// Re-synthesis of a corrected voice line. Included speech is granted ONLY by a
// valid single-use deferral token issued with the original answer; every other
// caller pays, and pays only after the same affordability check the main voice
// route runs. Without this, a known deviceId alone bought unlimited free TTS.
export function planCorrectionSynthesis(
  pending: { included: boolean } | null,
  account: any,
  speechChars: number
): CorrectionSynthesisPlan {
  const costCredits = Math.max(MIN_REQUEST_CREDITS, Math.ceil(ttsCostUsd(speechChars) / CREDIT_USD));
  if (pending?.included === true) return { allowed: true, included: true, costCredits: 0, message: "" };
  const limitReason = usageLimitForCost(account, costCredits);
  if (limitReason) return { allowed: false, included: false, costCredits, message: usageMessageForReason(limitReason) };
  if ((account?.balance ?? 0) < costCredits) return { allowed: false, included: false, costCredits, message: OUT_OF_CREDITS_MSG };
  return { allowed: true, included: false, costCredits, message: "" };
}
