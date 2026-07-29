import assert from "node:assert/strict";
import test from "node:test";
import { TurnReplayCache } from "../src/turnReplay.js";

test("simultaneous copies of one turn share the exact in-flight result", async () => {
  const cache = new TurnReplayCache<{ answer: string }>();
  let calls = 0;
  let release!: (value: { answer: string }) => void;
  const pending = new Promise<{ answer: string }>((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    return pending;
  };

  const first = cache.run("device-a:turn-1", operation);
  const retry = cache.run("device-a:turn-1", operation);
  assert.equal(calls, 0);
  release({ answer: "same answer" });
  assert.deepEqual(await first, { answer: "same answer" });
  assert.deepEqual(await retry, { answer: "same answer" });
  assert.equal(calls, 1);
});

test("a completed turn replays until expiry without rerunning provider work", async () => {
  let now = 1_000;
  const cache = new TurnReplayCache<string>(500, 10, () => now);
  let calls = 0;
  const operation = async () => `answer-${++calls}`;

  assert.equal(await cache.run("turn", operation), "answer-1");
  assert.equal(await cache.run("turn", operation), "answer-1");
  now += 501;
  assert.equal(await cache.run("turn", operation), "answer-2");
});

test("failed turns are removed so the same request id can genuinely recover", async () => {
  const cache = new TurnReplayCache<string>();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "recovered";
  };

  await assert.rejects(cache.run("turn", operation), /temporary failure/);
  assert.equal(await cache.run("turn", operation), "recovered");
  assert.equal(calls, 2);
});

test("device identity is part of the replay key and prevents cross-account reuse", async () => {
  const cache = new TurnReplayCache<string>();
  let calls = 0;
  const operation = async () => `answer-${++calls}`;
  assert.equal(await cache.run("device-a:shared-id", operation), "answer-1");
  assert.equal(await cache.run("device-b:shared-id", operation), "answer-2");
});
