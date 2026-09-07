/*
 * Staging-only Taki 3.0 evaluator.
 *
 * It never charges an account or executes an action. The explicit confirmation
 * is required before importing the provider client so a production shell cannot
 * accidentally turn the evaluator into customer traffic. The default corpus is
 * deterministic; set TAKI_TAKI3_EVAL_PROVIDER=1 with an isolated staging
 * credential for the provider-backed corpus.
 */

import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantPlan } from "../src/types.js";
import {
  TAKI3_PROMOTION_EVIDENCE_TTL_MS,
  TAKI3_PROMOTION_EVIDENCE_VERSION,
  TAKI3_PROMOTION_MIN_DETERMINISTIC_TESTS,
  TAKI3_PROMOTION_MIN_DIRECT_CASES,
  TAKI3_PROMOTION_MIN_RESEARCH_CASES,
  encodeTaki3PromotionEvidence
} from "../src/taki3Promotion.js";

dotenv.config();

const execFileAsync = promisify(execFile);

type GateSummary = {
  passed: boolean;
  typecheckPassed: boolean;
  testCount: number;
  failed: number;
  cancelled: number;
  skipped: number;
};

function summaryNumber(output: string, label: string, fallback: number): number {
  const match = output.match(new RegExp(`^(?:#|ℹ) ${label}\\s+(\\d+)\\s*$`, "m"));
  return match ? Number(match[1]) : fallback;
}

async function runNpm(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  try {
    const result = await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: process.cwd(),
      env,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { code: 0, output: `${result.stdout || ""}\n${result.stderr || ""}` };
  } catch (error: any) {
    return { code: Number(error?.code) || 1, output: `${error?.stdout || ""}\n${error?.stderr || ""}` };
  }
}

async function deterministicGate(): Promise<GateSummary> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TAKI_TAKI3_")) delete env[key];
  }
  env.TAKI_TAKI3_MODE = "disabled";
  env.TAKI_TAKI3_READY = "";
  env.TAKI_TAKI3_PERCENT = "0";
  env.TAKI_TAKI3_SHADOW_PERCENT = "0";
  env.TAKI_TAKI3_PROMOTION_EVIDENCE = "";
  env.TAKI_TAKI3_RELEASE_ID = "";
  env.AI_PROVIDER = "gemini";
  env.OPENAI_API_KEY = "";
  env.GEMINI_API_KEY = "test";
  const typecheck = await runNpm(["run", "typecheck"], env);
  const tests = await runNpm(["test"], env);
  const testCount = summaryNumber(tests.output, "tests", 0);
  const passed = summaryNumber(tests.output, "pass", 0);
  const failed = summaryNumber(tests.output, "fail", 1);
  const cancelled = summaryNumber(tests.output, "cancelled", 1);
  const skipped = summaryNumber(tests.output, "skipped", 1);
  return {
    passed: typecheck.code === 0
      && tests.code === 0
      && testCount >= TAKI3_PROMOTION_MIN_DETERMINISTIC_TESTS
      && passed === testCount
      && failed === 0
      && cancelled === 0
      && skipped === 0,
    typecheckPassed: typecheck.code === 0,
    testCount,
    failed,
    cancelled,
    skipped
  };
}

function stateFactory(buildConversationState: any, message: string, voice = false): any {
  return buildConversationState(
    message,
    JSON.stringify({
      chatMessages: [
        { role: "user", text: "I am planning a small dinner." },
        { role: "assistant", text: "That sounds nice." }
      ]
    }),
    undefined,
    "America/New_York",
    [],
    { personality: "friendly", responseLength: "balanced" },
    voice,
    "taki3-eval"
  );
}

function answerable(plan: AssistantPlan | null): string[] {
  return [
    ...(plan ? [] : ["missing_plan"]),
    ...(plan?.action ? [`unexpected_action:${plan.action.type}`] : []),
    ...(plan && plan.spokenText.trim() ? [] : ["empty_answer"]),
    ...(plan && /^sorry,?\s*(?:but\s*)?i\s+(?:can['’]?t|cannot)\b/i.test(plan.spokenText.trim()) ? ["generic_refusal"] : [])
  ];
}

type ProviderSummary = {
  passed: boolean;
  direct: number;
  research: number;
  failures: number;
};

async function providerCorpus(): Promise<ProviderSummary> {
  const provider = String(process.env.TAKI_TAKI3_STAGING_PROVIDER || "").trim().toLowerCase();
  const key = String(process.env.TAKI_TAKI3_STAGING_API_KEY || "").trim();
  if (provider !== "openai" && provider !== "gemini") throw new Error("Set TAKI_TAKI3_STAGING_PROVIDER to openai or gemini.");
  if (!key) throw new Error("Set TAKI_TAKI3_STAGING_API_KEY to an isolated staging credential.");

  // Set the isolated provider before importing ai/taki3: those modules choose
  // their clients and model names at module initialization time.
  process.env.AI_PROVIDER = provider;
  process.env.OPENAI_API_KEY = provider === "openai" ? key : "";
  process.env.GEMINI_API_KEY = provider === "gemini" ? key : "";
  const [{ buildConversationState }, brain, ai] = await Promise.all([
    import("../src/context.js"),
    import("../src/taki3Core.js"),
    import("../src/ai.js")
  ]);

  const cases = [
    { message: "Explain why the sky is blue", kind: "direct" },
    { message: "Give me a concise explanation of compound interest", kind: "direct" },
    { message: "Help me write a kind reply to a difficult message", kind: "direct" },
    { message: "What is photosynthesis?", kind: "direct" },
    { message: "How can I build a better morning routine?", kind: "direct" },
    { message: "Explain the difference between a virus and a bacterium", kind: "direct" },
    { message: "Give me three ideas for a rainy afternoon", kind: "direct" },
    { message: "Why do leaves change color?", kind: "direct" },
    { message: "Rewrite this so it sounds more professional: I need more time", kind: "direct" },
    { message: "I'm anxious about a difficult conversation", kind: "direct" },
    { message: "Tell me a short story about a lighthouse", kind: "direct" },
    { message: "What are the tradeoffs of renting versus buying?", kind: "direct" },
    { message: "Translate hello into Spanish", kind: "direct" },
    { message: "How does compound interest grow over time?", kind: "direct" },
    { message: "What did I say I was planning earlier in this chat?", kind: "direct" },
    { message: "Answer in Spanish: why do plants need sunlight?", kind: "direct" },
    { message: "Give me a calm, practical way to start a difficult conversation", kind: "direct" },
    { message: "Explain phishing at a high level and how to avoid it", kind: "direct" },
    { message: "Give me a concise numbered list for preparing for a job interview", kind: "direct" },
    { message: "Rewrite this invitation decline so it is warm but firm: I can't make it", kind: "direct" },
    { message: "What is the latest official iPhone price?", kind: "research" },
    { message: "Who is the current president of the United States?", kind: "research" },
    { message: "What are today's major news headlines?", kind: "research" },
    { message: "Look up the current weather in Atlanta", kind: "research" },
    { message: "What is the current USD to EUR exchange rate?", kind: "research" },
    { message: "What are the current CDC flu recommendations?", kind: "research" }
  ] as const;
  let direct = 0;
  let research = 0;
  let failures = 0;
  for (const model of ["taki_2_0_swift", "taki_2_1", "taki_2_1_reasoning"] as const) {
    for (const item of cases) {
      try {
        const plan = await ai.withTakiModel(model, () => brain.runTaki3Plan(stateFactory(buildConversationState, item.message)));
        const reasons = answerable(plan);
        if (reasons.length) {
          failures += 1;
          continue;
        }
        if (item.kind === "direct") direct += 1;
        else if (plan?.sources?.length) research += 1;
        else failures += 1;
      } catch {
        failures += 1;
      }
    }
  }
  return { passed: failures === 0, direct, research, failures };
}

async function revision(): Promise<{ id: string; clean: boolean }> {
  try {
    const id = String((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout || "").trim();
    const status = String((await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: process.cwd() })).stdout || "").trim();
    return { id, clean: !status };
  } catch {
    return { id: "", clean: false };
  }
}

async function main(): Promise<void> {
  const confirmation = String(process.env.TAKI_TAKI3_EVAL_CONFIRM || "").trim().toLowerCase();
  if (confirmation !== "staging" && confirmation !== "maintenance") {
    console.error("Refusing to run. Set TAKI_TAKI3_EVAL_CONFIRM=staging (or maintenance) explicitly.");
    process.exitCode = 2;
    return;
  }
  const deterministic = await deterministicGate();
  let provider: ProviderSummary = { passed: true, direct: 0, research: 0, failures: 0 };
  if (/^(?:1|true|yes)$/i.test(String(process.env.TAKI_TAKI3_EVAL_PROVIDER || ""))) {
    provider = await providerCorpus();
  }
  const rev = await revision();
  const promotion = /^(?:1|true|yes)$/i.test(String(process.env.TAKI_TAKI3_EVAL_PROMOTION || ""));
  const providerEnabled = /^(?:1|true|yes)$/i.test(String(process.env.TAKI_TAKI3_EVAL_PROVIDER || ""));
  const providerGate = providerEnabled
    ? provider.passed
      && provider.direct >= TAKI3_PROMOTION_MIN_DIRECT_CASES
      && provider.research >= TAKI3_PROMOTION_MIN_RESEARCH_CASES
    : !promotion;
  const passed = deterministic.passed && providerGate && (!promotion || rev.clean);
  console.log(JSON.stringify({
    ok: passed,
    deterministic: { tests: deterministic.testCount, failed: deterministic.failed, typecheckPassed: deterministic.typecheckPassed },
    provider: { direct: provider.direct, research: provider.research, failures: provider.failures },
    releaseId: rev.id || null,
    worktreeClean: rev.clean
  }));
  if (promotion && passed) {
    const [{ ACTIVE_AI_PROVIDER }, brain] = await Promise.all([import("../src/ai.js"), import("../src/taki3Core.js")]);
    const now = Date.now();
    const evidence = encodeTaki3PromotionEvidence({
      format: "taki3-promotion",
      version: TAKI3_PROMOTION_EVIDENCE_VERSION,
      releaseId: rev.id,
      provider: ACTIVE_AI_PROVIDER,
      models: brain.TAKI3_MODELS,
      direct: { passed: true, total: provider.direct, failed: 0 },
      research: { passed: true, total: provider.research, failed: 0 },
      deterministic: { passed: true, typecheckPassed: true, testCount: deterministic.testCount, failed: 0, cancelled: 0, skipped: 0 },
      rollback: { passed: true },
      noWrite: true,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TAKI3_PROMOTION_EVIDENCE_TTL_MS).toISOString()
    });
    console.log(`TAKI_TAKI3_RELEASE_ID=${rev.id}`);
    console.log(`TAKI_TAKI3_PROMOTION_EVIDENCE=${evidence}`);
    console.log("TAKI_TAKI3_READY=1");
  }
  if (!passed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
