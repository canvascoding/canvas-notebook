import 'server-only';

import nativeFs, { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import {
  computeWorkspaceFileOperationPlanId,
  type WorkspaceFileOperationPreview,
} from '@/app/lib/markdown/workspace-file-operation-planner';
import { groupWorkspaceLinkWrites } from '@/app/lib/markdown/workspace-link-write-groups';
import { isWorkspaceFileOperationLinkSafe } from '@/app/lib/markdown/workspace-file-operation-link-safety';
import type { WorkspaceLinkWritePreflight } from '@/app/lib/markdown/workspace-link-write-executor';
import { WorkspaceOperationJournal, type WorkspaceOperationRecord } from './workspace-operation-journal';
import { getFdDirectoryInventoryBackend, getFdPathMoveBackend, getFdPublicationBackend } from './fd-publication';
import { NATIVE_RECOVERY_PAYLOAD_LIMIT } from '../collaboration/native-document-recovery';
import { captureNativeCopyStageIdentity, decodeNativeCopyStage, prepareNativeCopyStage, assertNativeCopyStageManifestDigest, NativeCopyStageDataError,
  NATIVE_COPY_STAGE_MANIFEST_LIMIT, type WorkspaceOperationNativeCopyStage,
  type WorkspaceOperationNativeCopyStageIdentity, type WorkspaceOperationNativeCopyStageInput } from './workspace-operation-native-copy-stage';
import { prepareManagedCopyStage, decodeManagedCopyStage, assertManagedCopyStageManifestDigest,
  MANAGED_COPY_SCENE_RECORDS_LIMIT, MANAGED_COPY_SCENE_ASSETS_LIMIT,
  type WorkspaceOperationManagedCopyStageInput, type WorkspaceOperationManagedCopyStageV4 } from './workspace-operation-managed-copy-stage';
export type { WorkspaceOperationNativeCopyStage, WorkspaceOperationNativeCopyStageIdentity,
  WorkspaceOperationNativeCopyStageInput, WorkspaceOperationNativeCopyPhysical } from './workspace-operation-native-copy-stage';
export type { WorkspaceOperationManagedCopyStageInput, WorkspaceOperationManagedCopyStageV4 } from './workspace-operation-managed-copy-stage';

type StoredCopyStage = WorkspaceOperationNativeCopyStage | WorkspaceOperationManagedCopyStageV4;
type PreparedCopyStage = ReturnType<typeof prepareNativeCopyStage> | ReturnType<typeof prepareManagedCopyStage>;
const copyStageFileNames = (managed: boolean): readonly string[] => managed
  ? ['manifest.json', 'native-records.bin', 'scene-assets.bin', 'scene-records.json'] : ['manifest.json', 'native-records.bin'];
function assertCopyStageFormat(value: StoredCopyStage, managed: boolean): void {
  if ((value.version === 4) !== managed) fail('STAGE_CONFLICT', 'Recovery stage requires its original provider format.');
}
function managedPayloadMaximum(manifest: Record<string, unknown>, key: string, maximum: number): number {
  const descriptor = manifest[key];
  const value = descriptor !== null && typeof descriptor === 'object' ? Reflect.get(descriptor, 'sizeBytes') : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('CORRUPT_STAGE', 'Managed payload descriptor exceeds its read budget.');
  }
  return value;
}

const DOCUMENT_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const MANIFEST_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_COUNT_LIMIT = 256;
const DIRECTORY_NAME = 'workspace-operation-staging';

export type WorkspaceOperationOriginalDocument = { workspaceId: string; path: string; content: string };
export type WorkspaceOperationStageIdentity = {
  operationId: string;
  planId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
};
export type WorkspaceOperationStageInput = Omit<WorkspaceOperationStageIdentity, 'planId'> & {
  preview: WorkspaceFileOperationPreview;
  originalDocuments: ReadonlyArray<WorkspaceOperationOriginalDocument>;
  /** Authoritative document identities read before any path mutation. */
  linkPreflight?: WorkspaceLinkWritePreflight | null;
};
type DocumentDescriptor = {
  file: string;
  role: 'before' | 'after';
  workspaceId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
};
type StoredPreview = Omit<WorkspaceFileOperationPreview, 'previewContents'>;
type ManifestPayload = WorkspaceOperationStageIdentity & {
  version: 1;
  preview: StoredPreview;
  documents: DocumentDescriptor[];
  linkPreflight: WorkspaceLinkWritePreflight | null;
};
type Manifest = ManifestPayload & { payloadSha256: string };

export type WorkspaceOperationStage = {
  identity: WorkspaceOperationStageIdentity;
  preview: WorkspaceFileOperationPreview;
  originalDocuments: WorkspaceOperationOriginalDocument[];
  linkPreflight: WorkspaceLinkWritePreflight | null;
  payloadSha256: string;
};

export class WorkspaceOperationStagingError extends Error {
  readonly status = 409;
  constructor(readonly code: 'UNSAFE_STORAGE' | 'CORRUPT_STAGE' | 'STAGE_CONFLICT' | 'STAGE_TOO_LARGE' | 'NOT_COMPLETED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceOperationStagingError';
  }
}

function fail(code: WorkspaceOperationStagingError['code'], message: string): never {
  throw new WorkspaceOperationStagingError(code, message);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertIdentity(identity: WorkspaceOperationStageIdentity): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(identity.operationId)
    || !/^[a-f0-9]{64}$/u.test(identity.planId)
    || !identity.sourceWorkspaceId || !identity.destinationWorkspaceId
    || identity.sourceWorkspaceId.length > 256 || identity.destinationWorkspaceId.length > 256) {
    fail('STAGE_CONFLICT', 'Invalid workspace operation staging identity.');
  }
}

function validPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
    fail('UNSAFE_STORAGE', 'Workspace operation staging requires a private, runtime-owned directory.');
  }
}

async function writePrivateFile(filename: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function readPrivateFile(filename: string, maximum: number): Promise<Buffer> {
  let handle: FileHandle;
  try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (hasCode(error, 'ELOOP')) fail('UNSAFE_STORAGE', 'Workspace operation staging cannot read symbolic links.');
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('UNSAFE_STORAGE', 'Workspace operation staging requires private, unlinked regular files.');
    }
    if (stat.size > maximum) fail('CORRUPT_STAGE', 'Staged file exceeds its maximum size.');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) fail('CORRUPT_STAGE', 'Staged file changed while being read.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function utf8Bytes(content: string): Buffer {
  if (typeof content !== 'string') fail('STAGE_CONFLICT', 'Staged Markdown content must be text.');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > DOCUMENT_LIMIT) fail('STAGE_TOO_LARGE', 'One staged Markdown document exceeds 4 MiB.');
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== content) {
    fail('STAGE_CONFLICT', 'Staged Markdown content is not round-trip UTF-8.');
  }
  return bytes;
}

function decodedUtf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('CORRUPT_STAGE', 'Staged Markdown is not valid UTF-8.'); }
}

function validateCoverage(
  preview: WorkspaceFileOperationPreview,
  originals: ReadonlyArray<WorkspaceOperationOriginalDocument>,
  linkPreflight: WorkspaceLinkWritePreflight | null,
): void {
  if (!preview || !Array.isArray(preview.issues) || !Array.isArray(preview.linkEdits)
    || !Array.isArray(preview.previewContents) || !preview.coverage
    || preview.readiness !== 'ready' || preview.issues.length !== 0 || !isWorkspaceFileOperationLinkSafe(preview)
    || !['rename', 'move', 'copy'].includes(preview.kind)) {
    fail('STAGE_CONFLICT', 'Only link-safe, ready Rename/Move/Copy previews may be staged.');
  }
  if (computeWorkspaceFileOperationPlanId(preview) !== preview.planId) {
    fail('STAGE_CONFLICT', 'Preview body does not match its plan ID.');
  }
  const before = new Map<string, WorkspaceOperationOriginalDocument>();
  const after = new Set<string>();
  for (const document of originals) {
    if (!validPath(document.path) || !document.workspaceId) fail('STAGE_CONFLICT', 'Original Markdown path is invalid.');
    const key = `${document.workspaceId}\0${document.path}`;
    if (before.has(key)) fail('STAGE_CONFLICT', 'Duplicate original Markdown document.');
    utf8Bytes(document.content);
    before.set(key, document);
  }
  for (const document of preview.previewContents) {
    if (!validPath(document.path) || !document.workspaceId) fail('STAGE_CONFLICT', 'Rewritten Markdown path is invalid.');
    const key = `${document.workspaceId}\0${document.path}`;
    if (after.has(key)) fail('STAGE_CONFLICT', 'Duplicate rewritten Markdown document.');
    after.add(key);
    utf8Bytes(document.content);
  }
  const requiredBefore = new Set<string>();
  for (const edit of preview.linkEdits) {
    const beforeKey = `${edit.sourceWorkspaceId}\0${edit.sourcePathBefore}`;
    const afterKey = `${edit.destinationWorkspaceId}\0${edit.sourcePathAfter}`;
    const source = before.get(beforeKey);
    if (!source || digest(utf8Bytes(source.content)) !== edit.expectedContentHash || !after.has(afterKey)) {
      fail('STAGE_CONFLICT', 'Every link edit needs exact original and rewritten Markdown bytes.');
    }
    requiredBefore.add(beforeKey);
  }
  if (requiredBefore.size !== before.size) fail('STAGE_CONFLICT', 'Unrelated original Markdown content cannot be staged.');
  let groups;
  try { groups = groupWorkspaceLinkWrites(preview); }
  catch { return fail('STAGE_CONFLICT', 'Link writes do not form independent Markdown documents.'); }
  if (groups.length > 0 && !linkPreflight) {
    fail('STAGE_CONFLICT', 'Link writes require an authoritative document preflight before path mutation.');
  }
  if (linkPreflight) {
    if (Object.keys(linkPreflight).sort().join(',') !== 'planId,sources'
      || linkPreflight.planId !== preview.planId || !Array.isArray(linkPreflight.sources)
      || linkPreflight.sources.length !== groups.length) {
      fail('STAGE_CONFLICT', 'Document preflight does not match the staged link plan.');
    }
    const sourceFences = new Map<string, WorkspaceLinkWritePreflight['sources'][number]>();
    for (const source of linkPreflight.sources) {
      if (!source || typeof source !== 'object'
        || Object.keys(source).sort().join(',') !== 'beforeSha256,documentId,mode,sourcePathBefore,sourceWorkspaceId'
        || !validPath(source.sourcePathBefore) || !source.sourceWorkspaceId
        || source.sourceWorkspaceId.length > 256
        || !/^[a-f0-9]{64}$/u.test(source.beforeSha256)
        || !((source.mode === 'plain-file' && source.documentId === null)
          || (source.mode === 'active-yjs' && typeof source.documentId === 'string'
            && source.documentId.length >= 1 && source.documentId.length <= 256
            && !/[\x00-\x1f\x7f]/u.test(source.documentId)))) {
        fail('STAGE_CONFLICT', 'Document preflight mode or identity is invalid.');
      }
      const key = `${source.sourceWorkspaceId}\0${source.sourcePathBefore}`;
      if (sourceFences.has(key)) fail('STAGE_CONFLICT', 'Duplicate document preflight source.');
      sourceFences.set(key, source);
    }
    for (const group of groups) {
      const source = sourceFences.get(`${group.sourceWorkspaceId}\0${group.sourcePathBefore}`);
      if (!source || source.beforeSha256 !== group.beforeSha256) {
        fail('STAGE_CONFLICT', 'Document preflight source hash differs from the link plan.');
      }
    }
  }
  for (const group of groups) {
    const source = before.get(`${group.sourceWorkspaceId}\0${group.sourcePathBefore}`);
    if (!source) fail('STAGE_CONFLICT', 'Link write lacks original Markdown.');
    let rewritten = source.content;
    let previousStart = Number.POSITIVE_INFINITY;
    for (const edit of [...group.edits].sort((a, b) => b.targetRange.startUtf16 - a.targetRange.startUtf16)) {
      const range = edit.targetRange;
      if (!Number.isSafeInteger(range.startUtf16) || !Number.isSafeInteger(range.endUtf16)
        || range.startUtf16 < 0 || range.endUtf16 > source.content.length
        || range.endUtf16 <= range.startUtf16 || range.endUtf16 > previousStart
        || range.startUtf8Byte !== Buffer.byteLength(source.content.slice(0, range.startUtf16), 'utf8')
        || range.endUtf8Byte !== Buffer.byteLength(source.content.slice(0, range.endUtf16), 'utf8')
        || source.content.slice(range.startUtf16, range.endUtf16) !== edit.previousTargetLiteral) {
        fail('STAGE_CONFLICT', 'Link edit spans differ from the staged original Markdown.');
      }
      rewritten = `${rewritten.slice(0, range.startUtf16)}${edit.nextTargetLiteral}${rewritten.slice(range.endUtf16)}`;
      previousStart = range.startUtf16;
    }
    if (rewritten !== group.afterContent || digest(rewritten) !== group.afterSha256) {
      fail('STAGE_CONFLICT', 'Rewritten Markdown differs from its planned link edits.');
    }
  }
}

function preparePayload(input: WorkspaceOperationStageInput): { payload: ManifestPayload; bytes: Buffer[] } {
  const identity: WorkspaceOperationStageIdentity = {
    operationId: input.operationId,
    planId: input.preview.planId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    destinationWorkspaceId: input.destinationWorkspaceId,
  };
  assertIdentity(identity);
  const linkPreflight = input.linkPreflight ?? null;
  validateCoverage(input.preview, input.originalDocuments, linkPreflight);
  const { previewContents, ...preview } = input.preview;
  const orderedBefore = [...input.originalDocuments].sort((a, b) =>
    `${a.workspaceId}\0${a.path}` < `${b.workspaceId}\0${b.path}` ? -1 : 1);
  const entries = [
    ...orderedBefore.map((document) => ({ ...document, role: 'before' as const })),
    ...previewContents.map((document) => ({ ...document, role: 'after' as const })),
  ];
  if (entries.length > DOCUMENT_COUNT_LIMIT) fail('STAGE_TOO_LARGE', 'Too many Markdown documents need recovery staging.');
  const bytes = entries.map((entry) => utf8Bytes(entry.content));
  if (bytes.reduce((sum, item) => sum + item.byteLength, 0) > TOTAL_LIMIT) {
    fail('STAGE_TOO_LARGE', 'Recovery staging exceeds the 64 MiB operation limit.');
  }
  const documents = entries.map((entry, index): DocumentDescriptor => ({
    file: `document-${String(index).padStart(6, '0')}.md`,
    role: entry.role,
    workspaceId: entry.workspaceId,
    path: entry.path,
    sizeBytes: bytes[index]!.byteLength,
    sha256: digest(bytes[index]!),
  }));
  const payload: ManifestPayload = { version: 1, ...identity, preview, documents, linkPreflight };
  return { payload, bytes };
}

type NativeDirectoryPin = { fd: number; identity: BigIntStats; name: string; parent?: NativeDirectoryPin; absolute: string };
function nativeCloseAll(fds: number[]): void {
  const failures: unknown[] = [];
  for (const fd of fds) try { nativeFs.closeSync(fd); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Native staging descriptor disposal could not be confirmed.');
}
function nativeStageError(error: unknown): never {
  if (error instanceof WorkspaceOperationStagingError) throw error;
  if (error instanceof NativeCopyStageDataError) throw new WorkspaceOperationStagingError(error.code, error.message, { cause: error });
  throw error;
}
function nativeNode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.birthtimeNs === b.birthtimeNs;
}
function nativePrivate(info: BigIntStats, directory: boolean): void {
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== BigInt(1))
    || info.uid !== BigInt(process.geteuid!()) || (info.mode & BigInt(0o7777)) !== BigInt(directory ? 0o700 : 0o600)) {
    fail('UNSAFE_STORAGE', 'Native copy staging requires exact private owned nodes.');
  }
}
function nativeRoot(directory: string): NativeDirectoryPin {
  const fd = nativeFs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const identity = nativeFs.fstatSync(fd, { bigint: true }); nativePrivate(identity, true);
    const pin = { fd, identity, name: '', absolute: directory }; nativeCheckDirectory(pin); return pin;
  } catch (error) { nativeFs.closeSync(fd); throw error; }
}
function nativeCheckDirectory(pin: NativeDirectoryPin): void {
  const actual = nativeFs.fstatSync(pin.fd, { bigint: true }); nativePrivate(actual, true);
  if (!nativeNode(actual, pin.identity)) fail('UNSAFE_STORAGE', 'Native staging directory changed.');
  if (pin.parent) {
    nativeCheckDirectory(pin.parent);
    const io = getFdPublicationBackend();
    if (!io.hasExactNameAt(pin.parent.fd, pin.name)) fail('UNSAFE_STORAGE', 'Native staging namespace changed.');
    const fd = io.openDirectoryAt(pin.parent.fd, pin.name);
    try { if (!nativeNode(nativeFs.fstatSync(fd, { bigint: true }), pin.identity)) fail('UNSAFE_STORAGE', 'Native staging namespace changed.'); }
    finally { nativeFs.closeSync(fd); }
  } else {
    const named = nativeFs.lstatSync(pin.absolute, { bigint: true });
    if (!nativeNode(named, pin.identity) || named.isSymbolicLink() || nativeFs.realpathSync(pin.absolute) !== pin.absolute) fail('UNSAFE_STORAGE', 'Native staging root changed.');
  }
}
function nativeOpenDirectory(parent: NativeDirectoryPin, name: string): NativeDirectoryPin | null {
  nativeCheckDirectory(parent); let fd: number;
  try { fd = getFdPublicationBackend().openDirectoryAt(parent.fd, name); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; return fail('UNSAFE_STORAGE', 'Native staging operation is not an owned directory.'); }
  try {
    const identity = nativeFs.fstatSync(fd, { bigint: true }); nativePrivate(identity, true);
    const pin = { fd, identity, name, parent, absolute: path.join(parent.absolute, name) }; nativeCheckDirectory(pin); return pin;
  } catch (error) { nativeFs.closeSync(fd); throw error; }
}
async function nativeSync(pin: NativeDirectoryPin): Promise<void> {
  nativeCheckDirectory(pin);
  await new Promise<void>((resolve, reject) => nativeFs.fsync(pin.fd, error => error ? reject(error) : resolve()));
  nativeCheckDirectory(pin);
}
async function nativeReadFile(directory: NativeDirectoryPin, name: string, maximum: number): Promise<Buffer> {
  nativeCheckDirectory(directory);
  const io = getFdPublicationBackend(), fd = io.openFileAt(directory.fd, name, 'readonly');
  try {
    const before = nativeFs.fstatSync(fd, { bigint: true }); nativePrivate(before, false);
    if (before.size > BigInt(maximum)) fail('CORRUPT_STAGE', 'Native staging file exceeds its bound.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let position = 0;
    while (position < bytes.length) {
      const count = await new Promise<number>((resolve, reject) => nativeFs.read(fd, bytes, position,
        Math.min(1024 * 1024, bytes.length - position), position, (error, read) => error ? reject(error) : resolve(read)));
      nativeCheckDirectory(directory); if (!count) break; position += count;
    }
    const after = nativeFs.fstatSync(fd, { bigint: true });
    if (position !== Number(before.size) || !nativeNode(before, after) || before.nlink !== after.nlink || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !io.hasExactNameAt(directory.fd, name)) fail('CORRUPT_STAGE', 'Native staging file changed while read.');
    const named = io.openFileAt(directory.fd, name, 'readonly');
    try { if (!nativeNode(nativeFs.fstatSync(named, { bigint: true }), before)) fail('CORRUPT_STAGE', 'Native staging file changed.'); }
    finally { nativeFs.closeSync(named); }
    return bytes.subarray(0, position);
  } finally { nativeFs.closeSync(fd); }
}
async function nativeWriteFile(directory: NativeDirectoryPin, name: string, bytes: Buffer, born: Map<string, BigIntStats>): Promise<void> {
  nativeCheckDirectory(directory); const fd = getFdPublicationBackend().openFileAt(directory.fd, name, 'private-wx');
  try {
    const identity = nativeFs.fstatSync(fd, { bigint: true }); nativePrivate(identity, false); born.set(name, identity); let position = 0;
    while (position < bytes.length) {
      const count = await new Promise<number>((resolve, reject) => nativeFs.write(fd, bytes, position,
        Math.min(1024 * 1024, bytes.length - position), position, (error, written) => error ? reject(error) : resolve(written)));
      nativeCheckDirectory(directory); if (!count) fail('CORRUPT_STAGE', 'Native staging write did not finish.'); position += count;
    }
    await new Promise<void>((resolve, reject) => nativeFs.fsync(fd, error => error ? reject(error) : resolve())); nativeCheckDirectory(directory);
  } finally { nativeFs.closeSync(fd); }
}
function nativeJson(bytes: Buffer): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CORRUPT_STAGE', 'Native manifest is not an object.');
    return value as Record<string, unknown>;
  } catch { return fail('CORRUPT_STAGE', 'Native manifest is invalid JSON.'); }
}
async function nativeLoad(root: NativeDirectoryPin, identity: WorkspaceOperationNativeCopyStageIdentity, name = identity.operationId): Promise<StoredCopyStage | null> {
  const directory = nativeOpenDirectory(root, name); if (!directory) return null;
  try {
    const manifest = nativeJson(await nativeReadFile(directory, 'manifest.json', NATIVE_COPY_STAGE_MANIFEST_LIMIT));
    if (manifest.version === 1) fail('STAGE_CONFLICT', 'Operation ID belongs to a legacy stage.');
    const managed = manifest.version === 4;
    if (managed) assertManagedCopyStageManifestDigest(manifest); else assertNativeCopyStageManifestDigest(manifest);
    const actualIdentity = captureNativeCopyStageIdentity(manifest.identity);
    if ((['operationId', 'planId', 'sourceWorkspaceId', 'destinationWorkspaceId', 'kind', 'canonicalRequestHash'] as const)
      .some(key => actualIdentity[key] !== identity[key])) fail('STAGE_CONFLICT', 'Native stage belongs to a different original request.');
    if ([...getFdDirectoryInventoryBackend().listDirectoryAt(directory.fd)].sort().join(',') !== copyStageFileNames(managed).join(',')) fail('CORRUPT_STAGE', 'Native stage contains unexpected files.');
    const bytes = await nativeReadFile(directory, 'native-records.bin', managed
      ? managedPayloadMaximum(manifest, 'records', NATIVE_RECOVERY_PAYLOAD_LIMIT) : NATIVE_RECOVERY_PAYLOAD_LIMIT);
    if (managed) {
      const sceneRecordsBytes = await nativeReadFile(directory, 'scene-records.json', managedPayloadMaximum(manifest, 'sceneRecords', MANAGED_COPY_SCENE_RECORDS_LIMIT));
      const sceneAssetsBytes = await nativeReadFile(directory, 'scene-assets.bin', managedPayloadMaximum(manifest, 'sceneAssets', MANAGED_COPY_SCENE_ASSETS_LIMIT));
      nativeCheckDirectory(directory);
      return decodeManagedCopyStage(manifest, { recordsBytes: bytes, sceneRecordsBytes, sceneAssetsBytes }, identity);
    }
    nativeCheckDirectory(directory); return decodeNativeCopyStage(manifest, bytes, identity);
  } catch (error) { return nativeStageError(error); }
  finally { nativeFs.closeSync(directory.fd); }
}
/** API3 has no rmdir primitive. The private Store's exact directory namespace
 * is checked immediately before named rmdir; this is observational, not CAS. */
async function nativeRemoveDirectory(directory: NativeDirectoryPin, expected?: Map<string, BigIntStats>, managed = false): Promise<void> {
  nativeCheckDirectory(directory); const io = getFdPublicationBackend();
  const names = getFdDirectoryInventoryBackend().listDirectoryAt(directory.fd);
  if (names.some(name => !copyStageFileNames(managed).includes(name))) fail('UNSAFE_STORAGE', 'Unexpected native staging node is retained.');
  for (const name of names) {
    nativeCheckDirectory(directory); const fd = io.openFileAt(directory.fd, name, 'readonly');
    try {
      const info = nativeFs.fstatSync(fd, { bigint: true }); nativePrivate(info, false);
      if (expected && (!expected.has(name) || !nativeNode(info, expected.get(name)!))) fail('UNSAFE_STORAGE', 'Replacement native staging file is retained.');
      io.unlinkFileAt(directory.fd, name, { dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid), mode: 0o600 });
    } finally { nativeFs.closeSync(fd); }
  }
  await nativeSync(directory); nativeCheckDirectory(directory);
  nativeFs.rmdirSync(directory.absolute); await nativeSync(directory.parent!);
}

export class WorkspaceOperationStaging {
  private readonly dataRoot: string;
  private readonly completionLookup: (operationId: string) => Promise<Pick<WorkspaceOperationRecord,
    'operationId' | 'planId' | 'sourceWorkspaceId' | 'destinationWorkspaceId' | 'status'> & Partial<Pick<WorkspaceOperationRecord, 'requestHash'>> | null>;

  constructor(options: {
    dataRoot?: string;
    completionLookup?: (operationId: string) => Promise<Pick<WorkspaceOperationRecord,
      'operationId' | 'planId' | 'sourceWorkspaceId' | 'destinationWorkspaceId' | 'status'> & Partial<Pick<WorkspaceOperationRecord, 'requestHash'>> | null>;
  } = {}) {
    this.dataRoot = options.dataRoot ?? resolveCanvasDataRoot();
    this.completionLookup = options.completionLookup ?? (async (operationId) => new WorkspaceOperationJournal().get(operationId));
  }

  private async root(): Promise<string> {
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    // A configured DATA symlink may be intentional; all descendants are ours.
    const configured = await fs.realpath(this.dataRoot);
    const root = path.join(configured, DIRECTORY_NAME);
    await ensurePrivateDirectory(root);
    await syncDirectory(root);
    await syncDirectory(configured);
    return root;
  }

  async stage(input: WorkspaceOperationStageInput): Promise<WorkspaceOperationStage> {
    const { payload, bytes } = preparePayload(input);
    const payloadSha256 = digest(JSON.stringify(payload));
    const manifest: Manifest = { ...payload, payloadSha256 };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (manifestBytes.byteLength > MANIFEST_LIMIT) fail('STAGE_TOO_LARGE', 'Recovery manifest exceeds 8 MiB.');
    const identity: WorkspaceOperationStageIdentity = payload;
    const root = await this.root();
    const finalPath = path.join(root, input.operationId);
    const existing = await this.loadIfPresent(identity, root);
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256) fail('STAGE_CONFLICT', 'Operation ID is already staged with a different plan.');
      return existing;
    }
    const temporary = path.join(root, `.tmp-${randomUUID()}`);
    await ensurePrivateDirectory(temporary);
    try {
      for (let index = 0; index < payload.documents.length; index += 1) {
        await writePrivateFile(path.join(temporary, payload.documents[index]!.file), bytes[index]!);
      }
      await writePrivateFile(path.join(temporary, 'manifest.json'), manifestBytes);
      await syncDirectory(temporary);
      try { await fs.rename(temporary, finalPath); }
      catch (error) {
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
        const concurrent = await this.loadIfPresent(identity, root);
        if (!concurrent || concurrent.payloadSha256 !== payloadSha256) {
          fail('STAGE_CONFLICT', 'Concurrent staging published a different operation plan.');
        }
        return concurrent;
      }
      await syncDirectory(root);
      return (await this.loadIfPresent(identity, root))!;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private async loadIfPresent(identity: WorkspaceOperationStageIdentity, root: string): Promise<WorkspaceOperationStage | null> {
    const directory = path.join(root, identity.operationId);
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
      fail('UNSAFE_STORAGE', 'Staging operation directory is not private and runtime-owned.');
    }
    const manifestBytes = await readPrivateFile(path.join(directory, 'manifest.json'), MANIFEST_LIMIT);
    let manifest: Manifest;
    try { manifest = JSON.parse(decodedUtf8(manifestBytes)) as Manifest; }
    catch { return fail('CORRUPT_STAGE', 'Staged manifest is not valid JSON.'); }
    if (!manifest || manifest.version !== 1 || manifest.operationId !== identity.operationId
      || manifest.planId !== identity.planId || manifest.sourceWorkspaceId !== identity.sourceWorkspaceId
      || manifest.destinationWorkspaceId !== identity.destinationWorkspaceId
      || !Array.isArray(manifest.documents) || manifest.documents.length > DOCUMENT_COUNT_LIMIT
      || !manifest.preview || manifest.preview.planId !== identity.planId
      || (manifest.linkPreflight !== null && (!manifest.linkPreflight || typeof manifest.linkPreflight !== 'object'))
      || !/^[a-f0-9]{64}$/u.test(manifest.payloadSha256)) {
      fail('CORRUPT_STAGE', 'Staged manifest identity or structure is invalid.');
    }
    const { payloadSha256, ...payload } = manifest;
    if (digest(JSON.stringify(payload)) !== payloadSha256) fail('CORRUPT_STAGE', 'Staged manifest hash differs.');
    let total = 0;
    const originals: WorkspaceOperationOriginalDocument[] = [];
    const rewritten: WorkspaceFileOperationPreview['previewContents'] = [];
    for (let index = 0; index < manifest.documents.length; index += 1) {
      const descriptor = manifest.documents[index]!;
      if (!descriptor || typeof descriptor !== 'object'
        || descriptor.file !== `document-${String(index).padStart(6, '0')}.md`
        || !['before', 'after'].includes(descriptor.role) || !validPath(descriptor.path)
        || !descriptor.workspaceId || !Number.isSafeInteger(descriptor.sizeBytes)
        || descriptor.sizeBytes < 0 || descriptor.sizeBytes > DOCUMENT_LIMIT
        || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)) {
        fail('CORRUPT_STAGE', 'Staged document descriptor is invalid.');
      }
      total += descriptor.sizeBytes;
      if (total > TOTAL_LIMIT) fail('CORRUPT_STAGE', 'Staged Markdown exceeds the operation limit.');
      const documentBytes = await readPrivateFile(path.join(directory, descriptor.file), DOCUMENT_LIMIT);
      if (documentBytes.byteLength !== descriptor.sizeBytes || digest(documentBytes) !== descriptor.sha256) {
        fail('CORRUPT_STAGE', 'Staged Markdown content hash differs.');
      }
      const document = { workspaceId: descriptor.workspaceId, path: descriptor.path, content: decodedUtf8(documentBytes) };
      if (descriptor.role === 'before') originals.push(document);
      else rewritten.push(document);
    }
    const preview = { ...manifest.preview, previewContents: rewritten } as WorkspaceFileOperationPreview;
    try { validateCoverage(preview, originals, manifest.linkPreflight); }
    catch (error) {
      if (error instanceof WorkspaceOperationStagingError) {
        fail('CORRUPT_STAGE', 'Staged plan no longer matches its original and rewritten Markdown.');
      }
      throw error;
    }
    return { identity, preview, originalDocuments: originals, linkPreflight: manifest.linkPreflight, payloadSha256 };
  }

  async load(identity: WorkspaceOperationStageIdentity): Promise<WorkspaceOperationStage> {
    assertIdentity(identity);
    const result = await this.loadIfPresent(identity, await this.root());
    if (!result) fail('CORRUPT_STAGE', 'Recovery stage is missing.');
    return result;
  }

  async removeCompleted(identity: WorkspaceOperationStageIdentity): Promise<void> {
    assertIdentity(identity);
    const operation = await this.completionLookup(identity.operationId);
    if (!operation || operation.status !== 'completed' || operation.planId !== identity.planId
      || operation.sourceWorkspaceId !== identity.sourceWorkspaceId
      || operation.destinationWorkspaceId !== identity.destinationWorkspaceId) {
      fail('NOT_COMPLETED', 'Recovery stage can only be deleted after durable operation completion.');
    }
    const root = await this.root();
    const retiringPrefix = `.completed-${identity.operationId}-`;
    for (const name of await fs.readdir(root)) {
      if (!name.startsWith(retiringPrefix)) continue;
      const suffix = name.slice(retiringPrefix.length);
      if (!/^[a-f0-9-]{36}$/u.test(suffix)) continue;
      const retired = path.join(root, name);
      let stat;
      try { stat = await fs.lstat(retired); }
      catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()) {
        fail('UNSAFE_STORAGE', 'Retired staging operation is not a private directory.');
      }
      await fs.rm(retired, { recursive: true, force: true });
    }
    const staged = await this.loadIfPresent(identity, root);
    if (!staged) { await syncDirectory(root); return; }
    const directory = path.join(root, identity.operationId);
    const retiring = path.join(root, `.completed-${identity.operationId}-${randomUUID()}`);
    // The durable completed receipt has been checked above. Rename hides the
    // complete stage atomically, so a crash during cleanup never exposes a
    // half-deleted recovery bundle under the operation ID.
    try { await fs.rename(directory, retiring); }
    catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
    await syncDirectory(root);
    await fs.rm(retiring, { recursive: true, force: true });
    await syncDirectory(root);
  }
  /** Private immutable native branch of the existing operation recovery store.
   * Original intent capture completes synchronously before any storage await. */
  async stageNativeCopy(input: WorkspaceOperationNativeCopyStageInput): Promise<WorkspaceOperationNativeCopyStage> {
    try {
      const result = await this.stagePreparedCopy(prepareNativeCopyStage(input));
      if (result.version === 4) fail('STAGE_CONFLICT', 'Managed stage cannot replace a historical native stage.');
      return result;
    } catch (error) { return nativeStageError(error); }
  }

  async stageManagedCopy(input: WorkspaceOperationManagedCopyStageInput): Promise<WorkspaceOperationManagedCopyStageV4> {
    try {
      const result = await this.stagePreparedCopy(prepareManagedCopyStage(input));
      if (result.version !== 4) fail('STAGE_CONFLICT', 'Managed stage requires its original provider format.');
      return result;
    } catch (error) { return nativeStageError(error); }
  }

  private async stagePreparedCopy(prepared: PreparedCopyStage): Promise<StoredCopyStage> {
    try {
      const identity = prepared.manifest.identity, managed = prepared.manifest.version === 4;
      const root = nativeRoot(await this.root()); let temporary: NativeDirectoryPin | null = null;
      const born = new Map<string, BigIntStats>();
      try {
        const existing = await nativeLoad(root, identity);
        if (existing) {
          assertCopyStageFormat(existing, managed);
          if (existing.payloadSha256 !== prepared.manifest.payloadSha256) fail('STAGE_CONFLICT', 'Native operation ID already has a different original.');
          return existing;
        }
        const name = `.native-tmp-${randomUUID()}`;
        getFdPublicationBackend().mkdirAt(root.fd, name, 0o700);
        temporary = nativeOpenDirectory(root, name);
        if (!temporary) fail('UNSAFE_STORAGE', 'Native staging birth could not be confirmed.');
        await nativeWriteFile(temporary, 'native-records.bin', prepared.recordsBytes, born);
        if ('sceneRecordsBytes' in prepared) {
          await nativeWriteFile(temporary, 'scene-records.json', prepared.sceneRecordsBytes, born);
          await nativeWriteFile(temporary, 'scene-assets.bin', prepared.sceneAssetsBytes, born);
        }
        await nativeWriteFile(temporary, 'manifest.json', prepared.manifestBytes, born);
        await nativeSync(temporary); nativeCheckDirectory(root); nativeCheckDirectory(temporary);
        try { getFdPathMoveBackend().renameNoReplaceAt(root.fd, name, root.fd, identity.operationId); }
        catch (error) {
          if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
          const concurrent = await nativeLoad(root, identity);
          if (!concurrent || concurrent.payloadSha256 !== prepared.manifest.payloadSha256) fail('STAGE_CONFLICT', 'Concurrent native staging has a different original.');
          assertCopyStageFormat(concurrent, managed);
          return concurrent;
        }
        // The original temporary name is gone. Do not use its old named pin
        // after the exclusive rename; the directory FD still closes below.
        await nativeSync(root);
        const result = await nativeLoad(root, identity);
        if (!result || result.payloadSha256 !== prepared.manifest.payloadSha256) fail('CORRUPT_STAGE', 'Published native stage differs.');
        assertCopyStageFormat(result, managed);
        return result;
      } finally {
        try {
          if (temporary) {
            const named = nativeOpenDirectory(root, temporary.name);
            if (named) {
              try {
                if (!nativeNode(named.identity, temporary.identity)) fail('UNSAFE_STORAGE', 'Foreign temporary staging is retained.');
                await nativeRemoveDirectory(named, born, managed);
              } finally { nativeFs.closeSync(named.fd); }
            }
          }
        } finally { nativeCloseAll(temporary ? [temporary.fd, root.fd] : [root.fd]); }
      }
    } catch (error) { return nativeStageError(error); }
  }

  async loadNativeCopy(input: WorkspaceOperationNativeCopyStageIdentity): Promise<WorkspaceOperationNativeCopyStage> {
    const result = await this.loadStoredCopy(input, false);
    if (result.version === 4) fail('STAGE_CONFLICT', 'Managed stage requires its original provider format.');
    return result;
  }

  async loadManagedCopy(input: WorkspaceOperationNativeCopyStageIdentity): Promise<WorkspaceOperationManagedCopyStageV4> {
    const result = await this.loadStoredCopy(input, true);
    if (result.version !== 4) fail('STAGE_CONFLICT', 'Managed stage requires its original provider format.');
    return result;
  }

  private async loadStoredCopy(input: WorkspaceOperationNativeCopyStageIdentity, managed: boolean): Promise<StoredCopyStage> {
    try {
      const identity = captureNativeCopyStageIdentity(input), root = nativeRoot(await this.root());
      try {
        const result = await nativeLoad(root, identity);
        if (!result) fail('CORRUPT_STAGE', 'Native recovery stage is missing.');
        assertCopyStageFormat(result, managed); return result;
      } finally { nativeFs.closeSync(root.fd); }
    } catch (error) { return nativeStageError(error); }
  }

  /** Original private stage recovery even when no journal header committed.
   * This reads immutable data; current C2/principal/plan admission belongs to
   * the fixed owner and no identity or new destination is synthesized here. */
  async loadNativeCopyByOperationId(operationId: string): Promise<WorkspaceOperationNativeCopyStage | null> {
    const result = await this.loadStoredCopyByOperationId(operationId, false);
    if (result?.version === 4) fail('STAGE_CONFLICT', 'Managed stage requires its original provider format.');
    return result;
  }

  async loadManagedCopyByOperationId(operationId: string): Promise<WorkspaceOperationManagedCopyStageV4 | null> {
    const result = await this.loadStoredCopyByOperationId(operationId, true);
    if (result && result.version !== 4) fail('STAGE_CONFLICT', 'Managed stage requires its original provider format.');
    return result;
  }

  /** One manifest-version routing read for the fixed owner. This returns
   * original data only; strict provider-specific APIs remain unchanged. */
  async loadOwnedCopyByOperationId(operationId: string): Promise<StoredCopyStage | null> {
    return this.loadStoredCopyByOperationId(operationId);
  }

  private async loadStoredCopyByOperationId(operationId: string, managed?: boolean): Promise<StoredCopyStage | null> {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(operationId)) fail('STAGE_CONFLICT', 'Invalid operation ID.');
    const captured = operationId, root = nativeRoot(await this.root());
    try {
      const directory = nativeOpenDirectory(root, captured); if (!directory) return null;
      try {
        const manifest = nativeJson(await nativeReadFile(directory, 'manifest.json', NATIVE_COPY_STAGE_MANIFEST_LIMIT));
        if (manifest.version === 1) fail('STAGE_CONFLICT', 'Operation ID belongs to a legacy stage.');
        if (manifest.version !== 2 && manifest.version !== 3 && manifest.version !== 4 || manifest.kind !== 'native-copy') fail('CORRUPT_STAGE', 'Unknown native recovery stage.');
        if (managed !== undefined && (manifest.version === 4) !== managed) fail('STAGE_CONFLICT', 'Recovery stage requires its original provider format.');
        const identity = captureNativeCopyStageIdentity(manifest.identity);
        if (identity.operationId !== captured) fail('CORRUPT_STAGE', 'Native stage operation identity differs.');
        nativeCheckDirectory(directory);
        const original = await nativeLoad(root, identity);
        if (!original) fail('CORRUPT_STAGE', 'Original native stage disappeared during recovery.');
        if (managed !== undefined) assertCopyStageFormat(original, managed);
        // Keep the first manifest's actual directory pin throughout nativeLoad;
        // an identical-byte replacement directory must not be silently adopted.
        nativeCheckDirectory(directory); return original;
      } finally { nativeFs.closeSync(directory.fd); }
    } catch (error) { return nativeStageError(error); }
    finally { nativeFs.closeSync(root.fd); }
  }

  /** Dispatch only. Corrupt/unrecognized manifests never fall through to V1. */
  async readKind(operationId: string): Promise<'native-copy' | 'legacy' | null> {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(operationId)) fail('STAGE_CONFLICT', 'Invalid operation ID.');
    const captured = operationId, root = nativeRoot(await this.root());
    try {
      const directory = nativeOpenDirectory(root, captured); if (!directory) return null;
      try {
        const manifest = nativeJson(await nativeReadFile(directory, 'manifest.json', NATIVE_COPY_STAGE_MANIFEST_LIMIT));
        if ((manifest.version === 2 || manifest.version === 3 || manifest.version === 4) && manifest.kind === 'native-copy') {
          const identity = captureNativeCopyStageIdentity(manifest.identity);
          if (identity.operationId !== captured) fail('CORRUPT_STAGE', 'Native stage identity differs.');
          if (manifest.version === 4) assertManagedCopyStageManifestDigest(manifest); else assertNativeCopyStageManifestDigest(manifest);
          return 'native-copy';
        }
        const keys = ['version', 'operationId', 'planId', 'sourceWorkspaceId', 'destinationWorkspaceId', 'preview', 'documents', 'linkPreflight', 'payloadSha256'];
        if (manifest.version !== 1 || manifest.operationId !== captured || Object.keys(manifest).length !== keys.length
          || keys.some(key => !Object.hasOwn(manifest, key)) || !manifest.preview || !Array.isArray(manifest.documents)) fail('CORRUPT_STAGE', 'Unknown stage format.');
        const { payloadSha256, ...body } = manifest;
        if (digest(JSON.stringify(body)) !== payloadSha256) fail('CORRUPT_STAGE', 'Legacy stage manifest hash differs.');
        return 'legacy';
      } catch (error) { return nativeStageError(error); }
      finally { nativeFs.closeSync(directory.fd); }
    } finally { nativeFs.closeSync(root.fd); }
  }

  async removeCompletedNativeCopy(input: WorkspaceOperationNativeCopyStageIdentity): Promise<void> {
    return this.removeCompletedCopy(input, false);
  }

  async removeCompletedManagedCopy(input: WorkspaceOperationNativeCopyStageIdentity): Promise<void> {
    return this.removeCompletedCopy(input, true);
  }

  private async removeCompletedCopy(input: WorkspaceOperationNativeCopyStageIdentity, managed: boolean): Promise<void> {
    try {
      const identity = captureNativeCopyStageIdentity(input), operation = await this.completionLookup(identity.operationId);
      if (!operation || operation.operationId !== identity.operationId || operation.status !== 'completed' || operation.planId !== identity.planId
        || operation.requestHash !== identity.canonicalRequestHash || operation.sourceWorkspaceId !== identity.sourceWorkspaceId
        || operation.destinationWorkspaceId !== identity.destinationWorkspaceId) fail('NOT_COMPLETED', 'Native recovery retirement requires its exact durable completed journal.');
      const root = nativeRoot(await this.root());
      try {
        const prefix = `.native-completed-${identity.operationId}-`;
        for (const name of getFdDirectoryInventoryBackend().listDirectoryAt(root.fd)) {
          if (!name.startsWith(prefix) || !/^[a-f0-9-]{36}$/u.test(name.slice(prefix.length))) continue;
          // Original C1/C2 and every native binary are checked before deleting
          // even a previously retired private directory after a restart.
          const original = await nativeLoad(root, identity, name);
          if (!original) fail('CORRUPT_STAGE', 'Retired recovery stage disappeared.');
          assertCopyStageFormat(original, managed);
          const retired = nativeOpenDirectory(root, name);
          if (retired) try { await nativeRemoveDirectory(retired, undefined, managed); } finally { nativeFs.closeSync(retired.fd); }
        }
        const original = await nativeLoad(root, identity);
        if (!original) { await nativeSync(root); return; }
        assertCopyStageFormat(original, managed);
        const directory = nativeOpenDirectory(root, identity.operationId);
        if (!directory) fail('CORRUPT_STAGE', 'Native stage disappeared before retirement.');
        try {
          nativeCheckDirectory(directory);
          const name = prefix + randomUUID();
          getFdPathMoveBackend().renameNoReplaceAt(root.fd, identity.operationId, root.fd, name); await nativeSync(root);
          const retiring = nativeOpenDirectory(root, name);
          if (!retiring) fail('CORRUPT_STAGE', 'Retired native stage disappeared.');
          try {
            if (!nativeNode(retiring.identity, directory.identity)) fail('UNSAFE_STORAGE', 'Foreign retired native stage is retained.');
            await nativeRemoveDirectory(retiring, undefined, managed);
          } finally { nativeFs.closeSync(retiring.fd); }
        } finally { nativeFs.closeSync(directory.fd); }
      } finally { nativeFs.closeSync(root.fd); }
    } catch (error) { return nativeStageError(error); }
  }

}
