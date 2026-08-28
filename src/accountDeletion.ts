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

async function removeFromIndex(key: string, identities: Set<string>): Promise<void> {
  await storeUpdate<{ ids: string[] }, void>(key, { ids: [] }, (index) => {
    const ids = (Array.isArray(index.ids) ? index.ids : []).filter((id) => !identities.has(id));
    return { value: { ids }, result: undefined };
  });
}

export async function purgeAppleAccount(sub: string): Promise<{ identities: string[]; devices: string[] }> {
  const appleIdentity = `apple:${sub}`;
  const appleKey = `safety:applelink:${safetySafe(sub)}`;
  const linked = await storeGet<{ devices: string[] }>(appleKey, { devices: [] });
  const devices = [...new Set((linked.devices || []).filter((device): device is string => typeof device === "string" && isLinkedDeviceId(device)))];
  const identities = new Set<string>([appleIdentity, ...devices]);
  const userRecords = await Promise.all([...identities].map(async (identity) => ({
    identity,
    record: await storeGet<UserRecord | null>(`user:${safeColon(identity)}`, null)
  })));
  const ips = new Set(userRecords.flatMap(({ record }) => record?.ips || []));

  await removeFromIndex("users:index", identities);
  await removeFromIndex("safety:flagged", identities);
  await removeFromIndex("safety:all", identities);
  await removeFromIndex("nudges:index", identities);

  for (const ip of ips) await removeFromIndex(`userip:${safeColon(ip)}`, identities);

  await storeUpdate<any[], void>("feedback", [], (feedback) => ({
    value: (Array.isArray(feedback) ? feedback : []).filter((entry) => !identities.has(String(entry?.deviceId || ""))),
    result: undefined
  }));

  for (const identity of identities) {
    const plain = safePlain(identity);
    const safety = safetySafe(identity);
    const transactions = await storeGet<{ transactionIds: string[] }>(
      `iapidentity:${plain}`,
      { transactionIds: [] }
    );
    for (const transactionId of transactions.transactionIds) {
      const mapping = await storeGet<{ role?: "primary" | "secondary" }>(
        `iapmap:${transactionId}`,
        {}
      );
      await storeSet(`iapmap:${transactionId}`, { identity: "", role: mapping.role });
    }

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

  for (const device of devices) {
    // clearPushToken also removes the device from the durable token index. A
    // raw row delete left a stale index entry that could grow indefinitely and
    // forced later broadcasts to inspect an already-deleted token row.
    await clearPushToken(device);
    await clearLiveActivitiesForDevice(device);
    await cancelAlerts(device);
    const safeDevice = safetySafe(device);
    await storeUpdate<{ ids?: unknown }, void>(`safety:dev:${safeDevice}`, { ids: [] }, (stored) => {
      const currentIds = Array.isArray(stored?.ids) ? stored.ids.filter((id): id is string => typeof id === "string") : [];
      const ids = currentIds.filter((identity) => !identities.has(identity));
      return { value: { ids }, result: undefined };
    });
    await storeDelete(`safety:devapple:${safeDevice}`);

    // Retain only the starter-credit anti-abuse marker for this physical device.
    await storeSet(`credits:${safePlain(device)}`, {
      deviceId: device,
      tier: "free",
      grants: [],
      starterGiven: true,
      updatedAt: Date.now()
    });
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
  await removeFromIndex("users:index", identities);
  await removeFromIndex("safety:flagged", identities);
  await removeFromIndex("safety:all", identities);
  await removeFromIndex("nudges:index", identities);
  await storeUpdate<any[], void>("feedback", [], (feedback) => ({
    value: (Array.isArray(feedback) ? feedback : []).filter((entry) => String(entry?.deviceId || "") !== identity),
    result: undefined
  }));
  const plain = safePlain(identity);
  const safety = safetySafe(identity);
  const transactions = await storeGet<{ transactionIds: string[] }>(`iapidentity:${plain}`, { transactionIds: [] });
  for (const transactionId of transactions.transactionIds || []) {
    const mapping = await storeGet<{ role?: "primary" | "secondary" }>(`iapmap:${transactionId}`, {});
    await storeSet(`iapmap:${transactionId}`, { identity: "", role: mapping.role });
  }
  await Promise.all([
    storeDelete(`user:${safeColon(identity)}`),
    storeDelete(`credits:${plain}`),
    ...( /^\d{8}$/.test(identity) ? [storeDelete(`devicecredential:${plain}`)] : []),
    storeDelete(`routines:${identity}`),
    storeDelete(`chatsync:${safety}`),
    storeDelete(`nudges:manifest:${plain}`),
    storeDelete(`nudges:sent:${plain}`),
    storeDelete(`safety:acct:${safety}`),
    storeDelete(`safety:assoc:${safety}`),
    storeDelete(`iapidentity:${plain}`),
    storeDelete(`iapprimary:${plain}`),
    storeDelete(`stripe:identity-subs:${safety}`),
    storeSet(`webauth:${identity}`, false)
  ]);
  return { identities: [identity], devices: [] };
}
