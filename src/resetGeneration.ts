export const RESET_EPOCH_HEADER = "x-taki-reset-epoch";

const EXTERNAL_PATHS = new Set([
  "/api/credits/topup-config",
  "/api/credits/handoff",
  "/api/credits/account-check",
  "/api/credits/checkout",
  "/api/plans/checkout",
  "/api/stripe/webhook",
  "/api/email/callback",
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
