import assert from "node:assert/strict";
import test from "node:test";
import { capabilityAnswerFor } from "../src/capabilities.js";
import { buildConversationState } from "../src/context.js";
import { auditPlannerOutput } from "../src/plannerAudit.js";
import { fastVoiceReply, looksLikePlainVoiceKnowledgeQuestion, planAssistantResponse, planShareRequest } from "../src/planner.js";
import type { PlannerModelOutput } from "../src/types.js";
import { blankAction } from "../src/types.js";
import { finalizeResponse, resolveCalendarUpdateDates, validateAction } from "../src/validators.js";
import { briefForVoice, VOICE_MAX_CHARS } from "../src/util.js";
import { formatMathNumber, parsePackageTracking, youtubeVideoInputURL } from "../src/tools.js";
import { usageLimitsFor } from "../src/credits.js";
import { subscriptionMergeDecision } from "../src/iap.js";
import { billableAudioDurationMs, normalizeTextForSpeech, speechCharacterCount, stabilityForVariability, STT_MODEL, TTS_MODEL } from "../src/voice.js";
import { safeParseJsonObject } from "../src/util.js";
import { PROMPT_EXTRACTION_MSG, VOICE_PROMPT_EXTRACTION_MSG, promptExtractionMessageForMode } from "../src/safety.js";
import { extractFlightCode, normalizeTrackerKind } from "../src/entityClassifier.js";
import { parseTrackCommand, ship24StatusFromResponse } from "../src/tracker.js";
import { looksLikeComparisonRequest, looksLikeFlightQuestion, looksLikeStockQuestion } from "../src/tools.js";
import { parseUserPersona, personaPromptBlock } from "../src/persona.js";
import { normalizeChatTitle } from "../src/chatTitle.js";

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

test("unbacked success claims are never returned without an executable action", () => {
  for (const spokenText of [
    "I've texted Bill the details.",
    "Your reminder is set for 8.",
    "The email has been sent.",
    "Done."
  ]) {
    const response = finalizeResponse({
      spokenText,
      action: null,
      memoryPatch: { pendingClarification: null },
      needsExecution: false
    }, stateFor("do that"));
    assert.equal(response.spokenText, "Okay.", spokenText);
  }
});

test("shipping actions have deterministic missing-detail checks", () => {
  const expectations: [ReturnType<typeof blankAction>, RegExp][] = [
    [blankAction("compose_message"), /Who should I send/],
    [blankAction("compose_email"), /Who should I email/],
    [blankAction("call_phone"), /Who should I call/],
    [blankAction("calendar_create"), /title, date, and time/],
    [blankAction("calendar_update"), /Which calendar event/],
    [blankAction("calendar_delete"), /Which calendar event/],
    [blankAction("reminder_create"), /What should I remind/],
    [blankAction("maps_search"), /What should I search/],
    [blankAction("maps_directions"), /Where do you want directions/],
    [blankAction("open_app"), /Which app should I open/],
    [blankAction("health_query"), /health measurement/],
    [blankAction("music_control"), /play or control/],
    [blankAction("home_control"), /control in your home/],
    [blankAction("photos_search"), /search for in your photos/],
    [blankAction("contact_create"), /contact's name/]
  ];
  for (const [action, expected] of expectations) {
    assert.match(validateAction(action) || "", expected, action.type);
  }
});

test("calendar forwarding accepts grounded contacts and direct addresses", () => {
  const messageAction = blankAction("calendar_forward");
  messageAction.shareKind = "message";
  messageAction.calendarQuery = "dentist";
  messageAction.recipientName = "Bill";
  messageAction.contactQuery = "Bill";
  const messageState = stateFor("Text Bill the details from my dentist calendar event");
  assert.equal(auditPlannerOutput(plan({ intent: "calendar_forward", action: messageAction }), messageState), null);
  assert.equal(validateAction(messageAction), null);

  const emailAction = blankAction("calendar_forward");
  emailAction.shareKind = "email";
  emailAction.calendarQuery = "tomorrow";
  emailAction.emailAddress = "pat@example.com";
  assert.equal(validateAction(emailAction), null);
  const response = finalizeResponse({
    spokenText: "Emailing the event.",
    action: emailAction,
    memoryPatch: { pendingClarification: null },
    needsExecution: true
  }, stateFor("Email tomorrow's calendar to pat@example.com"));
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

test("voice uses current multilingual ElevenLabs models", () => {
  assert.equal(TTS_MODEL, "eleven_multilingual_v2");
  assert.equal(STT_MODEL, "scribe_v2");
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64")), 1_000);
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64"), 1_200), 1_200);
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64"), 60_000), 30_000);
});

test("voice speaks large numeric answers naturally without changing its budget", () => {
  assert.equal(normalizeTextForSpeech("800000000"), "eight hundred million");
  assert.equal(
    normalizeTextForSpeech("The answer is 800,000,000."),
    "The answer is eight hundred million."
  );
  assert.equal(
    normalizeTextForSpeech("40 thousand times 20 thousand equals 800 million."),
    "forty thousand times twenty thousand equals eight hundred million."
  );
  assert.equal(
    normalizeTextForSpeech("40,000 x 20,000 equals 800 million."),
    "forty thousand times twenty thousand equals eight hundred million."
  );
  assert.equal(normalizeTextForSpeech("The total is $12.50."), "The total is twelve dollars and fifty cents.");
  assert.equal(
    normalizeTextForSpeech("Call the phone number 2025550198."),
    "Call the phone number two zero two five five five zero one nine eight."
  );
  const numericWall = "9".repeat(140);
  assert.equal(normalizeTextForSpeech(numericWall), numericWall);
  assert.ok(speechCharacterCount("800000000") <= 140);
});

test("calculator formats large results as exact human-readable quantities", () => {
  assert.equal(formatMathNumber(8_000_000), "8 million");
  assert.equal(formatMathNumber(80_000_000), "80 million");
  assert.equal(formatMathNumber(800_000_000), "800 million");
  assert.equal(formatMathNumber(8_234_567), "8.234567 million");
  assert.equal(formatMathNumber(1_250_000_000), "1.25 billion");
  assert.equal(formatMathNumber(-40_000), "-40 thousand");
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

test("retail product prices never route through financial asset tracking", () => {
  const macs = parseTrackCommand("Track the price of MacBook Air vs Pro vs Mac mini");
  assert.equal(macs?.kind, "product");
  assert.match(macs?.query || "", /macbook air/i);
  assert.equal(parseTrackCommand("Track iPhone 17 price versus Galaxy S26 price")?.kind, "product");
  assert.equal(parseTrackCommand("Track Apple stock price")?.kind, "finance");
  assert.equal(parseTrackCommand("Track AAPL price")?.kind, "finance");
  assert.equal(looksLikeStockQuestion("What is the price of a MacBook Air?"), false);
  assert.equal(looksLikeStockQuestion("What is the Apple stock price?"), true);
});

test("explicit entity words resolve collisions before bare identifier shape", () => {
  assert.equal(parseTrackCommand("Track UA 123 game")?.kind, "sports");
  assert.equal(parseTrackCommand("Track flight UA 123 game")?.kind, "flight");
  assert.equal(parseTrackCommand("Track UA 123 stock")?.kind, "finance");
});

test("team-only tracker commands are recognized as sports", () => {
  assert.equal(parseTrackCommand("Track the Yankees")?.kind, "sports");
  assert.equal(parseTrackCommand("Follow the Lakers")?.kind, "sports");
  assert.equal(parseTrackCommand("Keep an eye on Arsenal")?.kind, "sports");
  assert.equal(parseTrackCommand("Track my steps"), null);
});

test("package tracking accepts common alphanumeric carrier formats", () => {
  const amazon = parsePackageTracking("Track my Amazon package TBA123456789012");
  assert.equal(amazon?.number, "TBA123456789012");
  assert.equal(amazon?.carrier, "Amazon");
  assert.match(amazon?.url || "", /amazon\.com/);

  const generic = parsePackageTracking("Track package LX1234ABCD567890");
  assert.equal(generic?.number, "LX1234ABCD567890");
});

test("Ship24 results select the newest event and normalized milestone", () => {
  const status = ship24StatusFromResponse({
    data: {
      trackings: [{
        shipment: { statusMilestone: "out_for_delivery", delivery: { estimatedDeliveryDate: "2026-07-18" } },
        events: [
          { occurrenceDatetime: "2026-07-17T10:00:00Z", status: "In transit", location: "Atlanta" },
          { occurrenceDatetime: "2026-07-18T09:00:00Z", status: "Out for delivery", location: { city: "New York", state: "NY" } }
        ]
      }]
    }
  });
  assert.equal(status?.line1, "Out for delivery");
  assert.equal(status?.line2, "New York, NY");
  assert.equal(status?.eta, "2026-07-18");
  assert.equal(status?.delivered, false);
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

test("learned user memories are bounded and included across chat prompts", () => {
  const persona = parseUserPersona({
    memories: ["The user works as a nurse.", "The user is allergic to dairy."],
    personality: "friendly"
  });
  assert.deepEqual(persona.memories, ["The user works as a nurse.", "The user is allergic to dairy."]);
  const prompt = personaPromptBlock(persona);
  assert.match(prompt, /REMEMBERED ABOUT THE USER/);
  assert.match(prompt, /works as a nurse/);
  assert.match(prompt, /allergic to dairy/);
});

test("grounded sources survive response finalization", () => {
  const sources = [{ title: "Example source", url: "https://example.com/current" }];
  const response = finalizeResponse({
    spokenText: "A grounded answer.",
    action: null,
    sources,
    memoryPatch: { pendingClarification: null, lastIntent: "web_search" },
    needsExecution: false
  }, stateFor("what is current?"));
  assert.deepEqual(response.sources, sources);
});

test("chat titles are short and stripped of model formatting", () => {
  assert.equal(normalizeChatTitle('**"Vacation Planning: Italy!"**'), "Vacation Planning Italy");
  assert.equal(normalizeChatTitle("one two three four five six seven"), "one two three four five six");
});

test("comparison phrasing routes to structured compare mode", () => {
  assert.equal(looksLikeComparisonRequest("Compare the iPhone and Pixel"), true);
  assert.equal(looksLikeComparisonRequest("iPhone vs. Pixel"), true);
  assert.equal(looksLikeComparisonRequest("Tell me about the iPhone"), false);
});

test("personal rules are bounded and clearly labeled in the persona prompt", () => {
  const persona = parseUserPersona({ rules: ["Never schedule before 9 AM."] });
  assert.deepEqual(persona.rules, ["Never schedule before 9 AM."]);
  assert.match(personaPromptBlock(persona), /USER RULES/);
});

test("voice fallback always fits without an ellipsis", () => {
  const text = "This is a deliberately long spoken answer with enough detail to exceed the voice display limit, followed by additional context that should never be shown as a cut off fragment or with trailing dots in the interface.";
  const result = briefForVoice(text);
  assert.ok(result.length <= VOICE_MAX_CHARS);
  assert.doesNotMatch(result, /(?:\.\.\.|…)/);
  assert.match(result, /[.!?]$/);
});

test("all common YouTube links route through video input", () => {
  const expected = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  assert.equal(youtubeVideoInputURL("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share"), expected);
  assert.equal(youtubeVideoInputURL("https://youtu.be/dQw4w9WgXcQ?si=abc"), expected);
  assert.equal(youtubeVideoInputURL("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), expected);
  assert.equal(youtubeVideoInputURL("https://www.youtube.com/live/dQw4w9WgXcQ"), expected);
  assert.equal(youtubeVideoInputURL("https://www.youtube.com/embed/dQw4w9WgXcQ"), expected);
  assert.equal(youtubeVideoInputURL("https://example.com/shorts/dQw4w9WgXcQ"), null);
});

test("usage limits add purchased credits to both plan windows", () => {
  assert.deepEqual(usageLimitsFor("plus", 5_000), { daily: 5_150, monthly: 8_000 });
  assert.deepEqual(usageLimitsFor("plus_voice", 0), { daily: 200, monthly: 4_000 });
  assert.deepEqual(usageLimitsFor("pro", 0), { daily: 750, monthly: 15_000 });
  assert.deepEqual(usageLimitsFor("free", 0), { daily: 5, monthly: 100 });
});

test("Apple account merges distinguish restored and genuinely duplicate subscriptions", () => {
  assert.deepEqual(subscriptionMergeDecision("original", ["original"]), { mode: "discard", secondaryTransactionId: "" });
  assert.deepEqual(subscriptionMergeDecision("original", ["second"]), { mode: "convert", secondaryTransactionId: "second" });
  assert.deepEqual(subscriptionMergeDecision("", ["first"]), { mode: "keep", secondaryTransactionId: "" });
});
