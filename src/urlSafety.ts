import dns from "node:dns/promises";
import net from "node:net";
import { fetchWithTimeout, readResponseBodyLimited } from "./util.js";

const MAX_URL_LENGTH = 2_048;
const MAX_REDIRECTS = 3;

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const nums = parts.map(Number);
  if (nums.some((part) => part < 0 || part > 255)) return null;
  return ((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3];
}

function inIpv4Range(value: string): boolean {
  const n = ipv4Number(value);
  if (n == null) return true;
  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff], // 0/8
    [0x0a000000, 0x0affffff], // 10/8
    [0x64400000, 0x647fffff], // 100.64/10 (CGNAT)
    [0x7f000000, 0x7fffffff], // loopback
    [0xa9fe0000, 0xa9feffff], // link-local
    [0xac100000, 0xac1fffff], // 172.16/12
    [0xc0000000, 0xc00000ff], // 192.0.0/24
    [0xc0000200, 0xc00002ff], // TEST-NET-1
    [0xc0a80000, 0xc0a8ffff], // 192.168/16
    [0xc6120000, 0xc613ffff], // TEST-NET-2
    [0xc6336400, 0xc63364ff], // TEST-NET-3
    [0xcb007100, 0xcb0071ff], // documentation
    [0xf0000000, 0xffffffff] // multicast/reserved
  ];
  return ranges.some(([start, end]) => n >= start && n <= end);
}

function ipv6Number(value: string): bigint | null {
  let normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = normalized.indexOf("%");
  if (zone >= 0) normalized = normalized.slice(0, zone);
  if (!normalized || normalized.includes(":::")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseParts = (part: string): number[] | null => {
    if (!part) return [];
    const parts = part.split(":");
    const out: number[] = [];
    for (const item of parts) {
      if (item.includes(".")) {
        const n = ipv4Number(item);
        if (n == null) return null;
        out.push((n >>> 16) & 0xffff, n & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(item)) return null;
        out.push(parseInt(item, 16));
      }
    }
    return out;
  };
  const left = parseParts(halves[0]);
  const right = parseParts(halves[1] || "");
  if (!left || !right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  if (groups.length !== 8) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function inIpv6PrivateRange(value: string): boolean {
  const number = ipv6Number(value);
  if (number == null) return true;
  const hasPrefix = (prefix: bigint, bits: number) =>
    (number >> BigInt(128 - bits)) === prefix;
  // Unspecified/loopback, unique-local, link-local, multicast, documentation,
  // benchmarking, and discard-only ranges are never valid public fetch hosts.
  if (number === 0n || number === 1n) return true;
  if (hasPrefix(0x7en, 7) || hasPrefix(0x3fan, 10) || hasPrefix(0xffn, 8)) return true; // fc00::/7, fe80::/10, ff00::/8
  // RFC 3849 documentation, RFC 5180 benchmarking, and RFC 6666 discard
  // ranges.  Do not reject all of 2001::/16: most ordinary public IPv6 hosts
  // live there.
  if (hasPrefix(0x20010db8n, 32) || hasPrefix(0x20010002n, 48) || hasPrefix(0x100n << 48n, 64)) return true;
  // IPv4-mapped IPv6 addresses must receive the IPv4 policy as well. Public
  // mapped addresses are allowed; private, loopback, link-local, test, and
  // multicast mapped addresses are rejected by the IPv4 policy above.
  if ((number >> 32n) === 0xffffn) {
    const v4 = Number(number & 0xffffffffn);
    const octets = [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".");
    return inIpv4Range(octets);
  }
  return false;
}

function isPrivateAddress(address: string): boolean {
  const kind = net.isIP(address);
  return kind === 4 ? inIpv4Range(address) : kind === 6 ? inIpv6PrivateRange(address) : true;
}

/** Return a normalized URL only when it resolves exclusively to public hosts. */
export async function validatePublicHttpUrl(raw: string): Promise<URL | null> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname.length > 253) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname === "metadata.google.internal" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return null;
  if (net.isIP(hostname)) return isPrivateAddress(hostname) ? null : url;
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); } catch { return null; }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) return null;
  return url;
}

/** Fetch an external URL while validating every redirect target. */
export async function fetchPublicUrl(
  raw: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
  label = "External request"
): Promise<Response | null> {
  let current = await validatePublicHttpUrl(raw);
  if (!current) return null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchWithTimeout(current, { ...init, redirect: "manual" }, timeoutMs, label);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    // A redirect response body is not useful, but leaving it unread can keep a
    // pooled socket occupied while we validate and fetch the next hop.
    try { await response.body?.cancel(); } catch { /* best effort */ }
    if (!location || redirects === MAX_REDIRECTS) return null;
    try {
      current = await validatePublicHttpUrl(new URL(location, current).toString());
    } catch {
      return null;
    }
    if (!current) return null;
  }
  return null;
}

export async function readPublicResponseText(response: Response, maxBytes = 1_000_000): Promise<string> {
  return readResponseBodyLimited(response, maxBytes);
}
