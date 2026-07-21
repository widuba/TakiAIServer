import { devicesForApple } from "./safety.js";
import { storeGet } from "./store.js";

export async function isKnownIdentity(identity: string): Promise<boolean> {
  if (/^\d{8}$/.test(identity)) {
    return await storeGet<boolean>(`devnum:used:${identity}`, false);
  }
  if (identity.startsWith("apple:") && identity.length > "apple:".length) {
    return (await devicesForApple(identity.slice("apple:".length))).length > 0;
  }
  return false;
}
