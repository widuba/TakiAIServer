import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(process.cwd(), "..");
const customerFiles = [
  "app/src/Membership.tsx",
  "app/src/Settings.tsx",
  "app/ios/App/App/NativeTakiUI.swift",
  "app/ios/App/App/CarPlaySceneDelegate.swift",
  "app/ios/App/App/Taki.storekit",
  "website/index.html",
  "website/buy/index.html",
  "website/support/index.html"
];

const contents = customerFiles.map((file) => [file, readFileSync(resolve(root, file), "utf8")] as const);

test("15. customer pricing surfaces display the correct plan names, prices, and dual balances", () => {
  const combined = contents.map(([, source]) => source).join("\n");
  for (const expected of [
    "Plus", "$9.99", "4,000", "50 Voice Credits",
    "Premium", "$14.99", "6,000", "300 Voice Credits",
    "Pro", "$24.99", "12,000", "600 Voice Credits",
    "Most Popular", "AI Credits", "Voice Credits"
  ]) assert.match(combined, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("16. customer-facing files no longer use the term Voice Turns", () => {
  for (const [file, source] of contents) {
    assert.doesNotMatch(source, /voice turns?/i, file);
  }
});
