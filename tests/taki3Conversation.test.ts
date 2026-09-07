import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationState } from "../src/context.js";
import { classifyTaki3Request, runTaki3Plan } from "../src/taki3.js";
import { planAssistantResponse } from "../src/planner.js";

function state(
  message: string,
  turns: Array<{ role: "user" | "assistant"; text: string }> = [],
  corrections: Array<{ misunderstoodAnswer: string; userCorrection: string }> = [],
  voice = false
) {
  return buildConversationState(
    message,
    JSON.stringify({ chatMessages: turns, corrections }),
    undefined,
    "America/New_York",
    [],
    { personality: "friendly", responseLength: "balanced", model: "taki_2_0_swift" } as any,
    voice,
    "12345678"
  );
}

function answerFixture(answer: string, grounded = false) {
  return async () => ({
    text: JSON.stringify({ answer, confidence: 0.96, shouldAskClarification: false, clarifyingQuestion: null }),
    ...(grounded
      ? { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "Fixture source", uri: "https://example.com/source" } }] } }] }
      : {})
  });
}

test("Taki 3.0 keeps long-chat context and corrections bounded but available", async () => {
  const turns = Array.from({ length: 64 }, (_, index) => ({
    role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
    text: `Background turn ${index}: a harmless detail about the ongoing project.`
  }));
  turns[52] = { role: "user", text: "I am moving to Santa Fe next month." };
  turns[53] = { role: "assistant", text: "That sounds like a big change." };
  turns[60] = { role: "assistant", text: "The capital of Australia is Sydney." };
  turns[61] = { role: "user", text: "No, correct that: the capital is Canberra." };
  turns[63] = { role: "assistant", text: "I will use the correction." };

  const current = state("What city did I say I was moving to, and what is the corrected capital?", turns, [
    { misunderstoodAnswer: "Sydney", userCorrection: "The capital is Canberra." }
  ]);
  assert.equal(current.transcript.length, 64);
  assert.match(current.fullTranscriptText, /Santa Fe/);
  assert.match(current.fullTranscriptText, /Canberra/);
  assert.match(current.correctionsText, /Canberra/);
  assert.equal(classifyTaki3Request(current).kind, "direct");

  let requestText = "";
  const plan = await runTaki3Plan(current, undefined, {
    generateContent: async (request) => {
      requestText = String(request.contents);
      return answerFixture("You said Santa Fe, and the corrected capital is Canberra.")();
    }
  });
  assert.match(requestText, /Santa Fe/);
  assert.match(requestText, /Canberra/);
  assert.match(plan?.spokenText || "", /Santa Fe/);
  assert.match(plan?.spokenText || "", /Canberra/);
});

test("Taki 3.0 research turns stay one-call and require grounding", async () => {
  const current = state("What is the current price of Apple stock? Verify it and cite the source.");
  assert.equal(classifyTaki3Request(current).kind, "research");
  let calls = 0;
  const plan = await runTaki3Plan(current, undefined, {
    generateContent: async (request) => {
      calls += 1;
      assert.equal(request.config.forceWebSearch, true);
      return answerFixture("The fixture source reports the current price.", true)();
    }
  });
  assert.equal(calls, 1);
  assert.equal(plan?.sources?.length, 1);
});

test("long-chat clarification state completes without a second model call", async () => {
  const first = await planAssistantResponse(state("Text Mom"));
  assert.equal(first.action, null);
  assert.equal(first.memoryPatch.pendingClarification?.intent, "compose_message");

  const context = JSON.stringify({
    chatMessages: [
      { role: "user", text: "Text Mom" },
      { role: "assistant", text: first.spokenText },
      ...Array.from({ length: 58 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `Older context ${index}` }))
    ],
    memory: { pendingClarification: first.memoryPatch.pendingClarification }
  });
  const second = await planAssistantResponse(buildConversationState(
    "I will be there in ten minutes.",
    context,
    undefined,
    "America/New_York",
    [],
    { model: "taki_2_0_swift" } as any,
    false,
    "12345678"
  ));
  assert.equal(second.action?.type, "compose_message");
  assert.equal(second.action?.contactQuery, "Mom");
  assert.equal(second.action?.body, "I will be there in ten minutes.");
});

test("reminder commands keep the task when the time comes first", async () => {
  const cases: Array<[string, string]> = [
    ["Remind me tomorrow at 8 AM to renew my passport", "08"],
    ["Set a reminder for tomorrow at 8 AM to renew my passport", "08"],
    ["Tomorrow at 8 AM remind me to renew my passport", "08"],
    ["Tomorrow at 8 AM, remind me to renew my passport", "08"],
    ["Remind me tomorrow at 8 AM, to renew my passport", "08"],
    ["Noon Friday remind me to renew my passport", "12"],
    ["At noon Friday, remind me to renew my passport", "12"],
    ["Remind me at noon Friday to renew my passport", "12"],
    ["Set a reminder, at noon Friday, to renew my passport", "12"],
    ["At 8 AM tomorrow remind me to renew my passport", "08"],
    ["Remind me to renew my passport tomorrow at 8 AM", "08"]
  ];
  for (const [message, hour] of cases) {
    const result = await planAssistantResponse(state(message));
    assert.equal(result.action?.type, "reminder_create", message);
    assert.equal(result.action?.title, "Renew my passport", message);
    assert.match(result.action?.dueDate || "", new RegExp(`T${hour}:00:00[+-]\\d{2}:\\d{2}$`), message);
    assert.ok(Date.parse(result.action?.dueDate || "") > Date.now(), message);
  }

  const timeOnly = await planAssistantResponse(state("Remind me at 9 AM to call Mom"));
  assert.equal(timeOnly.action?.type, "reminder_create");
  assert.equal(timeOnly.action?.title, "Call Mom");
  assert.match(timeOnly.action?.dueDate || "", /T09:00:00[+-]\d{2}:\d{2}$/);
  assert.ok(Date.parse(timeOnly.action?.dueDate || "") > Date.now());
});

test("common device features remain deterministic across a long mixed conversation", async () => {
  const cases: Array<[string, string]> = [
    ["Call Mom", "call_phone"],
    ["Text Chris that I am late", "compose_message"],
    ["Email alex@example.com saying the project is ready", "compose_email"],
    ["Remind me tomorrow at 8 AM to renew my passport", "reminder_create"],
    ["Put lunch with Priya on my calendar next Friday at noon", "calendar_create"],
    ["Give me directions to Amicalola Falls", "maps_directions"],
    ["Open Settings", "open_app"],
    ["Play my road trip playlist", "music_control"],
    ["Turn the kitchen lights off", "home_control"],
    ["Add oat milk to my grocery list", "list_action"],
    ["Remember that my dog's name is Miso", "memory_save"],
    ["Show my photos from this weekend", "photos_show"],
    ["Turn my flashlight on", "flashlight_control"],
    ["How many steps did I walk yesterday?", "health_query"],
    ["Log $20 for gas", "expense_action"],
    ["Mark my medication", "habit_action"],
    ["Remind me to stretch every weekday at 7 AM", "recurring_reminder"],
    ["When I get home turn on the lights", "automation_create"],
    ["Remind me to text Mom happy birthday at 9 AM", "scheduled_message"]
  ];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const [message, expected] of cases) {
    const result = await planAssistantResponse(state(message, turns));
    assert.equal(result.action?.type, expected, message);
    turns.push({ role: "user", text: message }, { role: "assistant", text: result.spokenText });
  }
  assert.ok(turns.length >= 38);
});
