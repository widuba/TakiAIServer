import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSources } from "../src/validators.js";

test("source verification removes unsafe local and credentialed URLs", () => {
  const sources = sanitizeSources([
    { title: "Local", url: "http://localhost:3000/private" },
    { title: "LAN", url: "http://192.168.1.2/internal" },
    { title: "IPv6 LAN", url: "http://[fd00::1]/internal" },
    { title: "Credentials", url: "https://user:secret@example.com/path" },
    { title: "Public", url: "https://www.apple.com/newsroom/" }
  ]);
  assert.deepEqual(sources, [{ title: "Public", url: "https://www.apple.com/newsroom/" }]);
});

test("source verification strips trackers, fragments, and duplicates", () => {
  const sources = sanitizeSources([
    { title: "Official release", url: "https://example.com/story?utm_source=taki&id=7#section" },
    { title: "Duplicate", url: "https://example.com/story?id=7" }
  ]);
  assert.deepEqual(sources, [{ title: "Official release", url: "https://example.com/story?id=7" }]);
});
