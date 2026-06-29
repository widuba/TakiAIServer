import { ai, RESEARCH_MODEL, RESEARCH_TIMEOUT_MS, TIME_ZONE } from "./ai.js";
import { withTimeout } from "./util.js";

/* ============================================================================
 * Finance + sports Live Activity tracking.
 *
 * parseTrackCommand detects "track/follow AAPL", "follow the Lakers game", etc.
 * fetchTrackerSnapshot pulls the current numbers (Yahoo for stocks, CoinGecko
 * for crypto, grounded search for sports) into a compact snapshot the device
 * renders in the Live Activity / Dynamic Island and re-polls to stay live.
 * ==========================================================================*/

export interface TrackerSnapshot {
  title: string;   // "AAPL", "Lakers vs Celtics"
  symbol: string;  // emoji badge
  line1: string;   // "$195.20", "102 – 98"
  line2: string;   // "Apple Inc.", "Lakers lead"
  trend: string;   // "up" | "down" | "flat"
  status: string;  // "+1.24% today", "Q4 · 2:15"
}

const PRICE_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TakiAI/1.0)" };

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
const SPORTS_CUE =
  /\b(vs\.?|versus|@|game|match|score|playing|kickoff|tip ?off|nba|nfl|mlb|nhl|mls|premier league|la ?liga|champions league|world cup|super ?bowl)\b/i;
const FINANCE_CUE =
  /\b(stock|shares?|ticker|price|nasdaq|nyse|crypto|coin)\b/i;

// Detect a "track X" command and classify it. Returns null for everything else
// (including "track my steps", which has no finance/sports cue).
export function parseTrackCommand(message: string): { kind: "finance" | "sports" | "flight"; query: string } | null {
  if (!TRACK_VERB.test(message)) return null;
  const m = message.toLowerCase();

  const query = message
    .replace(TRACK_VERB, " ")
    .replace(/\b(the|a|an|please|for me|my|on|stock|price|of|live)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Flight: "track flight UA123" / "follow flight DL 456". Needs the word
  // "flight" AND an airline-code+number, so it never grabs a stock ticker.
  if (/\bflight\b/i.test(message)) {
    // Airline code (2-char IATA — incl. digit codes like B6/F9 — or 3-letter
    // ICAO) + 1-4 digit flight number, optional space: "UA123", "DL 456", "B6 12".
    const code = message.match(/\b([A-Z][A-Z0-9]|[A-Z]{3})\s?(\d{1,4})\b/i);
    if (code) return { kind: "flight", query: (code[1] + code[2]).toUpperCase() };
  }

  if (SPORTS_CUE.test(message)) return { kind: "sports", query: query || message };
  if (CRYPTO_WORD.test(m) || FINANCE_CUE.test(m) || /\$[A-Za-z]{1,5}\b/.test(message) || /\b[A-Z]{2,5}\b/.test(message)) {
    return { kind: "finance", query: query || message };
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
      symbol: trend === "down" ? "📉" : "📈",
      line1: money(info.usd),
      line2: name,
      trend,
      status: chg == null ? "24h" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% today`
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
    const s: any = await withTimeout(
      fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(entity)}&quotesCount=10&newsCount=0`, { headers: PRICE_HEADERS }),
      6000, "Stock search"
    );
    const quotes: any[] = ((await s.json())?.quotes || []).filter((x: any) => x?.symbol);
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
    const r: any = await withTimeout(
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, { headers: PRICE_HEADERS }),
      6000, "Stock price"
    );
    const result = (await r.json())?.chart?.result?.[0];
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
      symbol: trend === "down" ? "📉" : "📈",
      line1: money(price, meta.currency || "USD"),
      line2: name,
      trend,
      status: chg == null ? "" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% today`
    };
  } catch (error) {
    console.error("Stock quote error:", error);
    return null;
  }
}

async function fetchSportsScore(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const nowLocal = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  const prompt = `Right now it is ${nowLocal}.
Find the score of the game involving "${query}" that is IN PROGRESS RIGHT NOW, or SCHEDULED FOR LATER TODAY (${nowLocal.split(" at ")[0]}).
CRITICAL: Use ONLY a game from today or one currently live. NEVER report a game from a previous day, even if the same two teams played then. If the only game between these teams happened on an earlier date, respond with exactly: null.
Respond with ONLY compact JSON (no markdown, no code fences):
{"title":"<Away> vs <Home>","line1":"<awayAbbr> <awayScore> – <homeAbbr> <homeScore>","line2":"<who is leading, or 'Final' / 'Tied'>","status":"<period and clock like 'Q4 2:15', 'Top 5th', 'Final', or the scheduled start time if it hasn't started>","trend":"flat"}
If it hasn't started yet, set line1 to the matchup abbreviations with no scores and status to the start time. If you can't find a game today, respond with exactly: null`;
  try {
    const res: any = await withTimeout(
      ai.models.generateContent({ model: RESEARCH_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } } as any),
      RESEARCH_TIMEOUT_MS, "Sports score"
    );
    let text = (res.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = JSON.parse(text);
    if (!obj || typeof obj.line1 !== "string") return null;
    return {
      title: String(obj.title || query).slice(0, 40),
      symbol: "🏆",
      line1: String(obj.line1 || "").slice(0, 24),
      line2: String(obj.line2 || "").slice(0, 30),
      trend: "flat",
      status: String(obj.status || "Live").slice(0, 20)
    };
  } catch (error) {
    console.error("Sports score error:", error);
    return null;
  }
}

// Pull the current snapshot for a tracker. Used both when starting the activity
// and by the device's refresh loop (/api/quote, /api/score).
// Live flight status via grounded search (same free, no-key path as sports
// scores). Returns a snapshot the Live Activity renders, or null if not found.
async function fetchFlightStatus(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  const flight = query.toUpperCase().replace(/\s+/g, "");
  const nowLocal = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  const prompt = `Right now it is ${nowLocal}.
Report the CURRENT status of airline flight "${flight}" for today (or its most recent/next occurrence if it operates daily).
Respond with ONLY compact JSON (no markdown, no code fences):
{"title":"<airline + number, e.g. 'United 123'>","line1":"<SHORT status: 'On time' | 'Delayed 25 min' | 'Boarding' | 'Departed' | 'In air' | 'Landed' | 'Cancelled'>","line2":"<ORIGIN → DEST airport codes, e.g. 'DEN → HNL'>","status":"<gate + local departure or arrival time / ETA, e.g. 'Gate B22 · dep 6:00 PM'>","trend":"<'up' if on time or landed, 'down' if delayed or cancelled, else 'flat'>"}
Use the user's local timezone (${timeZone}) for any times. If you cannot identify this flight, respond with exactly: null`;
  try {
    const res: any = await withTimeout(
      ai.models.generateContent({ model: RESEARCH_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } } as any),
      RESEARCH_TIMEOUT_MS, "Flight status"
    );
    let text = (res.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = JSON.parse(text);
    if (!obj || typeof obj.line1 !== "string") return null;
    const trend = obj.trend === "up" || obj.trend === "down" ? obj.trend : "flat";
    return {
      title: String(obj.title || flight).slice(0, 28),
      symbol: "✈️",
      line1: String(obj.line1 || "").slice(0, 24),
      line2: String(obj.line2 || "").slice(0, 30),
      trend,
      status: String(obj.status || "").slice(0, 30)
    };
  } catch (error) {
    console.error("Flight status error:", error);
    return null;
  }
}

export async function fetchTrackerSnapshot(kind: string, query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
  if (kind === "sports") return fetchSportsScore(query, timeZone);
  if (kind === "flight") return fetchFlightStatus(query, timeZone);
  // finance: crypto first (CoinGecko), then stocks (Yahoo).
  return (await fetchCryptoQuote(query)) || (await fetchStockQuote(query));
}

// Numeric price for an asset (crypto or stock), reusing the same resolution as
// the trackers. Used by the price-alert engine. Returns the displayed price (the
// same value the user sees), its label, and 24h trend, or null.
export async function fetchAssetPrice(query: string): Promise<{ price: number; label: string; trend: string } | null> {
  const snap = await fetchTrackerSnapshot("finance", query);
  if (!snap) return null;
  const price = parseFloat(snap.line1.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(price)) return null;
  return { price, label: snap.title, trend: snap.trend };
}
