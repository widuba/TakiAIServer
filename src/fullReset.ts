import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { storeCategory, storeEntries, storeResetAll, type StoreEntry } from "./store.js";

const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const TOKEN_FILES = ["push-tokens.json", "la-tokens.json"];

export type FullResetPreview = {
  accountRecords: number;
  indexedIdentities: number;
  appleAccounts: number;
  activeStripeSubscriptions: number;
  applePurchaseBindings: number;
  records: number;
  categories: Record<string, number>;
  notificationTokenFiles: number;
  fingerprint: string;
  activeStripeSubscriptionIds: string[];
};

function stripeIds(entries: StoreEntry[]): string[] {
  const ids = entries.flatMap((entry) => {
    if (!/^(?:stripe:subscription:|stripe_subscription_)/.test(entry.key)) return [];
    const value = entry.value && typeof entry.value === "object" ? entry.value as Record<string, unknown> : {};
    return value.active === true && typeof value.id === "string" && value.id ? [value.id] : [];
  });
  return [...new Set(ids)].sort();
}

export function summarizeFullReset(entries: StoreEntry[], notificationTokenFiles = 0): FullResetPreview {
  const categories: Record<string, number> = {};
  for (const entry of entries) {
    const category = storeCategory(entry.key);
    categories[category] = (categories[category] || 0) + 1;
  }
  const usersIndex = entries.find((entry) => entry.key === "users:index")?.value as { ids?: unknown } | undefined;
  const localUsersIndex = entries.find((entry) => entry.key === "users_index")?.value as { ids?: unknown } | undefined;
  const indexedIdentities = Array.isArray(usersIndex?.ids)
    ? usersIndex.ids.length
    : Array.isArray(localUsersIndex?.ids) ? localUsersIndex.ids.length : 0;
  const activeStripeSubscriptionIds = stripeIds(entries);
  const fingerprint = createHash("sha256")
    .update(entries.map((entry) => `${entry.key}:${entry.updatedAt || ""}:${JSON.stringify(entry.value)}`).join("\n"))
    .digest("hex");

  return {
    accountRecords: entries.filter((entry) => /^(?:user:|user_)/.test(entry.key) && !/^(?:userip:|userip_)/.test(entry.key)).length,
    indexedIdentities,
    appleAccounts: entries.filter((entry) => /^(?:user:apple:|user_apple_)/.test(entry.key)).length,
    activeStripeSubscriptions: activeStripeSubscriptionIds.length,
    applePurchaseBindings: entries.filter((entry) => /^(?:iapmap:|iapcredit:|iapmap_|iapcredit_)/.test(entry.key)).length,
    records: entries.length,
    categories,
    notificationTokenFiles,
    fingerprint,
    activeStripeSubscriptionIds
  };
}

export async function previewFullReset(): Promise<FullResetPreview> {
  const entries = await storeEntries();
  const notificationTokenFiles = TOKEN_FILES.filter((name) => fs.existsSync(path.join(SERVER_DIR, name))).length;
  return summarizeFullReset(entries, notificationTokenFiles);
}

export async function performFullReset(resetEpoch: number): Promise<{ deletedRecords: number; deletedTokenFiles: number }> {
  let deletedTokenFiles = 0;
  for (const name of TOKEN_FILES) {
    try {
      fs.unlinkSync(path.join(SERVER_DIR, name));
      deletedTokenFiles += 1;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const deletedRecords = await storeResetAll({
    "system:reset": { epoch: resetEpoch, completedAt: new Date(resetEpoch).toISOString() }
  });
  return { deletedRecords, deletedTokenFiles };
}
