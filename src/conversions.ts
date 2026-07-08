import { withTimeout } from "./util.js";

/* ============================================================================
 * Unit & currency conversion. Units convert exactly in code (no LLM). Currency
 * uses live ECB rates via the free frankfurter.app (no key). Server-only, like
 * the math tool — returns a concise answer string or null.
 * ==========================================================================*/

type Dim = "length" | "mass" | "volume" | "temp";
interface Unit { dim: Dim; factor: number; label: string } // factor = base units per 1 of this

// Base units: meter, gram, liter. Temperature handled specially.
const UNITS: Record<string, Unit> = {
  // length (base: meter)
  m: { dim: "length", factor: 1, label: "meters" }, meter: { dim: "length", factor: 1, label: "meters" }, meters: { dim: "length", factor: 1, label: "meters" }, metre: { dim: "length", factor: 1, label: "meters" }, metres: { dim: "length", factor: 1, label: "meters" },
  km: { dim: "length", factor: 1000, label: "kilometers" }, kilometer: { dim: "length", factor: 1000, label: "kilometers" }, kilometers: { dim: "length", factor: 1000, label: "kilometers" }, kilometre: { dim: "length", factor: 1000, label: "kilometers" }, kilometres: { dim: "length", factor: 1000, label: "kilometers" },
  cm: { dim: "length", factor: 0.01, label: "centimeters" }, centimeter: { dim: "length", factor: 0.01, label: "centimeters" }, centimeters: { dim: "length", factor: 0.01, label: "centimeters" },
  mm: { dim: "length", factor: 0.001, label: "millimeters" }, millimeter: { dim: "length", factor: 0.001, label: "millimeters" }, millimeters: { dim: "length", factor: 0.001, label: "millimeters" },
  mi: { dim: "length", factor: 1609.344, label: "miles" }, mile: { dim: "length", factor: 1609.344, label: "miles" }, miles: { dim: "length", factor: 1609.344, label: "miles" },
  yd: { dim: "length", factor: 0.9144, label: "yards" }, yard: { dim: "length", factor: 0.9144, label: "yards" }, yards: { dim: "length", factor: 0.9144, label: "yards" },
  ft: { dim: "length", factor: 0.3048, label: "feet" }, foot: { dim: "length", factor: 0.3048, label: "feet" }, feet: { dim: "length", factor: 0.3048, label: "feet" },
  in: { dim: "length", factor: 0.0254, label: "inches" }, inch: { dim: "length", factor: 0.0254, label: "inches" }, inches: { dim: "length", factor: 0.0254, label: "inches" },
  // mass (base: gram)
  g: { dim: "mass", factor: 1, label: "grams" }, gram: { dim: "mass", factor: 1, label: "grams" }, grams: { dim: "mass", factor: 1, label: "grams" },
  kg: { dim: "mass", factor: 1000, label: "kilograms" }, kilogram: { dim: "mass", factor: 1000, label: "kilograms" }, kilograms: { dim: "mass", factor: 1000, label: "kilograms" }, kilo: { dim: "mass", factor: 1000, label: "kilograms" }, kilos: { dim: "mass", factor: 1000, label: "kilograms" },
  mg: { dim: "mass", factor: 0.001, label: "milligrams" }, milligram: { dim: "mass", factor: 0.001, label: "milligrams" }, milligrams: { dim: "mass", factor: 0.001, label: "milligrams" },
  lb: { dim: "mass", factor: 453.592, label: "pounds" }, lbs: { dim: "mass", factor: 453.592, label: "pounds" }, pound: { dim: "mass", factor: 453.592, label: "pounds" }, pounds: { dim: "mass", factor: 453.592, label: "pounds" },
  oz: { dim: "mass", factor: 28.3495, label: "ounces" }, ounce: { dim: "mass", factor: 28.3495, label: "ounces" }, ounces: { dim: "mass", factor: 28.3495, label: "ounces" },
  ton: { dim: "mass", factor: 1_000_000, label: "metric tons" }, tons: { dim: "mass", factor: 1_000_000, label: "metric tons" }, tonne: { dim: "mass", factor: 1_000_000, label: "metric tons" },
  stone: { dim: "mass", factor: 6350.29, label: "stone" }, stones: { dim: "mass", factor: 6350.29, label: "stone" },
  // volume (base: liter)
  l: { dim: "volume", factor: 1, label: "liters" }, liter: { dim: "volume", factor: 1, label: "liters" }, liters: { dim: "volume", factor: 1, label: "liters" }, litre: { dim: "volume", factor: 1, label: "liters" }, litres: { dim: "volume", factor: 1, label: "liters" },
  ml: { dim: "volume", factor: 0.001, label: "milliliters" }, milliliter: { dim: "volume", factor: 0.001, label: "milliliters" }, milliliters: { dim: "volume", factor: 0.001, label: "milliliters" },
  cup: { dim: "volume", factor: 0.236588, label: "cups" }, cups: { dim: "volume", factor: 0.236588, label: "cups" },
  pint: { dim: "volume", factor: 0.473176, label: "pints" }, pints: { dim: "volume", factor: 0.473176, label: "pints" },
  quart: { dim: "volume", factor: 0.946353, label: "quarts" }, quarts: { dim: "volume", factor: 0.946353, label: "quarts" },
  gallon: { dim: "volume", factor: 3.78541, label: "gallons" }, gallons: { dim: "volume", factor: 3.78541, label: "gallons" }, gal: { dim: "volume", factor: 3.78541, label: "gallons" },
  tbsp: { dim: "volume", factor: 0.0147868, label: "tablespoons" }, tablespoon: { dim: "volume", factor: 0.0147868, label: "tablespoons" }, tablespoons: { dim: "volume", factor: 0.0147868, label: "tablespoons" },
  tsp: { dim: "volume", factor: 0.00492892, label: "teaspoons" }, teaspoon: { dim: "volume", factor: 0.00492892, label: "teaspoons" }, teaspoons: { dim: "volume", factor: 0.00492892, label: "teaspoons" },
  // temperature (special)
  c: { dim: "temp", factor: 0, label: "°C" }, celsius: { dim: "temp", factor: 0, label: "°C" }, centigrade: { dim: "temp", factor: 0, label: "°C" },
  f: { dim: "temp", factor: 0, label: "°F" }, fahrenheit: { dim: "temp", factor: 0, label: "°F" },
  k: { dim: "temp", factor: 0, label: "K" }, kelvin: { dim: "temp", factor: 0, label: "K" }
};

// "fl oz" as a special multi-word volume unit.
const FL_OZ = { dim: "volume" as Dim, factor: 0.0295735, label: "fluid ounces" };

// Common currency names/symbols → ISO code.
const CURRENCY: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", "us dollars": "USD", buck: "USD", bucks: "USD", "$": "USD",
  eur: "EUR", euro: "EUR", euros: "EUR", "€": "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", "£": "GBP", quid: "GBP", "pounds sterling": "GBP",
  jpy: "JPY", yen: "JPY", "¥": "JPY",
  cad: "CAD", "canadian dollars": "CAD", aud: "AUD", "australian dollars": "AUD",
  chf: "CHF", franc: "CHF", francs: "CHF", cny: "CNY", yuan: "CNY", rmb: "CNY",
  inr: "INR", rupee: "INR", rupees: "INR", "₹": "INR", mxn: "MXN", "mexican pesos": "MXN", peso: "MXN", pesos: "MXN",
  brl: "BRL", real: "BRL", reais: "BRL", krw: "KRW", won: "KRW", sek: "SEK", nok: "NOK", dkk: "DKK",
  hkd: "HKD", sgd: "SGD", nzd: "NZD", zar: "ZAR", rand: "ZAR", pln: "PLN", zloty: "PLN", try: "TRY", lira: "TRY"
};

function fmt(n: number): string {
  if (Math.abs(n) >= 100 || Number.isInteger(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(Number(n.toPrecision(4)));
}

// Map any temp unit key (celsius/centigrade/c, fahrenheit/f, kelvin/k) to a symbol.
function tempSym(key: string): "c" | "f" | "k" {
  if (key.startsWith("f")) return "f";
  if (key.startsWith("k")) return "k";
  return "c";
}
function tempTo(value: number, fromKey: string, toKey: string): number {
  const from = tempSym(fromKey), to = tempSym(toKey);
  let c: number; // to Celsius first
  if (from === "c") c = value; else if (from === "f") c = (value - 32) * 5 / 9; else c = value - 273.15;
  if (to === "c") return c;
  if (to === "f") return c * 9 / 5 + 32;
  return c + 273.15;
}

function lookupUnit(raw: string): (Unit & { key: string }) | null {
  const k = raw.toLowerCase().replace(/\.$/, "").trim();
  if (k === "fl oz" || k === "floz" || k === "fluid ounce" || k === "fluid ounces") return { ...FL_OZ, key: "floz" };
  const u = UNITS[k];
  return u ? { ...u, key: k } : null;
}

// Cheap pre-filter (generous — computeConversion returns null for non-conversions,
// so a false positive just falls through to the LLM harmlessly).
export function looksLikeConversion(message: string): boolean {
  const m = message.toLowerCase();
  if (/\bconvert\b/.test(m)) return true;
  if (/\bhow many\b/.test(m) && /\b(in|per|is|are|to)\b/.test(m)) return true;
  if (/\bhow much is\b/.test(m) && /\b(in|to|into)\b/.test(m)) return true;
  return /\b\d+(?:\.\d+)?\s*[a-z°$€£¥₹]+\s+(?:to|in|into)\s+[a-z°$€£¥₹]/.test(m);
}

// Returns a concise conversion answer, or null if it isn't a clean conversion.
export async function computeConversion(message: string): Promise<string | null> {
  const m = message.toLowerCase().replace(/[?!]/g, "").trim();

  // "convert 100 usd to eur" / "100 dollars in euros" / "$100 to gbp"
  let mm =
    m.match(/(?:convert\s+)?\$?€?£?¥?₹?\s*(-?\d+(?:[.,]\d+)?)\s*([a-z$€£¥₹]+(?:\s[a-z]+)?)\s+(?:to|in|into|=|equals?)\s+([a-z$€£¥₹]+(?:\s[a-z]+)?)/);
  if (mm) {
    const value = parseFloat(mm[1].replace(",", ""));
    const fromRaw = mm[2].trim(), toRaw = mm[3].trim();
    // currency?
    const fromCur = CURRENCY[fromRaw], toCur = CURRENCY[toRaw];
    if (fromCur && toCur) return await convertCurrency(value, fromCur, toCur);
    // units
    const from = lookupUnit(fromRaw), to = lookupUnit(toRaw);
    if (from && to && from.dim === to.dim) return convertUnit(value, from, to);
    if (from && to) return `Those units don't match — ${from.label} and ${to.label} measure different things.`;
  }

  // "how many cups in a liter" / "how many km in a mile"
  mm = m.match(/how many\s+([a-z ]+?)\s+(?:in|are in|per)\s+(?:a\s+|an\s+|one\s+)?([a-z ]+?)$/);
  if (mm) {
    const to = lookupUnit(mm[1].trim()), from = lookupUnit(mm[2].trim());
    if (from && to && from.dim === to.dim) return convertUnit(1, from, to);
  }

  // "how many km is 5 miles" / "how much is 30 c in f"
  mm = m.match(/how (?:many|much is)\s+([a-z ]+?)\s+(?:is|are|in)\s+(-?\d+(?:\.\d+)?)\s*([a-z°$€£¥₹]+)/)
    || m.match(/(-?\d+(?:\.\d+)?)\s*(celsius|fahrenheit|c|f|k|kelvin)\s+(?:to|in|into)\s+(celsius|fahrenheit|c|f|k|kelvin)/);
  if (mm && mm.length === 4 && /^\d/.test(mm[2] || "")) {
    const to = lookupUnit(mm[1].trim()), value = parseFloat(mm[2]), from = lookupUnit(mm[3].trim());
    if (from && to && from.dim === to.dim) return convertUnit(value, from, to);
  }

  return null;
}

function convertUnit(value: number, from: Unit & { key: string }, to: Unit & { key: string }): string {
  if (from.dim === "temp") {
    const out = tempTo(value, from.key, to.key);
    return `${fmt(value)} ${from.label} is ${fmt(out)} ${to.label}.`;
  }
  const out = value * (from.factor / to.factor);
  return `${fmt(value)} ${from.label} is ${fmt(out)} ${to.label}.`;
}

const rateCache = new Map<string, { at: number; rate: number }>();
async function convertCurrency(value: number, from: string, to: string): Promise<string | null> {
  if (from === to) return `${fmt(value)} ${from} is ${fmt(value)} ${to}.`;
  const key = `${from}:${to}`;
  const cached = rateCache.get(key);
  let rate: number | null = cached && Date.now() - cached.at < 3600_000 ? cached.rate : null;
  if (rate == null) {
    try {
      const r: any = await withTimeout(fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`), 7000, "FX");
      const d = await r.json();
      rate = d?.rates?.[to] ?? null;
      if (rate != null) rateCache.set(key, { at: Date.now(), rate });
    } catch (e) {
      console.error("FX error:", e);
    }
  }
  if (rate == null) return `I couldn't get a live exchange rate for ${from}→${to} just now.`;
  return `${fmt(value)} ${from} is about ${fmt(value * rate)} ${to} (rate ${fmt(rate)}).`;
}
