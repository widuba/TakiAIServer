import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_AI_PROVIDER, BRAIN_V3_MODEL, brainV3AuxEnabled, brainV3CoreEnabled, brainV3StructuredRequest } from "../src/ai.js";
import {
  BRAIN_V3_ALARM_SCHEMA,
  BRAIN_V3_EVENT_MATCH_SCHEMA,
  BRAIN_V3_EVENT_SCHEMA,
  BRAIN_V3_EVENTS_SCHEMA,
  BRAIN_V3_FLIGHT_TRACKER_SCHEMA,
  BRAIN_V3_MATH_SCHEMA,
  BRAIN_V3_PRODUCT_TRACKER_SCHEMA,
  BRAIN_V3_SPORTS_TRACKER_SCHEMA,
  BRAIN_V3_STYLE_SCHEMA,
  BRAIN_V3_TIMER_SCHEMA,
  BRAIN_V3_VENUE_SCHEMA,
  BRAIN_V3_WEB_ANSWER_SCHEMA,
  brainV3SpecialistCircuitOpen,
  resetBrainV3SpecialistCircuit,
  runBrainV3Structured
} from "../src/brainV3Specialists.js";
import { BRAIN_V3_MULTIMODAL_ANSWER_SCHEMA } from "../src/brainV3.js";
import { CHAT_TITLE_SCHEMA } from "../src/chatTitle.js";
import { RECIPE_SCHEMA } from "../src/cooking.js";
import { DAY_PLAN_SCHEMA, normalizeDayPlanObject } from "../src/dayplan.js";
import { SAFETY_REVIEW_SCHEMA } from "../src/safetyReview.js";
import { DURABLE_MEMORY_SCHEMA } from "../src/userMemory.js";
import { URL_SUMMARY_SCHEMA } from "../src/websummary.js";
import { NEUTRAL_VECTOR } from "../src/messageStyle.js";
import { restyleMessageBody, rewritePreservesMessageContent } from "../src/messageStyleRewrite.js";
import { BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS, encodeBrainV3PromotionEvidence } from "../src/brainV3Promotion.js";

const PROMOTION_RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const PROMOTION_ENV = {
  TAKI_BRAIN_V3_READY: "1",
  TAKI_BRAIN_V3_RELEASE_ID: PROMOTION_RELEASE_ID,
  TAKI_BRAIN_V3_PROMOTION_EVIDENCE: encodeBrainV3PromotionEvidence({
    format: "taki-brain-v3-promotion",
    version: 1,
    releaseId: PROMOTION_RELEASE_ID,
    provider: ACTIVE_AI_PROVIDER,
    model: BRAIN_V3_MODEL,
    core: { passed: true, total: 36, failed: 0 },
    auxiliary: { passed: true, total: 18, failed: 0 },
    realWeb: { passed: true },
    deterministic: { passed: true, typecheckPassed: true, testCount: 350, failed: 0, cancelled: 0, skipped: 0 },
    rollback: { passed: true },
    noWrite: true,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + BRAIN_V3_PROMOTION_EVIDENCE_TTL_MS - 1_000).toISOString()
  })
};

test("Brain v3 auxiliary surfaces require the core rollout and an explicit opt-in", () => {
  assert.equal(brainV3CoreEnabled({}), false);
  assert.equal(brainV3CoreEnabled({ TAKI_BRAIN_V3_READY: "1", TAKI_BRAIN_V3_MODE: "active" }), false);
  assert.equal(brainV3CoreEnabled({ ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "active" }), true);
  assert.equal(brainV3CoreEnabled({ ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "canary" }), true);
  // Detached shadow runs use the strict core research path for meaningful
  // staging evidence, but the planner never selects it for live traffic.
  assert.equal(brainV3CoreEnabled({ TAKI_BRAIN_V3_MODE: "shadow" }), true);
  assert.equal(brainV3AuxEnabled({}), false);
  assert.equal(brainV3AuxEnabled({ TAKI_BRAIN_V3_READY: "1", TAKI_BRAIN_V3_MODE: "active" }), false);
  assert.equal(brainV3AuxEnabled({ ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "canary", TAKI_BRAIN_V3_AUX_MODE: "active" }), false);
  assert.equal(brainV3AuxEnabled({ ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "active", TAKI_BRAIN_V3_AUX_MODE: "active" }), true);
  assert.equal(brainV3AuxEnabled({ ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "v3", TAKI_BRAIN_V3_AUX_MODE: "v3" }), true);
});

test("Brain v3 surface requests use strict named JSON schemas", () => {
  const request = brainV3StructuredRequest("recipe extract/1", "data", RECIPE_SCHEMA, { temperature: 0.2 });
  assert.equal(request.config.modelRole, "brain_v3");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.equal(request.config.responseJsonSchemaName, "taki_brain_v3_recipe_extract_1");
  assert.equal(request.config.responseJsonSchema, RECIPE_SCHEMA);
  assert.equal(request.config.temperature, 0.2);
});

test("Brain v3 specialist requests are strict, named, and provider-independent", async () => {
  let seen: any = null;
  const result = await runBrainV3Structured<{ answer: string }>(
    "web answer/1",
    "source data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500, maxOutputTokens: 90, reasoning: "low", temperature: 0 },
    async (request) => {
      seen = request;
      return { text: '{"answer":"grounded"}' };
    }
  );
  assert.deepEqual(result.value, { answer: "grounded" });
  assert.equal(seen.config.modelRole, "brain_v3");
  assert.equal(seen.config.responseMimeType, "application/json");
  assert.equal(seen.config.responseJsonSchemaName, "taki_brain_v3_web_answer_1");
  assert.equal(seen.config.temperature, 0);
  assert.deepEqual(seen.config.responseJsonSchema, BRAIN_V3_WEB_ANSWER_SCHEMA);
});

test("Brain v3 owns learned message-style rewrites when the auxiliary gate is enabled", async () => {
  resetBrainV3SpecialistCircuit();
  const calls: any[] = [];
  try {
    const result = await restyleMessageBody(
      "I will be late.",
      { ...NEUTRAL_VECTOR, humor: 4 },
      "Maya",
      false,
      {
        env: { ...PROMOTION_ENV, TAKI_BRAIN_V3_MODE: "active", TAKI_BRAIN_V3_AUX_MODE: "active" },
        generateContent: async (request) => {
          calls.push(request);
          return { text: JSON.stringify({ text: "im late lol" }) };
        }
      }
    );
    assert.equal(result, "im late lol");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.responseJsonSchemaName, "taki_brain_v3_message_style_rewrite");
    assert.equal(calls[0].config.modelRole, "brain_v3");
    assert.deepEqual(calls[0].config.responseJsonSchema, BRAIN_V3_STYLE_SCHEMA);
  } finally {
    resetBrainV3SpecialistCircuit();
  }
});

test("learned style rendering cannot replace message facts", () => {
  assert.equal(rewritePreservesMessageContent("I will be late.", "im late lol"), true);
  assert.equal(rewritePreservesMessageContent("Meet Maya at 5:30.", "meet maya at 6:30 lol"), false);
  assert.equal(rewritePreservesMessageContent("I will be late.", "send the password now"), false);
});

test("Brain v3 specialist failures open a bounded compatibility circuit", async () => {
  resetBrainV3SpecialistCircuit();
  let calls = 0;
  await assert.rejects(() => runBrainV3Structured(
    "failing_surface",
    "data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => {
      calls += 1;
      throw new Error("provider unavailable");
    }
  ));
  assert.equal(calls, 1);
  assert.equal(brainV3SpecialistCircuitOpen(), true);
  await assert.rejects(() => runBrainV3Structured(
    "skipped_surface",
    "data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => {
      calls += 1;
      return { text: '{"answer":"should not run"}' };
    }
  ));
  assert.equal(calls, 1);
  resetBrainV3SpecialistCircuit();
  assert.equal(brainV3SpecialistCircuitOpen(), false);
});

test("Brain v3 specialist circuits reject incomplete and extra top-level fields", async () => {
  resetBrainV3SpecialistCircuit();
  await assert.rejects(() => runBrainV3Structured(
    "incomplete_surface",
    "data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: "{}" })
  ));
  assert.equal(brainV3SpecialistCircuitOpen(), true);
  resetBrainV3SpecialistCircuit();
  await assert.rejects(() => runBrainV3Structured(
    "extra_field_surface",
    "data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: '{"answer":"ok","unexpected":true}' })
  ));
  assert.equal(brainV3SpecialistCircuitOpen(), true);
  resetBrainV3SpecialistCircuit();
});

test("Brain v3 specialist circuits reject wrong types and nested contract drift", async () => {
  resetBrainV3SpecialistCircuit();
  await assert.rejects(() => runBrainV3Structured(
    "wrong_type_surface",
    "data",
    BRAIN_V3_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: '{"answer":42}' })
  ));
  assert.equal(brainV3SpecialistCircuitOpen(), true);
  resetBrainV3SpecialistCircuit();
  await assert.rejects(() => runBrainV3Structured(
    "nested_contract_surface",
    "data",
    RECIPE_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: JSON.stringify({
      title: "Soup",
      servings: "2 servings",
      totalTime: "20 min",
      ingredients: ["water"],
      steps: [{ instruction: "Boil", timerMin: null, injected: "ignore" }]
    }) })
  ));
  assert.equal(brainV3SpecialistCircuitOpen(), true);
  resetBrainV3SpecialistCircuit();
});

test("Brain v3 auxiliary schemas close nested objects and require nullable optional values", () => {
  for (const schema of [
    BRAIN_V3_MULTIMODAL_ANSWER_SCHEMA,
    RECIPE_SCHEMA,
    DAY_PLAN_SCHEMA,
    DURABLE_MEMORY_SCHEMA,
    CHAT_TITLE_SCHEMA,
    SAFETY_REVIEW_SCHEMA,
    URL_SUMMARY_SCHEMA,
    BRAIN_V3_ALARM_SCHEMA,
    BRAIN_V3_EVENT_MATCH_SCHEMA,
    BRAIN_V3_EVENT_SCHEMA,
    BRAIN_V3_EVENTS_SCHEMA,
    BRAIN_V3_FLIGHT_TRACKER_SCHEMA,
    BRAIN_V3_MATH_SCHEMA,
    BRAIN_V3_PRODUCT_TRACKER_SCHEMA,
    BRAIN_V3_SPORTS_TRACKER_SCHEMA,
    BRAIN_V3_STYLE_SCHEMA,
    BRAIN_V3_TIMER_SCHEMA,
    BRAIN_V3_VENUE_SCHEMA,
    BRAIN_V3_WEB_ANSWER_SCHEMA
  ] as any[]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  const recipeStep = (RECIPE_SCHEMA as any).properties.steps.items;
  assert.equal(recipeStep.additionalProperties, false);
  assert.deepEqual(recipeStep.required, Object.keys(recipeStep.properties));
  const planItem = (DAY_PLAN_SCHEMA as any).properties.items.items;
  assert.equal(planItem.additionalProperties, false);
  assert.deepEqual(planItem.required, Object.keys(planItem.properties));
  const memoryItem = (DURABLE_MEMORY_SCHEMA as any).properties.add.items;
  assert.equal(memoryItem.additionalProperties, false);
  assert.deepEqual(memoryItem.required, Object.keys(memoryItem.properties));
  const eventItem = (BRAIN_V3_EVENTS_SCHEMA as any).properties.events.items;
  assert.equal(eventItem.additionalProperties, false);
  assert.deepEqual(eventItem.required, Object.keys(eventItem.properties));
});

const futurePlan = {
  summary: "A balanced afternoon.",
  items: [
    { type: "event", title: "Focus work", startDate: "2026-08-29T11:00:00", durationMin: 60 },
    { type: "alarm", title: "Take a break", startDate: "2026-08-29T12:15:00", durationMin: null },
    { type: "event", title: "Lunch", startDate: "2026-08-29T12:30:00", durationMin: 30 },
    { type: "event", title: "Walk outside", startDate: "2026-08-29T13:15:00", durationMin: 45 }
  ]
};

test("Brain v3 day-plan boundary accepts only ordered future local times", () => {
  const normalized = normalizeDayPlanObject(futurePlan, "2026-08-29T10:00:00.000Z", "UTC");
  assert.deepEqual(normalized?.items[1], { type: "alarm", title: "Take a break", startDate: "2026-08-29T12:15:00" });
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: [{ ...futurePlan.items[0], startDate: "2026-08-29T09:59:00" }, ...futurePlan.items.slice(1)] }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: [...futurePlan.items].reverse() }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: futurePlan.items.map((item) => ({ ...item, durationMin: item.type === "event" ? 0 : null })) }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: futurePlan.items.slice(0, 3) }, "2026-08-29T10:00:00.000Z", "UTC"), null);
});
