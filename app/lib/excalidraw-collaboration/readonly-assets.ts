import 'server-only';

import { createHash } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import type { SqlConnection } from '@/app/lib/db';
import { resolveDataDir } from '@/app/lib/db/provider';
import { getFdPublicationBackend, type FdPublicationBackend } from '@/app/lib/files/fd-publication';
import { EXCALIDRAW_ASSET_MAX_BYTES, EXCALIDRAW_MAX_ASSET_REFERENCES, EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import type { ExcalidrawAssetMetadata } from './protocol';

type AssetErrorCode = 'EXCALIDRAW_ASSET_SOURCE_INVALID' | 'EXCALIDRAW_ASSET_SOURCE_CHANGED' | 'EXCALIDRAW_ASSET_BUDGET_EXCEEDED';
export class ExcalidrawReadonlyAssetError extends Error {
  readonly status: number;
  constructor(readonly code: AssetErrorCode) {
    super('The captured Excalidraw assets could not be verified within their read budget.');
    this.name = 'ExcalidrawReadonlyAssetError'; this.status = code === 'EXCALIDRAW_ASSET_BUDGET_EXCEEDED' ? 413 : 409;
  }
}
export type ExcalidrawReadonlyAssetRecord = Readonly<{
  metadata: Readonly<ExcalidrawAssetMetadata>; bytes: Uint8Array; contentProof: string;
  storageIdentity: Readonly<{ dev: string; ino: string; sizeBytes: number }>;
}>;
const invalid = (): never => { throw new ExcalidrawReadonlyAssetError('EXCALIDRAW_ASSET_SOURCE_INVALID'); };
const changed = (): never => { throw new ExcalidrawReadonlyAssetError('EXCALIDRAW_ASSET_SOURCE_CHANGED'); };
const budget = (): never => { throw new ExcalidrawReadonlyAssetError('EXCALIDRAW_ASSET_BUDGET_EXCEEDED'); };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const mimeTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
const fields = ['fileId', 'contentHash', 'mimeType', 'sizeBytes', 'version', 'createdAt'] as const;
const integer = (value: unknown, minimum: number): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;

/** Pure canonical metadata capture; never loads a provider or inspects a blob. */
export function captureExcalidrawReadonlyAssetMetadata(value: unknown): Readonly<ExcalidrawAssetMetadata> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== fields.length) return invalid();
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    record[field] = descriptor.value;
  }
  if (typeof record.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(record.fileId)
    || typeof record.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.contentHash)
    || typeof record.mimeType !== 'string' || !mimeTypes.has(record.mimeType)
    || !integer(record.sizeBytes, 1) || !integer(record.version, 1) || !integer(record.createdAt, 0)) return invalid();
  if (record.sizeBytes > EXCALIDRAW_ASSET_MAX_BYTES) return budget();
  return Object.freeze({ fileId: record.fileId, contentHash: record.contentHash, mimeType: record.mimeType,
    sizeBytes: record.sizeBytes, version: record.version, createdAt: record.createdAt });
}

function captureAssetList(value: unknown): readonly Readonly<ExcalidrawAssetMetadata>[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  if (value.length > EXCALIDRAW_MAX_ASSET_REFERENCES) return budget();
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: Readonly<ExcalidrawAssetMetadata>[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    result.push(captureExcalidrawReadonlyAssetMetadata(descriptor.value));
  }
  return Object.freeze(result);
}

function captureAssetLimit(value: unknown): number {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => key !== 'maxTotalBytes')) return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'maxTotalBytes');
  if (descriptor && (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) return invalid();
  const limit = descriptor?.value ?? EXCALIDRAW_PORTABLE_MAX_BYTES;
  if (!integer(limit, 0) || limit > EXCALIDRAW_PORTABLE_MAX_BYTES) return invalid();
  return limit;
}

type Header = Readonly<{ metadata: Readonly<ExcalidrawAssetMetadata>; storageKey: string }>;
function sqlInteger(value: unknown): number {
  if (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/u.test(value)) return changed();
  if (typeof value !== 'number' && typeof value !== 'string') return changed();
  const number = Number(value); if (!integer(number, 0)) return changed(); return number;
}
async function headers(connection: SqlConnection, workspaceId: string,
  requested: readonly Readonly<ExcalidrawAssetMetadata>[]): Promise<readonly Header[]> {
  const rows = await connection.all(`SELECT workspace_id,file_id,content_sha256,mime_type,size_bytes,
    storage_key,version,status,created_at FROM collaboration_excalidraw_assets
    WHERE workspace_id=$1 AND file_id=ANY($2::text[]) ORDER BY file_id`, [workspaceId, requested.map(value => value.fileId)]);
  if (!Array.isArray(rows) || rows.length !== requested.length) return changed();
  const indexed = new Map<string, Header>(), scope = hash(workspaceId).slice(0, 32);
  for (const value of rows) {
    if (!value || typeof value !== 'object') return changed();
    const row = value as Record<string, unknown>;
    if (row.workspace_id !== workspaceId || row.status !== 'available') return changed();
    const metadata = captureExcalidrawReadonlyAssetMetadata({ fileId: row.file_id, contentHash: row.content_sha256,
      mimeType: row.mime_type, sizeBytes: sqlInteger(row.size_bytes), version: sqlInteger(row.version), createdAt: sqlInteger(row.created_at) });
    const storageKey = `${scope}/${metadata.contentHash}`;
    if (row.storage_key !== storageKey || indexed.has(metadata.fileId)) return changed();
    indexed.set(metadata.fileId, Object.freeze({ metadata, storageKey }));
  }
  return Object.freeze(requested.map(metadata => {
    const header = indexed.get(metadata.fileId);
    if (!header || fields.some(field => header.metadata[field] !== metadata[field])) return changed();
    return header;
  }));
}

type Directory = { fd: number; identity: BigIntStats; absolute: string; parent?: Directory; name?: string };
const nodeEqual = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'mode', 'uid', 'gid', 'birthtimeNs']
  .every(field => Reflect.get(a, field) === Reflect.get(b, field));
const fileEqual = (a: BigIntStats, b: BigIntStats) => nodeEqual(a, b)
  && ['nlink', 'size', 'mtimeNs', 'ctimeNs'].every(field => Reflect.get(a, field) === Reflect.get(b, field));
function owned(info: BigIntStats, directory: boolean, root = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== BigInt(1))
    || info.uid !== BigInt(process.geteuid!()) || (info.mode & BigInt(root ? 0o022 : 0o7777)) !== BigInt(root ? 0 : directory ? 0o700 : 0o600)) changed();
}
function checkDirectory(io: FdPublicationBackend, directory: Directory): void {
  const actual = fs.fstatSync(directory.fd, { bigint: true }); owned(actual, true, !directory.parent);
  if (!nodeEqual(actual, directory.identity)) return changed();
  if (directory.parent) {
    checkDirectory(io, directory.parent);
    if (!io.hasExactNameAt(directory.parent.fd, directory.name!)) return changed();
    const named = io.openDirectoryAt(directory.parent.fd, directory.name!);
    try { if (!nodeEqual(fs.fstatSync(named, { bigint: true }), directory.identity)) return changed(); }
    finally { fs.closeSync(named); }
  } else if (fs.realpathSync(directory.absolute) !== directory.absolute
    || !nodeEqual(fs.lstatSync(directory.absolute, { bigint: true }), directory.identity)) return changed();
}
async function readBlob(io: FdPublicationBackend, directory: Directory, metadata: Readonly<ExcalidrawAssetMetadata>): Promise<ExcalidrawReadonlyAssetRecord> {
  checkDirectory(io, directory);
  const fd = io.openFileAt(directory.fd, metadata.contentHash, 'readonly');
  try {
    const before = fs.fstatSync(fd, { bigint: true }); owned(before, false);
    if (before.size !== BigInt(metadata.sizeBytes)) return changed();
    const bytes = Buffer.alloc(metadata.sizeBytes + 1); let length = 0;
    while (length < bytes.length) {
      const count = await new Promise<number>((resolve, reject) => fs.read(fd, bytes, length,
        Math.min(1024 * 1024, bytes.length - length), length, (error, count) => error ? reject(error) : resolve(count)));
      checkDirectory(io, directory); if (!count) break; length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (length !== metadata.sizeBytes || !fileEqual(before, after) || !io.hasExactNameAt(directory.fd, metadata.contentHash)) return changed();
    const named = io.openFileAt(directory.fd, metadata.contentHash, 'readonly');
    try { if (!fileEqual(after, fs.fstatSync(named, { bigint: true }))) return changed(); }
    finally { fs.closeSync(named); }
    const captured = bytes.subarray(0, length), contentProof = hash(captured);
    if (contentProof !== metadata.contentHash || !fileEqual(after, fs.fstatSync(fd, { bigint: true }))) return changed();
    checkDirectory(io, directory);
    return Object.freeze({ metadata, bytes: new Uint8Array(captured), contentProof,
      storageIdentity: Object.freeze({ dev: String(after.dev), ino: String(after.ino), sizeBytes: length }) });
  } finally { fs.closeSync(fd); }
}

/** Caller owns its authorization, actual SQL connection/transaction and lifecycle
 * fences. Returned bytes are an owned copy; this observation grants no mutation
 * authority or global snapshot. No provider checkout, bootstrap, TX or lastref write. */
export async function readExcalidrawAssetsOnConnection(connection: SqlConnection, workspaceId: string,
  metadata: readonly ExcalidrawAssetMetadata[], options: { maxTotalBytes?: number } = {}): Promise<readonly ExcalidrawReadonlyAssetRecord[]> {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(workspaceId)) return invalid();
  const requested = captureAssetList(metadata), limit = captureAssetLimit(options);
  if (new Set(requested.map(asset => asset.fileId)).size !== requested.length) return invalid();
  if (requested.reduce((total, asset) => total + asset.sizeBytes, 0) > limit) return budget();
  if (!requested.length) return Object.freeze([]);
  const before = await headers(connection, workspaceId, requested), opened: number[] = [];
  try {
    const io = getFdPublicationBackend(), absolute = path.resolve(resolveDataDir());
    const rootFd = fs.openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); opened.push(rootFd);
    let directory: Directory = { fd: rootFd, identity: fs.fstatSync(rootFd, { bigint: true }), absolute };
    checkDirectory(io, directory);
    for (const name of ['collaboration-assets', 'excalidraw', hash(workspaceId).slice(0, 32)]) {
      const fd = io.openDirectoryAt(directory.fd, name); opened.push(fd);
      directory = { fd, identity: fs.fstatSync(fd, { bigint: true }), absolute: path.join(directory.absolute, name), parent: directory, name };
      checkDirectory(io, directory);
    }
    const records: ExcalidrawReadonlyAssetRecord[] = [];
    for (const header of before) records.push(await readBlob(io, directory, header.metadata));
    if (JSON.stringify(await headers(connection, workspaceId, requested)) !== JSON.stringify(before)) return changed();
    checkDirectory(io, directory);
    return Object.freeze(records);
  } catch (error) {
    if (error instanceof ExcalidrawReadonlyAssetError) throw error;
    return changed();
  } finally {
    let failed = false;
    for (const fd of opened.reverse()) try { fs.closeSync(fd); } catch { failed = true; }
    if (failed) changed();
  }
}
