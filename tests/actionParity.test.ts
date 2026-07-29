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
const nativeUiSource = readFileSync(resolve(root, "app/ios/App/App/NativeTakiUI.swift"), "utf8");
const sharedContentBridgeSource = readFileSync(resolve(root, "app/ios/App/App/SharedContentBridge.swift"), "utf8");
const contactsBridgeSource = readFileSync(resolve(root, "app/ios/App/App/ContactsBridge.swift"), "utf8");
const deviceBridgeSource = readFileSync(resolve(root, "app/ios/App/App/DeviceBridge.swift"), "utf8");
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
