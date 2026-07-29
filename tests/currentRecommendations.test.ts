import test from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentMovieRecommendationEvidence,
  parseRottenTomatoesGuide,
  parseRottenTomatoesStreamingPage
} from "../src/currentRecommendations.js";

const guideFixture = `
  <div class="block-countdown" data-media-release-date="1782864000000">
    <a class="meta-title" href="https://www.rottentomatoes.com/m/test_movie">Test Movie</a>
    <span class="meta-year">(2026)</span>
    <span class="tMeterScore">94%</span>
    <span class="tMeterScore">88%</span>
    <p class="meta-detail"><span class="title">Critics Consensus:</span> A joyful crowd-pleaser.</p>
  </div>`;

test("parses compact current movie evidence from an editorial guide", () => {
  const items = parseRottenTomatoesGuide(guideFixture);
  assert.equal(items.length, 1);
  assert.match(items[0], /Test Movie \(2026\)/);
  assert.match(items[0], /scores 94% \/ 88%/);
  assert.match(items[0], /release Jul 1, 2026/);
  assert.match(items[0], /A joyful crowd-pleaser/);
  assert.match(items[0], /rottentomatoes\.com\/m\/test_movie/);
});

test("parses streaming platform headings and listings without navigation noise", () => {
  const lines = parseRottenTomatoesStreamingPage(`
    <div class="content-body">
      <p>This month, streaming services add many titles.</p>
      <h2>HIGHLIGHTS</h2>
      <p>Another Service Movie</p>
      <h2>NETFLIX</h2>
      <p><strong>July 3</strong></p>
      <p>Fresh Movie</p>
      <p>Apple TV | Disney+ | Netflix</p>
      <h2>RELATED NEWS</h2>
      <p>Unrelated Movie</p>
    </div>
  `, "Netflix");
  assert.deepEqual(lines, ["Platform: Netflix", "NETFLIX", "July 3", "Fresh Movie"]);
});

test("current movie evidence tolerates failed sources and keeps successful direct sources", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/guide/popular-movies/")) {
      return new Response(guideFixture, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  const result = await getCurrentMovieRecommendationEvidence(
    "What are good movies worth watching this summer?",
    { now: new Date("2026-07-29T12:00:00Z"), fetchImpl }
  );
  assert.ok(result);
  assert.match(result.evidence, /Test Movie/);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://editorial.rottentomatoes.com/guide/popular-movies/");
});

test("does not use the movie-specific evidence path for unrelated recommendations", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("", { status: 500 });
  }) as typeof fetch;
  const result = await getCurrentMovieRecommendationEvidence(
    "What books should I read this summer?",
    { fetchImpl }
  );
  assert.equal(result, null);
  assert.equal(calls, 0);
});
