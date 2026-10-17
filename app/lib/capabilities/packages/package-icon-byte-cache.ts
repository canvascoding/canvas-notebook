import 'server-only';
import { createHash } from 'node:crypto';

/** Validated bytes only. Callers must authorize and verify the exact source
 * before every lookup; this cache never retains paths, resources or grants. */
export function createPackageIconByteCache(options: { maxBytes?: number; maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024, maxEntries = options.maxEntries ?? 64;
  const ttlMs = options.ttlMs ?? 30_000, now = options.now ?? Date.now;
  const entries = new Map<string, { bytes: Buffer; expiresAt: number }>();
  let retainedBytes = 0;
  return (sourceChecksum: string, contentType: string, bytes: Buffer, validate: () => boolean): Buffer | null => {
    const key = createHash('sha256').update(sourceChecksum).update('\0').update(contentType).update('\0').update(bytes).digest('hex');
    const held = entries.get(key);
    if (held) {
      entries.delete(key); retainedBytes -= held.bytes.byteLength;
      if (held.expiresAt > now()) {
        entries.set(key, held); retainedBytes += held.bytes.byteLength;
        return Buffer.from(held.bytes);
      }
    }
    if (!validate()) return null;
    if (bytes.byteLength <= maxBytes && maxEntries > 0) {
      while (entries.size && (entries.size >= maxEntries || retainedBytes + bytes.byteLength > maxBytes)) {
        const oldest = entries.keys().next().value!;
        retainedBytes -= entries.get(oldest)!.bytes.byteLength; entries.delete(oldest);
      }
      entries.set(key, { bytes: Buffer.from(bytes), expiresAt: now() + ttlMs }); retainedBytes += bytes.byteLength;
    }
    return Buffer.from(bytes);
  };
}
