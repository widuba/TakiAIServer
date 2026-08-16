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
  "/api/credits/handoff",
  // The first browser checkout step intentionally accepts only the public
  // eight-digit Account ID. It returns a short-lived signed checkout token;
  // the actual Stripe checkout routes require that token and do not accept a
  // raw physical ID from an unauthenticated browser.
  "/api/credits/account-check",
  "/api/stripe/webhook",
  "/api/iap/notifications"
]);

export function bypassDeviceAuth(path: string): boolean {
  return DEVICE_AUTH_EXEMPT_PATHS.has(path) || path.startsWith("/api/admin/");
}
