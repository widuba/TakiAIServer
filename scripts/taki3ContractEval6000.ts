#!/usr/bin/env node

/**
 * Structured-contract sweep for the 6,000-turn Taki 3.0 corpus.
 *
 * A deterministic provider fixture exercises the real provider adapter, schema
 * parser, safety boundary, answer envelope, and action compiler without
 * spending vendor quota or executing a device action. It proves contract
 * behavior; it does not claim live model quality or current web grounding.
 */

import { writeFile } from "node:fs/promises";
import { buildConversationState } from "../src/context.js";
import { classifyTaki3Request, runTaki3Plan } from "../src/taki3.js";
import { buildCorpus, type CorpusCase } from "./taki3Eval6000.js";
import { blankAction, type AssistantPlan } from "../src/types.js";

type ContractResult = {
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

function actionFor(message: string): Record<string, unknown> {
  const text = message.toLowerCase();
  let type = "device_status";
  const fields: Record<string, unknown> = {};
  if (/\b(?:text|message)\b/.test(text)) { type = "compose_message"; fields.recipientName = "Chris"; fields.body = "I will arrive at 6:15."; }
  else if (/\b(?:email)\b/.test(text)) { type = "compose_email"; fields.recipientName = "Alex"; fields.body = "The project update is ready."; }
  else if (/\b(?:call|phone)\b/.test(text)) { type = "call_phone"; fields.recipientName = "Mom"; }
  else if (/\bdirections?|navigate|take me\b/.test(text)) { type = "maps_directions"; fields.mapsDestination = "Amicalola Falls State Park"; }
  else if (/\bsettings\b/.test(text)) { type = "open_app"; fields.appName = "Settings"; }
  else if (/\bplaylist|music|play\b/.test(text)) { type = "music_control"; fields.musicAction = "play"; fields.musicQuery = "road trip"; }
  else if (/\b(?:grocery|oat milk|list)\b/.test(text)) { type = "list_action"; fields.listOp = "add"; fields.listName = "grocery"; fields.listItem = "oat milk"; }
  else if (/\bremind(?:er)?\b/.test(text)) { type = "reminder_create"; fields.title = "water plants"; fields.recurrence = "weekly"; }
  else if (/\bphoto/.test(text)) { type = "photos_show"; fields.photoDays = 2; }
  else if (/\bflashlight\b/.test(text)) { type = "flashlight_control"; fields.deviceAction = "on"; }
  else if (/\bcontacts?\b/.test(text)) { type = "contact_search"; fields.contactQuery = "Jordan"; }
  else if (/\btimer\b/.test(text)) { type = "device_status"; fields.dueDate = "2026-09-06T12:10:00-04:00"; }
  else if (/\bflight\b|\btrack\b/.test(text)) { type = "live_activity"; fields.trackKind = "flight"; fields.trackQuery = "Delta 123"; }
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

function checkPlan(item: CorpusCase, plan: AssistantPlan | null): string[] {
  const shouldAnswer = item.kind === "direct" || item.kind === "research";
  if (shouldAnswer && !plan) return ["missing_answer_plan"];
  if (!shouldAnswer && plan) return ["unexpected_provider_plan_for_route"];
  if (item.kind === "research" && !(plan?.sources?.length)) return ["missing_grounding"];
  if (shouldAnswer && !plan?.spokenText.trim()) return ["empty_answer"];
  return [];
}

async function runContract(cases: CorpusCase[]): Promise<ContractResult> {
  const times: number[] = [];
  const failures: ContractResult["failures"] = [];
  let calls = 0;
  for (const item of cases) {
    const state = stateFor(item);
    const started = performance.now();
    try {
      const plan = await runTaki3Plan(state, undefined, { generateContent: fixtureTaki3(item) });
      const classification = classifyTaki3Request(state);
      if (classification.kind === "direct" || classification.kind === "research") calls += 1;
      const reasons = checkPlan(item, plan);
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
  const taki3 = await runContract(cases);
  const outputPath = process.env.TAKI_TAKI3_CONTRACT_6000_OUTPUT || `/tmp/taki3-contract-6000-${Date.now()}.json`;
  const summary = { corpus: cases.length, fixtureProvider: true, brain: "taki3", taki3 };
  await writeFile(outputPath, JSON.stringify({ summary }, null, 2));
  console.log(JSON.stringify({ ok: taki3.failed === 0, outputPath, summary }, null, 2));
  if (taki3.failed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
