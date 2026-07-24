import { createHash } from "node:crypto";
import { generateContent, MAIN_MODEL, RESEARCH_MODEL, RESEARCH_TIMEOUT_MS, TIME_ZONE } from "./ai.js";
import { parse as parseHtml } from "node-html-parser";
import { safeParseJsonObject, withTimeout } from "./util.js";
import { storeDelete, storeGet, storeSet } from "./store.js";
import type { AssistantSource } from "./types.js";
import {
  extractFlightCode,
  hasExplicitFinanceCue,
  hasExplicitFlightCue,
  hasProductPriceCue,
  isStrongFlightReference,
  normalizeTrackerKind
} from "./entityClassifier.js";
export { extractFlightCode } from "./entityClassifier.js";

/* ============================================================================
 * Finance, product-price, sports, flight, and package Live Activity tracking.
 *
 * parseTrackCommand detects "track/follow AAPL", "follow the Lakers game", etc.
 * fetchTrackerSnapshot pulls the current numbers (Yahoo for stocks, CoinGecko
 * for crypto, grounded search for sports) into a compact snapshot the device
 * renders in the Live Activity / Dynamic Island and re-polls to stay live.
 * ==========================================================================*/

export interface TrackerSnapshot {
  title: string;   // "AAPL", "Lakers vs Celtics"
  symbol: string;  // SF Symbol name
  line1: string;   // "$195.20", "102 – 98"
  line2: string;   // "Apple Inc.", "Lakers lead"
  trend: string;   // "up" | "down" | "flat"
  status: string;  // "+1.24% today", "Q4 · 2:15"
  // Flight only: per-leg color "green" | "yellow" | "red" for the dep/arr times
  // (line1 = departure, line2 = arrival on a flight snapshot).
  depColor?: string;
  arrColor?: string;
  // Package only: estimated delivery date (ISO) + whether it's been delivered,
  // used to drive "arrives today" nudges.
  eta?: string;
  delivered?: boolean;
  sources?: AssistantSource[];
}

const PRICE_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TakiAI/1.0)" };

async function fetchYahooJson(path: string, label: string): Promise<any> {
  let lastError: unknown = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response: any = await withTimeout(fetch(`https://${host}${path}`, { headers: PRICE_HEADERS }), 6500, label);
      if (!response.ok) throw new Error(`${label} returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} unavailable`);
}

const CRYPTO_WORD =
  /\b(bitcoin|btc|ethereum|eth|dogecoin|doge|solana|sol|cardano|ada|xrp|ripple|litecoin|ltc|bnb|polkadot|dot|shiba inu|shib|polygon|matic|avalanche|avax|chainlink|link|tron|trx|monero|xmr|stellar|xlm|usd coin|usdc|tether|usdt)\b/i;

const CRYPTO_IDS: Record<string, string> = {
  bitcoin: "bitcoin", btc: "bitcoin", ethereum: "ethereum", eth: "ethereum",
  dogecoin: "dogecoin", doge: "dogecoin", solana: "solana", sol: "solana",
  cardano: "cardano", ada: "cardano", xrp: "ripple", ripple: "ripple",
  litecoin: "litecoin", ltc: "litecoin", bnb: "binancecoin", polkadot: "polkadot",
  dot: "polkadot", "shiba inu": "shiba-inu", shib: "shiba-inu", polygon: "matic-network",
  matic: "matic-network", avalanche: "avalanche-2", avax: "avalanche-2",
  chainlink: "chainlink", link: "chainlink", tron: "tron", trx: "tron",
  monero: "monero", xmr: "monero", stellar: "stellar", xlm: "stellar",
  "usd coin": "usd-coin", usdc: "usd-coin", tether: "tether", usdt: "tether"
};

function money(n: number, currency = "USD") {
  const frac = Math.abs(n) < 1 ? 6 : 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: frac }).format(n);
  } catch {
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: frac })}`;
  }
}

const TRACK_VERB =
  /\b(track|follow|watch|monitor|keep (?:an )?eye on|keep tabs on|live activity(?: for)?|pin)\b/i;
// "Put AAPL on my lock screen" / "show the Lakers game in my Dynamic Island":
// destination phrasing is as clear a tracking request as a track verb, and
// missing it sent these to the LLM, which refused ("use the Stocks app").
const TRACK_DESTINATION = /\b(lock ?screen|dynamic island|live activity)\b/i;
const TRACK_PUT_VERB = /\b(put|add|show|display|start|keep|throw|get)\b/i;

export function isTrackRequest(message: string): boolean {
  return TRACK_VERB.test(message) || (TRACK_DESTINATION.test(message) && TRACK_PUT_VERB.test(message));
}
const SPORTS_CUE =
  /\b(vs\.?|versus|@|game|match|score|playing|kickoff|tip ?off|nba|nfl|mlb|nhl|mls|premier league|la ?liga|champions league|world cup|super ?bowl)\b/i;
const FINANCE_CUE =
  /\b(stock|shares?|ticker|quote|trading|market|nasdaq|nyse|crypto|coin)\b/i;
const KNOWN_SPORTS_TEAM =
  /\b(yankees|mets|red sox|dodgers|cubs|phillies|braves|astros|padres|lakers|celtics|warriors|knicks|nets|heat|bucks|suns|mavericks|nuggets|cavaliers|chiefs|eagles|cowboys|packers|steelers|patriots|49ers|bills|ravens|jets|giants|dolphins|commanders|rangers|bruins|maple leafs|canadiens|oilers|panthers|lightning|golden knights|arsenal|chelsea|liverpool|manchester united|manchester city|tottenham|barcelona|real madrid|bayern munich|inter miami)\b/i;
const SPORTS_TEAM_NAMES: Record<string, string> = {
  yankees: "New York Yankees", mets: "New York Mets", "red sox": "Boston Red Sox",
  dodgers: "Los Angeles Dodgers", cubs: "Chicago Cubs", phillies: "Philadelphia Phillies",
  braves: "Atlanta Braves", astros: "Houston Astros", padres: "San Diego Padres",
  lakers: "Los Angeles Lakers", celtics: "Boston Celtics", warriors: "Golden State Warriors",
  knicks: "New York Knicks", nets: "Brooklyn Nets", heat: "Miami Heat", bucks: "Milwaukee Bucks",
  suns: "Phoenix Suns", mavericks: "Dallas Mavericks", nuggets: "Denver Nuggets",
  cavaliers: "Cleveland Cavaliers", chiefs: "Kansas City Chiefs", eagles: "Philadelphia Eagles",
  cowboys: "Dallas Cowboys", packers: "Green Bay Packers", steelers: "Pittsburgh Steelers",
  patriots: "New England Patriots", "49ers": "San Francisco 49ers", bills: "Buffalo Bills",
  ravens: "Baltimore Ravens", jets: "New York Jets", dolphins: "Miami Dolphins",
  commanders: "Washington Commanders", bruins: "Boston Bruins", "maple leafs": "Toronto Maple Leafs",
  canadiens: "Montreal Canadiens", oilers: "Edmonton Oilers", lightning: "Tampa Bay Lightning",
  "golden knights": "Vegas Golden Knights", arsenal: "Arsenal FC", chelsea: "Chelsea FC",
  liverpool: "Liverpool FC", "manchester united": "Manchester United", "manchester city": "Manchester City",
  tottenham: "Tottenham Hotspur", barcelona: "FC Barcelona", "real madrid": "Real Madrid",
  "bayern munich": "Bayern Munich", "inter miami": "Inter Miami CF"
};
const TRACKER_MODEL = String(process.env.GEMINI_TRACKER_MODEL || MAIN_MODEL).trim();
const TRACKER_TIMEOUT_MS = Number(process.env.TRACKER_TIMEOUT_MS || 35000);

function groundingSources(response: any): AssistantSource[] {
  const candidate = response?.candidates?.[0];
  const metadata = candidate?.groundingMetadata || candidate?.grounding_metadata;
  const chunks = metadata?.groundingChunks || metadata?.grounding_chunks || [];
  const seen = new Set<string>();
  const sources: AssistantSource[] = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const web = chunk?.web || chunk?.retrievedContext || chunk?.retrieved_context;
    const url = String(web?.uri || web?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: String(web?.title || "Web source").trim().slice(0, 140), url });
    if (sources.length >= 8) break;
  }
  return sources;
}

function canonicalSportsQuery(value: string): string {
  const key = value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|game|match|score)\b/g, " ").replace(/\s+/g, " ").trim();
  return SPORTS_TEAM_NAMES[key] || value;
}

// Detect a "track X" command and classify it. Returns null for everything else
// (including "track my steps", which has no finance/sports cue).
export function parseTrackCommand(message: string): { kind: "finance" | "product" | "sports" | "flight"; query: string } | null {
  if (!isTrackRequest(message)) return null;
  const m = message.toLowerCase();

  const query = message
    .replace(TRACK_VERB, " ")
    .replace(/\b(?:put|add|show|display|start|keep|throw|get)\b/gi, " ")
    .replace(/\b(?:on|in|to)\s+(?:my\s+)?(?:lock ?screen|dynamic island)\b/gi, " ")
    .replace(/\b(?:lock ?screen|dynamic island)\b/gi, " ")
    .replace(/\b(the|a|an|please|for me|my|on|stock|price|of|live)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Retail products are not financial assets. This must run before the sports
  // `vs` detector and before uppercase ticker detection ("MacBook Air vs Pro").
  if (hasProductPriceCue(message) && !hasExplicitFinanceCue(message)) {
    return { kind: "product", query: query || message };
  }

  // A carrier code/name plus a flight number is stronger evidence than a bare
  // uppercase ticker. Explicit finance wording still lets users request a stock.
  const flightCode = extractFlightCode(message);
  if (flightCode && hasExplicitFlightCue(message)) return { kind: "flight", query: flightCode };
  if (SPORTS_CUE.test(message) || KNOWN_SPORTS_TEAM.test(message)) return { kind: "sports", query: canonicalSportsQuery(query || message) };
  if (flightCode && isStrongFlightReference(message)) return { kind: "flight", query: flightCode };
  if (CRYPTO_WORD.test(m) || FINANCE_CUE.test(m) || hasExplicitFinanceCue(message) || /\$[A-Za-z]{1,5}\b/.test(message) || /\b[A-Z]{2,5}\b/.test(message)) {
    // Preserve the finance cue when a code+number also appears, so downstream
    // normalization cannot reinterpret an explicitly requested stock as a flight.
    const financeQuery = flightCode && hasExplicitFinanceCue(message)
      ? message.replace(TRACK_VERB, " ").trim()
      : query || message;
    return { kind: "finance", query: financeQuery };
  }
  return null;
}

async function fetchCryptoQuote(query: string): Promise<TrackerSnapshot | null> {
  const match = query.toLowerCase().match(CRYPTO_WORD);
  if (!match) return null;
  const word = match[0].toLowerCase();
  try {
    let id = CRYPTO_IDS[word];
    if (!id) {
      const s: any = await withTimeout(fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(word)}`), 6000, "Crypto search");
      id = (await s.json())?.coins?.[0]?.id;
    }
    if (!id) return null;
    const r: any = await withTimeout(
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`),
      6000, "Crypto price"
    );
    const info = (await r.json())?.[id];
    if (!info || typeof info.usd !== "number") return null;
    const chg = typeof info.usd_24h_change === "number" ? info.usd_24h_change : null;
    const trend = chg == null ? "flat" : chg >= 0 ? "up" : "down";
    const name = word.charAt(0).toUpperCase() + word.slice(1);
    return {
      title: word.length <= 4 ? word.toUpperCase() : name,
      symbol: trend === "down" ? "chart.line.downtrend.xyaxis" : "chart.line.uptrend.xyaxis",
      line1: money(info.usd),
      line2: name,
      trend,
      status: chg == null ? "24h" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% today`,
      sources: [{ title: "coingecko.com", url: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}` }]
    };
  } catch (error) {
    console.error("Crypto quote error:", error);
    return null;
  }
}

// Well-known company names → ticker, so resolution NEVER depends on Yahoo's
// search ranking (which differs by requesting IP — from a datacenter "goldman
// sachs" can surface a same-named ETF instead of GS).
const COMPANY_TICKERS: Record<string, string> = {
  "goldman sachs": "GS", "apple": "AAPL", "microsoft": "MSFT", "amazon": "AMZN",
  "google": "GOOGL", "alphabet": "GOOGL", "meta": "META", "facebook": "META",
  "tesla": "TSLA", "nvidia": "NVDA", "netflix": "NFLX", "disney": "DIS",
  "walmart": "WMT", "ford": "F", "general motors": "GM", "coca cola": "KO",
  "coca-cola": "KO", "pepsi": "PEP", "mcdonalds": "MCD", "mcdonald's": "MCD",
  "starbucks": "SBUX", "nike": "NKE", "boeing": "BA", "intel": "INTC", "amd": "AMD",
  "jpmorgan": "JPM", "jp morgan": "JPM", "bank of america": "BAC", "wells fargo": "WFC",
  "morgan stanley": "MS", "visa": "V", "mastercard": "MA", "paypal": "PYPL",
  "exxon": "XOM", "chevron": "CVX", "pfizer": "PFE", "johnson and johnson": "JNJ",
  "at&t": "T", "verizon": "VZ", "uber": "UBER", "lyft": "LYFT", "airbnb": "ABNB",
  "spotify": "SPOT", "palantir": "PLTR", "coinbase": "COIN", "robinhood": "HOOD",
  "gamestop": "GME", "berkshire": "BRK-B", "berkshire hathaway": "BRK-B",
  "costco": "COST", "target": "TGT", "home depot": "HD", "oracle": "ORCL",
  "salesforce": "CRM", "adobe": "ADBE", "ibm": "IBM", "qualcomm": "QCOM",
  "broadcom": "AVGO", "shopify": "SHOP", "block": "SQ", "square": "SQ", "snap": "SNAP",
  "reddit": "RDDT", "delta": "DAL", "american airlines": "AAL", "united airlines": "UAL"
};

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Resolve a query to { symbol, name } without trusting Yahoo search ranking when
// we don't have to: explicit TICKER → company MAP → finally Yahoo search.
async function resolveStockSymbol(query: string, entity: string): Promise<{ symbol: string; name: string } | null> {
  // 1) Explicit uppercase ticker in the original text ("track GS", "AAPL").
  const tick = query.match(/\b[A-Z]{1,5}\b/);
  if (tick) return { symbol: tick[0], name: tick[0] };
  // 2) Known company name.
  if (COMPANY_TICKERS[entity]) return { symbol: COMPANY_TICKERS[entity], name: titleCase(entity) };
  // 3) Yahoo search — prefer a US-listed common stock that is NOT a fund/ETF.
  try {
    const search = await fetchYahooJson(`/v1/finance/search?q=${encodeURIComponent(entity)}&quotesCount=10&newsCount=0`, "Stock search");
    const quotes: any[] = (search?.quotes || []).filter((x: any) => x?.symbol);
    const US = new Set(["NYQ", "NMS", "NGM", "NCM", "ASE", "PCX", "BATS"]);
    const fundish = (x: any) => /\b(etf|fund|trust|index|portfolio|etn)\b/i.test(`${x.shortname || ""} ${x.longname || ""}`);
    const q =
      quotes.find((x) => x.quoteType === "EQUITY" && US.has(x.exchange) && !fundish(x)) ||
      quotes.find((x) => x.quoteType === "EQUITY" && !fundish(x)) ||
      quotes.find((x) => x.quoteType === "EQUITY" && US.has(x.exchange)) ||
      quotes.find((x) => US.has(x.exchange)) ||
      quotes[0];
    if (!q?.symbol) return null;
    return { symbol: q.symbol, name: q.shortname || q.longname || q.symbol };
  } catch (error) {
    console.error("Stock search error:", error);
    return null;
  }
}

async function fetchStockQuote(query: string): Promise<TrackerSnapshot | null> {
  const entity = query
    .toLowerCase()
    .replace(/[?.!,]/g, "")
    .replace(/\b(stock|stocks|shares?|share|price|ticker|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!entity) return null;
  try {
    const resolved = await resolveStockSymbol(query, entity);
    if (!resolved) return null;
    const symbol = resolved.symbol;
    const name = resolved.name;
    const chart = await fetchYahooJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, "Stock price");
    const result = chart?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    let price: number | null = typeof meta.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (Array.isArray(closes)) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === "number") { price = closes[i]; break; }
      }
    }
    if (typeof price !== "number") return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const chg = typeof prev === "number" && prev ? ((price - prev) / prev) * 100 : null;
    const trend = chg == null ? "flat" : chg >= 0 ? "up" : "down";
    return {
      title: symbol,
      symbol: trend === "down" ? "chart.line.downtrend.xyaxis" : "chart.line.uptrend.xyaxis",
      line1: money(price, meta.currency || "USD"),
      line2: name,
      trend,
      status: chg == null ? "" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% today`,
      sources: [{ title: "finance.yahoo.com", url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` }]
    };
  } catch (error) {
    console.error("Stock quote error:", error);
    return null;
  }
}

const ESPN_LEAGUES: Array<{ match: RegExp; path: string }> = [
  { match: /\b(yankees|mets|red sox|dodgers|cubs|phillies|braves|astros|padres|mlb|baseball)\b/i, path: "baseball/mlb" },
  { match: /\b(lakers|celtics|warriors|knicks|nets|heat|bucks|suns|mavericks|nuggets|cavaliers|nba|basketball)\b/i, path: "basketball/nba" },
  { match: /\b(chiefs|eagles|cowboys|packers|steelers|patriots|49ers|bills|ravens|jets|dolphins|commanders|nfl|football)\b/i, path: "football/nfl" },
  { match: /\b(bruins|maple leafs|canadiens|oilers|lightning|golden knights|nhl|hockey)\b/i, path: "hockey/nhl" },
  { match: /\b(inter miami|mls)\b/i, path: "soccer/usa.1" },
  { match: /\b(arsenal|chelsea|liverpool|manchester united|manchester city|tottenham|premier league)\b/i, path: "soccer/eng.1" },
  { match: /\b(barcelona|real madrid|la liga)\b/i, path: "soccer/esp.1" },
  { match: /\b(bayern munich|bundesliga)\b/i, path: "soccer/ger.1" }
];

function sportsDateKey(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}${value("month")}${value("day")}`;
}

const sportsWords = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, " ")
  .split(/\s+/).filter((word) => word.length > 1 && ![
    "the", "game", "match", "event", "score", "track", "follow", "versus", "vs",
    "today", "tonight", "tomorrow", "live", "right", "now", "please"
  ].includes(word));

export function espnSportsSnapshotFromResponse(data: any, query: string, timeZone: string = TIME_ZONE): TrackerSnapshot | null {
  const wanted = sportsWords(query);
  const events = Array.isArray(data?.events) ? data.events : [];
  const event = events.find((candidate: any) => {
    const competition = candidate?.competitions?.[0];
    const names = (competition?.competitors || []).flatMap((competitor: any) => [
      competitor?.team?.displayName, competitor?.team?.shortDisplayName,
      competitor?.team?.name, competitor?.team?.abbreviation
    ]).filter(Boolean).join(" ").toLowerCase();
    return wanted.length > 0 && wanted.every((word) => names.includes(word));
  });
  const competition = event?.competitions?.[0];
  if (!competition) return null;
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const away = competitors.find((team: any) => team.homeAway === "away") || competitors[1];
  const home = competitors.find((team: any) => team.homeAway === "home") || competitors[0];
  if (!away?.team || !home?.team) return null;
  const status = competition.status || event.status || {};
  const state = String(status?.type?.state || "pre");
  const awayAbbr = String(away.team.abbreviation || away.team.shortDisplayName || "Away").slice(0, 5);
  const homeAbbr = String(home.team.abbreviation || home.team.shortDisplayName || "Home").slice(0, 5);
  const awayScore = String(away.score ?? "0");
  const homeScore = String(home.score ?? "0");
  const scoreLine = state === "pre" ? `${awayAbbr} – ${homeAbbr}` : `${awayAbbr} ${awayScore} – ${homeAbbr} ${homeScore}`;
  const awayValue = Number(awayScore);
  const homeValue = Number(homeScore);
  const leader = awayValue === homeValue ? "Tied" : awayValue > homeValue
    ? `${away.team.shortDisplayName || away.team.name} lead`
    : `${home.team.shortDisplayName || home.team.name} lead`;
  const when = new Date(competition.date || event.date);
  const scheduled = Number.isFinite(when.getTime())
    ? when.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    : "Scheduled";
  const statusText = state === "pre" ? scheduled : String(status?.type?.shortDetail || status?.type?.detail || (state === "post" ? "Final" : "Live"));
  const finishedLabel = /\b(postponed|cancelled|canceled|suspended)\b/i.test(statusText) ? statusText : "Final";
  return {
    title: `${away.team.shortDisplayName || away.team.name} vs ${home.team.shortDisplayName || home.team.name}`.slice(0, 40),
    symbol: "sportscourt.fill",
    line1: scoreLine.slice(0, 24),
    line2: (state === "pre" ? "Scheduled" : state === "post" ? finishedLabel : leader).slice(0, 30),
    trend: "flat",
    status: statusText.slice(0, 20)
  };
}

async function fetchEspnSportsScore(query: string, timeZone: string): Promise<TrackerSnapshot | null> {
  const preferred = ESPN_LEAGUES.filter((candidate) => candidate.match.test(query));
  const leagues = preferred.length ? preferred : ESPN_LEAGUES;
  const uniquePaths = Array.from(new Set(leagues.map((league) => league.path)));
  const snapshots = await Promise.all(uniquePaths.map(async (path) => {
    try {
      const sourceUrl = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${sportsDateKey(timeZone)}&limit=100`;
      const response: any = await withTimeout(fetch(sourceUrl, { headers: PRICE_HEADERS }), 8000, "Sports scoreboard");
      if (!response.ok) return null;
      const snapshot = espnSportsSnapshotFromResponse(await response.json(), query, timeZone);
      return snapshot ? { ...snapshot, sources: [{ title: "espn.com", url: sourceUrl }] } : null;
    } catch (error) {
      console.error("Sports scoreboard error:", error);
      return null;
    }
  }));
  return snapshots.find((snapshot) => snapshot !== null) || null;
}

async function fetchSportsScore(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const structured = await fetchEspnSportsScore(query, timeZone);
  if (structured) return structured;
  const nowLocal = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  const prompt = `Right now it is ${nowLocal}.
Find the score of the game involving "${query}" that is IN PROGRESS RIGHT NOW, or SCHEDULED FOR LATER TODAY (${nowLocal.split(" at ")[0]}).
CRITICAL: Use ONLY a game from today or one currently live. NEVER report a game from a previous day, even if the same two teams played then. If the only game between these teams happened on an earlier date, respond with exactly: null.
Respond with ONLY compact JSON (no markdown, no code fences):
{"title":"<Away> vs <Home>","line1":"<awayAbbr> <awayScore> – <homeAbbr> <homeScore>","line2":"<who is leading, or 'Final' / 'Tied'>","status":"<period and clock like 'Q4 2:15', 'Top 5th', 'Final', or the scheduled start time if it hasn't started>","trend":"flat"}
If it hasn't started yet, set line1 to the matchup abbreviations with no scores and status to the start time. If you can't find a game today, respond with exactly: null`;
  try {
    const res: any = await withTimeout(
      generateContent({ model: TRACKER_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }], thinkingConfig: { thinkingBudget: 0 } } } as any),
      TRACKER_TIMEOUT_MS, "Sports score"
    );
    const text = (res.text || "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = safeParseJsonObject(text);
    if (!obj || typeof obj.line1 !== "string") return null;
    const sources = groundingSources(res);
    if (!sources.length) return null;
    return {
      title: String(obj.title || query).slice(0, 40),
      symbol: "sportscourt.fill",
      line1: String(obj.line1 || "").slice(0, 24),
      line2: String(obj.line2 || "").slice(0, 30),
      trend: "flat",
      status: String(obj.status || "Live").slice(0, 20),
      sources
    };
  } catch (error) {
    console.error("Sports score error:", error);
    return null;
  }
}

const APPLE_MAC_STORE_URL = "https://www.apple.com/shop/buy-mac";
const APPLE_MAC_PRODUCTS = [
  { name: "MacBook Air", shortName: "Air", path: "/shop/buy-mac/macbook-air", aliases: [/\bmacbook air\b/i, /^air$/i] },
  { name: "MacBook Pro", shortName: "Pro", path: "/shop/buy-mac/macbook-pro", aliases: [/\bmacbook pro\b/i, /^pro$/i] },
  { name: "Mac mini", shortName: "mini", path: "/shop/buy-mac/mac-mini", aliases: [/\bmac mini\b/i, /^mini$/i] },
  { name: "iMac", shortName: "iMac", path: "/shop/buy-mac/imac", aliases: [/\bimac\b/i] },
  { name: "Mac Studio", shortName: "Studio", path: "/shop/buy-mac/mac-studio", aliases: [/\bmac studio\b/i, /^studio$/i] }
] as const;

type AppleMacProduct = (typeof APPLE_MAC_PRODUCTS)[number];

function requestedAppleMacProducts(query: string): AppleMacProduct[] {
  const parts = query
    .replace(/\b(track|follow|watch|monitor|price|prices|pricing|cost|costs|of|the)\b/gi, " ")
    .split(/\s+(?:vs\.?|versus)\s+|\s*,\s*|\s+and\s+/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const products = parts.map((part) => APPLE_MAC_PRODUCTS.find((product) => product.aliases.some((alias) => alias.test(part))));
  if (!products.length || products.some((product) => !product)) return [];
  const unique = products.filter((product, index) => products.indexOf(product) === index) as AppleMacProduct[];
  return unique;
}

function normalizedApplePath(href: string): string {
  try {
    return new URL(href, APPLE_MAC_STORE_URL).pathname.replace(/\/$/, "");
  } catch {
    return href.split(/[?#]/)[0].replace(/\/$/, "");
  }
}

export function appleMacPriceSnapshotFromHtml(html: string, query: string): TrackerSnapshot | null {
  const requested = requestedAppleMacProducts(query);
  if (!requested.length) return null;
  const root = parseHtml(html);
  // Apple renders its product shelf inside <noscript>; node-html-parser keeps
  // that body as text, so parse those fragments as documents as well.
  const roots = [root, ...root.querySelectorAll("noscript").map((node) => parseHtml(node.innerHTML))];
  const prices = new Map<string, string>();
  for (const document of roots) {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      const product = requested.find((candidate) => normalizedApplePath(href) === candidate.path);
      if (!product || prices.has(product.path)) continue;
      const priceText = anchor.querySelector(".rf-hcard-scrim-price")?.textContent || anchor.textContent;
      const price = priceText.replace(/\s+/g, " ").match(/\bFrom\s+(\$[\d,]+(?:\.\d{2})?)/i)?.[1];
      if (price) prices.set(product.path, price.replace(/\.00$/, ""));
    }
  }
  if (requested.some((product) => !prices.has(product.path))) return null;
  const comparing = requested.length > 1;
  return {
    title: comparing ? "Mac price comparison" : requested[0].name,
    symbol: "tag.fill",
    line1: requested.map((product) => prices.get(product.path)).join(" · ").slice(0, 48),
    line2: requested.map((product) => comparing ? product.shortName : product.name).join(" · ").slice(0, 44),
    trend: "flat",
    status: "Apple US starting prices",
    sources: [{ title: "apple.com", url: APPLE_MAC_STORE_URL }]
  };
}

async function fetchAppleMacPriceSnapshot(query: string): Promise<TrackerSnapshot | null> {
  if (!requestedAppleMacProducts(query).length) return null;
  try {
    const response: any = await withTimeout(fetch(APPLE_MAC_STORE_URL, { headers: PRICE_HEADERS }), 8000, "Apple Store prices");
    if (!response.ok) return null;
    return appleMacPriceSnapshotFromHtml(await response.text(), query);
  } catch (error) {
    console.error("Apple Store price error:", error);
    return null;
  }
}

async function fetchProductPriceSnapshot(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const appleSnapshot = await fetchAppleMacPriceSnapshot(query);
  if (appleSnapshot) return appleSnapshot;
  const nowLocal = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  const requestedItems = query
    .split(/\s+(?:vs\.?|versus)\s+|\s*,\s*|\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
  const expectedPrices = Math.max(1, requestedItems.length);
  const prompt = `Right now it is ${nowLocal}.
Find the current NEW retail price in USD for every product in this exact comparison: "${query}".
Use the manufacturer's official US store when available. Otherwise use a major authorized US retailer. Preserve the user's product order. For an underspecified product family, use the current base model and its starting price; do not silently substitute a different product. If you cannot verify every requested product, respond with exactly: null.
Respond with ONLY compact JSON (no markdown, no code fences):
{"title":"<short comparison title, max 30 chars>","line1":"<prices only in order, separated by ·, e.g. '$999 · $1,599 · $599'>","line2":"<short product labels in the same order, separated by ·, e.g. 'Air · Pro · mini'>","status":"<short source context, e.g. 'Apple US starting prices'>"}`;
  try {
    const res: any = await withTimeout(
      generateContent({ model: RESEARCH_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } } as any),
      RESEARCH_TIMEOUT_MS,
      "Product prices"
    );
    const text = String(res.text || "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = safeParseJsonObject(text);
    const line1 = String(obj?.line1 || "").trim();
    const line2 = String(obj?.line2 || "").trim();
    const priceCount = line1.match(/(?:\$|USD\s*)[\d,.]+/gi)?.length || 0;
    if (!obj || !line1 || !line2 || priceCount < expectedPrices) return null;
    const sources = groundingSources(res);
    if (!sources.length) return null;
    return {
      title: String(obj.title || "Product prices").slice(0, 30),
      symbol: "tag.fill",
      line1: line1.slice(0, 48),
      line2: line2.slice(0, 44),
      trend: "flat",
      status: String(obj.status || "Current retail prices").slice(0, 36),
      sources
    };
  } catch (error) {
    console.error("Product price error:", error);
    return null;
  }
}

// Pull the current snapshot for a tracker. Used both when starting the activity
// and by the device's refresh loop (/api/quote, /api/score).
type FlightStatsAirport = {
  fs?: string;
  iata?: string;
  times?: {
    scheduled?: { time?: string; ampm?: string; timezone?: string };
    estimatedActual?: { title?: string; time?: string; ampm?: string; timezone?: string };
  };
};

function compactFlightClock(value: any): string {
  const time = String(value?.time || "").trim();
  const ampm = String(value?.ampm || "").trim().toLowerCase();
  return `${time}${ampm ? ampm.charAt(0) : ""}`;
}

function flightTimeLine(airport: FlightStatsAirport, phase: "departed" | "arrived", statusDescription: string): string {
  const scheduled = compactFlightClock(airport?.times?.scheduled);
  const estimate = airport?.times?.estimatedActual;
  const estimateTime = compactFlightClock(estimate);
  const estimateTitle = String(estimate?.title || "").toLowerCase();
  let note = statusDescription || "scheduled";
  if (estimateTime && estimateTitle.includes("actual")) note = `${phase} ${estimateTime}`;
  else if (estimateTime && estimateTime !== scheduled) note = `est ${estimateTime}`;
  else if (/on time/i.test(statusDescription)) note = "on time";
  return `${scheduled || estimateTime || "—"}|${note}`.slice(0, 30);
}

export function flightStatsSnapshotFromHtml(html: string, requestedFlight: string, sourceUrl: string): TrackerSnapshot | null {
  const marker = "__NEXT_DATA__ =";
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = html.indexOf("{", start + marker.length);
  if (jsonStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonEnd = -1;
  for (let index = jsonStart; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") { inString = true; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) { jsonEnd = index + 1; break; }
    }
  }
  if (jsonEnd < 0) return null;
  const raw = html.slice(jsonStart, jsonEnd);
  let data: any;
  try { data = JSON.parse(raw); } catch { return null; }
  const flight = data?.props?.initialState?.flightTracker?.flight;
  const header = flight?.resultHeader;
  const carrier = String(header?.carrier?.fs || "").toUpperCase();
  const number = String(header?.flightNumber || "").toUpperCase();
  const actualCode = `${carrier}${number}`;
  const expectedCode = requestedFlight.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!flight || !carrier || !number || actualCode !== expectedCode) return null;

  const departure = flight.departureAirport as FlightStatsAirport;
  const arrival = flight.arrivalAirport as FlightStatsAirport;
  const depCode = String(departure?.iata || departure?.fs || header?.departureAirportFS || "DEP").toUpperCase();
  const arrCode = String(arrival?.iata || arrival?.fs || header?.arrivalAirportFS || "ARR").toUpperCase();
  const statusDescription = String(flight?.status?.statusDescription || header?.statusDescription || flight?.status?.status || "Scheduled").trim();
  const status = String(flight?.status?.status || statusDescription).trim();
  const rawColor = String(flight?.status?.color || "").toLowerCase();
  const color = rawColor === "red" || rawColor === "yellow" ? rawColor : "green";
  const trend = color === "red" ? "down" : color === "green" ? "up" : "flat";

  return {
    title: `${actualCode} · ${depCode}→${arrCode}`.slice(0, 30),
    symbol: "airplane",
    line1: flightTimeLine(departure, "departed", statusDescription),
    line2: flightTimeLine(arrival, "arrived", statusDescription),
    trend,
    status: `${status}${statusDescription && statusDescription !== status ? ` · ${statusDescription}` : ""}`.slice(0, 44),
    depColor: color,
    arrColor: color,
    sources: [{ title: "flightstats.com", url: sourceUrl }]
  };
}

async function fetchFlightStatsStatus(query: string): Promise<TrackerSnapshot | null> {
  const flight = (extractFlightCode(query) || query).toUpperCase().replace(/\s+/g, "");
  const match = flight.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (!match) return null;
  const sourceUrl = `https://www.flightstats.com/v2/flight-tracker/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
  try {
    const response: any = await withTimeout(fetch(sourceUrl, { headers: PRICE_HEADERS }), 10000, "FlightStats");
    if (!response.ok) return null;
    return flightStatsSnapshotFromHtml(await response.text(), flight, sourceUrl);
  } catch (error) {
    console.error("FlightStats error:", error);
    return null;
  }
}

// Live flight status uses FlightStats' structured public tracker first and
// grounded search as a fallback. Returns a snapshot the Live Activity renders.
async function fetchFlightStatus(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const flight = query.toUpperCase().replace(/\s+/g, "");
  const structured = await fetchFlightStatsStatus(flight);
  if (structured) return structured;
  const nowLocal = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  const prompt = `Right now it is ${nowLocal}.
Report the CURRENT status of airline flight "${flight}" for today (or its most recent/next occurrence if it operates daily).
Respond with ONLY compact JSON (no markdown, no code fences):
{
 "title":"<flight code · route, e.g. 'UA328 · DEN→HNL'>",
 "dep":"<departure as 'SCHEDULED|note': the scheduled clock time, a pipe, then a SHORT note — 'on time', or 'exp 6:25p' if delayed/estimated, or 'departed 6:05p' if it already left. e.g. '6:00p|on time' or '6:00p|exp 6:25p'>",
 "arr":"<arrival as 'SCHEDULED|note', same rule with 'arrived 9:50p'/'landed 9:50p' for the past. e.g. '9:45p|on time' or '9:45p|exp 10:10p'>",
 "depColor":"<'green' if departing/departed on time or early, 'yellow' if <30 min late or only estimated, 'red' if 30+ min late or cancelled>",
 "arrColor":"<same rule for arrival>",
 "status":"<SHORT overall + ONE useful detail: 'On time · Gate B22' | 'Delayed 25 min' | 'Boarding · T2' | 'In air' | 'Landed · Bag 5' | 'Cancelled'>",
 "trend":"<'up' if on time or landed on time, 'down' if delayed/cancelled, else 'flat'>"
}
Use the user's local timezone (${timeZone}). Always include the '|note' part. If you cannot identify this flight, respond with exactly: null`;
  try {
    const res: any = await withTimeout(
      generateContent({ model: TRACKER_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }], thinkingConfig: { thinkingBudget: 0 } } } as any),
      TRACKER_TIMEOUT_MS, "Flight status"
    );
    const text = (res.text || "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = safeParseJsonObject(text);
    if (!obj || (typeof obj.dep !== "string" && typeof obj.status !== "string")) return null;
    // Grounded search still needs entity validation. Never attach another
    // flight's times to the requested code.
    const normalizedTitle = String(obj.title || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalizedTitle.includes(flight)) return null;
    const sources = groundingSources(res);
    if (!sources.length) return null;
    const trend = obj.trend === "up" || obj.trend === "down" ? obj.trend : "flat";
    const color = (c: any) => (c === "green" || c === "yellow" || c === "red" ? c : "green");
    return {
      title: String(obj.title || flight).slice(0, 30),
      symbol: "airplane",
      line1: String(obj.dep || "").slice(0, 30),  // departure "SCHEDULED|note"
      line2: String(obj.arr || "").slice(0, 30),  // arrival "SCHEDULED|note"
      trend,
      status: String(obj.status || "").slice(0, 44),
      depColor: color(obj.depColor),
      arrColor: color(obj.arrColor),
      sources
    };
  } catch (error) {
    console.error("Flight status error:", error);
    return null;
  }
}

// Real package tracking via Ship24 (one universal API for UPS/FedEx/DHL/USPS/…).
// We create a durable tracker once, save its trackerId, then use the fast results
// endpoint for every refresh. Without a key the card remains an honest deep link.
const SHIP24_KEY = process.env.SHIP24_API_KEY || "";
export function isPackageTrackingConfigured(): boolean { return !!SHIP24_KEY; }

const SHIP24_MILESTONES: Record<string, { label: string; symbol: string; delivered?: boolean }> = {
  delivered: { label: "Delivered", symbol: "checkmark.circle.fill", delivered: true },
  out_for_delivery: { label: "Out for delivery", symbol: "shippingbox.fill" },
  in_transit: { label: "In transit", symbol: "shippingbox.fill" },
  available_for_pickup: { label: "Ready for pickup", symbol: "shippingbox.fill" },
  failed_attempt: { label: "Delivery attempted", symbol: "exclamationmark.triangle.fill" },
  exception: { label: "Delivery issue", symbol: "exclamationmark.triangle.fill" },
  info_received: { label: "Label created", symbol: "shippingbox.fill" },
  pending: { label: "Tracking…", symbol: "shippingbox.fill" }
};

type Ship24Status = { line1: string; line2: string; symbol: string; delivered: boolean; eta: string };
type Ship24TrackerRecord = { trackerId: string; trackingNumber: string; createdAt: number };

const ship24Headers = () => ({ Authorization: `Bearer ${SHIP24_KEY}`, "Content-Type": "application/json" });
const ship24Key = (number: string) => `ship24:tracker:${createHash("sha256").update(number.toUpperCase()).digest("hex").slice(0, 32)}`;

function ship24Location(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const location = value as Record<string, unknown>;
  return [location.city, location.state, location.countryCode || location.country]
    .map((part) => typeof part === "string" ? part.trim() : "")
    .filter(Boolean)
    .join(", ");
}

export function ship24StatusFromResponse(data: any): Ship24Status | null {
  const tracking = data?.data?.trackings?.[0];
  if (!tracking) return null;
  const milestone = String(tracking?.shipment?.statusMilestone || "pending").toLowerCase();
  const normalized = SHIP24_MILESTONES[milestone] || SHIP24_MILESTONES.pending;
  const events = Array.isArray(tracking?.events) ? [...tracking.events] : [];
  events.sort((a, b) => String(b?.occurrenceDatetime || "").localeCompare(String(a?.occurrenceDatetime || "")));
  const event = events[0] || null;
  const eventText = typeof event?.status === "string" ? event.status.trim() : "";
  const location = ship24Location(event?.location);
  const delivery = tracking?.shipment?.delivery || {};
  const eta = String(delivery.estimatedDeliveryDate || delivery.estimatedDeliveryDateFrom || "").trim();
  return {
    line1: (eventText || normalized.label).slice(0, 42),
    line2: (location || normalized.label).slice(0, 30),
    symbol: normalized.symbol,
    delivered: !!normalized.delivered,
    eta
  };
}

async function createShip24Tracker(number: string): Promise<Ship24TrackerRecord | null> {
  const response: any = await withTimeout(fetch("https://api.ship24.com/public/v1/trackers", {
    method: "POST",
    headers: ship24Headers(),
    // Ship24 recommends auto-detection unless a verified courier code is known.
    body: JSON.stringify({ trackingNumber: number })
  }), 12000, "Ship24 create tracker");
  if (!response.ok) {
    console.error("Ship24 create", response.status, (await response.text().catch(() => "")).slice(0, 160));
    return null;
  }
  const data = await response.json();
  const trackerId = String(data?.data?.tracker?.trackerId || "").trim();
  if (!trackerId) return null;
  const record = { trackerId, trackingNumber: number, createdAt: Date.now() };
  await storeSet(ship24Key(number), record);
  return record;
}

async function fetchShip24Status(number: string): Promise<Ship24Status | null> {
  if (!SHIP24_KEY) return null;
  const key = ship24Key(number);
  try {
    let record = await storeGet<Ship24TrackerRecord | null>(key, null);
    if (!record?.trackerId) record = await createShip24Tracker(number);
    if (!record?.trackerId) return null;

    const response: any = await withTimeout(fetch(
      `https://api.ship24.com/public/v1/trackers/${encodeURIComponent(record.trackerId)}/results`,
      { headers: ship24Headers() }
    ), 12000, "Ship24 tracker results");
    if (response.status === 404) {
      await storeDelete(key);
      return null;
    }
    if (!response.ok) {
      console.error("Ship24 results", response.status, (await response.text().catch(() => "")).slice(0, 160));
      return null;
    }
    return ship24StatusFromResponse(await response.json());
  } catch (error) {
    console.error("Ship24 error:", error);
    return null;
  }
}

// Package snapshot for the Live Activity. query = "carrier:number". When a
// tracking API key is configured we show REAL live status (and the LA updates on
// each push); otherwise we fall back to an honest "Tap to track" card. Either way
// the card keeps its "Open <carrier>" button.
export async function fetchPackageSnapshot(query: string): Promise<TrackerSnapshot | null> {
  const idx = query.indexOf(":");
  const carrier = idx >= 0 ? query.slice(0, idx) : "";
  const number = (idx >= 0 ? query.slice(idx + 1) : query).trim();
  if (!number) return null;
  const tail = number.length > 8 ? `#…${number.slice(-6)}` : `#${number}`;

  const live = await fetchShip24Status(number);
  if (live) {
    return {
      title: carrier || "Package", symbol: live.symbol, line1: live.line1, line2: live.line2,
      trend: live.delivered ? "up" : "flat", status: "", eta: live.eta || undefined,
      delivered: live.delivered,
      sources: [{ title: "ship24.com", url: `https://www.ship24.com/tracking?p=${encodeURIComponent(number)}` }]
    };
  }
  return {
    title: carrier || "Package",
    symbol: "shippingbox.fill",
    line1: SHIP24_KEY ? "Tracking…" : "Tap to track",
    line2: tail,
    trend: "flat",
    status: ""
  };
}

export async function fetchTrackerSnapshot(kind: string, query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const safeKind = normalizeTrackerKind(kind, query);
  if (safeKind === "product") return fetchProductPriceSnapshot(query, timeZone);
  if (safeKind === "sports") return fetchSportsScore(query, timeZone);
  if (safeKind === "flight") return fetchFlightStatus(extractFlightCode(query) || query, timeZone);
  if (safeKind === "package") return fetchPackageSnapshot(query);
  // finance: crypto first (CoinGecko), then stocks (Yahoo).
  return (await fetchCryptoQuote(query)) || (await fetchStockQuote(query));
}

// The device polls every ~10s for a smooth, live feel — but the grounded
// sports/flight lookups are slow + costly, so we cache per kind. Finance (free
// APIs) gets a short TTL so it actually refreshes each poll; sports/flight get a
// longer TTL (the data changes slowly) and serve cached snapshots in between.
const snapCache = new Map<string, { at: number; snap: TrackerSnapshot }>();
// TTLs sized so a ~15s push loop carries fresh data: finance (free APIs) every
// poll, sports each push during a game, flight a bit slower (status rarely
// changes minute-to-minute, and each lookup is a grounded search).
const SNAP_TTL: Record<string, number> = { finance: 8000, product: 30 * 60 * 1000, sports: 14000, flight: 30000, package: 60000 };
const snapInflight = new Map<string, Promise<TrackerSnapshot | null>>();

export async function cachedTrackerSnapshot(kind: string, query: string, timeZone?: string): Promise<TrackerSnapshot | null> {
  const key = `${kind}:${query.toLowerCase()}:${timeZone || ""}`;
  const ttl = SNAP_TTL[kind] ?? 10000;
  const cached = snapCache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.snap;
  const existing = snapInflight.get(key);
  if (existing) return (await existing) || cached?.snap || null;
  const request = fetchTrackerSnapshot(kind, query, timeZone)
    .then((snap) => {
      const pendingPackage = kind === "package" && snap?.line1 === "Tracking…";
      if (snap && !pendingPackage) snapCache.set(key, { at: Date.now(), snap });
      return snap;
    })
    .finally(() => snapInflight.delete(key));
  snapInflight.set(key, request);
  return (await request) || cached?.snap || null; // serve stale data on a transient failure
}

// Numeric price for an asset (crypto or stock), reusing the same resolution as
// the trackers. Used by the price-alert engine. Returns the displayed price (the
// same value the user sees), its label, and 24h trend, or null.
export async function fetchAssetPrice(query: string): Promise<{ price: number; label: string; trend: string; sources: AssistantSource[] } | null> {
  const snap = await fetchTrackerSnapshot("finance", query);
  if (!snap) return null;
  const price = parseFloat(snap.line1.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(price)) return null;
  return { price, label: snap.title, trend: snap.trend, sources: snap.sources || [] };
}
