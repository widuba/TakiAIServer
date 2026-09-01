const DEVICE_ID_RE = /^\d{8}$/;

/**
 * Return the customer-facing installation ID for an admin account row.
 *
 * Apple and Google identities are canonical backend keys, not the public
 * eight-digit Account ID. Keep those keys unchanged for account actions and
 * use a linked device ID only for dashboard display.
 */
export function adminAccountIdFor(identity: string, deviceIds: readonly string[]): string {
  const linkedDeviceId = deviceIds.find((id) => DEVICE_ID_RE.test(id));
  if (linkedDeviceId) return linkedDeviceId;
  return DEVICE_ID_RE.test(identity) ? identity : "";
}
