import 'server-only';

import type { IntegrationExecutionContext, IntegrationSource } from './contracts';
import { schemaFingerprint } from './schema';

type Entry = { json: string; bytes: number; expiresAt: number };

export function createIntegrationMetadataCacheKey(input: {
  context: IntegrationExecutionContext;
  source: IntegrationSource;
  providerRef: string;
  revision: string;
  kind: 'app_catalog' | 'tool_catalog';
  selector?: unknown;
}): string {
  if (!input.revision.trim()) throw new Error('Metadata requires a current source revision.');
  return schemaFingerprint(input);
}

/** Only successful raw descriptions belong here. Accounts, grants, health and schemas stay live. */
export class IntegrationMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(private readonly limits: {
    maxEntries?: number;
    maxBytes?: number;
    maxEntryBytes?: number;
    ttlMs?: number;
    now?: () => number;
  } = {}) {
    for (const value of [limits.maxEntries, limits.maxBytes, limits.maxEntryBytes, limits.ttlMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error('Metadata cache bounds must be positive integers.');
      }
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.totalBytes -= entry.bytes;
    this.entries.delete(key);
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= (this.limits.now ?? Date.now)()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return JSON.parse(entry.json) as T;
  }

  set(key: string, value: unknown, status: { complete: boolean; signal?: AbortSignal }): boolean {
    this.remove(key);
    if (!status.complete || status.signal?.aborted) return false;
    let json: string | undefined;
    try { json = JSON.stringify(value); } catch { return false; }
    if (json === undefined) return false;
    const bytes = Buffer.byteLength(json, 'utf8');
    const maxBytes = this.limits.maxBytes ?? 8 * 1024 * 1024;
    if (bytes > Math.min(this.limits.maxEntryBytes ?? 1024 * 1024, maxBytes)) return false;
    const now = (this.limits.now ?? Date.now)();
    for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.remove(entryKey);
    while (this.entries.size >= (this.limits.maxEntries ?? 128) || this.totalBytes + bytes > maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { json, bytes, expiresAt: now + (this.limits.ttlMs ?? 60_000) });
    this.totalBytes += bytes;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number { return this.entries.size; }
  get bytes(): number { return this.totalBytes; }
}

const metadataCacheHost = globalThis as typeof globalThis & { __canvasIntegrationMetadataCacheV1?: IntegrationMetadataCache };
export const integrationMetadataCache = metadataCacheHost.__canvasIntegrationMetadataCacheV1 ??= new IntegrationMetadataCache();
