import { generateContent, RESEARCH_MODEL, RESEARCH_TIMEOUT_MS, TIME_ZONE } from "./ai.js";
import { safeParseJsonObject, withTimeout } from "./util.js";
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
  /\b(stock|shares?|ticker|quote|trading|market|nasdaq|nyse|crypto|coin)\b/i;

// Detect a "track X" command and classify it. Returns null for everything else
// (including "track my steps", which has no finance/sports cue).
export function parseTrackCommand(message: string): { kind: "finance" | "product" | "sports" | "flight"; query: string } | null {
  if (!TRACK_VERB.test(message)) return null;
  const m = message.toLowerCase();

  const query = message
    .replace(TRACK_VERB, " ")
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
  if (SPORTS_CUE.test(message)) return { kind: "sports", query: query || message };
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
      symbol: trend === "down" ? "chart.line.downtrend.xyaxis" : "chart.line.uptrend.xyaxis",
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
      generateContent({ model: RESEARCH_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } } as any),
      RESEARCH_TIMEOUT_MS, "Sports score"
    );
    const text = (res.text || "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = safeParseJsonObject(text);
    if (!obj || typeof obj.line1 !== "string") return null;
    return {
      title: String(obj.title || query).slice(0, 40),
      symbol: "sportscourt.fill",
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

async function fetchProductPriceSnapshot(query: string, timeZone: string = TIME_ZONE): Promise<TrackerSnapshot | null> {
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
    return {
      title: String(obj.title || "Product prices").slice(0, 30),
      symbol: "tag.fill",
      line1: line1.slice(0, 48),
      line2: line2.slice(0, 44),
      trend: "flat",
      status: String(obj.status || "Current retail prices").slice(0, 36)
    };
  } catch (error) {
    console.error("Product price error:", error);
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
      generateContent({ model: RESEARCH_MODEL, contents: prompt, config: { tools: [{ googleSearch: {} }] } } as any),
      RESEARCH_TIMEOUT_MS, "Flight status"
    );
    const text = (res.text || "").trim();
    if (/^null$/i.test(text)) return null;
    const obj = safeParseJsonObject(text);
    if (!obj || (typeof obj.dep !== "string" && typeof obj.status !== "string")) return null;
    // Grounded search still needs entity validation. Never attach another
    // flight's times to the requested code.
    const normalizedTitle = String(obj.title || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalizedTitle.includes(flight)) return null;
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
      arrColor: color(obj.arrColor)
    };
  } catch (error) {
    console.error("Flight status error:", error);
    return null;
  }
}

// Real package tracking via Ship24 (one universal API for UPS/FedEx/DHL/USPS/…).
// Set SHIP24_API_KEY on Render to enable live status; without it the card falls
// back to an honest "Tap to track" shortcut. The endpoint is idempotent — the
// first call creates the tracker (can be slow) and later calls return updates.
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

async function fetchShip24Status(number: string, carrier: string): Promise<{ line1: string; line2: string; symbol: string; delivered: boolean; eta: string } | null> {
  if (!SHIP24_KEY) return null;
  try {
    const body: any = { trackingNumber: number };
    const cc = carrier ? carrier.toLowerCase() : "";
    if (cc === "ups" || cc === "fedex" || cc === "dhl" || cc === "usps") body.courierCode = [cc];
    const res: any = await withTimeout(
      fetch("https://api.ship24.com/public/v1/trackers/track", {
        method: "POST",
        headers: { Authorization: `Bearer ${SHIP24_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }),
      20000, "Ship24 track"
    );
    if (!res.ok) { console.error("Ship24 status", res.status, (await res.text().catch(() => "")).slice(0, 160)); return null; }
    const data = await res.json();
    const t = data?.data?.trackings?.[0];
    if (!t) return null;
    const milestone = String(t?.shipment?.statusMilestone || "pending");
    const m = SHIP24_MILESTONES[milestone] || SHIP24_MILESTONES.pending;
    const ev = Array.isArray(t?.events) && t.events.length ? t.events[0] : null;
    const evText = ev?.status ? String(ev.status).trim() : "";
    const loc = ev?.location ? String(ev.location).trim() : "";
    const d = t?.shipment?.delivery || {};
    const eta = String(d.estimatedDeliveryDate || d.estimatedDeliveryDateFrom || "").trim();
    return {
      line1: (evText || m.label).slice(0, 42),
      line2: loc ? loc.slice(0, 30) : (m.delivered ? "Delivered" : m.label),
      symbol: m.symbol,
      delivered: !!m.delivered,
      eta
    };
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

  const live = await fetchShip24Status(number, carrier);
  if (live) {
    return { title: carrier || "Package", symbol: live.symbol, line1: live.line1, line2: live.line2, trend: live.delivered ? "up" : "flat", status: "", eta: live.eta || undefined, delivered: live.delivered };
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
const SNAP_TTL: Record<string, number> = { finance: 8000, product: 30 * 60 * 1000, sports: 14000, flight: 30000, package: 300000 };

export async function cachedTrackerSnapshot(kind: string, query: string, timeZone?: string): Promise<TrackerSnapshot | null> {
  const key = `${kind}:${query.toLowerCase()}:${timeZone || ""}`;
  const ttl = SNAP_TTL[kind] ?? 10000;
  const cached = snapCache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.snap;
  const snap = await fetchTrackerSnapshot(kind, query, timeZone);
  if (snap) { snapCache.set(key, { at: Date.now(), snap }); return snap; }
  return cached?.snap ?? null; // serve a stale snapshot rather than nothing on a transient failure
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
