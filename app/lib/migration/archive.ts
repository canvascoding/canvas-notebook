import 'server-only';

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Open, type File as ZipFile } from 'unzipper';

export class MigrationArchiveError extends Error {
  readonly code = 'MIGRATION_ARCHIVE_INVALID';
}

const MAX_ENTRIES = 250_000;
const MAX_EXPANDED_BYTES = 100 * 1024 ** 3;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function assertMigrationArchivePath(value: string): void {
  if (!value || value.includes('\\') || /[\0\r\n]/u.test(value)
    || /^(?:\/|[a-z]:)/iu.test(value) || /%(?:2f|5c)/iu.test(value)
    || value.replace(/\/$/u, '').split('/').some(part => !part || part === '.' || part === '..')
    || (value !== 'manifest.json' && !value.startsWith('data/'))) {
    throw new MigrationArchiveError('The migration archive contains an unsafe path.');
  }
}

/** Inspect central-directory metadata; never ask an unzip tool to create paths. */
export async function openMigrationArchive(filename: string): Promise<ZipFile[]> {
  const archive = await Open.file(filename);
  if (archive.files.length > MAX_ENTRIES) throw new MigrationArchiveError('The migration archive contains too many entries.');
  const names = new Set<string>();
  let size = 0;
  for (const entry of archive.files) {
    assertMigrationArchivePath(entry.path);
    const name = entry.path.replace(/\/$/u, '').normalize('NFC').toLowerCase();
    if (names.has(name)) throw new MigrationArchiveError('The migration archive contains duplicate or conflicting paths.');
    names.add(name);
    const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (type && type !== 0o100000 && type !== 0o040000) throw new MigrationArchiveError('Links and special files are not supported in migration archives.');
    if (entry.flags & 1) throw new MigrationArchiveError('Encrypted ZIP entries are not supported.');
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new MigrationArchiveError('The migration archive has an invalid entry size.');
    size += entry.uncompressedSize;
    if (size > MAX_EXPANDED_BYTES) throw new MigrationArchiveError('The expanded migration archive exceeds 100 GiB.');
  }
  return archive.files;
}

function verifiedContent(entry: ZipFile, limit = entry.uncompressedSize, expectedHash?: string): Transform {
  let bytes = 0;
  let crc = 0xffffffff;
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit || bytes > entry.uncompressedSize) return callback(new MigrationArchiveError('A migration entry exceeds its declared size.'));
      hash.update(chunk);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)
        || (expectedHash && hash.digest('hex') !== expectedHash)) {
        return callback(new MigrationArchiveError('A migration entry failed its size or checksum verification.'));
      }
      callback();
    },
  });
}

export async function readMigrationEntry(entry: ZipFile, limit = 20 * 1024 ** 2): Promise<string> {
  if (entry.uncompressedSize > limit) throw new MigrationArchiveError('Migration metadata is too large.');
  const chunks: Buffer[] = [];
  await pipeline(entry.stream(), verifiedContent(entry, limit), new Writable({
    write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback(); },
  }));
  return Buffer.concat(chunks).toString('utf8');
}

export async function stageMigrationEntry(entry: ZipFile, destination: string, expectedHash?: string): Promise<void> {
  await pipeline(entry.stream(), verifiedContent(entry, entry.uncompressedSize, expectedHash),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}

export async function migrationFileSha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
