import 'server-only';

/** Short-lived presentation observations. Never a permission, account receipt,
 * schema cache or execution authorization. Every consumer supplies current ACL
 * and exact source/credential revisions before looking up an observation. */
export class ExtensionConnectionObservations<T> {
  private readonly entries = new Map<string, { value: T; until: number; bytes: number }>();
  private readonly pending = new Map<string, Promise<T>>();
  private bytes = 0;
  constructor(private readonly now = Date.now, private readonly maxEntries = 128,
    private readonly maxBytes = 1024 * 1024, private readonly ttl = 60_000, private readonly timeoutMs = 6_000) {}

  get(key: string): T | undefined {
    const item = this.entries.get(key);
    if (!item) return;
    if (item.until <= this.now()) { this.entries.delete(key); this.bytes -= item.bytes; return; }
    return structuredClone(item.value);
  }

  async refresh(key: string, load: (signal: AbortSignal) => Promise<T>, unavailable: T): Promise<T> {
    const current = this.get(key);
    if (current !== undefined) return current;
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    // Neither arbitrary concurrent queries nor abandoned browser requests may
    // create unbounded provider work. One bounded status operation serves the
    // same revision; a new HTTP request still performs its own ACL checks.
    if (this.pending.size >= 8) return structuredClone(unavailable);
    const task = (async () => {
      let value: T, ttl = this.ttl;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        value = await Promise.race([Promise.resolve().then(() => load(controller.signal)), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Connection observation timed out.')); }, this.timeoutMs);
        })]);
      }
      catch { value = unavailable; ttl = Math.min(ttl, 10_000); }
      finally { if (timer) clearTimeout(timer); }
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes <= this.maxBytes) {
        while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
        }
        this.entries.set(key, { value: structuredClone(value), until: this.now() + ttl, bytes }); this.bytes += bytes;
      }
      return value;
    })();
    this.pending.set(key, task);
    try { return structuredClone(await task); } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
}
