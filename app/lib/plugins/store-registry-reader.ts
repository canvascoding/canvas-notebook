import 'server-only';

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const METADATA_TTL_MS = 30_000;
const METADATA_CACHE_BYTES = 20 * 1024 * 1024;
type RegistryReadOptions = { allowedProtocols?: readonly string[]; signal?: AbortSignal; cache?: 'metadata' | 'fresh' };
type CachedRegistry = { value: unknown; bytes: number; expiresAt: number };
type PendingRegistry = { controller: AbortController; promise: Promise<unknown>; consumers: number };
const metadataCache = new Map<string, CachedRegistry>();
const pendingMetadata = new Map<string, PendingRegistry>();

function retainMetadata(key: string, value: unknown, bytes: number): void {
  metadataCache.delete(key);
  metadataCache.set(key, { value: structuredClone(value), bytes, expiresAt: Date.now() + METADATA_TTL_MS });
  let total = [...metadataCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [candidate, entry] of metadataCache) {
    if (total <= METADATA_CACHE_BYTES && metadataCache.size <= 32) break;
    metadataCache.delete(candidate); total -= entry.bytes;
  }
}

/** A caller cancels its own wait; the actual fetch stops when its final waiter leaves. */
async function waitForMetadata(entry: PendingRegistry, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  entry.consumers++;
  let abort: (() => void) | undefined;
  try {
    const value = signal ? await Promise.race([entry.promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]) : await entry.promise;
    signal?.throwIfAborted();
    return structuredClone(value);
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    if (--entry.consumers === 0) entry.controller.abort();
  }
}

/** JSON.parse silently overwrites duplicate keys, including escaped aliases. */
function parseUniqueJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  let index = 0;
  const whitespace = () => { while (/\s/u.test(raw[index] || '') && index < raw.length) index++; };
  const string = (): string => {
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') { index += 2; continue; }
      if (raw[index++] === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error('The store registry JSON is invalid.');
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('The store registry is too deeply nested.');
    whitespace();
    const token = raw[index];
    if (token === '"') { string(); return; }
    if (token === '{') {
      index++; whitespace(); const keys = new Set<string>();
      if (raw[index] === '}') { index++; return; }
      while (index < raw.length) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error('The store registry contains duplicate keys.');
        keys.add(key); whitespace(); index++; value(depth + 1); whitespace();
        if (raw[index++] === '}') return;
      }
    } else if (token === '[') {
      index++; whitespace(); if (raw[index] === ']') { index++; return; }
      while (index < raw.length) { value(depth + 1); whitespace(); if (raw[index++] === ']') return; }
    } else { while (index < raw.length && !/[\s,}\]]/u.test(raw[index])) index++; }
  };
  value(0);
  return parsed;
}

/** Metadata-only fetch: both headers and the entire body share one timeout and byte budget. */
export async function readBoundedStoreRegistryJson(rawUrl: string, options: RegistryReadOptions = {}): Promise<unknown> {
  const url = new URL(rawUrl);
  const protocols = options.allowedProtocols ?? (process.env.NODE_ENV === 'production' ? ['https:'] : ['https:', 'http:', 'file:']);
  if (!protocols.includes(url.protocol)) {
    throw new Error('The store registry source is unsupported.');
  }
  options.signal?.throwIfAborted();
  // Only explicitly requested public listing metadata is cached. Source review,
  // install and mutation readers retain the original fresh default.
  if (options.cache === 'metadata' && url.protocol !== 'file:' && !url.username && !url.password) {
    const key = JSON.stringify([url.href, [...protocols].sort()]);
    const cached = metadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
    metadataCache.delete(key);
    let pending = pendingMetadata.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = readRegistry(url, controller.signal).then(({ value, bytes }) => {
        if (!controller.signal.aborted) retainMetadata(key, value, bytes);
        return value;
      });
      pending = { controller, promise, consumers: 0 };
      pendingMetadata.set(key, pending);
      const current = pending;
      void promise.finally(() => { if (pendingMetadata.get(key) === current) pendingMetadata.delete(key); }).catch(() => {});
    }
    return waitForMetadata(pending, options.signal);
  }
  return (await readRegistry(url, options.signal)).value;
}

async function readRegistry(url: URL, signal?: AbortSignal): Promise<{ value: unknown; bytes: number }> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const file = fileURLToPath(url);
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    const bytes = await fs.readFile(file, { signal });
    if (bytes.byteLength > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    return { value: parseUniqueJson(bytes.toString('utf8')), bytes: bytes.byteLength };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    if (!response.ok || !response.body) throw new Error('The store registry is unavailable.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
        chunks.push(Buffer.from(item.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { value: parseUniqueJson(Buffer.concat(chunks).toString('utf8')), bytes };
  } finally { clearTimeout(timeout); controller.abort(); }
}
