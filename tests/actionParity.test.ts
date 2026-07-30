import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(process.cwd(), "..");
const serverEntry = readFileSync(resolve(root, "server/index.ts"), "utf8");
const serverTypes = readFileSync(resolve(root, "server/src/types.ts"), "utf8");
const appSource = readFileSync(resolve(root, "app/src/App.tsx"), "utf8");
const appProfileSource = readFileSync(resolve(root, "app/src/userProfile.ts"), "utf8");
const appStyles = readFileSync(resolve(root, "app/src/App.css"), "utf8");
const onboardingSource = readFileSync(resolve(root, "app/src/Onboarding.tsx"), "utf8");
const routineStoreSource = readFileSync(resolve(root, "app/src/routineStore.ts"), "utf8");
const nativeUiSource = readFileSync(resolve(root, "app/ios/App/App/NativeTakiUI.swift"), "utf8");
const sharedContentBridgeSource = readFileSync(resolve(root, "app/ios/App/App/SharedContentBridge.swift"), "utf8");
const contactsBridgeSource = readFileSync(resolve(root, "app/ios/App/App/ContactsBridge.swift"), "utf8");
const calendarBridgeSource = readFileSync(resolve(root, "app/ios/App/App/CalendarBridge.swift"), "utf8");
const remindersBridgeSource = readFileSync(resolve(root, "app/ios/App/App/RemindersBridge.swift"), "utf8");
const deviceBridgeSource = readFileSync(resolve(root, "app/ios/App/App/DeviceBridge.swift"), "utf8");
const cloudSyncBridgeSource = readFileSync(resolve(root, "app/ios/App/App/CloudSyncBridge.swift"), "utf8");
const permissionsBridgeSource = readFileSync(resolve(root, "app/ios/App/App/PermissionsBridge.swift"), "utf8");
const carPlaySource = readFileSync(resolve(root, "app/ios/App/App/CarPlaySceneDelegate.swift"), "utf8");

function quotedValues(source: string): Set<string> {
  return new Set(Array.from(source.matchAll(/"([a-z][a-z0-9_]*)"/g), (match) => match[1]));
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing contract marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing contract terminator after: ${start}`);
  return source.slice(from, to);
}

const wireActions = quotedValues(
  between(serverTypes, "export type AssistantActionType =", "export type AssistantAction =")
);

const appExecutor = between(
  appSource,
  "async function executeAction(",
  "const iconStroke ="
);
const appHandled = quotedValues(appExecutor);

const carPlayExecutor = between(
  carPlaySource,
  "private func execute(_ action: VoiceAction)",
  "// MARK: Native CarPlay actions"
);
const carPlayHandled = quotedValues(carPlayExecutor);

const responseOnly = new Set(["answer_only", "weather_answer"]);

test("server wire actions have explicit iPhone/iPad and CarPlay behavior", () => {
  const expectedExecutable = [...wireActions].filter((action) => !responseOnly.has(action));
  const missingOnPhone = expectedExecutable.filter((action) => !appHandled.has(action));
  const missingOnCarPlay = expectedExecutable.filter((action) => !carPlayHandled.has(action));
  assert.deepEqual(missingOnPhone, [], `Missing iPhone/iPad handlers: ${missingOnPhone.join(", ")}`);
  assert.deepEqual(missingOnCarPlay, [], `Missing CarPlay handlers: ${missingOnCarPlay.join(", ")}`);
});

const mustConfirm = new Set([
  "compose_message", "call_phone", "compose_email", "open_app", "service_handoff",
  "calendar_forward", "share_content", "maps_search", "maps_directions", "calendar_directions",
  "calendar_create", "calendar_update", "calendar_delete", "reminder_create",
  "recurring_reminder", "reminder_update", "reminder_delete", "live_activity",
  "alarm_set", "alarm_cancel", "timer_set", "timer_cancel", "stopwatch_start",
  "stopwatch_stop", "contact_create", "contact_update", "contact_delete",
  "clipboard_copy", "file_export", "flashlight_control", "health_log", "home_control",
  "music_control", "list_action", "expense_action", "habit_action", "automation_create",
  "scheduled_message", "cooking_schedule", "alert_create", "alert_cancel",
  "memory_save", "day_plan"
]);

test("Ask for Confirmation covers the same external and mutating actions on phone and CarPlay", () => {
  const phoneConfirm = quotedValues(
    between(appSource, "const CONFIRMABLE_ACTION_TYPES", "function actionNeedsUserConfirmation")
  );
  const carConfirm = quotedValues(
    between(carPlaySource, "private static func actionNeedsConfirmation", "private static func confirmationPrompt")
  );
  for (const action of mustConfirm) {
    assert.ok(phoneConfirm.has(action), `iPhone/iPad confirmation missing ${action}`);
    assert.ok(carConfirm.has(action), `CarPlay confirmation missing ${action}`);
  }
});

test("removed inbox connections cannot re-enter the planner or Apple clients", () => {
  const shippingContract = [
    serverEntry,
    serverTypes,
    readFileSync(resolve(root, "server/src/planner.ts"), "utf8"),
    appSource,
    carPlaySource
  ].join("\n");
  assert.doesNotMatch(shippingContract, /\bemail_connect\b|\bemailAuthUrl\b/);
  assert.doesNotMatch(shippingContract, /Settings\s*→\s*Email/);
  assert.doesNotMatch(serverEntry, /\/api\/email\/(?:connect|callback|status|search|send|disconnect)/);
});

test("retired Personal Rules and clipboard-import surfaces stay removed", () => {
  const retiredSurfaces = [appSource, appProfileSource, nativeUiSource, sharedContentBridgeSource].join("\n");
  assert.doesNotMatch(retiredSurfaces, /\bTakiRulesView\b|Personal Rules|sharedReaderPaste|readClipboard/);
  assert.doesNotMatch(appProfileSource, /^\s*rules:\s/m);
});

test("explicit memory actions use the structured correction-safe store on phone and CarPlay", () => {
  assert.match(serverTypes, /memoryOperation:\s*"save"\s*\|\s*"forget"\s*\|\s*"clear"/);
  assert.match(appSource, /applyMemoryOperation\(userProfileRef\.current, operation, fact/);
  assert.doesNotMatch(appSource, /saveMemoryFromAction/);
  assert.match(carPlaySource, /profile\["memories"\]\s*=\s*memories/);
  assert.doesNotMatch(carPlaySource, /profile\["about"\]\s*=\s*current\.isEmpty\s*\?\s*fact/);
});

test("typed request failures remain visible and truthful inside the conversation", () => {
  assert.match(appSource, /function conversationalRequestFailure\(/);
  assert.match(appSource, /I kept your request in this chat/);
  assert.match(
    appSource,
    /appendMessageToChat\(chatIdForRequest, makeChatMessage\("assistant", failure\)\)/
  );
  assert.match(appSource, /I won't pretend it did/);
});

test("retired Clock, Daily Briefing, and Active Alerts surfaces cannot reappear", () => {
  const shippingUi = [appSource, appProfileSource, appStyles, onboardingSource, nativeUiSource].join("\n");
  assert.doesNotMatch(
    shippingUi,
    /ClockTab|TakiClockView|Daily briefing|morning briefing|morningBriefing|TakiBriefingView|Active alerts|TakiAlertsView|clock-toggle/
  );
  assert.doesNotMatch(serverTypes, /recurIsBriefing/);
});

test("external action failures override optimistic server confirmations", () => {
  for (const fallback of [
    "I couldn't set up that location automation.",
    "I couldn't set up that scheduled message.",
    "I couldn't set up that recurring reminder.",
    "I couldn't set up that cooking reminder.",
    "I couldn't set up that alert.",
    "I couldn't cancel those alerts.",
    "I couldn't save that to Health.",
    "I couldn't reach your home accessories.",
    "I couldn't control Apple Music.",
    "I couldn't start that Live Activity."
  ]) {
    assert.match(appSource, new RegExp(`throw e instanceof Error \\? e : new Error\\(${JSON.stringify(fallback).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  }
});

test("multi-action execution reports partial success on phone, voice, and CarPlay", () => {
  assert.match(appSource, /executeActionBatch\(requestedActions/);
  assert.match(appSource, /executionReceiptText\(multiActions, batch/);
  assert.match(appSource, /executionReceiptText\(pending\.actions, batch/);
  assert.match(carPlaySource, /var successes:\s*\[\(VoiceAction, String\)\]/);
  assert.ok(carPlaySource.includes("I completed \\(successes.count) of \\(actions.count) actions"));
  assert.doesNotMatch(carPlaySource, /for action in actions \{\s*results\.append\(try await execute\(action\)\)/s);
});

test("permission recovery opens a verified Settings destination and queues every CarPlay handoff", () => {
  assert.match(permissionsBridgeSource, /UIApplication\.shared\.open\(url, options: \[:\]\) \{ opened in/);
  assert.match(permissionsBridgeSource, /if opened \{ call\.resolve\(\["ok": true\]\) \}/);
  assert.doesNotMatch(appSource, /PermissionsBridge\.openSettings\(\); \} catch \{ \/\* not on device \*\/ \}\s*appendMessageToChat\([^\n]+"Done\."/);
  for (const kind of ["Calendar", "Reminders", "Contacts", "Apple Music", "Health", "Photos", "Notifications"]) {
    assert.match(carPlaySource, new RegExp(`queuePhonePermission\\("${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
  }
});

test("phone and CarPlay distinguish answer timeout, capacity, configuration, and voice failures", () => {
  for (const kind of ["ai_timeout", "ai_quota", "ai_auth", "voice_unavailable"]) {
    assert.match(appSource, new RegExp(`serviceError === "${kind}"`));
    assert.match(carPlaySource, new RegExp(`serviceError == "${kind}"`));
  }
  assert.match(appSource, /stopped waiting instead of leaving you stuck/);
  assert.match(carPlaySource, /stopped waiting instead of leaving you stuck/);
});

test("executable action confirmations do not require a second model call", () => {
  assert.doesNotMatch(serverEntry, /response\.spokenText = await styleInCharacter\(response\.spokenText/);
  assert.doesNotMatch(serverEntry, /response\.spokenText && \(response\.action \|\| response\.memory\?\.pendingClarification\)/);
});

test("undo uses exact expiring native identifiers on iPhone, iPad, and CarPlay", () => {
  const iphoneUndo = appSource.match(/async function undoLastCreatedItem[\s\S]*?\n}\n\nasync function executeAction/)?.[0] || "";
  assert.match(calendarBridgeSource, /"identifier": event\.eventIdentifier/);
  assert.match(calendarBridgeSource, /func deleteEventByIdentifier/);
  assert.match(remindersBridgeSource, /"identifier": reminder\.calendarItemIdentifier/);
  assert.match(remindersBridgeSource, /func deleteReminderByIdentifier/);
  assert.match(contactsBridgeSource, /"identifier": contact\.identifier/);
  assert.match(contactsBridgeSource, /func deleteContactByIdentifier/);
  assert.match(appSource, /UNDO_RECEIPT_MAX_AGE_MS = 30 \* 60 \* 1000/);
  assert.match(appSource, /CalendarBridge\.deleteEventByIdentifier\(\{ identifier: receipt\.identifier \}\)/);
  assert.match(appSource, /RemindersBridge\.deleteReminderByIdentifier\(\{ identifier: receipt\.identifier \}\)/);
  assert.match(appSource, /ContactsBridge\.deleteContactByIdentifier\(\{ identifier: receipt\.identifier \}\)/);
  assert.match(carPlaySource, /undoReceiptMaxAge: TimeInterval = 30 \* 60/);
  assert.match(carPlaySource, /eventStore\.event\(withIdentifier: receipt\.identifier\)/);
  assert.match(carPlaySource, /eventStore\.calendarItem\(withIdentifier: receipt\.identifier\)/);
  assert.ok(iphoneUndo, "the bounded iPhone undo function should be present");
  assert.doesNotMatch(iphoneUndo, /(?:searchEvents|searchReminders|searchByName)/);
  assert.match(appSource, /const verifiedReply = executionReceiptText\(requestedActions, batch, correctedText\)/);
});

test("verified action history is private, bounded, shared with CarPlay, and preserves undo", () => {
  assert.match(deviceBridgeSource, /takiVerifiedActionHistoryV1/);
  assert.match(deviceBridgeSource, /maximumRecords = 30/);
  assert.match(deviceBridgeSource, /maximumAge: TimeInterval = 7 \* 24 \* 60 \* 60/);
  assert.match(deviceBridgeSource, /UserDefaults\(suiteName: kAppGroupID\)/);
  assert.match(deviceBridgeSource, /func recordActionOutcome/);
  assert.match(appSource, /async function executeRecordedAction/);
  assert.match(appSource, /DeviceBridge\.recordActionOutcome/);
  assert.match(appSource, /action\.type !== "undo_last" && action\.type !== "action_history"/);
  assert.match(carPlaySource, /TakiActionHistoryStore\.append/);
  assert.match(carPlaySource, /case "action_history": return TakiActionHistoryStore\.spokenSummary\(\)/);
  assert.match(nativeUiSource, /struct TakiRecentActivityView/);
  assert.match(nativeUiSource, /Label\("Recent Activity", systemImage: "checkmark\.shield"\)/);
});

test("phone calls use a verified native handoff", () => {
  assert.match(contactsBridgeSource, /CAPPluginMethod\(name: "callPhone"/);
  assert.match(contactsBridgeSource, /UIApplication\.shared\.canOpenURL\(url\)/);
  assert.match(contactsBridgeSource, /if opened \{ call\.resolve\(\["opened": true\]\) \}/);
  assert.match(appSource, /await ContactsBridge\.callPhone\(\{ phone \}\)/);
  assert.match(appSource, /if \(!result\.opened\) throw new Error\("Phone did not open\."\)/);
});

test("maps and service handoffs are verified before success is shown", () => {
  assert.match(deviceBridgeSource, /UIApplication\.shared\.open\(url, options: \[:\]\) \{ opened in/);
  assert.match(deviceBridgeSource, /\["https", "http", "uber", "lyft"\]\.contains\(scheme\)/);
  assert.match(appSource, /async function openMapsDirections/);
  assert.match(appSource, /await openExternalURL\(url\)/);
  assert.match(appSource, /if \(!\/\^\(uber\|lyft\):\/i\.test\(url\)\) throw error/);
  assert.match(appSource, /await openExternalURL\(buildServiceUrl\(action\)\)/);
});

test("CarPlay and iPhone use the same revisioned iCloud envelope", () => {
  assert.match(appSource, /JSON\.stringify\(\{ t, data \}\)/);
  assert.match(carPlaySource, /envelope\["t"\] is NSNumber/);
  assert.match(carPlaySource, /let inner = envelope\["data"\] as\? String/);
  assert.match(carPlaySource, /"t": revision/);
  assert.match(carPlaySource, /guard cloud\.string\(forKey: key\) == envelopeJSON/);
  assert.match(carPlaySource, /iCloud didn't keep that \\.* update, so I didn't mark it complete/);
});

test("personal management writes are verified and rolled back on local failure", () => {
  assert.match(appSource, /localStorage\.getItem\(LISTS_KEY\) !== serialized/);
  assert.match(appSource, /localStorage\.getItem\(EXPENSES_KEY\) !== serialized/);
  assert.match(appSource, /localStorage\.getItem\(HABITS_KEY\) !== serialized/);
  assert.match(appSource, /list\.pop\(\);\s+if \(!existed\) delete listsStore\[name\]/);
  assert.match(appSource, /expensesStore\.pop\(\); throw error/);
  assert.match(appSource, /if \(!existed\) delete habitsStore\[name\]/);
  const listCloudMerge = between(appSource, "function mergeCloudLists(", "function niceListName(");
  assert.doesNotMatch(listCloudMerge, /union|local\.some|local\.push/);
  assert.match(listCloudMerge, /Object\.assign\(listsStore, cloud\)/);
});

test("routine deletions have durable tombstones and cannot be merged back", () => {
  assert.match(routineStoreSource, /TOMBSTONE_KEY = "taki-routine-tombstones-v1"/);
  assert.match(routineStoreSource, /routineSyncPayload/);
  assert.match(routineStoreSource, /normalizeRoutineSyncPayload/);
  assert.match(appSource, /routineTombstonesRef/);
  assert.match(appSource, /\.filter\(\(routine\) => !deleted\[routine\.id\] \|\| routine\.updatedAt > deleted\[routine\.id\]\)/);
  assert.match(appSource, /\[id\]: new Date\(\)\.toISOString\(\)/);
  assert.match(appSource, /JSON\.stringify\(routineSyncPayload\(next, deleted\)\)/);
});

test("transient iCloud failures retain a monotonic durable outbox", () => {
  assert.match(appSource, /CLOUD_PENDING_PREFIX = "ios-ai-cloud-pending-"/);
  assert.match(appSource, /const t = Math\.max\(Date\.now\(\), priorRevision \+ 1\)/);
  assert.match(appSource, /async function flushPendingCloudWrites\(\)/);
  assert.match(appSource, /async function uploadCloudEnvelope\(/);
  assert.match(appSource, /cloudEnvelopeRevision\(remote\.value \|\| ""\) > pendingRevision/);
  assert.match(appSource, /return "superseded"/);
  assert.match(appSource, /if \(localStorage\.getItem\(`\$\{CLOUD_PENDING_PREFIX\}\$\{key\}`\)\) return null/);
  assert.match(appSource, /if \(localStorage\.getItem\(`\$\{CLOUD_PENDING_PREFIX\}\$\{key\}`\) === envelope\)/);
  assert.match(carPlaySource, /let revision = max\(Int64\(Date\(\)\.timeIntervalSince1970 \* 1000\), priorRevision \+ 1\)/);
  assert.match(cloudSyncBridgeSource, /FileManager\.default\.ubiquityIdentityToken != nil/);
  assert.match(cloudSyncBridgeSource, /guard store\.string\(forKey: key\) == value/);
  assert.match(carPlaySource, /iCloud isn't available, so I couldn't safely save/);
});
