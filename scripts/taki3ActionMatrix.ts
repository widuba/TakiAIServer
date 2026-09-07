import assert from "node:assert/strict";
import { buildConversationState } from "../src/context.js";
import { runTaki3CompatibilityPlan } from "../src/taki3Compatibility.js";
import { blankAction, type AssistantAction, type AssistantActionType, type PlannerIntent } from "../src/types.js";

type MatrixCase = {
  id: string;
  message: string;
  intent: PlannerIntent;
  action: Partial<AssistantAction>;
  expectAction?: AssistantActionType;
  voice?: boolean;
};

const allowPolicy = { decision: "allow", riskCategory: "none", confidence: 0.99, reason: "safe", safeAlternative: "" };
const baseUnderstanding = {
  answerMode: "action",
  speechAct: "request",
  tone: "neutral",
  sarcasm: "unlikely",
  language: "en",
  disfluencyDetected: false,
  repeatedFragments: [],
  fillerWords: [],
  confidence: 0.98,
  needsClarification: false,
  clarifyingQuestion: null,
  missing: [],
  webQuery: null,
  researchQuery: null,
  wantsCalendar: false,
  event: null,
  contact: null,
  place: null
};

const CASES: MatrixCase[] = [
  { id: "compose-message", message: "Text Chris that I am running late", intent: "compose_message", action: { type: "compose_message", recipientName: "Chris", contactQuery: "Chris", body: "I am running late" } },
  { id: "compose-email", message: "Email Chris at chris@example.com that I am running late", intent: "compose_email", action: { type: "compose_email", recipientName: "Chris", contactQuery: "Chris", body: "I am running late", emailAddress: "chris@example.com", emailSubject: "Running late" } },
  { id: "call-phone", message: "Call Chris", intent: "call_phone", action: { type: "call_phone", recipientName: "Chris", contactQuery: "Chris" } },
  { id: "calendar-create", message: "Add a team meeting to my calendar on January 1, 2099 at 10 AM", intent: "calendar_create", action: { type: "calendar_create", title: "Team meeting", startDate: "2099-01-01T10:00:00-05:00", endDate: "2099-01-01T11:00:00-05:00", location: "Office" } },
  { id: "calendar-search", message: "Show my calendar for tomorrow", intent: "calendar_search", action: { type: "calendar_search", calendarQuery: "tomorrow", daysAhead: 1 } },
  { id: "calendar-update", message: "Move my team meeting to January 2, 2099", intent: "calendar_update", action: { type: "calendar_update", calendarQuery: "team meeting", startDate: "2099-01-02T10:00:00-05:00", endDate: "2099-01-02T11:00:00-05:00" } },
  { id: "calendar-delete", message: "Delete my team meeting from my calendar", intent: "calendar_delete", action: { type: "calendar_delete", calendarQuery: "team meeting" } },
  { id: "calendar-directions", message: "Get directions to my next calendar event", intent: "calendar_directions", action: { type: "calendar_directions", calendarQuery: "next event" } },
  { id: "calendar-forward", message: "Email my calendar event to Chris at chris@example.com", intent: "calendar_forward", action: { type: "calendar_forward", recipientName: "Chris", contactQuery: "Chris", emailAddress: "chris@example.com", shareKind: "email_event", startDate: "2099-01-01T10:00:00-05:00", endDate: "2099-01-01T11:00:00-05:00" } },
  { id: "reminder-create", message: "Remind me tomorrow to call Chris", intent: "reminder_create", action: { type: "reminder_create", title: "call Chris", dueDate: "2099-01-02T09:00:00-05:00" } },
  { id: "reminder-search", message: "Show my reminders", intent: "reminder_search", action: { type: "reminder_search", reminderQuery: "all" } },
  { id: "reminder-update", message: "Reschedule my reminder to call Chris to January 2, 2099 at 9 AM", intent: "reminder_update", action: { type: "reminder_update", reminderQuery: "call Chris", title: "call Chris", dueDate: "2099-01-02T09:00:00-05:00" } },
  { id: "reminder-delete", message: "Delete my reminder to call Chris", intent: "reminder_delete", action: { type: "reminder_delete", reminderQuery: "call Chris" } },
  { id: "open-app", message: "Open Maps", intent: "open_app", action: { type: "open_app", appName: "Maps" } },
  { id: "maps-search", message: "Search Maps for coffee near me", intent: "maps_search", action: { type: "maps_search", mapsQuery: "coffee near me" } },
  { id: "maps-directions", message: "Get directions to the airport", intent: "maps_directions", action: { type: "maps_directions", mapsDestination: "the airport" } },
  { id: "personal-search", message: "Search my chats for the project plan", intent: "personal_search", action: { type: "personal_search", personalSearchQuery: "project plan" } },
  { id: "contact-create", message: "Save Chris as a contact with phone 404-555-1212", intent: "contact_create", action: { type: "contact_create", recipientName: "Chris", recipientPhone: "404-555-1212", contactQuery: "Chris" } },
  { id: "contact-search", message: "Find Chris in my contacts", intent: "contact_search", action: { type: "contact_search", contactQuery: "Chris" } },
  { id: "contact-update", message: "Update Chris's contact and change the phone to 404-555-1212", intent: "contact_update", action: { type: "contact_update", contactQuery: "Chris", contactField: "phone", recipientPhone: "404-555-1212" } },
  { id: "contact-delete", message: "Delete Chris's contact", intent: "contact_delete", action: { type: "contact_delete", contactQuery: "Chris" } },
  { id: "health-query", message: "How many steps did I take today", intent: "health_query", action: { type: "health_query", metric: "steps", healthDayOffset: 0, healthDayLabel: "today" } },
  { id: "health-log", message: "Log 64 ounces of water", intent: "health_query", action: { type: "health_log", healthLogMetric: "water", healthLogValue: 64 } },
  { id: "home-control", message: "Turn on the living room lights", intent: "home_control", action: { type: "home_control", homeAction: "lightsOn", homeTarget: "living room" } },
  { id: "music-control", message: "Play jazz music", intent: "music_control", action: { type: "music_control", musicAction: "play", musicQuery: "jazz" } },
  { id: "photos-show", message: "Show my recent photos", intent: "photos_show", action: { type: "photos_show", photoDays: 0 } },
  { id: "photos-search", message: "Find photos of my dog", intent: "photos_show", action: { type: "photos_search", photoQuery: "dog" } },
  { id: "live-activity", message: "Track my commute to work", intent: "live_activity", action: { type: "live_activity", liveActivityKind: "commute", liveActivityMode: "driving", trackKind: "product", trackQuery: "work", liveTitle: "Commute" } },
  { id: "day-plan", message: "Plan my day", intent: "day_plan", action: { type: "day_plan", planItems: [{ type: "task", title: "Work", startDate: "2099-01-01T09:00:00-05:00", durationMin: 60 }] } },
  { id: "service-handoff", message: "Open Uber for a ride to the airport", intent: "service_handoff", action: { type: "service_handoff", service: "uber", serviceKind: "ride", serviceLabel: "Uber", serviceDestination: "the airport" } },
  { id: "list-action", message: "Add milk to my grocery list", intent: "list_action", action: { type: "list_action", listOp: "add", listName: "grocery", listItem: "milk" } },
  { id: "expense-action", message: "Log a $12 lunch expense", intent: "expense_action", action: { type: "expense_action", expenseOp: "log", expenseAmount: 12, expenseCategory: "lunch" } },
  { id: "habit-action", message: "Log my workout habit", intent: "habit_action", action: { type: "habit_action", habitOp: "log", habitName: "workout" } },
  { id: "automation-create", message: "Create an automation to remind me to check email when I arrive at work", intent: "automation_create", action: { type: "automation_create", automationTrigger: "arrive", automationPlace: "work", automationAction: "remind me to check email" } },
  { id: "scheduled-message", message: "Schedule a text to Chris tomorrow at 9 AM saying I will call", intent: "scheduled_message", action: { type: "scheduled_message", recipientName: "Chris", contactQuery: "Chris", body: "I will call", dueDate: "2099-01-02T09:00:00-05:00", title: "Text Chris" } },
  { id: "cooking-mode", message: "Make me a pasta recipe", intent: "cooking_mode", action: { type: "cooking_mode", recipe: { title: "Pasta", servings: "2", totalTime: "20 minutes", ingredients: ["pasta"], steps: [{ instruction: "Boil the pasta", timerMin: null }] } } },
  { id: "cooking-schedule", message: "Schedule cooking pasta for tomorrow", intent: "cooking_schedule", action: { type: "cooking_schedule", title: "Cook pasta", dueDate: "2099-01-02T18:00:00-05:00", recipe: { title: "Pasta", servings: "2", totalTime: "20 minutes", ingredients: ["pasta"], steps: [{ instruction: "Boil the pasta", timerMin: null }] } } },
  { id: "alert-create", message: "Alert me when AAPL drops below 100", intent: "alert_create", action: { type: "alert_create", alertKind: "price", alertQuery: "AAPL", alertTarget: 100, alertDirection: "below" } },
  { id: "alert-cancel", message: "Cancel my AAPL price alert", intent: "alert_cancel", action: { type: "alert_cancel", alertKind: "price", alertQuery: "AAPL" } },
  { id: "recurring-reminder", message: "Remind me every weekday to stretch", intent: "recurring_reminder", action: { type: "recurring_reminder", title: "stretch", recurKind: "weekly", recurHour: 9, recurMinute: 0, recurWeekdays: [2, 3, 4, 5, 6] } },
  { id: "memory-save", message: "Remember that I prefer aisle seats", intent: "memory_save", action: { type: "memory_save", memoryOperation: "save", memoryFact: "I prefer aisle seats" } },
  { id: "share-content", message: "Share this answer", intent: "share_content", action: { type: "share_content", shareKind: "text", shareText: "This answer" } },
  { id: "clipboard-copy", message: "Copy this to my clipboard", intent: "clipboard_copy", action: { type: "clipboard_copy", body: "This text" } },
  { id: "file-export", message: "Save this as a file", intent: "file_export", action: { type: "file_export", body: "This text", title: "Export" } },
  { id: "flashlight-control", message: "Turn on the flashlight", intent: "flashlight_control", action: { type: "flashlight_control", deviceAction: "on" } },
  { id: "device-status", message: "Check my phone battery status", intent: "device_status", action: { type: "device_status", metric: "battery" } },
  { id: "action-history", message: "Show my recent activity", intent: "action_history", action: { type: "action_history" } },
  { id: "undo-last", message: "Undo that", intent: "undo_last", action: { type: "undo_last" } }
];

function fixtureFor(item: MatrixCase): Record<string, unknown> {
  return {
    intent: item.intent,
    ...baseUnderstanding,
    action: { ...blankAction(item.action.type as AssistantActionType), ...item.action },
    contact: null,
    place: null,
    event: null
  };
}

async function run(item: MatrixCase, variant: number): Promise<{ id: string; action: string | null; spokenText: string }> {
  const fixture = fixtureFor(item);
  const calls: any[] = [];
  const deps = {
    generateContent: async (request: any) => {
      calls.push(request);
      if (request?.config?.responseJsonSchemaName === "taki3_specialist_understanding") {
        return { text: JSON.stringify(fixture) };
      }
      if (request?.config?.responseJsonSchemaName === "taki3_specialist_policy") {
        return { text: JSON.stringify(allowPolicy) };
      }
      return { text: JSON.stringify({ answer: "A useful answer." }) };
    }
  };
  const prefixes = ["", "Please ", "Could you please "];
  const message = `${prefixes[variant % prefixes.length]}${item.message.charAt(0).toLocaleLowerCase()}${item.message.slice(1)}`;
  const plan = await runTaki3CompatibilityPlan(
    buildConversationState(message, "", undefined, "America/New_York", undefined, undefined, Boolean(item.voice), `taki3-action-matrix-${item.id}-${variant}`),
    undefined,
    deps
  );
  return { id: `${item.id}/${variant}`, action: plan.action?.type || null, spokenText: plan.spokenText };
}

const rows: { id: string; action: string | null; spokenText: string }[] = [];
for (const item of CASES) {
  for (let variant = 0; variant < 3; variant += 1) {
    try {
      rows.push(await run(item, variant));
    } catch (error) {
      console.error(`matrix case failed before planning: ${item.id}/${variant}`);
      throw error;
    }
  }
}

const failures: { id: string; expected: string; actual: string | null; spokenText: string }[] = [];
for (const row of rows) {
  const itemId = row.id.slice(0, row.id.lastIndexOf("/"));
  const item = CASES.find((candidate) => candidate.id === itemId);
  assert.ok(item, `unknown matrix row ${row.id}`);
  const expected = item.expectAction || item.action.type;
  if (row.action !== expected) failures.push({ id: row.id, expected, actual: row.action, spokenText: row.spokenText });
}

const summary = {
  brain: "taki3",
  cases: CASES.length,
  variantsPerCase: 3,
  total: rows.length,
  passed: rows.length - failures.length,
  failed: failures.length,
  failures
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
