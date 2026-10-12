/** Bounded, expiring reference storage; cached data never substitutes for current access checks. */
export class IntegrationReferenceCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 256,
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Reference cache bounds must be positive integers.');
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    const now = this.now();
    for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
