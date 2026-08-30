/**
 * Machine-checkable promotion evidence for Brain v3.
 *
 * The rollout flag is intentionally not sufficient on its own. A promotion
 * token is produced only by the staging evaluator after the deterministic
 * suite, core provider corpus, auxiliary provider corpus, real-web case, and
 * rollback checks have passed. The token contains no prompts, model output,
 * account data, or provider credentials.
 */

export const BRAIN_V3_PROMOTION_EVIDENCE_FORMAT = "taki-brain-v3-promotion" as const;
export const BRAIN_V3_PROMOTION_EVIDENCE_VERSION = 1 as const;
export const BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const BRAIN_V3_PROMOTION_MIN_CORE_CASES = 38;
export const BRAIN_V3_PROMOTION_MIN_AUXILIARY_CASES = 18;
export const BRAIN_V3_PROMOTION_MIN_DETERMINISTIC_TESTS = 300;

export type BrainV3PromotionEvidence = {
  format: typeof BRAIN_V3_PROMOTION_EVIDENCE_FORMAT;
  version: typeof BRAIN_V3_PROMOTION_EVIDENCE_VERSION;
  releaseId: string;
  provider: "openai" | "gemini";
  model: string;
  core: { passed: true; total: number; failed: 0 };
  auxiliary: { passed: true; total: number; failed: 0 };
  realWeb: { passed: true };
  deterministic: {
    passed: true;
    typecheckPassed: true;
    testCount: number;
    failed: 0;
    cancelled: 0;
    skipped: 0;
  };
  rollback: { passed: true };
  noWrite: true;
  issuedAt: string;
  expiresAt: string;
};

export type BrainV3PromotionGateStatus = {
  ready: boolean;
  reason:
    | "ready"
    | "readiness_flag_missing"
    | "release_id_missing"
    | "evidence_missing"
    | "evidence_malformed"
    | "evidence_version_mismatch"
    | "release_mismatch"
    | "provider_mismatch"
    | "model_mismatch"
    | "core_gate_missing"
    | "auxiliary_gate_missing"
    | "real_web_gate_missing"
    | "deterministic_gate_missing"
    | "rollback_gate_missing"
    | "no_write_gate_missing"
    | "evidence_time_invalid"
    | "evidence_expired";
  releaseId: string | null;
  expiresAt: string | null;
};

type PromotionEnvironment = Record<string, string | undefined>;

function isTruthy(value: unknown): boolean {
  return /^(?:1|true|yes)$/i.test(String(value || "").trim());
}

function validReleaseId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{7,128}$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A promotion release must contain no tracked or untracked worktree changes. */
export function brainV3WorktreeClean(statusOutput: unknown): boolean {
  return !String(statusOutput || "").trim();
}

function passedSuite(value: unknown, minimumCases: number): boolean {
  const suite = asRecord(value);
  return suite?.passed === true
    && Number.isSafeInteger(suite.total)
    && Number(suite.total) >= minimumCases
    && suite.failed === 0;
}

function decodeEvidence(value: string): Record<string, unknown> | null {
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function encodeBrainV3PromotionEvidence(evidence: BrainV3PromotionEvidence): string {
  return Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url");
}

export function brainV3PromotionGateStatus(
  env: PromotionEnvironment = process.env,
  expectedProvider?: string,
  expectedModel?: string,
  now = Date.now()
): BrainV3PromotionGateStatus {
  const releaseId = String(env.TAKI_BRAIN_V3_RELEASE_ID || "").trim() || null;
  const token = String(env.TAKI_BRAIN_V3_PROMOTION_EVIDENCE || "").trim();
  const base = (reason: BrainV3PromotionGateStatus["reason"], evidence?: Record<string, unknown>): BrainV3PromotionGateStatus => ({
    ready: false,
    reason,
    releaseId,
    expiresAt: typeof evidence?.expiresAt === "string" ? evidence.expiresAt : null
  });

  if (!isTruthy(env.TAKI_BRAIN_V3_READY)) return base("readiness_flag_missing");
  if (!releaseId || !validReleaseId(releaseId)) return base("release_id_missing");
  if (!token) return base("evidence_missing");

  const evidence = decodeEvidence(token);
  if (!evidence) return base("evidence_malformed");
  if (evidence.format !== BRAIN_V3_PROMOTION_EVIDENCE_FORMAT || evidence.version !== BRAIN_V3_PROMOTION_EVIDENCE_VERSION) {
    return base("evidence_version_mismatch", evidence);
  }
  if (evidence.releaseId !== releaseId) return base("release_mismatch", evidence);
  if (expectedProvider && evidence.provider !== expectedProvider) return base("provider_mismatch", evidence);
  if (expectedModel && evidence.model !== expectedModel) return base("model_mismatch", evidence);
  if (!passedSuite(evidence.core, BRAIN_V3_PROMOTION_MIN_CORE_CASES)) return base("core_gate_missing", evidence);
  if (!passedSuite(evidence.auxiliary, BRAIN_V3_PROMOTION_MIN_AUXILIARY_CASES)) return base("auxiliary_gate_missing", evidence);
  if (asRecord(evidence.realWeb)?.passed !== true) return base("real_web_gate_missing", evidence);

  const deterministic = asRecord(evidence.deterministic);
  if (
    deterministic?.passed !== true
    || deterministic.typecheckPassed !== true
    || !Number.isSafeInteger(deterministic.testCount)
    || Number(deterministic.testCount) < BRAIN_V3_PROMOTION_MIN_DETERMINISTIC_TESTS
    || deterministic.failed !== 0
    || deterministic.cancelled !== 0
    || deterministic.skipped !== 0
  ) return base("deterministic_gate_missing", evidence);
  if (asRecord(evidence.rollback)?.passed !== true) return base("rollback_gate_missing", evidence);
  if (evidence.noWrite !== true) return base("no_write_gate_missing", evidence);

  const issuedAt = typeof evidence.issuedAt === "string" ? Date.parse(evidence.issuedAt) : NaN;
  const expiresAt = typeof evidence.expiresAt === "string" ? Date.parse(evidence.expiresAt) : NaN;
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > now + 5 * 60_000
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS + 60_000
  ) return base("evidence_time_invalid", evidence);
  if (expiresAt <= now) return base("evidence_expired", evidence);

  return {
    ready: true,
    reason: "ready",
    releaseId,
    expiresAt: evidence.expiresAt as string
  };
}
