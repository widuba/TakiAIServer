import { devicesForApple } from "./safety.js";
import { storeGet, storeSet } from "./store.js";

// Web sign-ins (takiai.app/app) have no physical device to link, so a verified
// Apple/Google web account is recorded under this marker. It is set ONLY after
// the server has cryptographically verified the provider's ID token.
function webAuthKey(identity: string): string {
  return `webauth:${identity}`;
}

export function isWebAccountIdentity(identity: string): boolean {
  return /^(apple|google):.+/.test(identity);
}

export async function markWebAuthenticated(identity: string): Promise<void> {
  if (isWebAccountIdentity(identity)) await storeSet(webAuthKey(identity), true);
}

export async function isKnownIdentity(identity: string): Promise<boolean> {
  if (/^\d{8}$/.test(identity)) {
    return await storeGet<boolean>(`devnum:used:${identity}`, false);
  }
  if (identity.startsWith("apple:") && identity.length > "apple:".length) {
    // Known through an iOS device link OR a verified web sign-in.
    if ((await devicesForApple(identity.slice("apple:".length))).length > 0) return true;
    return await storeGet<boolean>(webAuthKey(identity), false);
  }
  if (identity.startsWith("google:") && identity.length > "google:".length) {
    return await storeGet<boolean>(webAuthKey(identity), false);
  }
  return false;
}
