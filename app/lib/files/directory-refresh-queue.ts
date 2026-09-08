interface RefreshEntry {
  promise: Promise<void>;
  run: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Coalesces display refreshes; callers record actual mutations separately. */
export class DirectoryRefreshQueue {
  private entries = new Map<string, RefreshEntry>();
  constructor(readonly intervalMs = 500) {}

  request(key: string, read: () => Promise<void>, immediate = false): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      if (immediate && existing.timer) { clearTimeout(existing.timer); existing.run(); }
      return existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const entry: RefreshEntry = { promise, run: () => {
      entry.timer = undefined;
      const finish = () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      };
      void Promise.resolve().then(read).then(() => { finish(); resolve(); }, (error) => { finish(); reject(error); });
    } };
    this.entries.set(key, entry);
    if (immediate) entry.run();
    else entry.timer = setTimeout(entry.run, this.intervalMs);
    return promise;
  }
}
