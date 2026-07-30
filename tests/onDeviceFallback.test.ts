import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseOnDeviceConversationFallback,
  compactOnDeviceContext
} from "../../app/src/onDeviceFallback.js";

test("on-device conversation fallback accepts basic timeless conversation", () => {
  assert.equal(canUseOnDeviceConversationFallback("Why is the sky blue?"), true);
  assert.equal(canUseOnDeviceConversationFallback("Help me brainstorm a funny name for a fictional dog"), true);
  assert.equal(canUseOnDeviceConversationFallback("Rewrite this sentence to sound friendlier"), true);
});

test("on-device conversation fallback rejects current facts, actions, and high-stakes guidance", () => {
  assert.equal(canUseOnDeviceConversationFallback("What are the best movies this summer?"), false);
  assert.equal(canUseOnDeviceConversationFallback("Who is the current president?"), false);
  assert.equal(canUseOnDeviceConversationFallback("Can you look up what Taki costs?"), false);
  assert.equal(canUseOnDeviceConversationFallback("Text Mom that I am late"), false);
  assert.equal(canUseOnDeviceConversationFallback("Add something to my calendar"), false);
  assert.equal(canUseOnDeviceConversationFallback("What dosage of this medication should I take?"), false);
  assert.equal(canUseOnDeviceConversationFallback("Summarize https://example.com"), false);
});

test("on-device context is bounded and stripped down", () => {
  const turns = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    text: `  turn ${index}   with spaces  `
  }));
  const compact = compactOnDeviceContext(turns);
  assert.equal(compact.length, 6);
  assert.equal(compact[0].text, "turn 3 with spaces");
  assert.equal(compact[5].text, "turn 8 with spaces");
});
