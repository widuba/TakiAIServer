import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS,
  brainV3PromotionGateStatus,
  brainV3WorktreeClean,
  encodeBrainV3PromotionEvidence,
  type BrainV3PromotionEvidence
} from "../src/brainV3Promotion.js";

const RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const PROVIDER = "openai";
const MODEL = "gpt-5.5";

function evidence(now = Date.now()): BrainV3PromotionEvidence {
  return {
    format: "taki-brain-v3-promotion",
    version: 1,
    releaseId: RELEASE_ID,
    provider: PROVIDER,
    model: MODEL,
    core: { passed: true, total: 32, failed: 0 },
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
    expiresAt: new Date(now + BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS - 1_000).toISOString()
  };
}

const CURRENT_EVIDENCE = evidence();
const execFileAsync = promisify(execFile);

async function runBrainV3Evaluator(env: Record<string, string>): Promise<{ code: number; output: string }> {
  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    TAKI_ENV: "",
    APP_ENV: "",
    AI_PROVIDER: "gemini",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    TAKI_BRAIN_V3_EVAL_CONFIRM: "",
    TAKI_BRAIN_V3_STAGING_PROVIDER: "",
    TAKI_BRAIN_V3_STAGING_API_KEY: "",
    ...env
  };
  try {
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/brainV3Eval.ts"], {
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
    TAKI_BRAIN_V3_READY: "1",
    TAKI_BRAIN_V3_RELEASE_ID: RELEASE_ID,
    TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence(CURRENT_EVIDENCE),
    ...overrides
  };
}

test("Brain v3 promotion worktree checks include tracked and untracked changes", () => {
  assert.equal(brainV3WorktreeClean(""), true);
  assert.equal(brainV3WorktreeClean(" M src/brainV3.ts\n"), false);
  assert.equal(brainV3WorktreeClean("?? local-staging-notes.txt\n"), false);
});

test("Brain v3 evaluator is staging-only and never reuses a generic key", async () => {
  const missingConfirmation = await runBrainV3Evaluator({
    TAKI_BRAIN_V3_STAGING_PROVIDER: "openai",
    TAKI_BRAIN_V3_STAGING_API_KEY: "staging-only"
  });
  assert.equal(missingConfirmation.code, 2);
  assert.match(missingConfirmation.output, /staging-only/);

  const productionMarker = await runBrainV3Evaluator({
    NODE_ENV: "production",
    TAKI_BRAIN_V3_EVAL_CONFIRM: "staging",
    TAKI_BRAIN_V3_STAGING_PROVIDER: "openai",
    TAKI_BRAIN_V3_STAGING_API_KEY: "staging-only"
  });
  assert.equal(productionMarker.code, 2);
  assert.match(productionMarker.output, /production environment marker/);

  const missingCredential = await runBrainV3Evaluator({
    TAKI_BRAIN_V3_EVAL_CONFIRM: "staging",
    TAKI_BRAIN_V3_STAGING_PROVIDER: "openai"
  });
  assert.equal(missingCredential.code, 2);
  assert.match(missingCredential.output, /STAGING_API_KEY/);

  const reusedCredential = await runBrainV3Evaluator({
    OPENAI_API_KEY: "generic-key",
    TAKI_BRAIN_V3_EVAL_CONFIRM: "staging",
    TAKI_BRAIN_V3_STAGING_PROVIDER: "openai",
    TAKI_BRAIN_V3_STAGING_API_KEY: "generic-key"
  });
  assert.equal(reusedCredential.code, 2);
  assert.match(reusedCredential.output, /distinct from the inherited generic provider key/);
});

test("Brain v3 cannot promote from a readiness flag alone", () => {
  const status = brainV3PromotionGateStatus({
    TAKI_BRAIN_V3_READY: "1",
    TAKI_BRAIN_V3_RELEASE_ID: RELEASE_ID
  }, PROVIDER, MODEL);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "evidence_missing");
});

test("Brain v3 accepts only complete, current, release-bound promotion evidence", () => {
  const status = brainV3PromotionGateStatus(environment(), PROVIDER, MODEL);
  assert.deepEqual(status, {
    ready: true,
    reason: "ready",
    releaseId: RELEASE_ID,
    expiresAt: CURRENT_EVIDENCE.expiresAt
  });
});

test("Brain v3 promotion evidence rejects release, provider, model, and expiry drift", () => {
  const now = Date.now();
  assert.equal(brainV3PromotionGateStatus(environment({ TAKI_BRAIN_V3_RELEASE_ID: "fedcba9876543210fedcba9876543210fedcba98" }), PROVIDER, MODEL, now).reason, "release_mismatch");
  assert.equal(brainV3PromotionGateStatus(environment({ TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence({ ...evidence(now), provider: "gemini" }) }), PROVIDER, MODEL, now).reason, "provider_mismatch");
  assert.equal(brainV3PromotionGateStatus(environment({ TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence({ ...evidence(now), model: "gpt-5.4-mini" }) }), PROVIDER, MODEL, now).reason, "model_mismatch");
  const expired = evidence(now - BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS - 10_000);
  assert.equal(brainV3PromotionGateStatus(environment({ TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence(expired) }), PROVIDER, MODEL, now).reason, "evidence_expired");
});

test("Brain v3 promotion evidence rejects an incomplete gate", () => {
  const incomplete = {
    ...evidence(),
    auxiliary: { passed: true as const, total: 17, failed: 0 as const }
  };
  const status = brainV3PromotionGateStatus(environment({
    TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence(incomplete)
  }), PROVIDER, MODEL);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "auxiliary_gate_missing");
});
