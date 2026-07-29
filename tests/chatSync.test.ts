import assert from "node:assert/strict";
import test from "node:test";
import { chatSyncKey, mergeSyncedChats, sanitizeSyncedChat, syncChats } from "../src/chatSync.js";
import { storeDelete } from "../src/store.js";

function chat(id: string, updatedAt: string, messages: any[]) {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt,
    messages
  };
}

test("chat sync merges turns from multiple Taki devices without duplicates", () => {
  const first = chat("one", "2026-07-01T00:00:01.000Z", [
    { id: "m1", role: "user", text: "Hello", createdAt: "2026-07-01T00:00:01.000Z" }
  ]);
  const second = chat("one", "2026-07-01T00:00:03.000Z", [
    { id: "m1", role: "user", text: "Hello", createdAt: "2026-07-01T00:00:01.000Z" },
    { id: "m2", role: "assistant", text: "Hi!", createdAt: "2026-07-01T00:00:02.000Z" }
  ]);
  const merged = mergeSyncedChats([sanitizeSyncedChat(first)!], [second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].messages.map((message) => message.id), ["m1", "m2"]);
  assert.equal(merged[0].updatedAt, second.updatedAt);
});

test("chat sync strips attachment data and honors deletion tombstones", () => {
  const unsafe = {
    ...chat("private", "2026-07-01T00:00:03.000Z", [{
      id: "m1",
      role: "user",
      text: "Look at this",
      createdAt: "2026-07-01T00:00:01.000Z",
      imagePreview: "data:image/jpeg;base64,secret",
      attachments: [{ preview: "secret" }]
    }]),
    attachments: [{ preview: "secret" }]
  };
  const clean = sanitizeSyncedChat(unsafe)!;
  assert.equal("attachments" in clean, false);
  assert.equal("imagePreview" in clean.messages[0], false);
  assert.deepEqual(mergeSyncedChats([clean], [], { private: Date.parse("2026-07-02T00:00:00.000Z") }), []);
});

test("a restored chat newer than its tombstone becomes available again", async () => {
  const identity = `test-chat-restore-${Date.now()}`;
  const original = chat("restored", "2026-07-01T00:00:03.000Z", [{
    id: "m1", role: "user", text: "Bring me back", createdAt: "2026-07-01T00:00:01.000Z"
  }]);
  try {
    await syncChats(identity, [original], "restored");
    const deleted = await syncChats(identity, [], undefined, ["restored"]);
    assert.equal(deleted.chats.length, 0);
    const restored = await syncChats(identity, [{ ...original, updatedAt: new Date(Date.now() + 1_000).toISOString() }], "restored");
    assert.equal(restored.chats[0]?.id, "restored");
    assert.equal(restored.deleted.restored, undefined);
  } finally {
    await storeDelete(chatSyncKey(identity));
  }
});
