#!/usr/bin/env node

/**
 * Long-context stress audit for the single Taki 3.0 surface.
 *
 * The normal 6,000-turn sweep varies individual requests and uses bounded
 * histories. This audit deliberately gives the same routing corpus very large
 * histories, oversized turns, repeated corrections, and voice/non-voice
 * contexts. It verifies that the state builder keeps the newest request, stays
 * inside the prompt budget, and that the Taki 3.0 contract still routes and
 * validates every case without a vendor call.
 */

import { writeFile } from "node:fs/promises";
import { buildConversationState } from "../src/context.js";
import { classifyTaki3Request, runTaki3Plan } from "../src/taki3.js";
import { buildCorpus, type CorpusCase } from "./taki3Eval6000.js";

type Failure = { id: string; expected: string; actual?: string; reasons: string[] };

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0;
}

function hugeContext(item: CorpusCase, index: number): string {
  const history = Array.from({ length: 1_500 }, (_, turn) => ({
    role: turn % 2 ? "assistant" : "user",
    // Include a few oversized turns so the per-turn truncation path is tested.
    text: turn % 37 === 0
      ? `Historical turn ${turn}: ${"old context ".repeat(600)}${item.message}`
      : `Historical turn ${turn}: the user discussed a project called Orchard and a place called Santa Fe.`
  }));
  history.push({ role: "assistant", text: "The prior answer may have missed an important detail." });
  history.push({ role: "user", text: item.message });
  return JSON.stringify({
    chatMessages: history,
    corrections: Array.from({ length: index % 17 === 0 ? 24 : 0 }, (_, correction) => ({
      misunderstoodAnswer: `Wrong detail ${correction}`,
      userCorrection: `Correct detail ${correction}: keep the latest request in view.`
    }))
  });
}

function fixture(item: CorpusCase): (request: any) => Promise<any> {
  return async () => ({
    text: JSON.stringify({
      answer: item.kind === "research"
        ? "The current answer is supported by the supplied source."
        : "Here is a concise, useful answer.",
      confidence: 0.95,
      shouldAskClarification: false,
      clarifyingQuestion: null
    }),
    ...(item.kind === "research"
      ? { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "Fixture source", uri: "https://example.com/source" } }] } }] }
      : {})
  });
}

async function main(): Promise<void> {
  const source = buildCorpus();
  // Use 100 cases per route, retaining the established 6000-case expectations.
  const cases = source.filter((_item, index) => index % 60 < 5).slice(0, 500);
  const failures: Failure[] = [];
  const timings: number[] = [];
  let providerContractCases = 0;

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const voice = index % 7 === 0;
    const stateStarted = performance.now();
    const state = buildConversationState(
      item.message,
      hugeContext(item, index),
      undefined,
      "America/New_York",
      [],
      { personality: "friendly", responseLength: "balanced" },
      voice,
      `long-chat-${index}`
    );
    const classification = classifyTaki3Request(state);
    const reasons: string[] = [];
    const expectedMaxTurns = voice ? 40 : 64;
    const expectedMaxChars = voice ? 14_000 : 28_000;
    if (state.transcript.length > expectedMaxTurns) reasons.push("transcript_turn_bound_exceeded");
    if (state.fullTranscriptText.length > expectedMaxChars) reasons.push("transcript_char_bound_exceeded");
    // The client includes the current user turn in chatMessages, and the state
    // builder intentionally removes that duplicate from the transcript. The
    // authoritative latest request remains the separate state.message field.
    if (state.message !== item.message) reasons.push("latest_request_lost");
    if (classification.kind !== item.kind) reasons.push(`classified_as_${classification.kind}`);

    if (item.kind === "direct" || item.kind === "research") {
      providerContractCases += 1;
      try {
        const plan = await runTaki3Plan(state, undefined, { generateContent: fixture(item) });
        if (!plan?.spokenText.trim()) reasons.push("empty_provider_contract_answer");
        if (item.kind === "research" && !plan?.sources?.length) reasons.push("missing_provider_contract_source");
      } catch (error) {
        reasons.push(`provider_contract_error:${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const plan = await runTaki3Plan(state, undefined, { generateContent: fixture(item) });
      if (plan !== null) reasons.push("unexpected_provider_plan_for_non_answer_route");
    }

    timings.push(performance.now() - stateStarted);
    if (reasons.length) failures.push({ id: `long-${String(index + 1).padStart(4, "0")}`, expected: item.kind, actual: classification.kind, reasons });
  }

  const summary = {
    corpus: cases.length,
    providerContractCases,
    historyTurns: 1_502,
    passed: cases.length - failures.length,
    failed: failures.length,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    maxMs: Math.max(...timings),
    brain: "taki3",
    failures: failures.slice(0, 100)
  };
  const outputPath = process.env.TAKI_TAKI3_LONG_CHAT_OUTPUT || `/tmp/taki3-long-chat-${Date.now()}.json`;
  await writeFile(outputPath, JSON.stringify({ summary }, null, 2));
  console.log(JSON.stringify({ ok: failures.length === 0, outputPath, summary }, null, 2));
  if (failures.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
