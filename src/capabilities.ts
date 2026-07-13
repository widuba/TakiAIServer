/* ============================================================================
 * Shipping capability contract.
 *
 * This is deliberately written from the actions the current iPhone app actually
 * executes. Prompts use the same source of truth, so a fallback answer cannot
 * forget that Taki can perform an action that the planner already supports.
 * ==========================================================================*/

export type Capability = {
  id: string;
  summary: string;
  examples: string;
  questionPatterns: RegExp[];
};

export const CAPABILITIES: Capability[] = [
  {
    id: "communication",
    summary: "draft texts and emails, forward calendar information to contacts or direct addresses, place calls, save contacts, and prepare scheduled messages",
    examples: "text Mom my next event, email tomorrow's calendar, call Alex, save a phone number, remind me to text someone later",
    questionPatterns: [/\b(text|message|email|call|phone|contacts?|scheduled messages?)\b/i]
  },
  {
    id: "calendar-reminders",
    summary: "create, find, update, remove, and forward calendar events and create or search reminders",
    examples: "add dinner Friday at 7, text Bill my meeting details, move the meeting, remind me when I get home",
    questionPatterns: [/\b(calendar|events?|appointments?|reminders?)\b/i]
  },
  {
    id: "navigation-weather",
    summary: "search nearby places, open directions, report the user's location, and answer weather questions",
    examples: "coffee near me, directions home, where am I, will it rain",
    questionPatterns: [/\b(maps?|directions?|navigate|nearby|places?|location|weather)\b/i]
  },
  {
    id: "device",
    summary: "open supported apps and control alarms, timers, stopwatches, Apple Music, and HomeKit devices",
    examples: "open Spotify, alarm at 7, timer for 10 minutes, play jazz, turn off the kitchen lights",
    questionPatterns: [/\b(open apps?|alarms?|timers?|stopwatches?|music|songs?|homekit|lights?|locks?|thermostat)\b/i]
  },
  {
    id: "health",
    summary: "read many HealthKit measurements, log supported health entries, and compare health trends",
    examples: "steps yesterday, sleep this week, log my water, how has my heart rate changed",
    questionPatterns: [/\b(health|healthkit|steps?|sleep|heart rate|workouts?|water|weight|blood pressure)\b/i]
  },
  {
    id: "photos",
    summary: "show recent photos, search the photo library on device, and analyze attached photos, supported files, pasted text, public webpages, and public YouTube videos",
    examples: "show this weekend's photos, what is in this picture, summarize this PDF, use this webpage as a source",
    questionPatterns: [/\b(photos?|pictures?|images?|camera|attachments?|files?|pdfs?|webpages?|youtube)\b/i]
  },
  {
    id: "organization",
    summary: "manage lists, expenses, habits, remembered personal facts, recurring reminders, and day plans",
    examples: "add milk to groceries, log $20 for gas, mark my medication, remember I'm vegetarian, plan my day",
    questionPatterns: [/\b(lists?|groceries|expenses?|spending|habits?|remember|memory|plan my day|day plans?)\b/i]
  },
  {
    id: "automation",
    summary: "run HomeKit scenes and routines and create supported location automations",
    examples: "goodnight, when I get home play music, run my morning routine",
    questionPatterns: [/\b(automations?|routines?|scenes?|when i (arrive|leave|get))\b/i]
  },
  {
    id: "live-information",
    summary: "look up current information and track supported sports, product prices, markets, flights, countdowns, and alerts",
    examples: "latest score, compare MacBook prices, AAPL price, track my flight, alert me when Bitcoin reaches a price",
    questionPatterns: [/\b(current|latest|news|scores?|stocks?|crypto|prices?|flights?|track|alerts?|live activit)\w*\b/i]
  },
  {
    id: "cooking-services",
    summary: "guide supported recipes and hand requests off to ride, food, grocery, and reservation apps for confirmation",
    examples: "walk me through a recipe, get an Uber, open DoorDash, find a table with OpenTable",
    questionPatterns: [/\b(cook|cooking|recipes?|uber|lyft|doordash|food delivery|groceries|reservations?|opentable|resy)\b/i]
  }
];

export function capabilityPromptBlock(): string {
  const lines = CAPABILITIES.map((cap) => `- ${cap.summary}. Examples: ${cap.examples}.`);
  return `TAKI'S SHIPPING CAPABILITIES (authoritative; these are implemented now):\n${lines.join("\n")}\n- Some capabilities still require device permission, a configured account, supported hardware/app, or user confirmation. State that specific requirement when relevant; never turn it into a blanket claim that Taki cannot do the task.\n- Taki can analyze supported attachments but cannot generate or return photos, videos, audio, downloadable files, or other media. Never claim that it created one.\n- Do not claim any ability outside this list or imply that an action completed unless an executable action is returned.`;
}

function isGenericCapabilityQuestion(message: string): boolean {
  const m = message.trim();
  return (
    /^(what (?:all )?can you do|what are your capabilities|what can taki do|show me what you can do)[?!.]*$/i.test(m) ||
    /^(can you|are you able to|do you know how to)\s+[^?!.]+[?!.]*$/i.test(m)
  );
}

// Answer only questions ABOUT an ability. Concrete commands such as "can you
// set an alarm for 7" continue through the normal planner and execute.
export function capabilityAnswerFor(message: string): string | null {
  if (!isGenericCapabilityQuestion(message)) return null;
  if (/^(what (?:all )?can you do|what are your capabilities|what can taki do|show me what you can do)/i.test(message.trim())) {
    return "I can handle communication, calendars and reminders, maps and weather, HealthKit, photos, music and HomeKit, alarms and timers, lists and routines, live information and tracking, cooking, and supported service handoffs.";
  }

  const matches = CAPABILITIES.filter((cap) => cap.questionPatterns.some((pattern) => pattern.test(message)));
  if (matches.length !== 1) return null;

  const requested = message.replace(/^(can you|are you able to|do you know how to)\s+/i, "").trim();
  if (/^can you\b/i.test(message) && /^(text|message|email|call|save|add|create|set|start|stop|open|play|show|find|search|turn|control|lock|unlock|remind|navigate|log|track|alert|get|book|order)\b/i.test(requested)) {
    return null;
  }

  // A time, quoted title, destination, recipient, or other concrete detail means
  // the user probably wants the action performed, not a yes/no capability reply.
  if (/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b|["“”]|\b(?:to|for|at|with)\s+[A-Z][\w'-]+/.test(message)) {
    return null;
  }
  return `Yes. I can ${matches[0].summary}.`;
}
