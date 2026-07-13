const LOCAL_WRITE_TTL_MS = 10_000;

interface LocalWrite {
  content: string;
  recordedAt: number;
}

function findLatestWriteIndex(writes: LocalWrite[], content: string) {
  for (let index = writes.length - 1; index >= 0; index--) {
    if (writes[index].content === content) return index;
  }
  return -1;
}

/**
 * Remembers a short sequence of writes made by this editor instance.
 *
 * Filesystem watcher events do not carry their originating browser request,
 * so a rapid second edit can otherwise make the first local save look like an
 * external edit. Matching a returned file version consumes all writes through
 * that version: this also handles watcher event coalescing.
 */
export class LocalFileWriteTracker {
  private readonly writesByPath = new Map<string, LocalWrite[]>();

  record(path: string, content: string, now = Date.now()) {
    this.prune(path, now);
    const writes = this.writesByPath.get(path) ?? [];
    writes.push({ content, recordedAt: now });
    this.writesByPath.set(path, writes);
  }

  discard(path: string, content: string) {
    const writes = this.writesByPath.get(path);
    if (!writes) return;

    const index = findLatestWriteIndex(writes, content);
    if (index < 0) return;

    writes.splice(index, 1);
    if (writes.length === 0) this.writesByPath.delete(path);
  }

  consumeMatchingWrite(path: string, content: string, now = Date.now()) {
    this.prune(path, now);
    const writes = this.writesByPath.get(path);
    if (!writes) return false;

    const index = findLatestWriteIndex(writes, content);
    if (index < 0) return false;

    writes.splice(0, index + 1);
    if (writes.length === 0) this.writesByPath.delete(path);
    return true;
  }

  private prune(path: string, now: number) {
    const writes = this.writesByPath.get(path);
    if (!writes) return;

    const freshWrites = writes.filter((write) => now - write.recordedAt <= LOCAL_WRITE_TTL_MS);
    if (freshWrites.length === 0) {
      this.writesByPath.delete(path);
      return;
    }
    if (freshWrites.length !== writes.length) {
      this.writesByPath.set(path, freshWrites);
    }
  }
}
