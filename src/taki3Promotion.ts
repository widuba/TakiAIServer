/**
 * Machine-checkable promotion evidence for the Taki 3.0 conversational core.
 *
 * Taki 3.0 is deliberately a small, single-call answer path. That makes it
 * cheap to exercise in shadow mode, but it also means the rollout gate must be
 * explicit: a mode flag by itself cannot move untested provider/model traffic
 * onto customer requests.
 */

export const TAKI3_PROMOTION_EVIDENCE_FORMAT = "taki3-promotion" as const;
export const TAKI3_PROMOTION_EVIDENCE_VERSION = 1 as const;
export const TAKI3_PROMOTION_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const TAKI3_PROMOTION_MIN_DIRECT_CASES = 40;
export const TAKI3_PROMOTION_MIN_RESEARCH_CASES = 12;
export const TAKI3_PROMOTION_MIN_DETERMINISTIC_TESTS = 380;

export type Taki3PromotionEvidence = {
  format: typeof TAKI3_PROMOTION_EVIDENCE_FORMAT;
  version: typeof TAKI3_PROMOTION_EVIDENCE_VERSION;
  releaseId: string;
  provider: "openai" | "gemini";
  models: string[];
  direct: { passed: true; total: number; failed: 0 };
  research: { passed: true; total: number; failed: 0 };
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

export type Taki3PromotionGateStatus = {
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
    | "models_mismatch"
    | "direct_gate_missing"
    | "research_gate_missing"
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

function passedSuite(value: unknown, minimumCases: number): boolean {
  const suite = asRecord(value);
  return suite?.passed === true
    && Number.isSafeInteger(suite.total)
    && Number(suite.total) >= minimumCases
    && suite.failed === 0;
}

function normalizedModelList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const models = value.map((model) => typeof model === "string" ? model.trim() : "");
  if (models.some((model) => !model || model.length > 256)) return null;
  return new Set(models).size === models.length ? models : null;
}

function decodeEvidence(value: string): Record<string, unknown> | null {
  if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function encodeTaki3PromotionEvidence(evidence: Taki3PromotionEvidence): string {
  return Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url");
}

export function taki3PromotionGateStatus(
  env: PromotionEnvironment = process.env,
  expectedProvider?: string,
  expectedModels?: readonly string[],
  now = Date.now()
): Taki3PromotionGateStatus {
  const releaseId = String(env.TAKI_TAKI3_RELEASE_ID || "").trim() || null;
  const token = String(env.TAKI_TAKI3_PROMOTION_EVIDENCE || "").trim();
  const base = (
    reason: Taki3PromotionGateStatus["reason"],
    evidence?: Record<string, unknown>
  ): Taki3PromotionGateStatus => ({
    ready: false,
    reason,
    releaseId,
    expiresAt: typeof evidence?.expiresAt === "string" ? evidence.expiresAt : null
  });

  if (!isTruthy(env.TAKI_TAKI3_READY)) return base("readiness_flag_missing");
  if (!releaseId || !validReleaseId(releaseId)) return base("release_id_missing");
  if (!token) return base("evidence_missing");

  const evidence = decodeEvidence(token);
  if (!evidence) return base("evidence_malformed");
  if (evidence.format !== TAKI3_PROMOTION_EVIDENCE_FORMAT || evidence.version !== TAKI3_PROMOTION_EVIDENCE_VERSION) {
    return base("evidence_version_mismatch", evidence);
  }
  if (evidence.releaseId !== releaseId) return base("release_mismatch", evidence);
  if (evidence.provider !== "openai" && evidence.provider !== "gemini") return base("provider_mismatch", evidence);
  if (expectedProvider && evidence.provider !== expectedProvider) return base("provider_mismatch", evidence);

  const evidenceModels = normalizedModelList(evidence.models);
  const requiredModels = expectedModels ? normalizedModelList([...expectedModels]) : null;
  if (!evidenceModels) return base("models_mismatch", evidence);
  if (expectedModels && (
    !requiredModels
    || evidenceModels.length !== requiredModels.length
    || evidenceModels.some((model) => !requiredModels.includes(model))
  )) return base("models_mismatch", evidence);

  if (!passedSuite(evidence.direct, TAKI3_PROMOTION_MIN_DIRECT_CASES)) return base("direct_gate_missing", evidence);
  if (!passedSuite(evidence.research, TAKI3_PROMOTION_MIN_RESEARCH_CASES)) return base("research_gate_missing", evidence);

  const deterministic = asRecord(evidence.deterministic);
  if (
    deterministic?.passed !== true
    || deterministic.typecheckPassed !== true
    || !Number.isSafeInteger(deterministic.testCount)
    || Number(deterministic.testCount) < TAKI3_PROMOTION_MIN_DETERMINISTIC_TESTS
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
    || expiresAt - issuedAt > TAKI3_PROMOTION_EVIDENCE_TTL_MS + 60_000
  ) return base("evidence_time_invalid", evidence);
  if (expiresAt <= now) return base("evidence_expired", evidence);

  return {
    ready: true,
    reason: "ready",
    releaseId,
    expiresAt: evidence.expiresAt as string
  };
}
