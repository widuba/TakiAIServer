import { storeGet, storeUpdate } from "./store.js";

export type SyncedChatSource = { title: string; url: string };
export type SyncedChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  sources?: SyncedChatSource[];
};
export type SyncedChat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SyncedChatMessage[];
  titleSource?: "default" | "auto" | "manual";
};
export type ChatSyncRecord = {
  chats: SyncedChat[];
  activeChatId?: string;
  deleted: Record<string, number>;
  updatedAt: number;
};

const MAX_CHATS = 50;
const MAX_MESSAGES_PER_CHAT = 300;
const MAX_TOTAL_TEXT = 1_500_000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const EMPTY_CHAT_SYNC: ChatSyncRecord = { chats: [], deleted: {}, updatedAt: 0 };

function safeIdentity(identity: string): string {
  return identity.replace(/[^a-zA-Z0-9_:-]/g, "_");
}

export function chatSyncKey(identity: string): string {
  return `chatsync:${safeIdentity(identity)}`;
}

function iso(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallback;
  // Client clocks are untrusted. A far-future updatedAt could permanently win
  // every merge and keep a stale conversation ahead of real phone/CarPlay
  // turns. Preserve small clock skew, but clamp anything beyond five minutes.
  return new Date(Math.min(parsed, Date.now() + MAX_FUTURE_SKEW_MS)).toISOString();
}

function cleanMessage(value: unknown): SyncedChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 200) : "";
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 12_000) : "";
  if (!role || !id || !text) return null;
  const createdAt = iso(raw.createdAt, new Date().toISOString());
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).flatMap((item): SyncedChatSource[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const title = typeof source.title === "string" ? source.title.trim().slice(0, 300) : "";
    const url = typeof source.url === "string" ? source.url.trim().slice(0, 3_000) : "";
    return title && /^https?:\/\//i.test(url) ? [{ title, url }] : [];
  }).slice(0, 8);
  return { id, role, text, createdAt, ...(sources.length ? { sources } : {}) };
}

export function sanitizeSyncedChat(value: unknown): SyncedChat | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 200) : "";
  if (!id) return null;
  const now = new Date().toISOString();
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .flatMap((message): SyncedChatMessage[] => {
      const clean = cleanMessage(message);
      return clean ? [clean] : [];
    })
    .slice(-MAX_MESSAGES_PER_CHAT);
  const titleSource = raw.titleSource === "auto" || raw.titleSource === "manual"
    ? raw.titleSource
    : "default";
  return {
    id,
    title: typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, 100)
      : "New Chat",
    createdAt: iso(raw.createdAt, now),
    updatedAt: iso(raw.updatedAt, messages.at(-1)?.createdAt || now),
    messages,
    titleSource
  };
}

function mergeOne(local: SyncedChat, remote: SyncedChat): SyncedChat {
  const messages = new Map(local.messages.map((message) => [message.id, message]));
  for (const message of remote.messages) messages.set(message.id, message);
  const remoteIsNewer = remote.updatedAt >= local.updatedAt;
  return {
    ...(remoteIsNewer ? remote : local),
    messages: [...messages.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_MESSAGES_PER_CHAT)
  };
}

export function mergeSyncedChats(
  existing: SyncedChat[],
  incoming: unknown[],
  deleted: Record<string, number> = {}
): SyncedChat[] {
  const merged = new Map(existing.map((chat) => [chat.id, chat]));
  for (const value of incoming) {
    const chat = sanitizeSyncedChat(value);
    if (!chat) continue;
    const tombstone = Number(deleted[chat.id] || 0);
    if (tombstone && tombstone >= Date.parse(chat.updatedAt)) continue;
    const prior = merged.get(chat.id);
    merged.set(chat.id, prior ? mergeOne(prior, chat) : chat);
  }
  for (const id of Object.keys(deleted)) merged.delete(id);

  let totalText = 0;
  const bounded: SyncedChat[] = [];
  for (const chat of [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (bounded.length >= MAX_CHATS) break;
    const kept: SyncedChatMessage[] = [];
    for (const message of [...chat.messages].reverse()) {
      const remaining = MAX_TOTAL_TEXT - totalText;
      if (remaining <= 0) break;
      // Keep the newest portion of an oversized turn instead of dropping the
      // entire chat as soon as one unusually long client message is seen.
      const text = message.text.length > remaining ? message.text.slice(-remaining) : message.text;
      if (!text) break;
      totalText += text.length;
      kept.push(text === message.text ? message : { ...message, text });
    }
    bounded.push({ ...chat, messages: kept.reverse() });
  }
  return bounded;
}

function normalizeChatSyncRecord(current: ChatSyncRecord | null): ChatSyncRecord {
  if (!current) return { ...EMPTY_CHAT_SYNC };
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  const deleted = Object.fromEntries(
    Object.entries(current.deleted || {}).filter(([, timestamp]) => Number(timestamp) > cutoff)
  );
  return {
    chats: mergeSyncedChats([], Array.isArray(current.chats) ? current.chats : [], deleted),
    activeChatId: typeof current.activeChatId === "string" ? current.activeChatId : undefined,
    deleted,
    updatedAt: Number(current.updatedAt || 0)
  };
}

export async function readSyncedChats(identity: string): Promise<ChatSyncRecord> {
  const current = await storeGet<ChatSyncRecord | null>(chatSyncKey(identity), null);
  return normalizeChatSyncRecord(current);
}

export async function syncChats(
  identity: string,
  incoming: unknown[],
  activeChatId?: string,
  deletedChatIds: string[] = []
): Promise<ChatSyncRecord> {
  const key = chatSyncKey(identity);
  return await storeUpdate<ChatSyncRecord | null, ChatSyncRecord>(key, null, (stored) => {
    // Keep the entire read/merge/write cycle under the store's per-key lock.
    // iPhone and CarPlay can post the same chat at nearly the same time; an
    // unlocked read-modify-write lets the later write erase the earlier turn.
    const current = normalizeChatSyncRecord(stored);
    const now = Date.now();
    const deleted = { ...current.deleted };
    for (const id of deletedChatIds.map((value) => String(value).trim().slice(0, 200)).filter(Boolean)) {
      deleted[id] = now;
    }
    // A restored chat is given a fresh updatedAt by the client. Let that newer
    // revision clear its older deletion tombstone while still rejecting stale
    // copies from another device that has not observed the deletion yet.
    for (const value of incoming) {
      const chat = sanitizeSyncedChat(value);
      if (chat && deleted[chat.id] && Date.parse(chat.updatedAt) > deleted[chat.id]) {
        delete deleted[chat.id];
      }
    }
    const chats = mergeSyncedChats(current.chats, incoming, deleted);
    const selected = activeChatId && chats.some((chat) => chat.id === activeChatId)
      ? activeChatId
      : current.activeChatId && chats.some((chat) => chat.id === current.activeChatId)
        ? current.activeChatId
        : chats[0]?.id;
    const next: ChatSyncRecord = {
      chats,
      ...(selected ? { activeChatId: selected } : {}),
      deleted,
      updatedAt: now
    };
    return { value: next, result: next };
  });
}
