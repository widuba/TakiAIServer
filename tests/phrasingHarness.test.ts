import assert from "node:assert/strict";
import test from "node:test";

import {
  isIdentifySongRequest,
  isWeatherQuestion,
  looksLikeCryptoQuestion,
  looksLikeFlightQuestion,
  looksLikeMathQuestion,
  looksLikeStockQuestion,
  parseAlertCancel,
  parseHomeCommand,
  parseLocationAutomation,
  parseMusicCommand,
  parsePackageTracking,
  parsePhotosSearch,
  parsePriceAlert,
  parseRememberCommand,
  parseSceneCommand,
  parseScheduledMessage,
  parseScoreAlert
} from "../src/tools.js";
import { parseRecurring } from "../src/recurring.js";
import { routeEverydayAction } from "../src/everyday.js";
import { parseExpense, parseHabit } from "../src/tracking.js";
import { isProductKnowledgeQuestion } from "../src/productKnowledge.js";
import { looksLikeCookingRequest } from "../src/cooking.js";

/* ============================================================================
 * Adversarial phrasing harness.
 *
 * Every bug found in the feature sweep was a deterministic pre-LLM detector
 * that was either too NARROW (the real phrasing fell through to the model, or
 * to a lesser detector) or too BROAD (a topic word hijacked an unrelated
 * sentence). Fixing them one at a time kept producing new ones, because
 * widening a pattern lets it swallow a neighbouring case.
 *
 * So this asserts the whole picture at once: each phrasing is run through EVERY
 * detector, and the exact SET of detectors that claim it must match what is
 * declared. That catches both directions in a single assertion:
 *   - a missing name  -> the detector got too narrow (feature silently broke)
 *   - an extra name   -> some detector got too broad (it hijacked this sentence)
 *
 * Overlaps are often legitimate — "alert me when Apple hits 350" really is both
 * a price alert and a stock mention, and the planner's ordering resolves it. So
 * overlaps must be listed explicitly, which turns this table into the written
 * record of intended precedence.
 * ==========================================================================*/

type DetectorName =
  | "product_knowledge" | "price_alert" | "score_alert" | "alert_cancel"
  | "location_automation" | "scheduled_message" | "recurring" | "music"
  | "home" | "scene" | "photos_search" | "weather" | "stock_question"
  | "crypto_question" | "cooking" | "identify_song" | "math" | "flight"
  | "package" | "remember" | "habit" | "expense" | "everyday_reminder_edit";

const DETECTORS: { name: DetectorName; claims: (message: string) => boolean }[] = [
  { name: "product_knowledge", claims: isProductKnowledgeQuestion },
  { name: "price_alert", claims: (m) => !!parsePriceAlert(m) },
  { name: "score_alert", claims: (m) => !!parseScoreAlert(m) },
  { name: "alert_cancel", claims: (m) => !!parseAlertCancel(m) },
  { name: "location_automation", claims: (m) => !!parseLocationAutomation(m) },
  { name: "scheduled_message", claims: (m) => !!parseScheduledMessage(m) },
  { name: "recurring", claims: (m) => !!parseRecurring(m) },
  { name: "music", claims: (m) => !!parseMusicCommand(m) },
  { name: "home", claims: (m) => !!parseHomeCommand(m) },
  { name: "scene", claims: (m) => !!parseSceneCommand(m) },
  { name: "photos_search", claims: (m) => !!parsePhotosSearch(m) },
  { name: "weather", claims: isWeatherQuestion },
  { name: "stock_question", claims: looksLikeStockQuestion },
  { name: "crypto_question", claims: looksLikeCryptoQuestion },
  { name: "cooking", claims: looksLikeCookingRequest },
  { name: "identify_song", claims: isIdentifySongRequest },
  { name: "math", claims: looksLikeMathQuestion },
  { name: "flight", claims: looksLikeFlightQuestion },
  { name: "package", claims: (m) => !!parsePackageTracking(m) },
  { name: "remember", claims: (m) => !!parseRememberCommand(m) },
  { name: "habit", claims: (m) => !!parseHabit(m) },
  { name: "expense", claims: (m) => !!parseExpense(m) },
  // The everyday router edits existing reminders. Its patterns make
  // "reminder|task" optional, so they can swallow calendar entries.
  {
    name: "everyday_reminder_edit",
    claims: (m) => {
      const routed: any = routeEverydayAction(m, { timeZone: "America/New_York", previousAnswer: "" } as any);
      return String(routed?.action?.type || "").startsWith("reminder_");
    }
  }
];

function claimsFor(message: string): DetectorName[] {
  return DETECTORS.filter((d) => {
    try { return d.claims(message); } catch { return false; }
  }).map((d) => d.name);
}

// Overlap alone is harmless — what matters is which detector the planner lets
// win. Both bugs of that shape came from a LESS specific detector running first:
// parseHomeCommand ran before the location automation (so the lights came on
// immediately), and parseHabit ran before the recurring reminder (so no 8am
// alert was scheduled). This list mirrors the planner's real order, most
// specific first, so a reordering that reintroduces either bug fails here.
const PRECEDENCE: DetectorName[] = [
  "scheduled_message",      // keeps the message body, beats a plain reminder
  "recurring",              // beats habit tracking for "remind me ... every day"
  "location_automation",    // MUST beat home/music, or the action fires now
  "alert_cancel",
  "price_alert",            // beats a bare stock/crypto quote
  "score_alert",
  "identify_song",          // beats music playback
  "scene",                  // a named scene beats a single home command
  "home",
  "music",
  "everyday_reminder_edit",
  "package", "flight", "photos_search", "cooking", "remember", "habit", "expense",
  "weather", "math", "crypto_question", "stock_question", "product_knowledge"
];

function winnerFor(message: string): DetectorName | null {
  const claimed = claimsFor(message);
  return PRECEDENCE.find((name) => claimed.includes(name)) ?? null;
}

type Case = {
  message: string;
  claims: DetectorName[];
  /** Which detector must take precedence when several claim the sentence. */
  wins?: DetectorName;
  note?: string;
};

function check(cases: Case[]) {
  const failures: string[] = [];
  for (const c of cases) {
    const actual = claimsFor(c.message).sort();
    const expected = [...c.claims].sort();
    if (actual.join("|") !== expected.join("|")) {
      const missing = expected.filter((n) => !actual.includes(n));
      const extra = actual.filter((n) => !expected.includes(n as DetectorName));
      failures.push(
        `"${c.message}"\n` +
        (missing.length ? `      MISSING (detector too narrow): ${missing.join(", ")}\n` : "") +
        (extra.length ? `      EXTRA (detector too broad / hijack): ${extra.join(", ")}\n` : "") +
        (c.note ? `      note: ${c.note}\n` : "")
      );
      continue;
    }
    // Declared overlaps must still resolve to the right owner.
    const expectedWinner = c.wins ?? (c.claims.length === 1 ? c.claims[0] : undefined);
    if (expectedWinner) {
      const actualWinner = winnerFor(c.message);
      if (actualWinner !== expectedWinner) {
        failures.push(
          `"${c.message}"\n` +
          `      WRONG OWNER: expected ${expectedWinner} to win, got ${actualWinner}\n` +
          (c.note ? `      note: ${c.note}\n` : "")
        );
      }
    }
  }
  assert.equal(failures.length, 0, failures.length ? `\n    ${failures.join("\n    ")}` : "");
}

/* ---- Regressions: every bug the feature sweep turned up ------------------ */

test("harness: bugs found in the feature sweep stay fixed", () => {
  check([
    // "model" used to hijack anything containing the word.
    { message: "What is the latest iPhone model?", claims: [] },
    { message: "What model car should I buy?", claims: [] },
    { message: "What Taki model am I using?", claims: ["product_knowledge"] },

    // Taki's tiers are Plus/Premium/Pro — also the commonest hardware suffixes.
    // "iPhone 17 Pro price" was answered with Taki's own subscription pricing.
    { message: "iPhone 17 Pro price", claims: [] },
    { message: "MacBook Pro price", claims: [] },
    { message: "AirPods Pro cost", claims: [] },
    { message: "Galaxy S25 Plus price", claims: [] },
    { message: "iphone 17 pro price", claims: [], note: "lowercase typing must not slip through" },
    // ...while genuine tier questions still answer locally.
    { message: "What does Taki Pro cost?", claims: ["product_knowledge"] },
    { message: "What does Plus include?", claims: ["product_knowledge"] },

    // The imperative alert form failed the "alert me" gate entirely.
    { message: "Set a price alert for Bitcoin above 70000", claims: ["price_alert", "crypto_question"], wins: "price_alert" },
    { message: "Set an alert for Tesla below 200", claims: ["price_alert"] },
    { message: "Alert me when Bitcoin reaches 70000", claims: ["price_alert"] },

    // A location automation with no comma ran the action immediately. home/music
    // legitimately also match — the automation MUST win, or the lights come on
    // while the user is still out. That precedence is the whole bug.
    {
      message: "When I get home turn on the lights",
      claims: ["location_automation", "home"], wins: "location_automation",
      note: "home also matches; running it first is what turned the lights on immediately"
    },
    {
      message: "When I get home play music",
      claims: ["location_automation", "music"], wins: "location_automation"
    },
    {
      message: "When I leave work turn off the lights",
      claims: ["location_automation", "home"], wins: "location_automation"
    },

    // ...but a reminder that merely contains an action verb is NOT an automation.
    { message: "When I arrive at work remind me to check email", claims: [] },

    // Recurrence was being folded into the reminder title. habit_action also
    // claims a medication sentence, so recurring must win or nothing is scheduled.
    {
      message: "Remind me to take my medication every day at 8am",
      claims: ["recurring", "habit"], wins: "recurring",
      note: "habit also matches; running it first answered 'Done.' and scheduled no 8am alert"
    },
    { message: "Remind me to stretch every hour", claims: ["recurring"] },

    // Editing a calendar entry must not be claimed by the reminder editor:
    // "reminder|task" is optional in its patterns, so it swallowed appointments
    // and planned reminder_update, which fails on-device (no such reminder).
    { message: "Move my dentist appointment to Friday at 3", claims: [] },
    { message: "Reschedule my dentist appointment to Friday at 3pm", claims: [] },
    { message: "Move my 2pm meeting to 4pm", claims: [] },
    { message: "Rename my dentist appointment to checkup", claims: [] },
    // The same optional "(reminder|task)?" appeared across the whole everyday
    // family, so ordinary English claimed a reminder edit — including a writing
    // request. reminderDelete already required the explicit word; the rest now do.
    { message: "Complete the sentence for me", claims: [], note: "a writing request, not a reminder" },
    { message: "Finish my coffee", claims: [] },
    { message: "Reopen the investigation", claims: [] },
    { message: "Mark the meeting as done", claims: [], note: "meeting is a calendar entry" },
    { message: "Add the note bring snacks to the birthday party event", claims: [] },
    // ...but genuine reminder edits still belong to it.
    { message: "Complete the reminder to buy milk", claims: ["everyday_reminder_edit"] },
    { message: "Mark my grocery task as done", claims: ["everyday_reminder_edit"] },
    { message: "Reschedule my reminder to call mom to 5pm", claims: ["everyday_reminder_edit"] },
    { message: "Rename the reminder groceries to shopping", claims: ["everyday_reminder_edit"] },

    // A scheduled text must keep its body rather than collapse to a reminder.
    { message: "Remind me to text Mom happy birthday at 9am", claims: ["scheduled_message"] },
    { message: "schedule a text to Mom saying I am running late at 5pm", claims: ["scheduled_message"] }
  ]);
});

/* ---- Each intent, phrased several natural ways --------------------------- */

test("harness: one intent survives many phrasings", () => {
  check([
    // Weather
    { message: "What's the weather?", claims: ["weather"] },
    { message: "Is it going to rain today?", claims: ["weather"] },
    { message: "How cold is it outside right now?", claims: ["weather"] },

    // Home control vs scenes
    { message: "Turn off the kitchen lights", claims: ["home"] },
    { message: "Lock the front door", claims: ["home"] },
    { message: "lights out", claims: ["home"], note: "terse spoken command must still work" },
    { message: "dim the bedroom lights", claims: ["home"] },
    { message: "Goodnight", claims: ["scene"] },

    // Music
    { message: "Play some jazz", claims: ["music"] },
    { message: "Skip this song", claims: ["music"] },
    { message: "Pause the music", claims: ["music"] },

    // Song identification must not be confused with playback.
    { message: "What song is this?", claims: ["identify_song"] },
    { message: "Shazam this", claims: ["identify_song"] },

    // Photos
    { message: "Show me photos from this weekend", claims: ["photos_search"] },

    // Math
    { message: "What is 15% of 240?", claims: ["math"] },

    // Memory
    { message: "Remember that I'm vegetarian", claims: ["remember"] },

    // Tracking
    { message: "Log $20 for gas", claims: ["expense"] },
    { message: "Mark my medication", claims: ["habit"] },

    // Alerts: cancelling is distinct from creating.
    { message: "Turn off my Bitcoin alerts", claims: ["alert_cancel"] },
    { message: "Alert me when the Braves game ends", claims: ["score_alert"] }
  ]);
});

/* ---- Negative space: sentences no detector may claim --------------------- */

test("harness: ordinary questions are never claimed by a device detector", () => {
  // These are plain conversation. Any claim here means a detector is too broad,
  // which is how a topic word ends up hijacking an unrelated question.
  check([
    { message: "Explain how mRNA vaccines work", claims: [] },
    { message: "Why is the sky blue?", claims: [] },
    { message: "Who won the last Super Bowl?", claims: [] },
    { message: "Write me a haiku about autumn", claims: [] },
    { message: "What should I get my sister for her birthday?", claims: [] },
    { message: "Summarize this in one sentence: the garden opens Saturday.", claims: [] },
    { message: "I'm feeling overwhelmed today", claims: [] },
    { message: "Tell me a joke", claims: [] },
    // "lights" + a word as common as "out" used to be enough to fire a HomeKit
    // command, so a narrative sentence would switch the user's real lights off.
    { message: "The lights went out in the story", claims: [] },
    { message: "How do LED lights work?", claims: [] },
    // Weather claims this ("forecast"); it is aurora-adjacent so that is
    // defensible, but the key point is that HOME must not claim it.
    { message: "Northern lights forecast", claims: ["weather"] },
    { message: "City lights at night are pretty", claims: [] }
  ]);
});
