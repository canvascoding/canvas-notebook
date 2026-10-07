import 'server-only';

import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { normalizeCapabilityPackageRelativePath } from '@/app/lib/capabilities/packages/io';

const invalid = () => new CapabilityPackageError('PACKAGE_INVALID', 'The Store archive is invalid.', 400);
const limit = () => new CapabilityPackageError('PACKAGE_LIMIT_EXCEEDED', 'The Store package exceeds its size limit.', 413);

/** One timeout covers headers and the complete, bounded response body. */
export async function readBoundedStorePackageBytes(url: URL, maxBytes = CAPABILITY_PACKAGE_LIMITS.maxTotalBytes,
  timeoutMs = 20_000): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) throw limit();
  if (url.protocol === 'file:') {
    const handle = await fs.open(fileURLToPath(url), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw limit();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > maxBytes) throw limit();
        chunks.push(bytes);
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid();
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new CapabilityPackageError('PACKAGE_INVALID', 'The Store download failed.', 502);
    const advertised = response.headers.get('content-length');
    if (advertised && /^\d+$/u.test(advertised) && BigInt(advertised) > BigInt(maxBytes)) {
      await response.body?.cancel(); throw limit();
    }
    const chunks: Buffer[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    try {
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw limit(); }
        chunks.push(Buffer.from(result.value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (controller.signal.aborted) throw new CapabilityPackageError('PACKAGE_INVALID', 'The Store download timed out.', 504);
    throw error;
  } finally { clearTimeout(timeout); }
}

export function normalizeStoreArchivePath(value: string): string {
  return normalizeCapabilityPackageRelativePath(value.endsWith('/') ? value.slice(0, -1) : value);
}

type ArchiveEntry = { name: string; directory: boolean; size: number; executable: boolean };
/** Inspect the central directory before JSZip can overwrite duplicates or sanitize paths. */
function inspectArchive(bytes: Buffer): ArchiveEntry[] {
  if (bytes.length > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes || bytes.length < 22) throw limit();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw invalid();
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff || centralSize === 0xffffffff || bytes.readUInt16LE(end + 8) !== count
    || start + centralSize !== end) throw invalid();
  let offset = start; const names = new Set<string>(), entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    if (offset + 46 + length + extra + comment > end || flags & 1 || ![0, 8].includes(method)) throw invalid();
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length)); }
    catch { throw invalid(); }
    const directory = name.endsWith('/'), normalized = normalizeStoreArchivePath(name);
    const folded = normalized.normalize('NFC').toLowerCase();
    if (names.has(folded)) throw invalid(); names.add(folded);
    const unix = bytes.readUInt32LE(offset + 38) >>> 16, kind = unix & 0xf000;
    if (kind && kind !== (directory ? 0x4000 : 0x8000)) throw invalid();
    const size = bytes.readUInt32LE(offset + 24), local = bytes.readUInt32LE(offset + 42);
    if (directory && size !== 0) throw invalid();
    if (size === 0xffffffff || local === 0xffffffff || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    if (local + 30 + localLength + localExtra > start
      || !bytes.subarray(local + 30, local + 30 + localLength).equals(bytes.subarray(offset + 46, offset + 46 + length))) throw invalid();
    if (directory) {
      const dataStart = local + 30 + localLength + localExtra, compressedSize = bytes.readUInt32LE(offset + 20);
      if (dataStart + compressedSize > start) throw invalid();
      if (method === 0 && compressedSize !== 0) throw invalid();
      if (method === 8) {
        try { if (inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize), {maxOutputLength: 1}).length) throw invalid(); }
        catch { throw invalid(); }
      }
    }
    entries.push({ name, directory, size, executable: Boolean(unix & 0o111) });
    offset += 46 + length + extra + comment;
  }
  if (offset !== end) throw invalid();
  return entries;
}

/** Extract only the selected root, streaming each file within the shared package budgets. */
export async function extractBoundedStorePackageArchive(bytes: Buffer, packagePath: string | undefined,
  kind: 'plugin' | 'skill'): Promise<{tempRoot: string; packageRoot: string}> {
  const entries = inspectArchive(bytes);
  const prefix = packagePath ? `${normalizeStoreArchivePath(packagePath)}/` : '';
  const selected = entries.filter(entry => !prefix || entry.name.startsWith(prefix));
  const files = selected.filter(entry => !entry.directory);
  const directories = new Map<string, string>();
  const paths = new Map<string, {path: string; directory: boolean}>();
  const register = (value: string, directory: boolean) => {
    const folded = value.normalize('NFC').toLowerCase(), previous = paths.get(folded);
    if (previous && (previous.path !== value || previous.directory !== directory)) throw invalid();
    paths.set(folded, {path: value, directory});
    if (directory) directories.set(folded, value);
  };
  for (const entry of selected) {
    const stripped = prefix ? entry.name.slice(prefix.length) : entry.name;
    if (!stripped) continue; // The selected package root is the already-created extraction root.
    const relative = normalizeStoreArchivePath(stripped), segments = relative.split('/');
    for (let index = 1; index < segments.length; index++) register(segments.slice(0, index).join('/'), true);
    register(relative, entry.directory);
  }
  if (!files.length) throw invalid();
  if (files.length > CAPABILITY_PACKAGE_LIMITS.maxFiles || directories.size > CAPABILITY_PACKAGE_LIMITS.maxFiles
    || files.some(entry => entry.size > CAPABILITY_PACKAGE_LIMITS.maxFileBytes)
    || files.reduce((total, entry) => total + entry.size, 0) > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) throw limit();
  const zip = await JSZip.loadAsync(bytes);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-${kind}-store-`));
  const packageRoot = path.join(tempRoot, 'package');
  try {
    await fs.mkdir(packageRoot);
    for (const directory of [...directories.values()].sort()) {
      await fs.mkdir(path.join(packageRoot, directory), {recursive: true});
    }
    let total = 0;
    for (const entry of files) {
      const relative = normalizeStoreArchivePath(prefix ? entry.name.slice(prefix.length) : entry.name);
      const source = zip.files[entry.name];
      if (!source || source.dir || source.unsafeOriginalName && source.unsafeOriginalName !== entry.name) throw invalid();
      const target = path.join(packageRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
      let size = 0;
      try {
        for await (const chunk of new Readable({read() { /* JSZip drives this compatibility stream. */ }}).wrap(source.nodeStream('nodebuffer'))) {
          const value = Buffer.from(chunk); size += value.length; total += value.length;
          if (size > CAPABILITY_PACKAGE_LIMITS.maxFileBytes || total > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes || size > entry.size) throw limit();
          await handle.writeFile(value);
        }
      } finally { await handle.close(); }
      if (size !== entry.size) throw invalid();
    }
    return { tempRoot, packageRoot };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }); throw error;
  }
}
