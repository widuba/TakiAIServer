/* Deterministic entity classification for ambiguous live trackers. */

const AIRLINE_CODES: Record<string, string> = {
  "united airlines": "UA", united: "UA",
  "delta air lines": "DL", "delta airlines": "DL", delta: "DL",
  "american airlines": "AA", american: "AA",
  southwest: "WN", jetblue: "B6", "jet blue": "B6", alaska: "AS",
  spirit: "NK", frontier: "F9", "air canada": "AC",
  "british airways": "BA", lufthansa: "LH", emirates: "EK",
  qatar: "QR", "qatar airways": "QR", "air france": "AF", klm: "KL",
  ryanair: "FR", easyjet: "U2", "easy jet": "U2",
  "turkish airlines": "TK", turkish: "TK",
  "singapore airlines": "SQ", cathay: "CX", "cathay pacific": "CX",
  qantas: "QF", "virgin atlantic": "VS", hawaiian: "HA"
};

const FINANCE_CUE = /\b(stock|stocks|shares?|ticker|price|quote|trading|market|nasdaq|nyse|crypto|coin|valuation)\b|\$/i;
const FLIGHT_CUE = /\b(flight|airline|airlines|depart(?:ure|ing|s)?|arriv(?:al|ing|es?)?|land(?:ing|ed|s)?|gate|boarding|on time|delayed|cancelled)\b/i;
const KNOWN_AIRLINE_CODES = new Set([
  ...Object.values(AIRLINE_CODES),
  "UAL", "DAL", "AAL", "SWA", "JBU", "ASA", "NKS", "FFT", "ACA", "BAW",
  "DLH", "UAE", "QTR", "AFR", "KLM", "RYR", "EZY", "THY", "SIA", "CPA",
  "QFA", "VIR", "HAL"
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasExplicitFinanceCue(message: string): boolean {
  return FINANCE_CUE.test(message);
}

export function hasExplicitFlightCue(message: string): boolean {
  return FLIGHT_CUE.test(message);
}

// Supports IATA/ICAO codes with optional spaces or hyphens, plus common airline
// names: UA123, UA 123, UAL-123, United 123, and flight 123 on United.
export function extractFlightCode(message: string): string | null {
  const coded = message.match(/\b([A-Z][A-Z0-9]|[A-Z]{3})\s*[- ]?\s*(\d{1,4})\b/i);
  if (coded) {
    const carrier = coded[1].toUpperCase();
    const wasUppercase = coded[1] === coded[1].toUpperCase();
    if (wasUppercase || KNOWN_AIRLINE_CODES.has(carrier) || FLIGHT_CUE.test(message)) {
      return `${carrier}${coded[2]}`;
    }
  }

  const aliases = Object.entries(AIRLINE_CODES).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of aliases) {
    const airline = escapeRegex(name).replace(/\s+/g, "\\s+");
    const after = message.match(new RegExp(`\\b${airline}\\b(?:\\s+airlines?)?(?:\\s+flight)?\\s*#?\\s*(\\d{1,4})\\b`, "i"));
    if (after) return `${code}${after[1]}`;
    const before = message.match(new RegExp(`\\bflight\\s*#?\\s*(\\d{1,4})\\s+(?:on\\s+)?${airline}\\b`, "i"));
    if (before) return `${code}${before[1]}`;
  }
  return null;
}

// A code-shaped reference is a flight unless the user explicitly asks for a
// financial instrument. Explicit flight language always wins.
export function isStrongFlightReference(message: string): boolean {
  if (!extractFlightCode(message)) return false;
  return hasExplicitFlightCue(message) || !hasExplicitFinanceCue(message);
}

export function normalizeTrackerKind(kind: string, query: string): string {
  return kind === "finance" && isStrongFlightReference(query) ? "flight" : kind;
}
