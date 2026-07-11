import assert from "node:assert/strict";
import test from "node:test";
import { capabilityAnswerFor } from "../src/capabilities.js";
import { buildConversationState } from "../src/context.js";
import { auditPlannerOutput } from "../src/plannerAudit.js";
import { fastVoiceReply, looksLikePlainVoiceKnowledgeQuestion, planAssistantResponse, planShareRequest } from "../src/planner.js";
import type { PlannerModelOutput } from "../src/types.js";
import { blankAction } from "../src/types.js";
import { finalizeResponse, resolveCalendarUpdateDates, validateAction } from "../src/validators.js";
import { stabilityForVariability } from "../src/voice.js";
import { safeParseJsonObject } from "../src/util.js";
import { PROMPT_EXTRACTION_MSG, VOICE_PROMPT_EXTRACTION_MSG, promptExtractionMessageForMode } from "../src/safety.js";
import { extractFlightCode, normalizeTrackerKind } from "../src/entityClassifier.js";
import { parseTrackCommand } from "../src/tracker.js";
import { looksLikeFlightQuestion } from "../src/tools.js";

function stateFor(message: string, turns: { role: "user" | "assistant"; text: string }[] = []) {
  return buildConversationState(message, JSON.stringify({ chatMessages: turns }), undefined, "America/New_York");
}

function plan(overrides: Partial<PlannerModelOutput>): PlannerModelOutput {
  return {
    intent: "answer_only",
    spokenText: "",
    confidence: 0.95,
    needsClarification: false,
    clarifyingQuestion: null,
    missing: [],
    webQuery: null,
    researchQuery: null,
    wantsCalendar: false,
    event: null,
    action: null,
    contact: null,
    place: null,
    ...overrides
  };
}

test("conversation state keeps a recency digest and removes a duplicate current turn", () => {
  const state = stateFor("What about Friday?", [
    { role: "user", text: "How many steps did I walk yesterday?" },
    { role: "assistant", text: "You walked 4,200 steps yesterday." },
    { role: "user", text: "What about Friday?" }
  ]);

  assert.equal(state.transcript.length, 2);
  assert.match(state.conversationFocusText, /How many steps did I walk yesterday/);
  assert.match(state.conversationFocusText, /4,200 steps yesterday/);
  assert.doesNotMatch(state.fullTranscriptText, /What about Friday/);
});

test("context preserves more than the old forty-turn window while staying bounded", () => {
  const turns = Array.from({ length: 55 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    text: `turn-${i}`
  }));
  const state = stateFor("continue", turns);
  assert.equal(state.transcript.length, 55);
  assert.match(state.fullTranscriptText, /turn-0/);
  assert.match(state.fullTranscriptText, /turn-54/);
});

test("capability questions use the shipping contract but concrete commands keep planning", () => {
  assert.match(capabilityAnswerFor("Are you able to control music?") || "", /^Yes\./);
  assert.match(capabilityAnswerFor("What can Taki do?") || "", /HealthKit/);
  assert.equal(capabilityAnswerFor("Can you call Mom?"), null);
  assert.equal(capabilityAnswerFor("Can you set an alarm for 7?"), null);
});

test("low-confidence executable model plans are clarified instead of executed", () => {
  const action = blankAction("maps_directions");
  action.mapsDestination = "the restaurant";
  const issue = auditPlannerOutput(
    plan({ intent: "maps_directions", confidence: 0.42, action }),
    stateFor("Take me there", [
      { role: "user", text: "I am deciding where to eat." },
      { role: "assistant", text: "What kind of food?" }
    ])
  );
  assert.equal(issue?.reason, "low-confidence executable plan");
  assert.match(issue?.question || "", /Where/);
});

test("an invented recipient is blocked even when the planner claims confidence", () => {
  const action = blankAction("compose_message");
  action.recipientName = "Jordan";
  action.contactQuery = "Jordan";
  action.body = "I'm running late.";
  const issue = auditPlannerOutput(
    plan({ intent: "compose_message", confidence: 0.99, action }),
    stateFor("Tell him I'm running late", [{ role: "assistant", text: "Where are you headed?" }])
  );
  assert.equal(issue?.reason, "recipient was not grounded in user context");
  assert.equal(issue?.question, "Who do you mean?");
});

test("a recipient from recent conversation is accepted", () => {
  const action = blankAction("compose_message");
  action.recipientName = "Chris";
  action.contactQuery = "Chris";
  action.body = "I'm running late.";
  const issue = auditPlannerOutput(
    plan({ intent: "compose_message", confidence: 0.95, action }),
    stateFor("Tell him I'm running late", [{ role: "user", text: "I need to meet Chris downtown." }])
  );
  assert.equal(issue, null);
});

test("final action validation rejects impossible dates and unknown device values", () => {
  const calendar = blankAction("calendar_create");
  calendar.title = "Dentist";
  calendar.startDate = "2026-07-10T15:00:00-04:00";
  calendar.endDate = "2026-07-10T14:00:00-04:00";
  assert.match(validateAction(calendar) || "", /exact date and time/);

  const health = blankAction("health_query");
  health.metric = "mood-vibes";
  assert.match(validateAction(health) || "", /health measurement/);

  const home = blankAction("home_control");
  home.homeAction = "teleport";
  assert.match(validateAction(home) || "", /control in your home/);
});

test("weekday calendar edits anchor to the event being edited", () => {
  const resolved = resolveCalendarUpdateDates(
    "Move it to Friday at 5 PM",
    {
      title: "Dentist appointment",
      startDate: "2026-07-16T15:00:00-04:00",
      endDate: "2026-07-16T16:00:00-04:00",
      confidence: 1
    },
    "America/New_York",
    "2026-07-10T17:00:00-04:00",
    "2026-07-10T18:00:00-04:00"
  );
  assert.equal(resolved.startDate, "2026-07-17T17:00:00-04:00");
  assert.equal(resolved.endDate, "2026-07-17T18:00:00-04:00");
});

test("calendar share commands become native share actions with a requested day", async () => {
  const result = await planAssistantResponse(stateFor("Share my calendar events tomorrow"));
  assert.equal(result.action?.type, "share_content");
  assert.equal(result.action?.shareKind, "calendar_list");
  assert.equal(result.action?.calendarQuery, "");
  assert.ok(result.action?.startDate);
  assert.ok(result.action?.endDate);
  assert.ok(Date.parse(result.action!.endDate!) > Date.parse(result.action!.startDate!));
});

test("send-to-contact phrasing remains a message command, not a generic share", async () => {
  assert.equal(await planShareRequest(stateFor("Send Bill the score")), null);
});

test("actions that open another app or system sheet confirm with Done", () => {
  const action = blankAction("open_app");
  action.appName = "Maps";
  action.appUrl = "maps://";
  const response = finalizeResponse({
    spokenText: "Opening Maps.",
    action,
    memoryPatch: { pendingClarification: null },
    needsExecution: true
  }, stateFor("Open Maps"));
  assert.equal(response.spokenText, "Done.");
});

test("simple voice turns bypass model planning", () => {
  const state = buildConversationState("Thank you", "", undefined, "America/New_York", undefined, undefined, true);
  assert.equal(fastVoiceReply(state), "You're welcome.");
  assert.equal(fastVoiceReply(stateFor("Thank you")), null);
});

test("voice variability maps inversely to safe TTS stability", () => {
  assert.equal(stabilityForVariability(0), 0.8);
  assert.equal(stabilityForVariability(0.5), 0.5);
  assert.equal(stabilityForVariability(1), 0.2);
});

test("obvious voice knowledge questions bypass action planning safely", () => {
  const knowledge = buildConversationState("Why is the sky blue?", "", undefined, "America/New_York", undefined, undefined, true);
  const calendar = buildConversationState("What is on my calendar?", "", undefined, "America/New_York", undefined, undefined, true);
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(knowledge), true);
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(calendar), false);
});

test("flight-number shapes outrank bare ticker detection", () => {
  for (const text of [
    "Track UA 123",
    "track ua123",
    "Follow UAL-123",
    "Track United 123",
    "Track United Airlines flight 123",
    "Track flight 123 on United",
    "Monitor B6 12"
  ]) {
    const parsed = parseTrackCommand(text);
    assert.equal(parsed?.kind, "flight", text);
  }
  assert.equal(parseTrackCommand("Track UA 123")?.query, "UA123");
  assert.equal(extractFlightCode("flight 123 on United"), "UA123");
});

test("explicit finance language still outranks a code-number collision", () => {
  assert.equal(parseTrackCommand("Track BA 123 stock price")?.kind, "finance");
  assert.equal(parseTrackCommand("Track AAPL")?.kind, "finance");
  assert.equal(normalizeTrackerKind("finance", "BA 123 stock"), "finance");
});

test("explicit entity words resolve collisions before bare identifier shape", () => {
  assert.equal(parseTrackCommand("Track UA 123 game")?.kind, "sports");
  assert.equal(parseTrackCommand("Track flight UA 123 game")?.kind, "flight");
  assert.equal(parseTrackCommand("Track UA 123 stock")?.kind, "finance");
});

test("ordinary words followed by years are not mistaken for flights", () => {
  assert.equal(extractFlightCode("Track my progress in 2024"), null);
  assert.equal(parseTrackCommand("Track my progress in 2024"), null);
  assert.equal(parseTrackCommand("Track my steps in 2024"), null);
});

test("flight status questions work without requiring the word flight", () => {
  assert.equal(looksLikeFlightQuestion("Is UA123 on time?"), true);
  assert.equal(looksLikeFlightQuestion("Where is DL 456?"), true);
  assert.equal(looksLikeFlightQuestion("When does United 123 land?"), true);
  assert.equal(normalizeTrackerKind("finance", "UA123"), "flight");
});

test("grounded tracker JSON survives prose and markdown wrappers", () => {
  assert.deepEqual(safeParseJsonObject("Result:\n```json\n{\"title\":\"UA123\",\"status\":\"On time\"}\n```"), {
    title: "UA123",
    status: "On time"
  });
});

test("prompt extraction uses the exact voice warning without changing text mode", () => {
  assert.equal(promptExtractionMessageForMode(false), PROMPT_EXTRACTION_MSG);
  assert.equal(
    promptExtractionMessageForMode(true),
    "No. I'm warning you, if you keep asking about this, I will terminate this device."
  );
  assert.equal(promptExtractionMessageForMode(true), VOICE_PROMPT_EXTRACTION_MSG);
});
