import assert from "node:assert/strict";
import test from "node:test";
import { localCoreActionFor } from "../../app/src/coreActionFallback.js";

test("explicit essential commands have deterministic on-device plans", () => {
  assert.deepEqual(localCoreActionFor("Call Mary Johnson")?.action, {
    type: "call_phone",
    recipientName: "Mary Johnson",
    contactQuery: "Mary Johnson"
  });
  assert.deepEqual(localCoreActionFor("Text Alex that I'm running ten minutes late")?.action, {
    type: "compose_message",
    recipientName: "Alex",
    contactQuery: "Alex",
    body: "I'm running ten minutes late"
  });
  assert.equal(localCoreActionFor("Email sam@example.com saying The appointment moved")?.action.type, "compose_email");
  assert.equal(localCoreActionFor("Directions to 1 Apple Park Way")?.action.type, "maps_directions");
  assert.equal(localCoreActionFor("Show pizza in Apple Maps")?.action.type, "maps_search");
  assert.equal(localCoreActionFor("Check my calendar")?.action.type, "calendar_search");
  assert.equal(localCoreActionFor("Show me my reminders")?.action.type, "reminder_search");
  assert.equal(localCoreActionFor("Remind me to buy detergent")?.action.type, "reminder_create");
  assert.equal(localCoreActionFor("Turn the flashlight off")?.action.type, "flashlight_control");
  assert.equal(localCoreActionFor("What's my iPhone battery level")?.action.type, "device_status");
  assert.equal(localCoreActionFor("Open Spotify")?.action.type, "open_app");
  assert.equal(localCoreActionFor("Undo that")?.action.type, "undo_last");
  assert.equal(localCoreActionFor("Did that work?")?.action.type, "action_history");
});

test("on-device plans refuse context, research, and dates they cannot resolve safely", () => {
  assert.equal(localCoreActionFor("Call him"), null);
  assert.equal(localCoreActionFor("Directions there"), null);
  assert.equal(localCoreActionFor("Text Chris about the latest game"), null);
  assert.equal(localCoreActionFor("Remind me to call Mom tomorrow at 9"), null);
  assert.equal(localCoreActionFor("Open Some Unknown App"), null);
  assert.equal(localCoreActionFor("What movies should I watch?"), null);
});
