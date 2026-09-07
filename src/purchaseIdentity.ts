/**
 * Choose the name shown in a browser purchase confirmation.
 *
 * The name entered in Taki Personalization is the user's explicit choice for
 * how Taki should address them. Apple and device-derived names are fallbacks
 * for older accounts that have not chosen one yet.
 */
export function resolvePurchaseDisplayName(args: {
  takiName?: string;
  appleName?: string;
  deviceOwnerName?: string;
  accountId: string;
}): string {
  const clean = (value: unknown, max: number) => String(value || "").trim().slice(0, max);
  const takiName = clean(args.takiName, 60);
  const appleName = clean(args.appleName, 60);
  const deviceOwnerName = clean(args.deviceOwnerName, 60);
  const accountId = clean(args.accountId, 8);
  return takiName || appleName || deviceOwnerName || `Account ${accountId}`;
}
