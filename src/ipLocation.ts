import { isIP } from "node:net";

/** Approximate IP geolocation supplied by Cloudflare, never device GPS. */
export interface IpLocation {
  ip: string;
  source: "cloudflare";
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
  countryCode?: string;
  continent?: string;
  postalCode?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  updatedAt: number;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
}

function cleanHeader(headers: Record<string, unknown> | undefined, name: string, limit: number, uppercase = false): string | undefined {
  let value = headerValue(headers, name);
  if (!value) return undefined;
  // Cloudflare's location transform has used URL-encoded values for some
  // non-ASCII city/region names. Decode only when it is safe to do so.
  if (/%[0-9a-f]{2}/i.test(value)) {
    try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
  }
  value = value.replace(/\s+/g, " ").trim().slice(0, limit);
  if (!value) return undefined;
  return uppercase ? value.toUpperCase() : value;
}

function coordinate(headers: Record<string, unknown> | undefined, name: string, min: number, max: number): number | undefined {
  const raw = headerValue(headers, name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  // IP geolocation is approximate; keep the dashboard payload compact and do
  // not imply GPS-level precision.
  return Math.round(value * 100) / 100;
}

/** Normalize the spellings emitted by Render, Node, and Cloudflare. */
export function normalizeIp(value: unknown): string {
  if (typeof value !== "string") return "";
  let candidate = value.trim().toLowerCase();
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) candidate = bracketed[1];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(candidate)) candidate = candidate.slice("::ffff:".length);
  return isIP(candidate) ? candidate.slice(0, 120) : "";
}

/**
 * Prefer Cloudflare's original visitor address over the proxy address. The
 * Render origin should be restricted to Cloudflare when this header is used as
 * an authoritative abuse/account-association signal; otherwise a direct caller
 * could forge proxy headers. Invalid/missing headers retain the old fallback.
 */
export function clientIpForRequest(req: any): string {
  const headers = req?.headers as Record<string, unknown> | undefined;
  for (const name of ["cf-connecting-ip", "cf-connecting-ipv6"]) {
    const cloudflareIp = normalizeIp(headerValue(headers, name));
    if (cloudflareIp) return cloudflareIp;
  }
  const expressIp = normalizeIp(req?.ip);
  if (expressIp) return expressIp;
  const forwarded = headerValue(headers, "x-forwarded-for")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const forwardedIp = normalizeIp(forwarded.at(-1));
  if (forwardedIp) return forwardedIp;
  return normalizeIp(req?.socket?.remoteAddress) || "unknown";
}

/** Read Cloudflare's optional visitor-location headers for an admin estimate. */
export function locationForRequest(req: any, ip = clientIpForRequest(req)): IpLocation | null {
  const safeIp = normalizeIp(ip);
  if (!safeIp) return null;
  const headers = req?.headers as Record<string, unknown> | undefined;
  const location: IpLocation = {
    ip: safeIp,
    source: "cloudflare",
    updatedAt: Date.now(),
    ...(cleanHeader(headers, "cf-ipcity", 100) ? { city: cleanHeader(headers, "cf-ipcity", 100) } : {}),
    ...(cleanHeader(headers, "cf-region", 100) ? { region: cleanHeader(headers, "cf-region", 100) } : {}),
    ...(cleanHeader(headers, "cf-region-code", 20, true) ? { regionCode: cleanHeader(headers, "cf-region-code", 20, true) } : {}),
    ...(cleanHeader(headers, "cf-ipcountry", 10, true) ? { countryCode: cleanHeader(headers, "cf-ipcountry", 10, true) } : {}),
    ...(cleanHeader(headers, "cf-ipcontinent", 10, true) ? { continent: cleanHeader(headers, "cf-ipcontinent", 10, true) } : {}),
    ...(cleanHeader(headers, "cf-postal-code", 20) ? { postalCode: cleanHeader(headers, "cf-postal-code", 20) } : {}),
    ...(cleanHeader(headers, "cf-timezone", 80) ? { timezone: cleanHeader(headers, "cf-timezone", 80) } : {}),
    ...(cleanHeader(headers, "cf-ipcountry-name", 80) ? { country: cleanHeader(headers, "cf-ipcountry-name", 80) } : {}),
    ...(coordinate(headers, "cf-iplatitude", -90, 90) !== undefined ? { latitude: coordinate(headers, "cf-iplatitude", -90, 90) } : {}),
    ...(coordinate(headers, "cf-iplongitude", -180, 180) !== undefined ? { longitude: coordinate(headers, "cf-iplongitude", -180, 180) } : {})
  };
  const hasLocation = Object.keys(location).some((key) => !["ip", "source", "updatedAt"].includes(key));
  return hasLocation ? location : null;
}

/** Sanitize stored location records before exposing them to the admin UI. */
export function normalizeStoredIpLocation(value: unknown): IpLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const ip = normalizeIp(raw.ip);
  if (!ip) return null;
  const updatedAt = Number(raw.updatedAt);
  const location: IpLocation = {
    ip,
    source: "cloudflare",
    updatedAt: Number.isFinite(updatedAt) ? Math.max(0, Math.floor(updatedAt)) : 0
  };
  const textFields: Array<[keyof IpLocation, number]> = [
    ["city", 100], ["region", 100], ["regionCode", 20], ["country", 80],
    ["countryCode", 10], ["continent", 10], ["postalCode", 20], ["timezone", 80]
  ];
  for (const [key, limit] of textFields) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      const text = raw[key].trim().replace(/\s+/g, " ").slice(0, limit);
      if (text) (location as any)[key] = ["regionCode", "countryCode", "continent"].includes(key) ? text.toUpperCase() : text;
    }
  }
  for (const [key, min, max] of [["latitude", -90, 90], ["longitude", -180, 180]] as const) {
    const number = Number(raw[key]);
    if (Number.isFinite(number) && number >= min && number <= max) (location as any)[key] = Math.round(number * 100) / 100;
  }
  return location;
}

/** Merge the latest bounded location estimate for each IP. */
export function mergeIpLocations(values: readonly unknown[] | undefined): IpLocation[] {
  const byIp = new Map<string, IpLocation>();
  for (const value of values || []) {
    const location = normalizeStoredIpLocation(value);
    if (!location) continue;
    const prior = byIp.get(location.ip);
    if (!prior) {
      byIp.set(location.ip, location);
      continue;
    }
    const newer = location.updatedAt >= prior.updatedAt ? location : prior;
    const older = newer === location ? prior : location;
    byIp.set(location.ip, { ...older, ...newer, ip: location.ip, source: "cloudflare", updatedAt: Math.max(prior.updatedAt, location.updatedAt) });
  }
  return [...byIp.values()].slice(-25);
}
