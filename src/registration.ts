import { createHash, randomUUID } from "node:crypto";

import { identitiesForIp } from "./users.js";
import { storeUpdate } from "./store.js";

/** Maximum number of Taki installations that may be created from one IP. */
export const MAX_ACCOUNTS_PER_IP = 10;

// A reservation prevents a burst of concurrent requests from all observing
// the same pre-registration count and minting more than the configured limit.
// Reservations are short-lived so a crashed request cannot permanently consume
// a slot. Existing accounts are counted from the userip index on every attempt.
const RESERVATION_TTL_MS = 15 * 60_000;
const STATE_PREFIX = "signup:ip:";

type SignupReservation = { token: string; expiresAt: number };
type SignupState = { pending: SignupReservation[] };

function normalizedIp(ip: string): string {
  const value = String(ip || "unknown").trim().toLowerCase();
  // Express can expose IPv4 clients as IPv4-mapped IPv6 addresses depending on
  // the proxy/listener. Normalize that spelling so one client cannot bypass
  // the cap by alternating between the two representations.
  return value.replace(/^::ffff:/, "").slice(0, 120) || "unknown";
}

function ipVariants(ip: string): string[] {
  const canonical = normalizedIp(ip);
  const variants = new Set([canonical]);
  // Older rows may have been written before IPv4-mapped addresses were
  // canonicalized. Count those records too while the index migrates naturally.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(canonical)) variants.add(`::ffff:${canonical}`);
  return [...variants];
}

function stateKey(ip: string): string {
  const digest = createHash("sha256").update(normalizedIp(ip)).digest("hex").slice(0, 32);
  return `${STATE_PREFIX}${digest}`;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && (/^\d{8}$/.test(value) || /^(?:apple|google):[^:\s]{1,256}$/.test(value));
}

function normalizeState(value: unknown): SignupState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<SignupState> : {};
  const now = Date.now();
  const pending = Array.isArray(raw.pending)
    ? raw.pending.flatMap((item: any): SignupReservation[] => {
      const token = typeof item?.token === "string" ? item.token.trim() : "";
      const expiresAt = Number(item?.expiresAt);
      return token && /^[a-f0-9-]{20,80}$/i.test(token) && Number.isFinite(expiresAt) && expiresAt > now
        ? [{ token, expiresAt }]
        : [];
    }).slice(-MAX_ACCOUNTS_PER_IP)
    : [];
  return { pending };
}

/**
 * Atomically reserve one signup slot for an IP. Returns an opaque reservation
 * token, or null when ten existing/reserved accounts already occupy the cap.
 */
export async function reserveSignupSlot(ip: string): Promise<string | null> {
  const observed = new Set(
    (await Promise.all(ipVariants(ip).map((variant) => identitiesForIp(variant))))
      .flat()
      .filter(validIdentity)
  );
  const token = randomUUID();
  const key = stateKey(ip);
  return storeUpdate<SignupState, string | null>(key, { pending: [] }, (stored) => {
    const state = normalizeState(stored);
    if (observed.size + state.pending.length >= MAX_ACCOUNTS_PER_IP) {
      return { value: state, result: null };
    }
    state.pending.push({ token, expiresAt: Date.now() + RESERVATION_TTL_MS });
    return { value: state, result: token };
  });
}

/** Release a reservation when registration fails before an account is issued. */
export async function releaseSignupSlot(ip: string, token: string): Promise<void> {
  if (!token) return;
  await storeUpdate<SignupState, void>(stateKey(ip), { pending: [] }, (stored) => {
    const state = normalizeState(stored);
    return { value: { pending: state.pending.filter((item) => item.token !== token) }, result: undefined };
  });
}

/** Commit a successful registration by removing its pending reservation. */
export async function commitSignupSlot(ip: string, token: string): Promise<boolean> {
  if (!token) return false;
  return storeUpdate<SignupState, boolean>(stateKey(ip), { pending: [] }, (stored) => {
    const state = normalizeState(stored);
    const found = state.pending.some((item) => item.token === token);
    return {
      value: { pending: state.pending.filter((item) => item.token !== token) },
      result: found
    };
  });
}

/** Exported for deterministic cleanup in tests and full-reset tooling. */
export function signupStateKeyForIp(ip: string): string {
  return stateKey(ip);
}
