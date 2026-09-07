import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  TAKI3_SPECIALIST_PROMOTION_EVIDENCE_TTL_MS,
  TAKI3_SPECIALIST_PROMOTION_EVIDENCE_VERSION,
  TAKI3_SPECIALIST_PROMOTION_MIN_CORE_CASES,
  taki3SpecialistPromotionGateStatus,
  taki3SpecialistWorktreeClean,
  encodeTaki3SpecialistPromotionEvidence,
  type Taki3SpecialistPromotionEvidence
} from "../src/taki3SpecialistPromotion.js";

const RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const PROVIDER = "openai";
const MODEL = "gpt-5.5";
const MODELS = [MODEL, "gpt-5.4-mini", "gpt-5.6-luna"];

function evidence(now = Date.now()): Taki3SpecialistPromotionEvidence {
  return {
    format: "taki3-specialist-promotion",
    version: TAKI3_SPECIALIST_PROMOTION_EVIDENCE_VERSION,
    releaseId: RELEASE_ID,
    provider: PROVIDER,
    model: MODEL,
    models: MODELS,
    core: { passed: true, total: TAKI3_SPECIALIST_PROMOTION_MIN_CORE_CASES, failed: 0 },
    auxiliary: { passed: true, total: 18, failed: 0 },
    realWeb: { passed: true },
    deterministic: {
      passed: true,
      typecheckPassed: true,
      testCount: 350,
      failed: 0,
      cancelled: 0,
      skipped: 0
    },
    rollback: { passed: true },
    noWrite: true,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + TAKI3_SPECIALIST_PROMOTION_EVIDENCE_TTL_MS - 1_000).toISOString()
  };
}

const CURRENT_EVIDENCE = evidence();
const execFileAsync = promisify(execFile);

async function runTaki3SpecialistEvaluator(env: Record<string, string>): Promise<{ code: number; output: string }> {
  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    TAKI_ENV: "",
    APP_ENV: "",
    AI_PROVIDER: "gemini",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    TAKI_TAKI3_SPECIALIST_EVAL_CONFIRM: "",
    TAKI_TAKI3_SPECIALIST_STAGING_PROVIDER: "",
    TAKI_TAKI3_SPECIALIST_STAGING_API_KEY: "",
    ...env
  };
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/taki3SpecialistEval.ts"], {
      cwd: process.cwd(),
      env: childEnv,
      timeout: 15_000,
      maxBuffer: 1_000_000
    });
    return { code: 0, output: `${result.stdout || ""}\n${result.stderr || ""}` };
  } catch (error: any) {
    return {
      code: Number(error?.code) || 1,
      output: `${error?.stdout || ""}\n${error?.stderr || ""}`
    };
  }
}

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    TAKI_TAKI3_SPECIALIST_READY: "1",
    TAKI_TAKI3_SPECIALIST_RELEASE_ID: RELEASE_ID,
    TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence(CURRENT_EVIDENCE),
    ...overrides
  };
}

test("Taki 3.0 specialist promotion worktree checks include tracked and untracked changes", () => {
  assert.equal(taki3SpecialistWorktreeClean(""), true);
  assert.equal(taki3SpecialistWorktreeClean(" M src/taki3Specialist.ts\n"), false);
  assert.equal(taki3SpecialistWorktreeClean("?? local-staging-notes.txt\n"), false);
});

test("Taki 3.0 specialist evaluator requires explicit staging or maintenance key use", async () => {
  const missingConfirmation = await runTaki3SpecialistEvaluator({
    TAKI_TAKI3_SPECIALIST_STAGING_PROVIDER: "openai",
    TAKI_TAKI3_SPECIALIST_STAGING_API_KEY: "staging-only"
  });
  assert.equal(missingConfirmation.code, 2);
  assert.match(missingConfirmation.output, /staging|maintenance/);

  const productionMarker = await runTaki3SpecialistEvaluator({
    NODE_ENV: "production",
    TAKI_TAKI3_SPECIALIST_EVAL_CONFIRM: "staging",
    TAKI_TAKI3_SPECIALIST_STAGING_PROVIDER: "openai",
    TAKI_TAKI3_SPECIALIST_STAGING_API_KEY: "staging-only"
  });
  assert.equal(productionMarker.code, 2);
  assert.match(productionMarker.output, /production environment marker/);

  const missingCredential = await runTaki3SpecialistEvaluator({
    TAKI_TAKI3_SPECIALIST_EVAL_CONFIRM: "staging",
    TAKI_TAKI3_SPECIALIST_STAGING_PROVIDER: "openai"
  });
  assert.equal(missingCredential.code, 2);
  assert.match(missingCredential.output, /STAGING_API_KEY/);

  const reusedCredential = await runTaki3SpecialistEvaluator({
    OPENAI_API_KEY: "generic-key",
    TAKI_TAKI3_SPECIALIST_EVAL_CONFIRM: "staging",
    TAKI_TAKI3_SPECIALIST_STAGING_PROVIDER: "openai",
    TAKI_TAKI3_SPECIALIST_STAGING_API_KEY: "generic-key"
  });
  assert.equal(reusedCredential.code, 2);
  assert.match(reusedCredential.output, /distinct from the inherited generic provider key/);
});

test("Taki 3.0 specialist cannot promote from a readiness flag alone", () => {
  const status = taki3SpecialistPromotionGateStatus({
    TAKI_TAKI3_SPECIALIST_READY: "1",
    TAKI_TAKI3_SPECIALIST_RELEASE_ID: RELEASE_ID
  }, PROVIDER, MODEL);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "evidence_missing");
});

test("Taki 3.0 specialist accepts only complete, current, release-bound promotion evidence", () => {
  const status = taki3SpecialistPromotionGateStatus(environment(), PROVIDER, MODEL, Date.now(), MODELS);
  assert.deepEqual(status, {
    ready: true,
    reason: "ready",
    releaseId: RELEASE_ID,
    expiresAt: CURRENT_EVIDENCE.expiresAt
  });
});

test("Taki 3.0 specialist promotion evidence rejects release, provider, model, and expiry drift", () => {
  const now = Date.now();
  assert.equal(taki3SpecialistPromotionGateStatus(environment({ TAKI_TAKI3_SPECIALIST_RELEASE_ID: "fedcba9876543210fedcba9876543210fedcba98" }), PROVIDER, MODEL, now).reason, "release_mismatch");
  assert.equal(taki3SpecialistPromotionGateStatus(environment({ TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence({ ...evidence(now), provider: "gemini" }) }), PROVIDER, MODEL, now).reason, "provider_mismatch");
  assert.equal(taki3SpecialistPromotionGateStatus(environment({ TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence({ ...evidence(now), model: "gpt-5.4-mini" }) }), PROVIDER, MODEL, now).reason, "model_mismatch");
  const expired = evidence(now - TAKI3_SPECIALIST_PROMOTION_EVIDENCE_TTL_MS - 10_000);
  assert.equal(taki3SpecialistPromotionGateStatus(environment({ TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence(expired) }), PROVIDER, MODEL, now).reason, "evidence_expired");
});

test("Taki 3.0 specialist promotion evidence rejects an untested response model set", () => {
  const status = taki3SpecialistPromotionGateStatus(environment({
    TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence({
      ...evidence(),
      models: [MODEL, "gpt-5.4-mini"]
    })
  }), PROVIDER, MODEL, Date.now(), MODELS);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "models_mismatch");
});

test("Taki 3.0 specialist promotion evidence rejects an incomplete gate", () => {
  const incomplete = {
    ...evidence(),
    auxiliary: { passed: true as const, total: 17, failed: 0 as const }
  };
  const status = taki3SpecialistPromotionGateStatus(environment({
    TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence(incomplete)
  }), PROVIDER, MODEL);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "auxiliary_gate_missing");
});
