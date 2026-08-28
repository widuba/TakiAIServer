export const RESET_EPOCH_HEADER = "x-taki-reset-epoch";

const EXTERNAL_PATHS = new Set([
  // These bootstrap routes must remain reachable by a fresh install (or an
  // old installation that has just learned a new reset epoch). Requiring the
  // previous generation here creates a deadlock: the client cannot register or
  // discover that its old device id was deleted until it already has a valid
  // generation header.
  "/api/register-device",
  "/api/device/info",
  "/api/web/auth/config",
  "/api/web/auth/google",
  "/api/web/auth/apple",
  "/api/web/auth/logout",
  "/api/credits/topup-config",
  "/api/credits/handoff",
  "/api/credits/account-check",
  "/api/credits/checkout",
  "/api/plans/checkout",
  "/api/stripe/webhook",
  "/api/iap/notifications",
  "/api/engagement/click"
]);

export function bypassResetGeneration(path: string): boolean {
  return path.startsWith("/api/admin/") || EXTERNAL_PATHS.has(path);
}

export function hasCurrentResetGeneration(requiredEpoch: number, supplied: unknown): boolean {
  if (!(requiredEpoch > 0)) return true;
  if (Array.isArray(supplied)) supplied = supplied[0];
  if (typeof supplied !== "string" || !/^\d+$/.test(supplied.trim())) return false;
  return Number(supplied) === requiredEpoch;
}
