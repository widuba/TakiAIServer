import assert from "node:assert/strict";
import test from "node:test";
import {
  actionReceiptLabel,
  executionReceiptText,
  isPermissionFailureMessage,
  type ReceiptAction
} from "../../app/src/actionReceipt.js";

test("recent activity has a clear receipt label", () => {
  assert.equal(actionReceiptLabel({ type: "action_history" }), "recent activity check");
});

test("partial phone action success names both completed and failed work", () => {
  const calendar: ReceiptAction = { type: "calendar_create", title: "Dentist" };
  const reminder: ReceiptAction = { type: "reminder_create", title: "Bring insurance card" };
  const text = executionReceiptText(
    [calendar, reminder],
    {
      successes: [{ raw: calendar, action: calendar, reply: "Added Dentist." }],
      failures: [{ raw: reminder, action: reminder, detail: "Reminders access isn't enabled." }]
    },
    "Done."
  );

  assert.match(text, /completed 1 of 2 actions/i);
  assert.match(text, /calendar event “Dentist”/);
  assert.match(text, /reminder “Bring insurance card”: Reminders access isn't enabled/);
  assert.doesNotMatch(text, /^Done\.?$/i);
});

test("zero and single-action failures never imply success", () => {
  const call: ReceiptAction = { type: "call_phone", recipientName: "Alex" };
  const message: ReceiptAction = { type: "compose_message", recipientName: "Sam" };
  const allFailed = executionReceiptText(
    [call, message],
    {
      successes: [],
      failures: [
        { raw: call, action: call, detail: "I couldn't open the call." },
        { raw: message, action: message, detail: "I couldn't open Messages." }
      ]
    },
    "Calling and texting now."
  );
  assert.match(allFailed, /couldn't complete any of the 2 actions/i);
  assert.match(allFailed, /phone call/);
  assert.match(allFailed, /message draft/);

  const single = executionReceiptText(
    [call],
    { successes: [], failures: [{ raw: call, action: call, detail: "The call screen didn't open." }] },
    "Calling now."
  );
  assert.equal(single, "The call screen didn't open.");
});

test("permission recovery recognizes real denial wording without classifying ordinary outages", () => {
  assert.equal(isPermissionFailureMessage("Calendar access isn't enabled."), true);
  assert.equal(isPermissionFailureMessage("Notifications aren't enabled for Taki AI."), true);
  assert.equal(isPermissionFailureMessage("I don't have permission to save that to Health."), true);
  assert.equal(isPermissionFailureMessage("The calendar service is temporarily unavailable."), false);
  assert.equal(isPermissionFailureMessage("I couldn't find that reminder."), false);
});
