import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_AI_PROVIDER, TAKI3_SPECIALIST_MODEL, TAKI3_SPECIALIST_MODELS, taki3SpecialistsEnabled, taki3CompatibilityEnabled, taki3SpecialistStructuredRequest } from "../src/ai.js";
import {
  TAKI3_SPECIALIST_ALARM_SCHEMA,
  TAKI3_SPECIALIST_EVENT_MATCH_SCHEMA,
  TAKI3_SPECIALIST_EVENT_SCHEMA,
  TAKI3_SPECIALIST_EVENTS_SCHEMA,
  TAKI3_SPECIALIST_FLIGHT_TRACKER_SCHEMA,
  TAKI3_SPECIALIST_MATH_SCHEMA,
  TAKI3_SPECIALIST_PRODUCT_TRACKER_SCHEMA,
  TAKI3_SPECIALIST_SPORTS_TRACKER_SCHEMA,
  TAKI3_SPECIALIST_STYLE_SCHEMA,
  TAKI3_SPECIALIST_TIMER_SCHEMA,
  TAKI3_SPECIALIST_VENUE_SCHEMA,
  TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
  taki3SpecialistCircuitOpen,
  resetTaki3SpecialistCircuit,
  runTaki3SpecialistStructured
} from "../src/taki3Specialists.js";
import { TAKI3_COMPATIBILITY_MULTIMODAL_ANSWER_SCHEMA as TAKI3_SPECIALIST_MULTIMODAL_ANSWER_SCHEMA } from "../src/taki3Compatibility.js";
import { CHAT_TITLE_SCHEMA } from "../src/chatTitle.js";
import { RECIPE_SCHEMA } from "../src/cooking.js";
import { DAY_PLAN_SCHEMA, normalizeDayPlanObject } from "../src/dayplan.js";
import { SAFETY_REVIEW_SCHEMA } from "../src/safetyReview.js";
import { DURABLE_MEMORY_SCHEMA } from "../src/userMemory.js";
import { URL_SUMMARY_SCHEMA } from "../src/websummary.js";
import { NEUTRAL_VECTOR } from "../src/messageStyle.js";
import { restyleMessageBody, rewritePreservesMessageContent } from "../src/messageStyleRewrite.js";
import { TAKI3_SPECIALIST_PROMOTION_EVIDENCE_TTL_MS, TAKI3_SPECIALIST_PROMOTION_EVIDENCE_VERSION, TAKI3_SPECIALIST_PROMOTION_MIN_CORE_CASES, encodeTaki3SpecialistPromotionEvidence } from "../src/taki3SpecialistPromotion.js";

const PROMOTION_RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const PROMOTION_ENV = {
  TAKI_TAKI3_SPECIALIST_READY: "1",
  TAKI_TAKI3_SPECIALIST_RELEASE_ID: PROMOTION_RELEASE_ID,
  TAKI_TAKI3_SPECIALIST_PROMOTION_EVIDENCE: encodeTaki3SpecialistPromotionEvidence({
    format: "taki3-specialist-promotion",
    version: TAKI3_SPECIALIST_PROMOTION_EVIDENCE_VERSION,
    releaseId: PROMOTION_RELEASE_ID,
    provider: ACTIVE_AI_PROVIDER,
    model: TAKI3_SPECIALIST_MODEL,
    models: TAKI3_SPECIALIST_MODELS,
    core: { passed: true, total: TAKI3_SPECIALIST_PROMOTION_MIN_CORE_CASES, failed: 0 },
    auxiliary: { passed: true, total: 18, failed: 0 },
    realWeb: { passed: true },
    deterministic: { passed: true, typecheckPassed: true, testCount: 350, failed: 0, cancelled: 0, skipped: 0 },
    rollback: { passed: true },
    noWrite: true,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + TAKI3_SPECIALIST_PROMOTION_EVIDENCE_TTL_MS - 1_000).toISOString()
  })
};

test("Taki 3.0 specialist auxiliary surfaces require the core rollout and an explicit opt-in", () => {
  assert.equal(taki3CompatibilityEnabled({}), false);
  assert.equal(taki3CompatibilityEnabled({ TAKI_TAKI3_SPECIALIST_READY: "1", TAKI_TAKI3_SPECIALIST_MODE: "active" }), false);
  assert.equal(taki3CompatibilityEnabled({ ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "active" }), true);
  assert.equal(taki3CompatibilityEnabled({ ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "canary" }), true);
  // Detached shadow runs use the strict core research path for meaningful
  // staging evidence, but the planner never selects it for live traffic.
  assert.equal(taki3CompatibilityEnabled({ TAKI_TAKI3_SPECIALIST_MODE: "shadow" }), true);
  assert.equal(taki3SpecialistsEnabled({}), false);
  assert.equal(taki3SpecialistsEnabled({ TAKI_TAKI3_SPECIALIST_READY: "1", TAKI_TAKI3_SPECIALIST_MODE: "active" }), false);
  assert.equal(taki3SpecialistsEnabled({ ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "canary", TAKI_TAKI3_SPECIALIST_AUX_MODE: "active" }), false);
  assert.equal(taki3SpecialistsEnabled({ ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "active", TAKI_TAKI3_SPECIALIST_AUX_MODE: "active" }), true);
  assert.equal(taki3SpecialistsEnabled({ ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "active", TAKI_TAKI3_SPECIALIST_AUX_MODE: "active" }), true);
});

test("Taki 3.0 specialist surface requests use strict named JSON schemas", () => {
  const request = taki3SpecialistStructuredRequest("recipe extract/1", "data", RECIPE_SCHEMA, { temperature: 0.2 });
  assert.equal(request.config.modelRole, "taki3_specialist");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.equal(request.config.responseJsonSchemaName, "taki3_specialist_recipe_extract_1");
  assert.equal(request.config.responseJsonSchema, RECIPE_SCHEMA);
  assert.equal(request.config.temperature, 0.2);
});

test("Taki 3.0 specialist specialist requests are strict, named, and provider-independent", async () => {
  let seen: any = null;
  const result = await runTaki3SpecialistStructured<{ answer: string }>(
    "web answer/1",
    "source data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500, maxOutputTokens: 90, reasoning: "low", temperature: 0 },
    async (request) => {
      seen = request;
      return { text: '{"answer":"grounded"}' };
    }
  );
  assert.deepEqual(result.value, { answer: "grounded" });
  assert.equal(seen.config.modelRole, "taki3_specialist");
  assert.equal(seen.config.responseMimeType, "application/json");
  assert.equal(seen.config.responseJsonSchemaName, "taki3_specialist_web_answer_1");
  assert.equal(seen.config.temperature, 0);
  assert.deepEqual(seen.config.responseJsonSchema, TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA);
});

test("Taki 3.0 specialist owns learned message-style rewrites when the auxiliary gate is enabled", async () => {
  resetTaki3SpecialistCircuit();
  const calls: any[] = [];
  try {
    const result = await restyleMessageBody(
      "I will be late.",
      { ...NEUTRAL_VECTOR, humor: 4 },
      "Maya",
      false,
      {
        env: { ...PROMOTION_ENV, TAKI_TAKI3_SPECIALIST_MODE: "active", TAKI_TAKI3_SPECIALIST_AUX_MODE: "active" },
        generateContent: async (request) => {
          calls.push(request);
          return { text: JSON.stringify({ text: "im late lol" }) };
        }
      }
    );
    assert.equal(result, "im late lol");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.responseJsonSchemaName, "taki3_specialist_message_style_rewrite");
    assert.equal(calls[0].config.modelRole, "taki3_specialist");
    assert.deepEqual(calls[0].config.responseJsonSchema, TAKI3_SPECIALIST_STYLE_SCHEMA);
  } finally {
    resetTaki3SpecialistCircuit();
  }
});

test("learned style rendering cannot replace message facts", () => {
  assert.equal(rewritePreservesMessageContent("I will be late.", "im late lol"), true);
  assert.equal(rewritePreservesMessageContent("Meet Maya at 5:30.", "meet maya at 6:30 lol"), false);
  assert.equal(rewritePreservesMessageContent("I will be late.", "send the password now"), false);
});

test("Taki 3.0 specialist specialist failures open a bounded compatibility circuit", async () => {
  resetTaki3SpecialistCircuit();
  let calls = 0;
  await assert.rejects(() => runTaki3SpecialistStructured(
    "failing_surface",
    "data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => {
      calls += 1;
      throw new Error("provider unavailable");
    }
  ));
  assert.equal(calls, 1);
  assert.equal(taki3SpecialistCircuitOpen(), true);
  await assert.rejects(() => runTaki3SpecialistStructured(
    "skipped_surface",
    "data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => {
      calls += 1;
      return { text: '{"answer":"should not run"}' };
    }
  ));
  assert.equal(calls, 1);
  resetTaki3SpecialistCircuit();
  assert.equal(taki3SpecialistCircuitOpen(), false);
});

test("Taki 3.0 specialist specialist circuits reject incomplete and extra top-level fields", async () => {
  resetTaki3SpecialistCircuit();
  await assert.rejects(() => runTaki3SpecialistStructured(
    "incomplete_surface",
    "data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: "{}" })
  ));
  assert.equal(taki3SpecialistCircuitOpen(), true);
  resetTaki3SpecialistCircuit();
  await assert.rejects(() => runTaki3SpecialistStructured(
    "extra_field_surface",
    "data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: '{"answer":"ok","unexpected":true}' })
  ));
  assert.equal(taki3SpecialistCircuitOpen(), true);
  resetTaki3SpecialistCircuit();
});

test("Taki 3.0 specialist specialist circuits reject wrong types and nested contract drift", async () => {
  resetTaki3SpecialistCircuit();
  await assert.rejects(() => runTaki3SpecialistStructured(
    "wrong_type_surface",
    "data",
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA,
    { timeoutMs: 500 },
    async () => ({ text: '{"answer":42}' })
  ));
  assert.equal(taki3SpecialistCircuitOpen(), true);
  resetTaki3SpecialistCircuit();
  await assert.rejects(() => runTaki3SpecialistStructured(
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
  assert.equal(taki3SpecialistCircuitOpen(), true);
  resetTaki3SpecialistCircuit();
});

test("Taki 3.0 specialist auxiliary schemas close nested objects and require nullable optional values", () => {
  for (const schema of [
    TAKI3_SPECIALIST_MULTIMODAL_ANSWER_SCHEMA,
    RECIPE_SCHEMA,
    DAY_PLAN_SCHEMA,
    DURABLE_MEMORY_SCHEMA,
    CHAT_TITLE_SCHEMA,
    SAFETY_REVIEW_SCHEMA,
    URL_SUMMARY_SCHEMA,
    TAKI3_SPECIALIST_ALARM_SCHEMA,
    TAKI3_SPECIALIST_EVENT_MATCH_SCHEMA,
    TAKI3_SPECIALIST_EVENT_SCHEMA,
    TAKI3_SPECIALIST_EVENTS_SCHEMA,
    TAKI3_SPECIALIST_FLIGHT_TRACKER_SCHEMA,
    TAKI3_SPECIALIST_MATH_SCHEMA,
    TAKI3_SPECIALIST_PRODUCT_TRACKER_SCHEMA,
    TAKI3_SPECIALIST_SPORTS_TRACKER_SCHEMA,
    TAKI3_SPECIALIST_STYLE_SCHEMA,
    TAKI3_SPECIALIST_TIMER_SCHEMA,
    TAKI3_SPECIALIST_VENUE_SCHEMA,
    TAKI3_SPECIALIST_WEB_ANSWER_SCHEMA
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
  const eventItem = (TAKI3_SPECIALIST_EVENTS_SCHEMA as any).properties.events.items;
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

test("Taki 3.0 specialist day-plan boundary accepts only ordered future local times", () => {
  const normalized = normalizeDayPlanObject(futurePlan, "2026-08-29T10:00:00.000Z", "UTC");
  assert.deepEqual(normalized?.items[1], { type: "alarm", title: "Take a break", startDate: "2026-08-29T12:15:00" });
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: [{ ...futurePlan.items[0], startDate: "2026-08-29T09:59:00" }, ...futurePlan.items.slice(1)] }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: [...futurePlan.items].reverse() }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: futurePlan.items.map((item) => ({ ...item, durationMin: item.type === "event" ? 0 : null })) }, "2026-08-29T10:00:00.000Z", "UTC"), null);
  assert.equal(normalizeDayPlanObject({ ...futurePlan, items: futurePlan.items.slice(0, 3) }, "2026-08-29T10:00:00.000Z", "UTC"), null);
});
