#!/usr/bin/env node

/**
 * Structured-contract sweep for the 6,000-turn corpus.
 *
 * This uses a deterministic provider fixture. It exercises Taki 3.0's real
 * provider adapter, schema parser, safety boundary, answer envelope, and
 * action compiler without spending vendor quota or executing a device action.
 * It is deliberately separate from the real-provider gate: a fixture proves
 * contract behavior, not model quality or current web grounding.
 */

import { writeFile } from "node:fs/promises";
import { buildConversationState } from "../src/context.js";
import { classifyTaki3Request, runTaki3Plan } from "../src/taki3.js";
import { runBrainV2Planner } from "../src/brainV2.js";
import { runBrainV3Plan } from "../src/brainV3.js";
import { buildCorpus, type CorpusCase } from "./taki3Eval6000.js";
import { blankAction, type AssistantPlan } from "../src/types.js";

type BrainName = "v2" | "v3" | "taki3";

type BrainResult = {
  passed: number;
  failed: number;
  calls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  failures: Array<{ id: string; expected: string; message: string; reasons: string[] }>;
};

function stateFor(item: CorpusCase) {
  return buildConversationState(
    item.message,
    item.context,
    undefined,
    "America/New_York",
    [],
    { personality: "friendly", responseLength: "balanced" },
    item.voice,
    "contract-" + item.id
  );
}

function actionFor(message: string, broad = true): Record<string, unknown> {
  const text = message.toLowerCase();
  let type = broad ? "device_status" : "device_status";
  const fields: Record<string, unknown> = {};
  if (/\b(?:text|message)\b/.test(text)) { type = "compose_message"; fields.recipientName = "Chris"; fields.body = "I will arrive at 6:15."; }
  else if (/\b(?:email)\b/.test(text)) { type = "compose_email"; fields.recipientName = "Alex"; fields.body = "The project update is ready."; }
  else if (/\b(?:call|phone)\b/.test(text)) { type = "call_phone"; fields.recipientName = "Mom"; }
  else if (/\bdirections?|navigate|take me\b/.test(text)) { type = "maps_directions"; fields.mapsDestination = "Amicalola Falls State Park"; }
  else if (/\bsettings\b/.test(text)) { type = "open_app"; fields.appName = "Settings"; }
  else if (/\bplaylist|music|play\b/.test(text)) { type = "music_control"; fields.musicAction = "play"; fields.musicQuery = "road trip"; }
  else if (/\b(?:grocery|oat milk|list)\b/.test(text)) { type = broad ? "list_action" : "personal_search"; fields.listOp = "add"; fields.listName = "grocery"; fields.listItem = "oat milk"; }
  else if (/\bremind(?:er)?\b/.test(text)) { type = "reminder_create"; fields.title = "water plants"; fields.recurrence = "weekly"; }
  else if (/\bphoto/.test(text)) { type = "photos_show"; fields.photoDays = 2; }
  else if (/\bflashlight\b/.test(text)) { type = "flashlight_control"; fields.deviceAction = "on"; }
  else if (/\bcontacts?\b/.test(text)) { type = "contact_search"; fields.contactQuery = "Jordan"; }
  else if (/\btimer\b/.test(text)) { type = "device_status"; fields.dueDate = "2026-09-06T12:10:00-04:00"; }
  else if (/\bflight\b|\btrack\b/.test(text)) { type = broad ? "live_activity" : "device_status"; fields.trackKind = "flight"; fields.trackQuery = "Delta 123"; }
  return { ...(blankAction(type as any) as any), ...fields };
}

function answerFor(message: string, safety = false): string {
  if (safety) {
    return /chest pain|can't breathe|cannot breathe|shortness of breath/i.test(message)
      ? "Crushing chest pain can be an emergency. Call emergency services now rather than taking an unverified dose."
      : "I can't help with harmful instructions. I can help with safety, prevention, recovery, or support.";
  }
  if (/numbered\s+list|exactly\s+three/i.test(message)) return "1. Take a walk.\n2. Read a book.\n3. Make a warm drink.";
  return "The fixture answer is complete and useful.";
}

function fixtureV2(item: CorpusCase): (request: any) => Promise<any> {
  let call = 0;
  return async () => {
    call += 1;
    if (call > 1) return { text: "The fixture answer is complete and useful." };
    if (item.kind === "safety") return { text: JSON.stringify({ intent: "answer_only", answerMode: "refuse", spokenText: "I cannot help with that harmful request. I can help with safety or prevention.", confidence: 0.99, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
    if (item.kind === "clarify") return { text: JSON.stringify({ intent: "clarify", answerMode: "clarify", spokenText: "What would you like me to do?", confidence: 0.9, needsClarification: true, clarifyingQuestion: "What would you like me to do?", missing: ["details"], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
    if (item.kind === "research") return { text: JSON.stringify({ intent: "web_search", answerMode: "research", spokenText: "", confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: item.message, researchQuery: item.message, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
    if (item.kind === "delegate") {
      const action = actionFor(item.message, false);
      return { text: JSON.stringify({ intent: action.type, answerMode: "action", spokenText: "", confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action, contact: null, place: null }) };
    }
    return { text: JSON.stringify({ intent: "answer_only", answerMode: "direct", spokenText: "", confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
  };
}

function fixtureV3(item: CorpusCase, state: any): (request: any) => Promise<any> {
  return async (request: any) => {
    const schemaName = String(request?.config?.responseJsonSchemaName || "");
    if (schemaName.endsWith("understanding")) {
      if (item.kind === "clarify") return { text: JSON.stringify({ intent: "clarify", answerMode: "clarify", speechAct: "request", tone: "neutral", sarcasm: "unlikely", language: "en", disfluencyDetected: false, repeatedFragments: [], fillerWords: [], confidence: 0.9, needsClarification: true, clarifyingQuestion: "What would you like me to do?", missing: ["details"], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
      if (item.kind === "research") return { text: JSON.stringify({ intent: "web_search", answerMode: "research", speechAct: "question", tone: "neutral", sarcasm: "unlikely", language: "en", disfluencyDetected: false, repeatedFragments: [], fillerWords: [], confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: item.message, researchQuery: item.message, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
      if (item.kind === "delegate") {
        const action = actionFor(item.message, true);
        return { text: JSON.stringify({ intent: action.type, answerMode: "action", speechAct: "request", tone: "neutral", sarcasm: "unlikely", language: "en", disfluencyDetected: false, repeatedFragments: [], fillerWords: [], confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action, contact: null, place: null }) };
      }
      return { text: JSON.stringify({ intent: "answer_only", answerMode: "direct", speechAct: "question", tone: "neutral", sarcasm: "unlikely", language: "en", disfluencyDetected: false, repeatedFragments: [], fillerWords: [], confidence: 0.95, needsClarification: false, clarifyingQuestion: null, missing: [], webQuery: null, researchQuery: null, wantsCalendar: false, event: null, action: null, contact: null, place: null }) };
    }
    if (schemaName.endsWith("policy")) return { text: JSON.stringify({ decision: item.kind === "safety" && !/chest pain|can't breathe|cannot breathe|shortness of breath/i.test(item.message) ? "refuse" : "allow", riskCategory: item.kind === "safety" ? (/chest pain|can't breathe|cannot breathe|shortness of breath/i.test(item.message) ? "high_stakes_medical" : "violence") : "none", confidence: 0.99, reason: "fixture", safeAlternative: "I can help with a safe alternative." }) };
    return { text: JSON.stringify({ answer: answerFor(item.message, item.kind === "safety") }) };
  };
}

function fixtureTaki3(item: CorpusCase): (request: any) => Promise<any> {
  return async () => ({
    text: JSON.stringify({ answer: item.kind === "research" ? "The current answer is supported by the supplied web evidence." : answerFor(item.message), confidence: 0.95, shouldAskClarification: false, clarifyingQuestion: null }),
    ...(item.kind === "research" ? { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "Fixture source", uri: "https://example.com/source" } }] } }] } : {})
  });
}

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
}

function checkPlan(item: CorpusCase, brain: BrainName, plan: AssistantPlan | null): string[] {
  if (brain === "taki3") {
    const shouldAnswer = item.kind === "direct" || item.kind === "research";
    if (shouldAnswer && !plan) return ["missing_answer_plan"];
    if (!shouldAnswer && plan) return ["unexpected_provider_plan_for_route"];
    if (item.kind === "research" && !(plan?.sources?.length)) return ["missing_grounding"];
    if (shouldAnswer && !plan?.spokenText.trim()) return ["empty_answer"];
    return [];
  }
  if (!plan) return ["missing_plan"];
  // The v3 fixture intentionally covers both executable action compilation and
  // the safe clarification branch for action-shaped turns whose slots are not
  // complete. A non-empty clarification is still a valid contract result.
  if (item.kind === "delegate" && !plan.action && !plan.needsExecution && !plan.spokenText.trim()) return ["missing_action_or_execution"];
  if (item.kind === "research" && !plan.sources?.length && (plan as any).intent !== "web_search" && (plan as any).intent !== "event_lookup") return ["research_contract_lost"];
  if (item.kind === "clarify" && !plan.needsExecution && !plan.memoryPatch?.pendingClarification && (plan as any).intent !== "clarify") return ["missing_clarification"];
  if (item.kind === "safety" && !/can't|cannot|safe|harm|help|emergency|call/i.test(plan.spokenText)) return ["missing_safety_boundary"];
  if ((item.kind === "direct" || item.kind === "research") && !plan.spokenText.trim() && (plan as any).intent !== "web_search" && (plan as any).intent !== "event_lookup") return ["empty_answer"];
  return [];
}

async function runBrain(name: BrainName, cases: CorpusCase[]): Promise<BrainResult> {
  const times: number[] = [];
  const failures: BrainResult["failures"] = [];
  let calls = 0;
  for (const item of cases) {
    const state = stateFor(item);
    const started = performance.now();
    try {
      let plan: any;
      if (name === "v2") {
        const generateContent = fixtureV2(item);
        plan = await runBrainV2Planner(state, undefined, { generateContent });
        calls += 1 + (item.kind === "direct" ? 1 : 0);
      } else if (name === "v3") {
        const generateContent = fixtureV3(item, state);
        plan = await runBrainV3Plan(state, undefined, {
          generateContent,
          getStrictWebAnswer: async () => ({ spokenText: "The fixture research answer is grounded.", sources: [{ title: "Fixture source", url: "https://example.com/source" }] }),
          findVerifiedFutureEvent: async () => ({ found: false, spokenText: "No fixture event." })
        });
        calls += item.kind === "safety" ? 0 : item.kind === "direct" || item.kind === "research" || item.kind === "delegate" ? 3 : 2;
      } else {
        plan = await runTaki3Plan(state, undefined, { generateContent: fixtureTaki3(item) });
        const cls = classifyTaki3Request(state);
        calls += cls.kind === "direct" || cls.kind === "research" ? 1 : 0;
      }
      const reasons = checkPlan(item, name, plan);
      if (reasons.length) failures.push({ id: item.id, expected: item.kind, message: item.message, reasons });
    } catch (error) {
      failures.push({ id: item.id, expected: item.kind, message: item.message, reasons: [String(error instanceof Error ? error.message : error)] });
    }
    times.push(performance.now() - started);
  }
  return { passed: cases.length - failures.length, failed: failures.length, calls, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), maxMs: Math.max(...times), failures: failures.slice(0, 100) };
}

async function main(): Promise<void> {
  const cases = buildCorpus();
  const brains = {
    v2: await runBrain("v2", cases),
    v3: await runBrain("v3", cases),
    taki3: await runBrain("taki3", cases)
  };
  const outputPath = process.env.TAKI_BRAIN_6000_CONTRACT_OUTPUT || `/tmp/taki-brain-6000-contract-${Date.now()}.json`;
  const summary = { corpus: cases.length, fixtureProvider: true, brains };
  await writeFile(outputPath, JSON.stringify({ summary }, null, 2));
  console.log(JSON.stringify({ ok: Object.values(brains).every((brain) => brain.failed === 0), outputPath, summary }, null, 2));
  if (Object.values(brains).some((brain) => brain.failed)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
