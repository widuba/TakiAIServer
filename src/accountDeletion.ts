import { storeDelete, storeGet, storeSet } from "./store.js";
import { cancelAlerts } from "./alerts.js";
import { forgetToken } from "./push.js";
import { removeApplePromotionalSubscriber } from "./promotional.js";

const safeColon = (value: string) => value.replace(/[^a-zA-Z0-9_:.-]/g, "_");
const safePlain = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const safetySafe = (value: string) => value.replace(/[^a-zA-Z0-9_:-]/g, "_");

type UserRecord = { ips?: string[] };

async function removeFromIndex(key: string, identities: Set<string>): Promise<void> {
  const index = await storeGet<{ ids: string[] }>(key, { ids: [] });
  const ids = index.ids.filter((id) => !identities.has(id));
  if (ids.length) await storeSet(key, { ids });
  else await storeDelete(key);
}

export async function purgeAppleAccount(sub: string): Promise<{ identities: string[]; devices: string[] }> {
  const appleIdentity = `apple:${sub}`;
  const appleKey = `safety:applelink:${safetySafe(sub)}`;
  const linked = await storeGet<{ devices: string[] }>(appleKey, { devices: [] });
  const devices = [...new Set((linked.devices || []).filter(Boolean))];
  const identities = new Set<string>([appleIdentity, ...devices]);
  const pushTokens = new Map<string, string>();
  for (const device of devices) {
    pushTokens.set(device, await storeGet<string>(`push:token:${safePlain(device)}`, ""));
  }

  const userRecords = await Promise.all([...identities].map(async (identity) => ({
    identity,
    record: await storeGet<UserRecord | null>(`user:${safeColon(identity)}`, null)
  })));
  const ips = new Set(userRecords.flatMap(({ record }) => record?.ips || []));

  await removeFromIndex("users:index", identities);
  await removeFromIndex("safety:flagged", identities);
  await removeFromIndex("nudges:index", identities);

  for (const ip of ips) await removeFromIndex(`userip:${safeColon(ip)}`, identities);

  const feedback = await storeGet<any[]>("feedback", []);
  const keptFeedback = feedback.filter((entry) => !identities.has(String(entry?.deviceId || "")));
  if (keptFeedback.length) await storeSet("feedback", keptFeedback);
  else await storeDelete("feedback");

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
      storeDelete(`email:conn:${plain}`),
      storeDelete(`routines:${identity}`),
      storeDelete(`push:token:${plain}`),
      storeDelete(`nudges:manifest:${plain}`),
      storeDelete(`nudges:sent:${plain}`),
      storeDelete(`safety:acct:${safety}`),
      storeDelete(`safety:assoc:${safety}`),
      storeDelete(`safety:test-restriction:${safety}`),
      storeDelete(`iapidentity:${plain}`),
      storeDelete(`iapprimary:${plain}`),
      storeDelete(`stripe:identity-subs:${safety}`)
    ]);
  }

  for (const device of devices) {
    const token = pushTokens.get(device) || "";
    if (token) forgetToken(token);
    await cancelAlerts(device);
    const safeDevice = safetySafe(device);
    const deviceIndex = await storeGet<{ ids: string[] }>(`safety:dev:${safeDevice}`, { ids: [] });
    const ids = deviceIndex.ids.filter((identity) => !identities.has(identity));
    if (ids.length) await storeSet(`safety:dev:${safeDevice}`, { ids });
    else await storeDelete(`safety:dev:${safeDevice}`);
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
