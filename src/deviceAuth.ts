// Public registration, web-auth, provider callbacks, and browser checkout
// routes have their own trust model. They must not require the per-install
// credential that protects physical-device API calls: the web purchase page
// intentionally starts with only the eight-digit Account ID.
export const DEVICE_AUTH_EXEMPT_PATHS = new Set([
  "/api/register-device",
  // Launch-time validation must be able to reach the route after a full reset
  // has removed the old installation credential. The route performs its own
  // credential check and returns the same generic 404 for an unknown or
  // invalid installation, so this does not become an account-existence oracle.
  "/api/device/info",
  "/api/home-options",
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

// These routes exist to report access, acknowledge a server-issued notice,
// manage account data, stop an existing operation, or restore verified
// purchases. They must remain reachable while a user is restricted; all other
// authenticated API operations are checked against server-owned safety state.
const SAFETY_ACCESS_EXEMPT_PATHS = new Set([
  "/api/credits",
  "/api/credits/preflight",
  "/api/account/acknowledge-notice",
  "/api/assistant/cancel",
  "/api/chats",
  "/api/chats/sync",
  "/api/feedback",
  "/api/account/delete",
  "/api/account/delete-google",
  "/api/account/apple/disconnect",
  "/api/web/auth/logout",
  "/api/iap/credit-packs",
  "/api/iap/verify",
  "/api/register-push",
  "/api/unregister-push",
  "/api/unregister-la"
]);

export function bypassDeviceAuth(path: string): boolean {
  return DEVICE_AUTH_EXEMPT_PATHS.has(path) || path.startsWith("/api/admin/");
}

export function bypassSafetyAccess(path: string, method = "GET"): boolean {
  if (SAFETY_ACCESS_EXEMPT_PATHS.has(path) || path.startsWith("/api/admin/")) return true;
  // Suspended users can still inspect and cancel their own server-side alerts.
  return (path === "/api/alerts" && method.toUpperCase() === "GET")
    || path === "/api/alerts/cancel";
}
