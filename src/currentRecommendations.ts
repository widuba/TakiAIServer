import { parse } from "node-html-parser";
import { fetchWithTimeout, readResponseBodyLimited } from "./util.js";

export type RecommendationSource = { title: string; url: string };

export type CurrentRecommendationEvidence = {
  evidence: string;
  sources: RecommendationSource[];
};

type FetchLike = typeof fetch;

const RT_EDITORIAL = "https://editorial.rottentomatoes.com";
const POPULAR_MOVIES_URL = `${RT_EDITORIAL}/guide/popular-movies/`;
const BEST_NEW_MOVIES_URL = `${RT_EDITORIAL}/guide/best-new-movies/`;

function cleanText(value: string, max = 360): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
    .slice(0, max);
}

function monthName(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
    .format(date)
    .toLowerCase();
}

function streamingArticleBase(date: Date): string {
  const month = monthName(date);
  const year = date.getUTCFullYear();
  return `${RT_EDITORIAL}/article/new-movies-and-shows-streaming-in-${month}-${year}-what-to-watch-on-netflix-prime-video-disney-hbo-max-and-more/`;
}

function summerCalendarUrl(date: Date): string {
  return `${RT_EDITORIAL}/article/summer-movie-calendar-${date.getUTCFullYear()}/`;
}

async function fetchHtml(url: string, fetchImpl: FetchLike, timeoutMs = 5_000): Promise<string> {
  const init: RequestInit = {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "TakiAI/1.0 (+https://takiai.app)"
    }
  };
  // Keep the injectable fetch used by parser tests, while production requests
  // use the shared abort-backed deadline instead of leaving a stalled socket
  // alive after the recommendation request has timed out.
  const response = fetchImpl === fetch
    ? await fetchWithTimeout(url, init, timeoutMs, "Recommendation source")
    : await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Recommendation source returned ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 2_000_000) throw new Error("Recommendation source was unexpectedly large");
  const html = await readResponseBodyLimited(response, 2_000_000);
  if (!html) throw new Error("Recommendation source was empty or unexpectedly large");
  return html;
}

export function parseRottenTomatoesGuide(html: string, limit = 12): string[] {
  const root = parse(html);
  const entries: string[] = [];
  for (const item of root.querySelectorAll(".block-countdown, .preview-item")) {
    const titleNode = item.querySelector(".meta-title");
    const title = cleanText(titleNode?.text || "", 100);
    if (!title) continue;
    const year = cleanText(item.querySelector(".meta-year")?.text || "", 16);
    const scores = item.querySelectorAll(".tMeterScore")
      .map((node) => cleanText(node.text, 12))
      .filter(Boolean)
      .slice(0, 2);
    const detail = item.querySelectorAll(".meta-detail")
      .map((node) => cleanText(node.text))
      .find((text) => /critics consensus:|synopsis:/i.test(text))
      || cleanText(item.querySelector(".meta-detail")?.text || "");
    const releaseMillis = Number(item.getAttribute("data-media-release-date") || 0);
    const release = releaseMillis > 0
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
        .format(new Date(releaseMillis))
      : "";
    const href = String(titleNode?.getAttribute("href") || "").trim();
    const fields = [
      `${title}${year ? ` ${year}` : ""}`,
      scores.length ? `scores ${scores.join(" / ")}` : "",
      release ? `release ${release}` : "",
      detail,
      /^https?:\/\//i.test(href) ? href : ""
    ].filter(Boolean);
    entries.push(fields.join(" — "));
    if (entries.length >= limit) break;
  }
  return entries;
}

export function parseRottenTomatoesStreamingPage(html: string, platform: string, limit = 28): string[] {
  const root = parse(html);
  const body = root.querySelector(".content-body");
  if (!body) return [];
  const lines: string[] = [];
  const platformHeading = platform.replace(/\s+/g, " ").trim().toLowerCase();
  let insidePlatformSection = false;
  for (const node of body.querySelectorAll("h2, p")) {
    const line = cleanText(node.text, 260);
    if (node.tagName === "H2") {
      if (line.toLowerCase() === platformHeading) {
        insidePlatformSection = true;
        lines.push(line);
        continue;
      }
      if (insidePlatformSection) break;
    }
    // Each paginated article repeats a cross-service HIGHLIGHTS block before
    // its own platform heading. Do not attribute those titles to this service.
    if (!insidePlatformSection || !line || /^apple tv \| disney\+/i.test(line)) continue;
    lines.push(line);
    if (lines.length >= limit) break;
  }
  return lines.length ? [`Platform: ${platform}`, ...lines] : [];
}

function isMovieRecommendation(message: string): boolean {
  return /\b(movies?|films?|cinema|in theaters?)\b/i.test(message);
}

function wantsSeasonalCalendar(message: string): boolean {
  return /\b(summer|spring|fall|autumn|winter|upcoming|release|in theaters?)\b/i.test(message);
}

/**
 * Fast, deterministic evidence path for current movie recommendations.
 * It intentionally uses direct editorial pages rather than a search-results
 * feed, and returns nothing when the request is outside this narrow domain.
 */
export async function getCurrentMovieRecommendationEvidence(
  message: string,
  options: { now?: Date; fetchImpl?: FetchLike } = {}
): Promise<CurrentRecommendationEvidence | null> {
  if (!isMovieRecommendation(message)) return null;

  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl || fetch;
  const streamingBase = streamingArticleBase(now);
  const requests: Array<{ label: string; title: string; url: string; kind: "guide" | "streaming" }> = [
    { label: "Popular now", title: "Rotten Tomatoes — popular movies now", url: POPULAR_MOVIES_URL, kind: "guide" },
    { label: "Best new movies", title: "Rotten Tomatoes — best new movies", url: BEST_NEW_MOVIES_URL, kind: "guide" },
    { label: "Apple TV+", title: "Rotten Tomatoes — current streaming calendar", url: streamingBase, kind: "streaming" },
    { label: "HBO Max", title: "Rotten Tomatoes — HBO Max streaming calendar", url: `${streamingBase}4/`, kind: "streaming" },
    { label: "Netflix", title: "Rotten Tomatoes — Netflix streaming calendar", url: `${streamingBase}5/`, kind: "streaming" },
    { label: "Prime Video", title: "Rotten Tomatoes — Prime Video streaming calendar", url: `${streamingBase}8/`, kind: "streaming" }
  ];
  if (wantsSeasonalCalendar(message)) {
    requests.push({
      label: "Current release calendar",
      title: "Rotten Tomatoes — current summer movie calendar",
      url: summerCalendarUrl(now),
      kind: "guide"
    });
  }

  const settled = await Promise.allSettled(requests.map(async (request) => {
    const html = await fetchHtml(request.url, fetchImpl);
    const lines = request.kind === "guide"
      ? parseRottenTomatoesGuide(html, request.label === "Current release calendar" ? 24 : 12)
      : parseRottenTomatoesStreamingPage(html, request.label);
    return { request, lines };
  }));

  const sections: string[] = [];
  const sources: RecommendationSource[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value.lines.length) continue;
    sections.push(`[${result.value.request.label}]\n${result.value.lines.join("\n")}`);
    sources.push({ title: result.value.request.title, url: result.value.request.url });
  }
  if (!sections.length || !sources.length) return null;
  return {
    evidence: sections.join("\n\n").slice(0, 24_000),
    sources: sources.slice(0, 8)
  };
}
