import assert from "node:assert/strict";
import test from "node:test";
import { geminiListPriceUsd, ttsCostUsd } from "../src/metering.js";
import { FREE_VOICE_PER_CYCLE, TIERS, worstCaseContributionUsd } from "../src/credits.js";
import { detectPersonalSearch } from "../src/planner.js";

test("one credit always represents exactly $0.001 of vendor usage", () => {
  assert.equal(ttsCostUsd(1000), 0.05);
  assert.equal(ttsCostUsd(200), 0.01);
  assert.equal(
    geminiListPriceUsd("gemini-2.5-flash", {
      promptTokenCount: 1000,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 1000
    }),
    0.0053
  );
});

test("Pro remains the highest-contribution paid tier at worst-case included usage", () => {
  const contributions = (["plus", "plus_voice", "pro"] as const)
    .map((tier) => ({ tier, contribution: worstCaseContributionUsd(tier) }));
  const highest = contributions.reduce((best, current) => current.contribution > best.contribution ? current : best);
  assert.equal(highest.tier, "pro", JSON.stringify(contributions));
  assert.ok(worstCaseContributionUsd("pro") >= 6.2);
  assert.equal(FREE_VOICE_PER_CYCLE.pro, 300);
  assert.equal(TIERS.pro.creditsPerCycle, 15_000);
});

test("unified personal search only captures explicit broad searches", () => {
  assert.equal(detectPersonalSearch("Find anything about the beach house"), "the beach house");
  assert.equal(detectPersonalSearch("Search all my stuff for Project Apollo"), "Project Apollo");
  assert.equal(detectPersonalSearch("Find a coffee shop near me"), null);
});
