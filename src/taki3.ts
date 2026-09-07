import type { AssistantPlan, ConversationState } from "./types.js";
import {
  TAKI3_ANSWER_SCHEMA,
  TAKI3_MODELS,
  classifyTaki3Request as classifyCoreTaki3Request,
  normalizeTaki3RolloutMode as normalizeCoreTaki3RolloutMode,
  runTaki3Plan as runCoreTaki3Plan,
  runTaki3Shadow as runCoreTaki3Shadow,
  shouldUseTaki3 as shouldUseCoreTaki3,
  shouldShadowTaki3 as shouldShadowCoreTaki3,
  taki3CanAttempt,
  taki3CanaryPercent as coreTaki3CanaryPercent,
  taki3CircuitOpen,
  taki3PromotionReady as coreTaki3PromotionReady,
  taki3PromotionStatus as coreTaki3PromotionStatus,
  taki3RolloutStats as coreTaki3RolloutStats,
  taki3ShadowPercent as coreTaki3ShadowPercent,
  noteTaki3Failure as coreNoteTaki3Failure,
  noteTaki3Success as coreNoteTaki3Success,
  resetTaki3RolloutStats as coreResetTaki3RolloutStats,
  type Taki3Classification as CoreTaki3Classification,
  type Taki3Dependencies as CoreTaki3Dependencies,
  type Taki3RequestClass as CoreTaki3RequestClass,
  type Taki3RolloutMode as CoreTaki3RolloutMode,
  type Taki3RolloutStats as CoreTaki3RolloutStats
} from "./taki3Core.js";

/**
 * Stable customer-facing facade for Taki 3.0. The planner and health endpoint
 * import this module so implementation names and rollout details stay behind
 * one product boundary.
 */
export const TAKI3_VERSION = "3.0" as const;
export { TAKI3_ANSWER_SCHEMA, TAKI3_MODELS };

export type Taki3RolloutMode = CoreTaki3RolloutMode;
export type Taki3RequestClass = CoreTaki3RequestClass;
export type Taki3Classification = CoreTaki3Classification;
export type Taki3RolloutStats = CoreTaki3RolloutStats;
export type Taki3Dependencies = CoreTaki3Dependencies;

export const normalizeTaki3RolloutMode = normalizeCoreTaki3RolloutMode;
export const taki3PromotionStatus = coreTaki3PromotionStatus;
export const taki3PromotionReady = coreTaki3PromotionReady;
export const taki3CanaryPercent = coreTaki3CanaryPercent;
export const taki3ShadowPercent = coreTaki3ShadowPercent;
export const shouldUseTaki3 = shouldUseCoreTaki3;
export const shouldShadowTaki3 = shouldShadowCoreTaki3;
export const classifyTaki3Request = classifyCoreTaki3Request;
export const runTaki3Plan = runCoreTaki3Plan;
export const runTaki3Shadow = runCoreTaki3Shadow;

/** Keep a stable function type for callers that inject deterministic fixtures. */
export async function runTaki3Answer(
  state: ConversationState,
  onStableVoiceText?: (text: string) => void | Promise<void>,
  deps?: Taki3Dependencies
): Promise<AssistantPlan | null> {
  return runCoreTaki3Plan(state, onStableVoiceText, deps);
}

export {
  taki3CanAttempt,
  taki3CircuitOpen,
  coreNoteTaki3Failure as noteTaki3Failure,
  coreNoteTaki3Success as noteTaki3Success,
  coreTaki3RolloutStats as taki3RolloutStats,
  coreResetTaki3RolloutStats as resetTaki3RolloutStats
};
