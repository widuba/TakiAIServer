/**
 * Short-lived replay for one exact assistant turn.
 *
 * The app intentionally retries transient 502/503 responses with the same
 * request id. If the first HTTP connection disappears after the model finished,
 * starting the whole turn again wastes provider cost and can produce a different
 * answer. This cache shares in-flight work and replays a completed payload.
 * Failed work is removed immediately so a genuine retry can still recover.
 */
export class TurnReplayCache<T> {
  private readonly entries = new Map<string, {
    expiresAt: number;
    promise: Promise<T>;
  }>();

  constructor(
    private readonly ttlMs = 2 * 60_000,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now
  ) {}

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const at = this.now();
    this.prune(at);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > at) return existing.promise;

    const promise = Promise.resolve().then(operation);
    const entry = { expiresAt: at + this.ttlMs, promise };
    this.entries.set(key, entry);
    promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return promise;
  }

  private prune(at: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}
