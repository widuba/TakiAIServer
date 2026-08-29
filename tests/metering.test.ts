import assert from "node:assert/strict";
import test from "node:test";
import { geminiListPriceUsd, googleSearchListPriceUsd, openAIListPriceUsd, openAIWebSearchCallCount, sttCostUsd, ttsCostUsd } from "../src/metering.js";
import { ATTACHMENT_BASE_CREDITS, FREE_STARTER_CREDITS, FREE_VOICE_LIMIT, FREE_VOICE_PER_CYCLE, GRANT_EXPIRY_DAYS, IN_APP_CREDIT_PRODUCTS, TIERS, attachmentBaseCostCredits, compareGrantSpendOrder, hasVoiceAccess, inAppCreditsForProduct, isFreeVoice, summary as creditSummary, topupCentsPerCredit, topupPriceCents, type CreditGrant } from "../src/credits.js";
import { detectPersonalSearch } from "../src/planner.js";

test("one credit always represents exactly $0.001 of vendor usage", () => {
  assert.equal(ttsCostUsd(1000), 0.05);
  assert.equal(ttsCostUsd(200), 0.01);
  assert.equal(sttCostUsd(3_600_000), 0.22);
  assert.equal(sttCostUsd(30_000), 0.22 / 120);
  assert.equal(
    geminiListPriceUsd("gemini-2.5-flash", {
      promptTokenCount: 1000,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 1000
    }),
    0.0053
  );
});

test("Gemini 3 list pricing includes thinking tokens and actual search queries", () => {
  assert.equal(
    geminiListPriceUsd("gemini-3.5-flash", {
      promptTokenCount: 1000,
      candidatesTokenCount: 1000,
      thoughtsTokenCount: 1000
    }),
    0.0195
  );
  const grounded = {
    candidates: [{ groundingMetadata: { webSearchQueries: ["weather today", "rain radar"] } }]
  };
  assert.equal(googleSearchListPriceUsd("gemini-3.5-flash", grounded), 0.028);
  assert.equal(googleSearchListPriceUsd("gemini-2.5-flash", grounded), 0.035);
  assert.equal(googleSearchListPriceUsd("gemini-3.5-flash", { candidates: [{}] }), 0);
  assert.equal(
    geminiListPriceUsd("gemini-3.6-flash", { promptTokenCount: 1000, candidatesTokenCount: 1000 }),
    0.009
  );
  assert.equal(
    geminiListPriceUsd("gemini-3.5-flash-lite", { promptTokenCount: 1000, candidatesTokenCount: 1000 }),
    0.0028
  );
});

test("OpenAI standard pricing accounts for cached tokens, output, and web calls", () => {
  assert.equal(
    openAIListPriceUsd("gpt-5.4-nano", {
      input_tokens: 2000,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 1000
    }),
    0.00147
  );
  assert.equal(
    openAIListPriceUsd("gpt-5.4-mini", {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1000
    }),
    0.00525
  );
  assert.equal(openAIWebSearchCallCount({
    output: [{ type: "web_search_call" }, { type: "message" }, { type: "web_search_call" }]
  }), 2);
});

test("OpenAI GPT-5.5 and GPT-5.6 Luna pricing matches the current catalog", () => {
  assert.equal(
    openAIListPriceUsd("gpt-5.5", {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1000
    }),
    0.035
  );
  assert.equal(
    openAIListPriceUsd("gpt-5.6-luna", {
      input_tokens: 2000,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens: 1000
    }),
    0.00142
  );
});

test("the authoritative catalog contains the new plan grants and prices", () => {
  assert.deepEqual(
    (["plus", "plus_voice", "pro"] as const).map((tier) => [TIERS[tier].creditsPerCycle, TIERS[tier].voiceCreditsPerCycle, TIERS[tier].priceUsd]),
    [[4_000, 50, 9.99], [6_000, 300, 14.99], [12_000, 600, 24.99]]
  );
  assert.equal(TIERS.plus_voice.label, "Premium");
  assert.equal(TIERS.plus_voice.badge, "Most Popular");
  assert.equal(FREE_VOICE_PER_CYCLE.plus_voice, 300);
  assert.equal(FREE_VOICE_PER_CYCLE.pro, 600);
});

test("free accounts get recurring AI Credits but no Voice Credits", () => {
  assert.equal(FREE_STARTER_CREDITS, 250);
  assert.equal(FREE_VOICE_LIMIT, 0);
  assert.equal(isFreeVoice("free", 250, 0, 0), false);
  assert.equal(hasVoiceAccess("free", 0), false);
  assert.equal(hasVoiceAccess("free", 0, true), true);
  assert.equal(hasVoiceAccess("plus", 500), true);
});

test("a free account starts at 250 AI Credits, zero Voice Credits, and doesn't restack within the month", async () => {
  const id = `free-cycle-${Date.now()}`;
  const first = await creditSummary(id);
  assert.equal(first.tier, "free");
  assert.equal(first.balance, FREE_STARTER_CREDITS);
  assert.equal(first.voiceCredits, 0);
  const again = await creditSummary(id);
  assert.equal(again.balance, FREE_STARTER_CREDITS);
});

test("legacy voice helpers reflect the new Voice Credit allowances and attachment floor", () => {
  assert.equal(isFreeVoice("plus_voice", 1000, 299), true);
  assert.equal(isFreeVoice("plus_voice", 1000, 300), false);
  assert.equal(ATTACHMENT_BASE_CREDITS, 40);
  assert.equal(attachmentBaseCostCredits([
    { kind: "image" }, { kind: "file" }, { kind: "url" }, { kind: "text" }
  ]), 80);
});

test("purchased credits expire after 90 days and are spent after subscription credits", () => {
  assert.equal(GRANT_EXPIRY_DAYS, 90);
  const grant = (source: string, expiresAt: number): CreditGrant => ({
    id: source,
    amount: 100,
    remaining: 100,
    grantedAt: 1,
    expiresAt,
    source
  });
  const ordered = [
    grant("iap_topup:pack", 10),
    grant("subscription:plus", 30),
    grant("free_starter", 20)
  ].sort(compareGrantSpendOrder);
  assert.deepEqual(ordered.map((item) => item.source), ["subscription:plus", "free_starter", "iap_topup:pack"]);
});

test("additional-credit discounts and in-app double-rate packs stay server authoritative", () => {
  assert.equal(topupCentsPerCredit("free"), 1);
  assert.equal(topupCentsPerCredit("plus"), 1);
  assert.equal(topupCentsPerCredit("plus_voice"), 0.8);
  assert.equal(topupCentsPerCredit("pro"), 0.6);
  assert.equal(topupPriceCents(500, "free"), 500);
  assert.equal(topupPriceCents(500, "plus_voice"), 400);
  assert.equal(topupPriceCents(500, "pro"), 300);

  const productId = "com.davidwiduba.takiai.credits.999";
  assert.equal(IN_APP_CREDIT_PRODUCTS[productId].priceCents, 999);
  assert.equal(inAppCreditsForProduct(productId, "free"), 500);
  assert.equal(inAppCreditsForProduct(productId, "plus_voice"), 650);
  assert.equal(inAppCreditsForProduct(productId, "pro"), 850);
});

test("web account identities are recognized only after a verified sign-in marker", async () => {
  const { isKnownIdentity, isWebAccountIdentity, markWebAuthenticated } = await import("../src/identity.js");
  assert.equal(isWebAccountIdentity("google:abc123"), true);
  assert.equal(isWebAccountIdentity("apple:xyz"), true);
  assert.equal(isWebAccountIdentity("12345678"), false);
  const identity = `google:test-${Date.now()}`;
  assert.equal(await isKnownIdentity(identity), false);
  await markWebAuthenticated(identity);
  assert.equal(await isKnownIdentity(identity), true);
  // Unverified identities never pass, and junk never marks.
  assert.equal(await isKnownIdentity("google:"), false);
  await markWebAuthenticated("not-an-account");
  assert.equal(await isKnownIdentity("not-an-account"), false);
});

test("unified personal search only captures explicit broad searches", () => {
  assert.equal(detectPersonalSearch("Find anything about the beach house"), "the beach house");
  assert.equal(detectPersonalSearch("Search all my stuff for Project Apollo"), "Project Apollo");
  assert.equal(detectPersonalSearch("Find a coffee shop near me"), null);
});
