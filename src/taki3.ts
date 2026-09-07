import type { AssistantPlan, ConversationState } from "./types.js";
import {
  BRAIN_V4_ANSWER_SCHEMA,
  BRAIN_V4_MODELS,
  brainV4CanAttempt,
  brainV4CanaryPercent,
  brainV4CircuitOpen,
  brainV4PromotionReady,
  brainV4PromotionStatus,
  brainV4RolloutStats,
  brainV4ShadowPercent,
  classifyBrainV4Request,
  normalizeBrainV4RolloutMode,
  noteBrainV4Failure,
  noteBrainV4Success,
  resetBrainV4RolloutStats,
  runBrainV4Plan,
  runBrainV4Shadow,
  shouldShadowBrainV4,
  shouldUseBrainV4,
  type BrainV4Classification,
  type BrainV4Dependencies,
  type BrainV4RequestClass,
  type BrainV4RolloutMode,
  type BrainV4RolloutStats
} from "./brainV4.js";

/**
 * The customer-facing brain name is Taki 3.0. The implementation details are
 * deliberately hidden behind this module so the planner and health contract
 * no longer expose numbered Brain v2/v3/v4 products. The underlying strict
 * answer core remains isolated until live provider evidence permits promotion.
 */
export const TAKI3_VERSION = "3.0" as const;
export const TAKI3_ANSWER_SCHEMA = BRAIN_V4_ANSWER_SCHEMA;
export const TAKI3_MODELS = BRAIN_V4_MODELS;

export type Taki3RolloutMode = BrainV4RolloutMode;
export type Taki3RequestClass = BrainV4RequestClass;
export type Taki3Classification = BrainV4Classification;
export type Taki3RolloutStats = BrainV4RolloutStats;
export type Taki3Dependencies = BrainV4Dependencies;

function translatedEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const translated = { ...env };
  // Taki 3.0 names are canonical. The old variables are read only as a
  // compatibility bridge for an already-deployed Render service.
  if (translated.TAKI_TAKI3_MODE) translated.TAKI_BRAIN_V4_MODE = translated.TAKI_TAKI3_MODE;
  if (translated.TAKI_TAKI3_PERCENT) translated.TAKI_BRAIN_V4_PERCENT = translated.TAKI_TAKI3_PERCENT;
  if (translated.TAKI_TAKI3_SHADOW_PERCENT) translated.TAKI_BRAIN_V4_SHADOW_PERCENT = translated.TAKI_TAKI3_SHADOW_PERCENT;
  if (translated.TAKI_TAKI3_READY) translated.TAKI_BRAIN_V4_READY = translated.TAKI_TAKI3_READY;
  if (translated.TAKI_TAKI3_RELEASE_ID) translated.TAKI_BRAIN_V4_RELEASE_ID = translated.TAKI_TAKI3_RELEASE_ID;
  if (translated.TAKI_TAKI3_PROMOTION_EVIDENCE) translated.TAKI_BRAIN_V4_PROMOTION_EVIDENCE = translated.TAKI_TAKI3_PROMOTION_EVIDENCE;
  return translated;
}

export function normalizeTaki3RolloutMode(env: Record<string, string | undefined> = process.env): Taki3RolloutMode {
  return normalizeBrainV4RolloutMode(translatedEnvironment(env));
}

export function taki3PromotionStatus(env: Record<string, string | undefined> = process.env) {
  return brainV4PromotionStatus(translatedEnvironment(env));
}

export function taki3PromotionReady(env: Record<string, string | undefined> = process.env): boolean {
  return brainV4PromotionReady(translatedEnvironment(env));
}

export function taki3CanaryPercent(env: Record<string, string | undefined> = process.env): number {
  return brainV4CanaryPercent(translatedEnvironment(env));
}

export function taki3ShadowPercent(env: Record<string, string | undefined> = process.env): number {
  return brainV4ShadowPercent(translatedEnvironment(env));
}

export function shouldUseTaki3(
  state: Pick<ConversationState, "deviceId">,
  env: Record<string, string | undefined> = process.env
): boolean {
  return shouldUseBrainV4(state, translatedEnvironment(env));
}

export function shouldShadowTaki3(
  stateOrEnv: Pick<ConversationState, "deviceId"> | Record<string, string | undefined> = process.env,
  providedEnv?: Record<string, string | undefined>
): boolean {
  if (Object.prototype.hasOwnProperty.call(stateOrEnv, "TAKI_TAKI3_MODE")
    || Object.prototype.hasOwnProperty.call(stateOrEnv, "TAKI_BRAIN_V4_MODE")) {
    return shouldShadowBrainV4(translatedEnvironment(stateOrEnv as Record<string, string | undefined>));
  }
  return shouldShadowBrainV4(
    stateOrEnv as Pick<ConversationState, "deviceId">,
    providedEnv ? translatedEnvironment(providedEnv) : undefined
  );
}

export const classifyTaki3Request = classifyBrainV4Request;
export const runTaki3Plan = runBrainV4Plan;
export const runTaki3Shadow = runBrainV4Shadow;
export const taki3CanAttempt = brainV4CanAttempt;
export const taki3CircuitOpen = brainV4CircuitOpen;
export const noteTaki3Failure = noteBrainV4Failure;
export const noteTaki3Success = noteBrainV4Success;
export const taki3RolloutStats = brainV4RolloutStats;
export const resetTaki3RolloutStats = resetBrainV4RolloutStats;

/** Keep a stable function type for callers that inject deterministic fixtures. */
export async function runTaki3Answer(
  state: ConversationState,
  onStableVoiceText?: (text: string) => void | Promise<void>,
  deps?: Taki3Dependencies
): Promise<AssistantPlan | null> {
  return runTaki3Plan(state, onStableVoiceText, deps);
}
