import 'server-only';
import { createGunzip } from 'node:zlib';
import { Transform, type Readable } from 'node:stream';
import type { PortableDatabaseHeader } from './database-schema';

/** Bound both nested decompression and individual JSON records. */
export async function* portableDatabaseLines(source: Readable): AsyncGenerator<string> {
  let bytes = 0; let pending = Buffer.alloc(0);
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 100 * 1024 ** 3 ? new Error('Expanded database snapshot exceeds 100 GiB.') : null, chunk);
  } });
  const unzip = createGunzip(); source.on('error', error => unzip.destroy(error));
  const stream = source.pipe(unzip).pipe(limit); unzip.on('error', error => limit.destroy(error));
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        if (newline > 64 * 1024 ** 2) throw new Error('Database snapshot record exceeds 64 MiB.');
        const line = pending.subarray(0, newline).toString('utf8'); pending = pending.subarray(newline + 1);
        if (!line) throw new Error('Database snapshot contains an empty record.');
        yield line;
      }
      if (pending.length > 64 * 1024 ** 2) throw new Error('Database snapshot record exceeds 64 MiB.');
    }
    if (pending.length) throw new Error('Database snapshot is incomplete.');
  } finally { source.destroy(); unzip.destroy(); limit.destroy(); }
}

export function parsePortableDatabaseHeader(line: string): PortableDatabaseHeader {
  if (Buffer.byteLength(line) > 8 * 1024 ** 2) throw new Error('Database snapshot header exceeds 8 MiB.');
  const header = JSON.parse(line) as PortableDatabaseHeader;
  if (!header || header.format !== 'canvas-postgres-rows' || header.version !== 1 || !Array.isArray(header.tables)
    || !Array.isArray(header.users) || !/^[a-f0-9]{64}$/u.test(header.schemaHash) || typeof header.organizationId !== 'string') throw new Error('Unsupported portable PostgreSQL snapshot.');
  return header;
}
