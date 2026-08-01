import assert from "node:assert/strict";
import test from "node:test";
import { parseSafetyDecision, safetyReviewPrompt } from "../src/safetyReview.js";

test("contextual safety review explicitly separates extraction intent from general prompt discussion", () => {
  const prompt = safetyReviewPrompt("user text");
  assert.match(prompt, /system promp/i, "misspelled extraction attempts are part of contextual review");
  assert.match(prompt, /benign questions about system prompts in general/i);
  assert.match(prompt, /target must be this assistant's hidden instructions/i);
  assert.match(prompt, /never isolated keywords/i);
});

test("contextual safety decisions require a valid category and high confidence", () => {
  assert.deepEqual(
    parseSafetyDecision('{"flag":true,"category":"prompt_extraction","confidence":0.93}'),
    { flag: true, category: "prompt_extraction", confidence: 0.93 }
  );
  assert.equal(parseSafetyDecision('{"flag":true,"category":"prompt_extraction","confidence":0.79}').flag, false);
  assert.equal(parseSafetyDecision('{"flag":true,"category":"unknown","confidence":1}').flag, false);
  assert.equal(parseSafetyDecision("not json").flag, false);
});
