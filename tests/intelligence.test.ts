import assert from "node:assert/strict";
import test from "node:test";
import { capabilityAnswerFor } from "../src/capabilities.js";
import { buildConversationState } from "../src/context.js";
import { auditPlannerOutput } from "../src/plannerAudit.js";
import { calendarDirectionsQuery, fastVoiceReply, looksLikePlainVoiceKnowledgeQuestion, planAssistantResponse, planShareRequest } from "../src/planner.js";
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
import { appleMacPriceSnapshotFromHtml, espnSportsSnapshotFromResponse, flightStatsSnapshotFromHtml, parseTrackCommand, ship24StatusFromResponse } from "../src/tracker.js";
import { looksLikeEasyQuestion, looksLikeSubstantiveQuestion, looksLikeFlightQuestion, looksLikeStockQuestion, isIdentifySongRequest } from "../src/tools.js";
import { parseUserPersona, personaPromptBlock } from "../src/persona.js";
import { normalizeChatTitle } from "../src/chatTitle.js";
import { currencyConversionSource } from "../src/conversions.js";

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

test("calendar-to-driving commands resolve device calendar data before the final handoff", async () => {
  assert.equal(calendarDirectionsQuery("Get the address from my calendar entry and go there."), "");
  assert.equal(calendarDirectionsQuery("What is on my calendar tomorrow?"), null);

  const result = await planAssistantResponse(stateFor("Get the address from my calendar entry and go there."));
  assert.equal(result.action?.type, "calendar_directions");
  assert.equal(result.action?.calendarQuery, "");
  assert.equal(result.action?.daysAhead, 30);
  assert.match(result.spokenText, /check your calendar/i);
});

test("specific calendar driving commands retain the event subject", async () => {
  const result = await planAssistantResponse(stateFor("Get the address for my dentist appointment and drive there"));
  assert.equal(result.action?.type, "calendar_directions");
  assert.match(result.action?.calendarQuery || "", /dentist appointment/i);
});

test("calendar driving commands convert relative dates into search boundaries", async () => {
  assert.equal(calendarDirectionsQuery("Get tomorrow's calendar event address and go there"), "");
  assert.equal(calendarDirectionsQuery("Take me to my next calendar entry"), "");
  assert.equal(calendarDirectionsQuery("Take me to my next calendar meeting"), "meeting");

  const result = await planAssistantResponse(stateFor("Get the address from my calendar event tomorrow and drive there"));
  assert.equal(result.action?.type, "calendar_directions");
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

test("voice uses low-latency Flash v2.5 with current transcription", () => {
  assert.equal(TTS_MODEL, "eleven_flash_v2_5");
  assert.equal(STT_MODEL, "scribe_v2");
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64")), 1_000);
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64"), 1_200), 1_200);
  assert.equal(billableAudioDurationMs(Buffer.alloc(4_000).toString("base64"), 60_000), 60_000);
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

test("obvious knowledge questions bypass action planning safely in voice AND text", () => {
  const knowledge = buildConversationState("Why is the sky blue?", "", undefined, "America/New_York", undefined, undefined, true);
  const calendar = buildConversationState("What is on my calendar?", "", undefined, "America/New_York", undefined, undefined, true);
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(knowledge), true);
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(calendar), false);
  // Text mode now bypasses too — the planner round-trip was most of the
  // perceived latency on simple typed questions.
  const typedKnowledge = buildConversationState("What is the capital of France?", "", undefined, "America/New_York");
  const typedAction = buildConversationState("What is the weather today?", "", undefined, "America/New_York");
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(typedKnowledge), true);
  assert.equal(looksLikePlainVoiceKnowledgeQuestion(typedAction), false);
});

test("easy questions route to the fast model; drafting, analysis, and long asks do not", () => {
  assert.equal(looksLikeEasyQuestion("What is the capital of France?"), true);
  assert.equal(looksLikeEasyQuestion("Why is the sky blue?"), true);
  assert.equal(looksLikeEasyQuestion("Draft a friendly out-of-office message"), false);
  assert.equal(looksLikeEasyQuestion("Compare the iPhone and Pixel cameras in depth"), false);
  assert.equal(looksLikeEasyQuestion("Write a python function to parse dates"), false);
  assert.equal(looksLikeEasyQuestion("Plan a 3-day trip to Rome with a daily itinerary"), false);
  assert.equal(looksLikeEasyQuestion("What's the tallest mountain? And the deepest ocean? And the longest river?"), false);
  assert.equal(looksLikeEasyQuestion("x".repeat(200)), false);
});

test("lock-screen phrasings start trackers instead of leaking to the model", () => {
  assert.equal(parseTrackCommand("Put Apple stock on my lock screen")?.kind, "finance");
  assert.equal(parseTrackCommand("add AAPL to my lock screen")?.kind, "finance");
  assert.equal(parseTrackCommand("show the Lakers game in my Dynamic Island")?.kind, "sports");
  assert.equal(parseTrackCommand("track bitcoin")?.kind, "finance");
  // No destination and no track verb — stays a normal question.
  assert.equal(parseTrackCommand("What do you think of Apple stock?"), null);
  assert.equal(parseTrackCommand("show me apple stock"), null);
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
  assert.deepEqual(parseTrackCommand("Track the Yankees"), { kind: "sports", query: "New York Yankees" });
  assert.deepEqual(parseTrackCommand("Follow the Lakers"), { kind: "sports", query: "Los Angeles Lakers" });
  assert.deepEqual(parseTrackCommand("Keep an eye on Arsenal"), { kind: "sports", query: "Arsenal FC" });
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

test("structured sports scoreboards produce a current Live Activity snapshot", () => {
  const snapshot = espnSportsSnapshotFromResponse({
    events: [{
      date: "2026-07-18T23:05:00Z",
      competitions: [{
        date: "2026-07-18T23:05:00Z",
        status: { type: { state: "in", shortDetail: "Top 7th" } },
        competitors: [
          { homeAway: "home", score: "3", team: { displayName: "New York Yankees", shortDisplayName: "Yankees", abbreviation: "NYY" } },
          { homeAway: "away", score: "2", team: { displayName: "Boston Red Sox", shortDisplayName: "Red Sox", abbreviation: "BOS" } }
        ]
      }]
    }]
  }, "New York Yankees", "America/New_York");
  assert.equal(snapshot?.title, "Red Sox vs Yankees");
  assert.equal(snapshot?.line1, "BOS 2 – NYY 3");
  assert.equal(snapshot?.line2, "Yankees lead");
  assert.equal(snapshot?.status, "Top 7th");
  assert.equal(espnSportsSnapshotFromResponse({
    events: [{ competitions: [{
      status: { type: { state: "pre", shortDetail: "7:05 PM" } },
      competitors: [
        { homeAway: "home", team: { displayName: "Baltimore Orioles", shortDisplayName: "Orioles", abbreviation: "BAL" } },
        { homeAway: "away", team: { displayName: "Toronto Blue Jays", shortDisplayName: "Blue Jays", abbreviation: "TOR" } }
      ]
    }] }]
  }, "the Orioles game tonight")?.title, "Blue Jays vs Orioles");
});

test("official Apple Store cards produce a complete product-price comparison", () => {
  const card = (name: string, path: string, price: string) => `
    <a href="${path}">
      <div class="rf-hcard-content-title">${name}</div>
      <div class="rf-hcard-scrim-price">From <span class="nowrap">${price}</span></div>
    </a>`;
  const html = [
    card("MacBook Air", "/shop/buy-mac/macbook-air", "$1,299"),
    card("MacBook Pro", "/shop/buy-mac/macbook-pro", "$1,999"),
    card("Mac mini", "/shop/buy-mac/mac-mini", "$799")
  ].join("\n");
  const snapshot = appleMacPriceSnapshotFromHtml(html, "MacBook Air vs MacBook Pro vs Mac mini");
  assert.equal(snapshot?.line1, "$1,299 · $1,999 · $799");
  assert.equal(snapshot?.line2, "Air · Pro · mini");
  assert.equal(snapshot?.status, "Apple US starting prices");
  assert.equal(snapshot?.sources?.[0]?.url, "https://www.apple.com/shop/buy-mac");
  assert.equal(appleMacPriceSnapshotFromHtml(html, "MacBook Air vs Pixelbook"), null);
});

test("structured FlightStats pages produce a verified flight Live Activity snapshot", () => {
  const page = {
    props: { initialState: { flightTracker: { flight: {
      resultHeader: {
        carrier: { fs: "UA" }, flightNumber: "123", departureAirportFS: "LHR",
        arrivalAirportFS: "EWR", status: "Scheduled", statusDescription: "On time"
      },
      status: { status: "Scheduled", statusDescription: "On time", color: "green" },
      departureAirport: {
        iata: "LHR",
        times: { scheduled: { time: "7:45", ampm: "AM" }, estimatedActual: { title: "Estimated", time: "7:45", ampm: "AM" } }
      },
      arrivalAirport: {
        iata: "EWR",
        times: { scheduled: { time: "10:30", ampm: "AM" }, estimatedActual: { title: "Estimated", time: "10:30", ampm: "AM" } }
      }
    } } } }
  };
  const url = "https://www.flightstats.com/v2/flight-tracker/UA/123";
  const html = `<script>__NEXT_DATA__ = ${JSON.stringify(page)};__NEXT_LOADED_PAGES__=[];</script>`;
  const snapshot = flightStatsSnapshotFromHtml(html, "UA123", url);
  assert.equal(snapshot?.title, "UA123 · LHR→EWR");
  assert.equal(snapshot?.line1, "7:45a|on time");
  assert.equal(snapshot?.line2, "10:30a|on time");
  assert.equal(snapshot?.status, "Scheduled · On time");
  assert.equal(snapshot?.sources?.[0]?.url, url);
  assert.equal(flightStatsSnapshotFromHtml(html, "UA124", url), null);
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

test("live currency conversions expose the exact rate endpoint", () => {
  assert.equal(
    currencyConversionSource("Convert 100 USD to EUR"),
    "https://api.frankfurter.app/latest?from=USD&to=EUR"
  );
  assert.equal(currencyConversionSource("Convert 5 miles to kilometers"), null);
});

test("chat titles are short and stripped of model formatting", () => {
  assert.equal(normalizeChatTitle('**"Vacation Planning: Italy!"**'), "Vacation Planning Italy");
  assert.equal(normalizeChatTitle("one two three four five six seven"), "one two three four five six");
});

test("conversational choices stay on the fast tier; consequential ones escalate", () => {
  // Casual/subjective preference — genuinely conversational, keep it fast.
  assert.equal(looksLikeEasyQuestion("Which is better, apples or oranges?"), true);
  assert.equal(looksLikeSubstantiveQuestion("Which is better, apples or oranges?"), false);
  assert.equal(looksLikeSubstantiveQuestion("What's your favorite color?"), false);
  assert.equal(looksLikeSubstantiveQuestion("Is cereal a soup?"), false);

  // Objective, consequential decision — needs the informational model.
  assert.equal(looksLikeSubstantiveQuestion("Which is more worth it, a MacBook Air or a MacBook Pro?"), true);
  assert.equal(looksLikeSubstantiveQuestion("Should I buy the iPhone 15 or wait?"), true);
  assert.equal(looksLikeSubstantiveQuestion("iPhone or Galaxy?"), true);
  assert.equal(looksLikeSubstantiveQuestion("Which laptop has better battery life?"), true);
});

test("song-identification requests are detected without hijacking playback", () => {
  assert.equal(isIdentifySongRequest("What song is this?"), true);
  assert.equal(isIdentifySongRequest("what's playing"), true);
  assert.equal(isIdentifySongRequest("Shazam this"), true);
  assert.equal(isIdentifySongRequest("identify this song"), true);
  assert.equal(isIdentifySongRequest("who is this playing right now"), true);
  // Not song ID: playback command, or a trivia lookup about a named song.
  assert.equal(isIdentifySongRequest("play this song"), false);
  assert.equal(isIdentifySongRequest("who sang Bohemian Rhapsody"), false);
  assert.equal(isIdentifySongRequest("what are the lyrics to Yesterday"), false);
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
  assert.equal(VOICE_MAX_CHARS, 280);

  const longList = `Common examples include things such as ${"dogs, cats, birds, and fish, ".repeat(20)}with many more beyond those.`;
  const complete = briefForVoice(longList);
  assert.equal(complete, "Common examples include things such as dogs, cats, and birds.");
  assert.ok(complete.length <= VOICE_MAX_CHARS);
  assert.doesNotMatch(complete, /(?:such as|including|for example|like|,|;|:)\s*$/i);
  assert.match(complete, /[.!?]$/);
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
  assert.deepEqual(usageLimitsFor("free", 0), { daily: 250, monthly: 250 });
  assert.deepEqual(usageLimitsFor("free", 500), { daily: 750, monthly: 750 });
});

test("Apple account merges distinguish restored and genuinely duplicate subscriptions", () => {
  assert.deepEqual(subscriptionMergeDecision("original", ["original"]), { mode: "discard", secondaryTransactionId: "" });
  assert.deepEqual(subscriptionMergeDecision("original", ["second"]), { mode: "convert", secondaryTransactionId: "second" });
  assert.deepEqual(subscriptionMergeDecision("", ["first"]), { mode: "keep", secondaryTransactionId: "" });
});
