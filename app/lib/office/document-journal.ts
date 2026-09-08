import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FileActorType } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { DOCX_PACKAGE_LIMITS } from './docx-package';

export const OFFICE_JOURNAL_LIMITS = Object.freeze({
  identityLength: 256,
  idempotencyKeyLength: 128,
  pathLength: 4096,
  manifestBytes: 8192,
  pendingEntries: 4096,
  historyEntries: 100_000,
  contentBytes: DOCX_PACKAGE_LIMITS.compressedBytes,
});

export type OfficeJournalErrorCode =
  | 'OFFICE_JOURNAL_INVALID_INPUT'
  | 'OFFICE_IDEMPOTENCY_CONFLICT'
  | 'OFFICE_JOURNAL_CORRUPT'
  | 'OFFICE_JOURNAL_UNAVAILABLE'
  | 'OFFICE_JOURNAL_UNSAFE_STORAGE'
  | 'OFFICE_JOURNAL_SCAN_LIMIT'
  | 'OFFICE_VERSION_NOT_FOUND';

export class OfficeJournalError extends Error {
  readonly status: number;

  constructor(readonly code: OfficeJournalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OfficeJournalError';
    this.status = code === 'OFFICE_IDEMPOTENCY_CONFLICT' ? 409 : code === 'OFFICE_VERSION_NOT_FOUND' ? 404
      : code === 'OFFICE_JOURNAL_INVALID_INPUT' ? 400 : code === 'OFFICE_JOURNAL_CORRUPT' ? 500 : 503;
  }
}

export type OfficeCommitIdentity = {
  workspaceId: string;
  lineageId: string;
  actorUserId: string;
  actorSessionId: string;
  idempotencyKey: string;
};

export type OfficeCommitRecord = Readonly<OfficeCommitIdentity & {
  version: 1;
  id: string;
  path: string;
  actorType: FileActorType;
  beforeHash: string | null;
  afterHash: string;
  beforeSizeBytes: number | null;
  afterSizeBytes: number;
  baseRevisionId: string | null;
  revisionId: string | null;
  createdAt: number;
  status: 'prepared' | 'completed';
}>;

export type PrepareOfficeCommitInput = OfficeCommitIdentity & {
  path: string;
  actorType: FileActorType;
  beforeHash: string | null;
  baseRevisionId: string | null;
  beforeContent: Buffer | null;
  content: Buffer;
};

export type OfficeVersionMetadata = {
  contentHash: string;
  sizeBytes: number;
  createdAt: number;
  revisionId: string | null;
  commitId: string;
  status: 'baseline' | 'prepared' | 'completed';
  path: string;
  actorUserId: string | null;
  actorSessionId: string | null;
  actorType: FileActorType | null;
};

type Scope = { workspaceId: string; lineageId: string };
type JournalPaths = { root: string; blobs: string; commits: string; pending: string };
const HASH = /^[a-f0-9]{64}$/u;
const ACTOR_TYPES = new Set(['user', 'agent', 'automation', 'system']);

function fail(code: OfficeJournalErrorCode, message: string): never {
  throw new OfficeJournalError(code, message);
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertScope(input: Scope): void {
  if (!validString(input.workspaceId, OFFICE_JOURNAL_LIMITS.identityLength) || !validString(input.lineageId, OFFICE_JOURNAL_LIMITS.identityLength)) {
    fail('OFFICE_JOURNAL_INVALID_INPUT', 'A bounded workspace and document identity is required.');
  }
}

function assertIdentity(input: OfficeCommitIdentity): void {
  assertScope(input);
  if (!validString(input.actorUserId, OFFICE_JOURNAL_LIMITS.identityLength) || !validString(input.actorSessionId, OFFICE_JOURNAL_LIMITS.identityLength)
    || !validString(input.idempotencyKey, OFFICE_JOURNAL_LIMITS.idempotencyKeyLength)) {
    fail('OFFICE_JOURNAL_INVALID_INPUT', 'A bounded user, session and idempotency key is required for a document commit.');
  }
}

function validPath(value: unknown): value is string {
  if (!validString(value, OFFICE_JOURNAL_LIMITS.pathLength) || /[\\:]/u.test(value)) return false;
  const relative = value.startsWith('/') ? value.slice(1) : value;
  return relative.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function validRevision(value: unknown): value is string | null {
  return value === null || validString(value, OFFICE_JOURNAL_LIMITS.identityLength);
}

function commitId(input: Pick<OfficeCommitIdentity, 'workspaceId' | 'lineageId' | 'actorSessionId' | 'idempotencyKey'>): string {
  // A session/key cannot be reused by changing the user or actor type.
  return digest(JSON.stringify([input.workspaceId, input.lineageId, input.actorSessionId, input.idempotencyKey]));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    fail('OFFICE_JOURNAL_UNSAFE_STORAGE', 'Document history requires private directories owned by the runtime user.');
  }
  // Also finish a previous mkdir/rename whose parent fsync failed before retry.
  await syncDirectory(directory);
  await syncDirectory(path.dirname(directory));
}

async function journalPaths(scope: Scope): Promise<JournalPaths> {
  const configured = resolveCanvasDataRoot();
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  // An intentionally configured DATA symlink (including macOS /var) is resolved
  // once. Every application-owned descendant must itself be a private directory.
  const dataRoot = await fs.realpath(configured);
  let root = dataRoot;
  for (const segment of ['office-documents', digest(scope.workspaceId), digest(scope.lineageId)]) {
    root = path.join(root, segment);
    await ensurePrivateDirectory(root);
  }
  const result = { root, blobs: path.join(root, 'blobs'), commits: path.join(root, 'commits'), pending: path.join(root, 'pending') };
  for (const directory of [result.blobs, result.commits, result.pending]) await ensurePrivateDirectory(directory);
  return result;
}

async function withJournal<T>(scope: Scope, operation: (paths: JournalPaths) => Promise<T>): Promise<T> {
  assertScope(scope);
  const lockKey = `office-journal:${digest(JSON.stringify([scope.workspaceId, scope.lineageId]))}`;
  // A separate lock domain is safe inside the caller's workspace mutation lock
  // and still serializes concurrent sibling calls in that reentrant context.
  return withWorkspaceMutationLock(lockKey, async () => {
    try {
      return await operation(await journalPaths(scope));
    } catch (error) {
      if (error instanceof OfficeJournalError) throw error;
      throw new OfficeJournalError('OFFICE_JOURNAL_UNAVAILABLE', 'Document history could not be durably read or written. Retry the operation.', { cause: error });
    }
  });
}

async function readPrivateFile(filename: string, maximum: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    if (hasCode(error, 'ELOOP')) fail('OFFICE_JOURNAL_UNSAFE_STORAGE', 'Document history must not contain symbolic links.');
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('OFFICE_JOURNAL_UNSAFE_STORAGE', 'Document history requires private, regular files without external links.');
    }
    if (stat.size > maximum) fail('OFFICE_JOURNAL_CORRUPT', 'A document history file exceeds its expected size limit.');
    // readFile() can grow without bound if a compromised writer changes an inode.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) fail('OFFICE_JOURNAL_CORRUPT', 'A document history file changed while being read.');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** The rename is followed by fsync of its parent before success is returned. */
async function atomicPersist(filename: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => { if (!hasCode(error, 'ENOENT')) throw error; });
  }
}

async function syncPersistedFile(filename: string): Promise<void> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
}

function parseRecord(bytes: Buffer, scope: Scope, expectedId: string): OfficeCommitRecord {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
    const record = value as OfficeCommitRecord;
    assertIdentity(record);
    if (record.version !== 1 || record.id !== expectedId || record.id !== commitId(record)
      || record.workspaceId !== scope.workspaceId || record.lineageId !== scope.lineageId
      || !validPath(record.path) || !ACTOR_TYPES.has(record.actorType)
      || !validHash(record.afterHash) || (record.beforeHash !== null && !validHash(record.beforeHash))
      || !validRevision(record.baseRevisionId) || !validRevision(record.revisionId)
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !Number.isSafeInteger(record.afterSizeBytes) || record.afterSizeBytes < 0 || record.afterSizeBytes > OFFICE_JOURNAL_LIMITS.contentBytes
      || (record.beforeHash === null ? record.beforeSizeBytes !== null : !Number.isSafeInteger(record.beforeSizeBytes)
        || record.beforeSizeBytes === null || record.beforeSizeBytes < 0 || record.beforeSizeBytes > OFFICE_JOURNAL_LIMITS.contentBytes)
      || (record.status !== 'prepared' && record.status !== 'completed')
      || (record.status === 'prepared' ? record.revisionId !== null : record.revisionId === null)) throw new Error('Invalid record');
    return Object.freeze(record);
  } catch {
    return fail('OFFICE_JOURNAL_CORRUPT', 'A document commit manifest is invalid or belongs to another identity.');
  }
}

async function readRecord(paths: JournalPaths, scope: Scope, id: string): Promise<OfficeCommitRecord | null> {
  const bytes = await readPrivateFile(path.join(paths.commits, `${id}.json`), OFFICE_JOURNAL_LIMITS.manifestBytes);
  return bytes ? parseRecord(bytes, scope, id) : null;
}

function recordBytes(record: OfficeCommitRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > OFFICE_JOURNAL_LIMITS.manifestBytes) fail('OFFICE_JOURNAL_INVALID_INPUT', 'The document commit metadata exceeds the size limit.');
  return bytes;
}

async function readBlob(paths: JournalPaths, hash: string): Promise<Buffer | null> {
  const bytes = await readPrivateFile(path.join(paths.blobs, `${hash}.docx`), OFFICE_JOURNAL_LIMITS.contentBytes);
  if (bytes && digest(bytes) !== hash) fail('OFFICE_JOURNAL_CORRUPT', 'A saved document version failed its content hash check.');
  return bytes;
}

async function ensureBlob(paths: JournalPaths, hash: string, bytes: Buffer): Promise<void> {
  const existing = await readBlob(paths, hash);
  if (existing) {
    if (!existing.equals(bytes)) fail('OFFICE_JOURNAL_CORRUPT', 'A saved document version does not match its content identity.');
    await syncPersistedFile(path.join(paths.blobs, `${hash}.docx`));
    return;
  }
  await atomicPersist(path.join(paths.blobs, `${hash}.docx`), bytes);
}

async function markPending(paths: JournalPaths, record: OfficeCommitRecord): Promise<void> {
  const filename = path.join(paths.pending, `${record.id}.json`);
  const bytes = Buffer.from(`${record.id}\n`);
  const existing = await readPrivateFile(filename, 65);
  if (existing) {
    if (!existing.equals(bytes)) fail('OFFICE_JOURNAL_CORRUPT', 'A pending document commit marker is invalid.');
    await syncPersistedFile(filename);
  } else {
    await atomicPersist(filename, bytes);
  }
}

function assertSameIdentity(record: OfficeCommitRecord, input: OfficeCommitIdentity): void {
  if (record.workspaceId !== input.workspaceId || record.lineageId !== input.lineageId || record.actorUserId !== input.actorUserId
    || record.actorSessionId !== input.actorSessionId || record.idempotencyKey !== input.idempotencyKey) {
    fail('OFFICE_IDEMPOTENCY_CONFLICT', 'This document commit key is already bound to another identity.');
  }
}

function assertSameCommit(record: OfficeCommitRecord, input: Pick<OfficeCommitRecord, 'path' | 'actorType' | 'beforeHash' | 'afterHash' | 'baseRevisionId' | 'beforeSizeBytes' | 'afterSizeBytes'>): void {
  if (record.path !== input.path || record.actorType !== input.actorType || record.beforeHash !== input.beforeHash
    || record.afterHash !== input.afterHash || record.baseRevisionId !== input.baseRevisionId
    || record.beforeSizeBytes !== input.beforeSizeBytes || record.afterSizeBytes !== input.afterSizeBytes) {
    fail('OFFICE_IDEMPOTENCY_CONFLICT', 'This document commit key is already bound to different content or a different starting revision.');
  }
}

/**
 * Persist both byte snapshots and a prepared receipt BEFORE the canonical rename.
 * The caller authorizes workspace access, validates DOCX and holds the workspace
 * mutation lock across prepare, canonical replacement and revision finalization.
 */
export async function prepareOfficeCommit(input: PrepareOfficeCommitInput): Promise<OfficeCommitRecord> {
  assertIdentity(input);
  if (!validPath(input.path) || !ACTOR_TYPES.has(input.actorType) || !validRevision(input.baseRevisionId)
    || (input.beforeHash !== null && !validHash(input.beforeHash)) || !Buffer.isBuffer(input.content)
    || (input.beforeContent !== null && !Buffer.isBuffer(input.beforeContent))
    || (input.beforeHash === null) !== (input.beforeContent === null)
    || input.content.length > OFFICE_JOURNAL_LIMITS.contentBytes || (input.beforeContent?.length ?? 0) > OFFICE_JOURNAL_LIMITS.contentBytes) {
    fail('OFFICE_JOURNAL_INVALID_INPUT', 'Document commit content, path or starting revision is invalid or exceeds the size limit.');
  }
  // Copy before the first await: caller-owned Buffers must not mutate the receipt.
  const content = Buffer.from(input.content);
  const beforeContent = input.beforeContent === null ? null : Buffer.from(input.beforeContent);
  if (beforeContent && digest(beforeContent) !== input.beforeHash) fail('OFFICE_JOURNAL_INVALID_INPUT', 'The document starting snapshot does not match its supplied hash.');
  const candidate: OfficeCommitRecord = Object.freeze({
    version: 1,
    id: commitId(input),
    workspaceId: input.workspaceId,
    lineageId: input.lineageId,
    path: input.path,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId,
    actorType: input.actorType,
    idempotencyKey: input.idempotencyKey,
    beforeHash: input.beforeHash,
    afterHash: digest(content),
    beforeSizeBytes: beforeContent?.length ?? null,
    afterSizeBytes: content.length,
    baseRevisionId: input.baseRevisionId,
    revisionId: null,
    createdAt: Date.now(),
    status: 'prepared',
  });
  const serialized = recordBytes(candidate);
  return withJournal(candidate, async (paths) => {
    const existing = await readRecord(paths, candidate, candidate.id);
    if (existing) {
      assertSameIdentity(existing, candidate);
      assertSameCommit(existing, candidate);
    }
    if (beforeContent) await ensureBlob(paths, candidate.beforeHash!, beforeContent);
    await ensureBlob(paths, candidate.afterHash, content);
    if (!existing) await atomicPersist(path.join(paths.commits, `${candidate.id}.json`), serialized);
    else await syncPersistedFile(path.join(paths.commits, `${candidate.id}.json`));
    const record = existing ?? candidate;
    if (record.status === 'prepared') await markPending(paths, record);
    return record;
  });
}

export async function findOfficeCommit(input: OfficeCommitIdentity): Promise<OfficeCommitRecord | null> {
  assertIdentity(input);
  return withJournal(input, async (paths) => {
    const record = await readRecord(paths, input, commitId(input));
    if (record) assertSameIdentity(record, input);
    return record;
  });
}

/** Only call after the canonical bytes and the database revision are durable. */
export async function completeOfficeCommit(record: OfficeCommitRecord, revisionId: string): Promise<OfficeCommitRecord> {
  assertIdentity(record);
  if (!validString(revisionId, OFFICE_JOURNAL_LIMITS.identityLength) || record.id !== commitId(record)) fail('OFFICE_JOURNAL_INVALID_INPUT', 'A valid document commit and revision ID is required.');
  return withJournal(record, async (paths) => {
    const current = await readRecord(paths, record, record.id);
    if (!current) fail('OFFICE_JOURNAL_CORRUPT', 'The prepared document commit cannot be found.');
    assertSameIdentity(current, record);
    assertSameCommit(current, record);
    if (current.createdAt !== record.createdAt || (current.status === 'completed' && current.revisionId !== revisionId)) {
      fail('OFFICE_IDEMPOTENCY_CONFLICT', 'The document commit was already finalized with a different revision.');
    }
    const completed: OfficeCommitRecord = current.status === 'completed' ? current : Object.freeze({ ...current, status: 'completed', revisionId });
    if (current.status !== 'completed') await atomicPersist(path.join(paths.commits, `${record.id}.json`), recordBytes(completed));
    else await syncPersistedFile(path.join(paths.commits, `${record.id}.json`));
    // A crash between these steps leaves a harmless stale marker; readers inspect
    // the authoritative manifest and never replay a completed commit.
    try {
      await fs.unlink(path.join(paths.pending, `${record.id}.json`));
      await syncDirectory(paths.pending);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    return completed;
  });
}

async function scanRecords(directory: string, limit: number, visit: (id: string) => Promise<void>): Promise<void> {
  const handle = await fs.opendir(directory);
  let count = 0;
  for await (const entry of handle) {
    if (++count > limit) fail('OFFICE_JOURNAL_SCAN_LIMIT', 'Document history exceeds the bounded scan limit. All saved versions remain preserved.');
    // Incomplete staging files are never authoritative. They can survive a crash.
    if (/^\.tmp-[a-f0-9-]{36}$/u.test(entry.name)) continue;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile()) fail('OFFICE_JOURNAL_UNSAFE_STORAGE', 'Document history contains an unexpected or linked entry.');
    await visit(entry.name.slice(0, -5));
  }
}

export async function listPendingOfficeCommits(scope: Scope): Promise<OfficeCommitRecord[]> {
  return withJournal(scope, async (paths) => {
    const records: OfficeCommitRecord[] = [];
    await scanRecords(paths.pending, OFFICE_JOURNAL_LIMITS.pendingEntries, async (id) => {
      const marker = await readPrivateFile(path.join(paths.pending, `${id}.json`), 65);
      if (!marker?.equals(Buffer.from(`${id}\n`))) fail('OFFICE_JOURNAL_CORRUPT', 'A pending document commit marker is invalid.');
      const record = await readRecord(paths, scope, id);
      if (!record) fail('OFFICE_JOURNAL_CORRUPT', 'A pending document commit has no authoritative manifest.');
      if (record.status === 'prepared') records.push(record);
    });
    return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  });
}

export async function readOfficeVersion(input: Scope & { contentHash: string }): Promise<Buffer> {
  if (!validHash(input.contentHash)) fail('OFFICE_JOURNAL_INVALID_INPUT', 'A valid document version hash is required.');
  return withJournal(input, async (paths) => {
    const bytes = await readBlob(paths, input.contentHash);
    if (!bytes) fail('OFFICE_VERSION_NOT_FOUND', 'The saved document version could not be found.');
    return bytes;
  });
}

/** Distinct byte versions, including the original snapshot and unpublished results. */
export async function listOfficeVersions(workspaceId: string, lineageId: string): Promise<OfficeVersionMetadata[]> {
  const scope = { workspaceId, lineageId };
  return withJournal(scope, async (paths) => {
    const records: OfficeCommitRecord[] = [];
    await scanRecords(paths.commits, OFFICE_JOURNAL_LIMITS.historyEntries, async (id) => {
      const record = await readRecord(paths, scope, id);
      if (!record) fail('OFFICE_JOURNAL_CORRUPT', 'A saved document commit disappeared while reading history.');
      records.push(record);
    });
    records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const versions = new Map<string, OfficeVersionMetadata>();
    for (const record of records) {
      if (record.beforeHash && !versions.has(record.beforeHash)) versions.set(record.beforeHash, {
        contentHash: record.beforeHash,
        sizeBytes: record.beforeSizeBytes!,
        createdAt: record.createdAt,
        revisionId: record.baseRevisionId,
        commitId: record.id,
        status: 'baseline',
        path: record.path,
        actorUserId: null,
        actorSessionId: null,
        actorType: null,
      });
      const existing = versions.get(record.afterHash);
      if (!existing || record.status === 'completed' || existing.status === 'baseline') versions.set(record.afterHash, {
        contentHash: record.afterHash,
        sizeBytes: record.afterSizeBytes,
        createdAt: record.createdAt,
        revisionId: record.revisionId,
        commitId: record.id,
        status: record.status,
        path: record.path,
        actorUserId: record.actorUserId,
        actorSessionId: record.actorSessionId,
        actorType: record.actorType,
      });
    }
    return [...versions.values()].sort((a, b) => b.createdAt - a.createdAt || a.contentHash.localeCompare(b.contentHash));
  });
}
