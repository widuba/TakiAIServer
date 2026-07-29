import assert from "node:assert/strict";
import test from "node:test";
import { applyMemoryOperation } from "../../app/src/memoryStore.js";
import { DEFAULT_PROFILE } from "../../app/src/userProfile.js";
import { parseForgetMemoryCommand, parseRememberCommand } from "../src/tools.js";

const fixedOptions = {
  id: () => "memory-fixed",
  now: () => "2026-07-29T12:00:00.000Z"
};

test("explicit remember writes a structured memory instead of free-text about", () => {
  const profile = { ...DEFAULT_PROFILE, about: "User-authored personalization", memories: [] };
  const result = applyMemoryOperation(profile, "save", "I live in Atlanta", fixedOptions);

  assert.equal(result.changed, true);
  assert.equal(result.profile.about, "User-authored personalization");
  assert.deepEqual(result.profile.memories, [{
    id: "memory-fixed",
    text: "I live in Atlanta",
    category: "Home",
    createdAt: "2026-07-29T12:00:00.000Z"
  }]);
});

test("a corrected single-value fact replaces structured and legacy copies", () => {
  const profile = {
    ...DEFAULT_PROFILE,
    about: "I live in Atlanta\nI enjoy long-form answers",
    memories: [{ id: "old", text: "The user lives in Atlanta", category: "Home", createdAt: "2025-01-01T00:00:00.000Z" }]
  };
  const result = applyMemoryOperation(profile, "save", "I moved to Boston", fixedOptions);

  assert.equal(result.message, "I updated what I remember about that.");
  assert.equal(result.profile.about, "I enjoy long-form answers");
  assert.deepEqual(result.profile.memories.map((memory) => memory.text), ["I moved to Boston"]);
});

test("forget removes matching structured and pre-migration about facts only", () => {
  const profile = {
    ...DEFAULT_PROFILE,
    about: "My dog is named Poppy\nUse straightforward wording",
    memories: [
      { id: "dog", text: "The user's dog is named Poppy", category: "Family", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "job", text: "The user works as a teacher", category: "Work", createdAt: "2025-01-01T00:00:00.000Z" }
    ]
  };
  const result = applyMemoryOperation(profile, "forget", "my dog Poppy", fixedOptions);

  assert.equal(result.affected, 2);
  assert.equal(result.profile.about, "Use straightforward wording");
  assert.deepEqual(result.profile.memories.map((memory) => memory.id), ["job"]);
});

test("clear truthfully removes both structured memories and about text", () => {
  const profile = {
    ...DEFAULT_PROFILE,
    about: "Call me David",
    memories: [{ id: "one", text: "The user likes jazz", category: "Preferences", createdAt: "2025-01-01T00:00:00.000Z" }]
  };
  const result = applyMemoryOperation(profile, "clear", "", fixedOptions);
  assert.equal(result.profile.about, "");
  assert.deepEqual(result.profile.memories, []);
  assert.match(result.message, /cleared everything/i);
});

test("memory command parsing supports save, targeted forget, and clear without hijacking ordinary speech", () => {
  assert.equal(parseRememberCommand("Remember that I'm vegetarian"), "I'm vegetarian");
  assert.deepEqual(parseForgetMemoryCommand("Forget that I live in Atlanta"), { operation: "forget", fact: "I live in Atlanta" });
  assert.deepEqual(parseForgetMemoryCommand("Clear all memories"), { operation: "clear", fact: null });
  assert.deepEqual(parseForgetMemoryCommand("Forget everything you remember about me"), { operation: "clear", fact: null });
  assert.equal(parseForgetMemoryCommand("I forgot my keys"), null);
  assert.equal(parseForgetMemoryCommand("Don't forget to call Mom"), null);
  assert.equal(parseForgetMemoryCommand("Forget it"), null);
});
