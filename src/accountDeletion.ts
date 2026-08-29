import { storeDelete, storeGet, storeSet, storeUpdate } from "./store.js";
import { cancelAlerts } from "./alerts.js";
import { clearLiveActivitiesForDevice } from "./push.js";
import { clearPushToken } from "./nudges.js";
import { removeApplePromotionalSubscriber } from "./promotional.js";

const safeColon = (value: string) => value.replace(/[^a-zA-Z0-9_:.-]/g, "_");
const safePlain = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const safetySafe = (value: string) => value.replace(/[^a-zA-Z0-9_:-]/g, "_");
const isLinkedDeviceId = (value: string): boolean =>
  /^\d{8}$/.test(value) ||
  (process.env.NODE_ENV !== "production" && /^testdevice[a-z0-9]{8,80}$/i.test(value));

type UserRecord = { ips?: string[] };
type AssociationRecord = { ips?: string[] };

/**
 * A privacy deletion must invalidate an installation without banning the
 * person behind it.  The marker contains no account data and is deliberately
 * not consulted by signup admission; it only lets an already-open client
 * recognize that its credential was erased and return to onboarding.
 */
export const privacyDeletedDeviceKey = (deviceId: string): string =>
  `privacy:deleted:${safePlain(deviceId)}`;

export async function isPrivacyDeletedDevice(deviceId: string): Promise<boolean> {
  if (!/^\d{8}$/.test(deviceId)) return false;
  const marker = await storeGet<unknown>(privacyDeletedDeviceKey(deviceId), null);
  if (marker === true) return true;
  return !!marker && typeof marker === "object";
}

async function removeFromIndex(key: string, identities: Set<string>): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(key, { ids: [] }, (index) => {
    const ids = (Array.isArray(index.ids) ? index.ids : []).filter((id) => !identities.has(id));
    return { value: { ids }, result: undefined };
  });
}

function validIp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120 && value !== "unknown";
}

async function accountIps(identities: Set<string>): Promise<Set<string>> {
  const rows = await Promise.all([...identities].map(async (identity) => {
    const [user, assoc] = await Promise.all([
      storeGet<UserRecord | null>(`user:${safeColon(identity)}`, null),
      storeGet<AssociationRecord | null>(`safety:assoc:${safetySafe(identity)}`, null)
    ]);
    return [
      ...(Array.isArray(user?.ips) ? user.ips : []),
      ...(Array.isArray(assoc?.ips) ? assoc.ips : [])
    ];
  }));
  return new Set(rows.flat().filter(validIp));
}

async function clearSharedAccountIndexes(identities: Set<string>, ips: Set<string>): Promise<void> {
  await removeFromIndex("users:index", identities);
  await removeFromIndex("safety:flagged", identities);
  await removeFromIndex("safety:all", identities);
  await removeFromIndex("nudges:index", identities);

  for (const ip of ips) await removeFromIndex(`userip:${safeColon(ip)}`, identities);

  await storeUpdate<any[], void>("feedback", [], (feedback) => ({
    value: (Array.isArray(feedback) ? feedback : []).filter((entry) => !identities.has(String(entry?.deviceId || ""))),
    result: undefined
  }));
  // A privacy deletion must not leave an old identity/device permanently
  // banned. IPs remain untouched because they are historical context only and
  // are never consulted by admission or enforcement.
  await storeUpdate<{ identities?: unknown; devices?: unknown; ips?: unknown }, void>(
    "safety:banlist",
    { identities: [], devices: [], ips: [] },
    (stored) => ({
      value: {
        identities: (Array.isArray(stored?.identities) ? stored.identities : [])
          .filter((value): value is string => typeof value === "string" && !identities.has(value)),
        devices: (Array.isArray(stored?.devices) ? stored.devices : [])
          .filter((value): value is string => typeof value === "string" && !identities.has(value)),
        ips: (Array.isArray(stored?.ips) ? stored.ips : [])
          .filter((value): value is string => typeof value === "string")
      },
      result: undefined
    })
  );
}

async function clearTransactionMappings(identity: string): Promise<void> {
  const plain = safePlain(identity);
  const transactions = await storeGet<{ transactionIds?: string[] }>(
    `iapidentity:${plain}`,
    { transactionIds: [] }
  );
  for (const transactionId of Array.isArray(transactions.transactionIds) ? transactions.transactionIds : []) {
    const mapping = await storeGet<{ role?: "primary" | "secondary" }>(
      `iapmap:${transactionId}`,
      {}
    );
    // Keep the transaction row for idempotent webhook handling, but sever the
    // identity so a late provider callback cannot recreate deleted account data.
    await storeSet(`iapmap:${transactionId}`, { identity: "", role: mapping.role });
  }
}

async function clearIdentityRecords(identity: string): Promise<void> {
  const plain = safePlain(identity);
  const safety = safetySafe(identity);
  await clearTransactionMappings(identity);
  await Promise.all([
    storeDelete(`user:${safeColon(identity)}`),
    storeDelete(`credits:${plain}`),
    ...( /^\d{8}$/.test(identity) ? [storeDelete(`devicecredential:${plain}`)] : []),
    storeDelete(`email:conn:${plain}`),
    storeDelete(`email:conn:${identity}`),
    storeDelete(`routines:${identity}`),
    storeDelete(`chatsync:${safety}`),
    storeDelete(`push:token:${plain}`),
    storeDelete(`nudges:manifest:${plain}`),
    storeDelete(`nudges:sent:${plain}`),
    storeDelete(`safety:acct:${safety}`),
    storeDelete(`safety:assoc:${safety}`),
    storeDelete(`safety:test-restriction:${safety}`),
    storeDelete(`iapidentity:${plain}`),
    storeDelete(`iapprimary:${plain}`),
    storeDelete(`stripe:identity-subs:${safety}`),
    storeSet(`webauth:${identity}`, false)
  ]);
}

async function clearPhysicalSideEffects(device: string, identities: Set<string>): Promise<void> {
  // clearPushToken also removes the device from the durable token index. A raw
  // row delete would leave a stale entry that later broadcasts still inspect.
  await clearPushToken(device);
  await clearLiveActivitiesForDevice(device);
  await cancelAlerts(device);
  const safeDevice = safetySafe(device);
  await storeUpdate<{ ids?: unknown }, void>(`safety:dev:${safeDevice}`, { ids: [] }, (stored) => {
    const currentIds = Array.isArray(stored?.ids)
      ? stored.ids.filter((id): id is string => typeof id === "string")
      : [];
    return { value: { ids: currentIds.filter((identity) => !identities.has(identity)) }, result: undefined };
  });
  await storeDelete(`safety:devapple:${safeDevice}`);

  // Keep only the starter-credit marker for abuse protection.  It does not
  // block a new signup and the old credential has already been erased.
  await storeSet(`credits:${safePlain(device)}`, {
    deviceId: device,
    tier: "free",
    grants: [],
    starterGiven: true,
    updatedAt: Date.now()
  });
  await storeSet(privacyDeletedDeviceKey(device), { deletedAt: Date.now() });
}

export async function purgeAppleAccount(sub: string): Promise<{ identities: string[]; devices: string[] }> {
  const appleIdentity = `apple:${sub}`;
  const appleKey = `safety:applelink:${safetySafe(sub)}`;
  const linked = await storeGet<{ devices: string[] }>(appleKey, { devices: [] });
  const devices = [...new Set((linked.devices || []).filter((device): device is string => typeof device === "string" && isLinkedDeviceId(device)))];
  const identities = new Set<string>([appleIdentity, ...devices]);
  const ips = await accountIps(identities);

  await clearSharedAccountIndexes(identities, ips);

  for (const identity of identities) {
    await clearIdentityRecords(identity);
  }

  for (const device of devices) {
    await clearPhysicalSideEffects(device, identities);
  }

  await storeDelete(appleKey);
  await removeApplePromotionalSubscriber(sub);
  return { identities: [...identities], devices };
}

/**
 * Delete a verified web-only identity (currently Google, and future web
 * providers).  Apple-linked installations use purgeAppleAccount above because
 * they also need to discover and clean every physical device.
 */
export async function purgeStandaloneAccount(identity: string): Promise<{ identities: string[]; devices: string[] }> {
  if (!identity || !/^(google|apple):[^:]+$/.test(identity)) return { identities: [], devices: [] };
  const identities = new Set([identity]);
  await clearSharedAccountIndexes(identities, await accountIps(identities));
  await clearIdentityRecords(identity);
  return { identities: [identity], devices: [] };
}

/** Delete a device-only account without banning its hardware or network. */
export async function purgeDeviceAccount(deviceId: string): Promise<{ identities: string[]; devices: string[] }> {
  if (!isLinkedDeviceId(deviceId)) return { identities: [], devices: [] };
  const identities = new Set([deviceId]);
  await clearSharedAccountIndexes(identities, await accountIps(identities));
  await clearIdentityRecords(deviceId);
  await clearPhysicalSideEffects(deviceId, identities);
  return { identities: [deviceId], devices: [deviceId] };
}
