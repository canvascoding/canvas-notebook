import 'server-only';

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

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
export async function readBoundedStoreRegistryJson(rawUrl: string, options: { allowedProtocols?: readonly string[] } = {}): Promise<unknown> {
  const url = new URL(rawUrl);
  if (!(options.allowedProtocols ?? (process.env.NODE_ENV === 'production' ? ['https:'] : ['https:', 'http:', 'file:'])).includes(url.protocol)) {
    throw new Error('The store registry source is unsupported.');
  }
  if (url.protocol === 'file:') {
    const file = fileURLToPath(url);
    if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    const bytes = await fs.readFile(file);
    if (bytes.byteLength > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    return parseUniqueJson(bytes.toString('utf8'));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('The store registry is unavailable.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('The store registry exceeds its byte limit.');
        chunks.push(Buffer.from(item.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return parseUniqueJson(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timeout); controller.abort(); }
}
