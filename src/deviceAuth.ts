// Public registration, web-auth, provider callbacks, and browser checkout
// routes have their own trust model. They must not require the per-install
// credential that protects physical-device API calls: the web purchase page
// intentionally starts with only the eight-digit Account ID.
export const DEVICE_AUTH_EXEMPT_PATHS = new Set([
  "/api/register-device",
  "/api/device/info",
  "/api/web/auth/config",
  "/api/web/auth/google",
  "/api/web/auth/apple",
  "/api/credits/purchase-link",
  "/api/credits/handoff",
  "/api/credits/account-check",
  "/api/credits/checkout",
  "/api/plans/checkout",
  "/api/stripe/webhook",
  "/api/iap/notifications"
]);

export function bypassDeviceAuth(path: string): boolean {
  return DEVICE_AUTH_EXEMPT_PATHS.has(path) || path.startsWith("/api/admin/");
}
