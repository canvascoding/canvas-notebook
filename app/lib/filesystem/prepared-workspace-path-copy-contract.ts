import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import path from 'node:path';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceOperationJobScope } from '../files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from '../files/workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import type { PreparedPathMoveIdentity } from './prepared-workspace-path-move-contract';

export type PreparedPathCopyIdentity = PreparedPathMoveIdentity;
export type PreparedPathCopyBudget = Readonly<{ maxDepth: number; maxEntries: number; maxHashBytes: number }>;
export const PREPARED_PATH_COPY_LIMITS: PreparedPathCopyBudget = Object.freeze({ maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 });
export type PreparedPathCopyDirectory = Readonly<{ relativePath: string; identity: PreparedPathCopyIdentity }>;
export type PreparedPathCopyParents = Readonly<{ directories: readonly PreparedPathCopyDirectory[]; missingPrefix: string | null }>;
export type PreparedPathCopyEntry = Readonly<{ relativePath: string; kind: 'directory'; identity: PreparedPathCopyIdentity }>
  | Readonly<{ relativePath: string; kind: 'projection_file'; identity: PreparedPathCopyIdentity }>
  | Readonly<{ relativePath: string; kind: 'regular_file'; identity: PreparedPathCopyIdentity; sha256: string }>;
export type PreparedPathCopySource = Readonly<{ kind: 'regular_file'; identity: PreparedPathCopyIdentity; sha256: string }>
  | Readonly<{ kind: 'projection_file'; identity: PreparedPathCopyIdentity }>
  | Readonly<{ kind: 'directory'; entries: readonly PreparedPathCopyEntry[] }>
  | Readonly<{ kind: 'projection_absent' }>;
export type PreparedPathCopyPayload = Readonly<{ kind: 'regular_file'; identity: PreparedPathCopyIdentity; sha256: string }>
  | Readonly<{ kind: 'directory'; entries: readonly Exclude<PreparedPathCopyEntry, { kind: 'projection_file' }>[] }>;
export type PreparedPathCopyRoot = Readonly<{ resolvedPath: string; identity: PreparedPathCopyIdentity }>;
/** Mechanical original observations only. Journal provenance, current actor,
 * native projection membership and SQL/namespace admission belong to the owner. */
export type PreparedWorkspacePathCopyOriginalV1 = Readonly<{
  version: 1; sourceWorkspace: WorkspaceOperationJobScope; destinationWorkspace: WorkspaceOperationJobScope;
  sourcePath: string; destinationPath: string; budget: PreparedPathCopyBudget; projectionPaths: readonly string[];
  filesystem: Readonly<{ sourceRoot: PreparedPathCopyRoot; destinationRoot: PreparedPathCopyRoot;
    sourceParents: PreparedPathCopyParents; destinationParents: PreparedPathCopyParents }>;
  source: PreparedPathCopySource;
  staging: Readonly<{ relativePath: string; identity: PreparedPathCopyIdentity; payload: PreparedPathCopyPayload }> | null;
}>;
/** Only exact owner-bound native projection leaves are replaceable. Their
 * original observations remain part of the immutable mechanical proof. */
export type PreparedWorkspacePathCopyOriginalV2 = Readonly<Omit<PreparedWorkspacePathCopyOriginalV1, 'version'> & {
  version: 2; sourceProjectionPolicy: 'native-derived-leaves-v2';
}>;
export type PreparedPathCopyDerivedFile = Readonly<{
  path: string; provider: 'excalidraw'; documentId: string; lineageId: string;
  lifecycleGeneration: number; sourceContentProof: string; sizeBytes: number; sha256: string;
}>;
export type PreparedPathCopyDerivedFileInput = Readonly<Omit<PreparedPathCopyDerivedFile, 'sizeBytes' | 'sha256'> & { bytes: Uint8Array }>;
/** Provider bytes are captured by the caller's authority reader. Physical Scene
 * projections are observations only, never the source of these payload bytes. */
export type PreparedWorkspacePathCopyOriginalV3 = Readonly<Omit<PreparedWorkspacePathCopyOriginalV1, 'version'> & {
  version: 3; sourceProjectionPolicy: 'provider-derived-files-v3'; derivedFiles: readonly PreparedPathCopyDerivedFile[];
}>;
export type PreparedWorkspacePathCopyOriginal = PreparedWorkspacePathCopyOriginalV1 | PreparedWorkspacePathCopyOriginalV2 | PreparedWorkspacePathCopyOriginalV3;
export type PreparedWorkspacePathCopyParentReceipt = Readonly<{ version: 1; originalProof: string;
  relativePath: string; identity: PreparedPathCopyIdentity }>;
export type PreparedWorkspacePathCopyReceipt = Readonly<{ version: 1; original: PreparedWorkspacePathCopyOriginal;
  createdParents: readonly PreparedWorkspacePathCopyParentReceipt[];
  observation: Readonly<{ kind: 'published'; method: 'rename-no-replace'; copy: PreparedPathCopyPayload }>
    | Readonly<{ kind: 'projection_absent' }> }>;
/** Mechanical original data only. The fixed owner must first verify the
 * producer's immutable original journal, durable path receipt and parent ACK. */
export type PreparedWorkspacePathCopySharedParent = Readonly<{
  producerOriginal: PreparedWorkspacePathCopyOriginal;
  producerReceipt: PreparedWorkspacePathCopyReceipt;
  parentReceipt: PreparedWorkspacePathCopyParentReceipt;
}>;
type PreparedWorkspacePathCopyLegacyInput = Readonly<{
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext; sourcePath: string; destinationPath: string;
  sourceKind: 'regular_file' | 'directory' | 'projection_absent'; budget?: PreparedPathCopyBudget;
  /** Exact owner-proven native paths, never globs, extensions or a permission. */
  projectionPaths?: readonly string[];
  sourceProjectionPolicy?: 'native-derived-leaves-v2';
}>;
export type PreparedWorkspacePathCopyInputV3 = Readonly<Omit<PreparedWorkspacePathCopyLegacyInput, 'sourceProjectionPolicy'> & {
  sourceProjectionPolicy: 'provider-derived-files-v3'; derivedFiles: readonly PreparedPathCopyDerivedFileInput[];
}>;
export type PreparedWorkspacePathCopyInput = PreparedWorkspacePathCopyLegacyInput | PreparedWorkspacePathCopyInputV3;
export type CapturedPathCopyRequest = Readonly<{
  sourceWorkspace: WorkspaceOperationJobScope; destinationWorkspace: WorkspaceOperationJobScope;
  sourcePath: string; destinationPath: string; sourceKind: PreparedWorkspacePathCopyInput['sourceKind'];
  budget: PreparedPathCopyBudget; projectionPaths: readonly string[];
  sourceProjectionPolicy?: 'native-derived-leaves-v2' | 'provider-derived-files-v3';
  derivedFiles?: readonly PreparedPathCopyDerivedFile[];
}>;
export type RecoveredWorkspacePathCopyInput = Readonly<{
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext; original: PreparedWorkspacePathCopyOriginal;
  createdParents?: readonly PreparedWorkspacePathCopyParentReceipt[];
  sharedParents?: readonly PreparedWorkspacePathCopySharedParent[];
}>;
export type PreparedPathCopyErrorCode = 'invalid-input' | 'invalid-lifetime' | 'reentrant-operation' | 'already-published'
  | 'scope-changed' | 'unsafe-path' | 'source-changed' | 'staging-changed' | 'destination-occupied' | 'budget-exceeded'
  | 'parent-journal-required' | 'parent-create-unconfirmed' | 'unawaited-operation' | 'cross-device-copy'
  | 'publication-unconfirmed' | 'recovery-conflict' | 'cleanup-unconfirmed' | 'disposal-unconfirmed';
export class PreparedWorkspacePathCopyError extends Error {
  readonly status: 503 | undefined;
  constructor(readonly code: PreparedPathCopyErrorCode, readonly mutationAttempted = false, options?: ErrorOptions) {
    super('The prepared copy could not be confirmed.', options); this.name = 'PreparedWorkspacePathCopyError';
    this.status = ['cleanup-unconfirmed', 'disposal-unconfirmed'].includes(code) ? 503 : undefined;
  }
}
export function copyFailure(code: PreparedPathCopyErrorCode): never { throw new PreparedWorkspacePathCopyError(code); }
export function freezeCopyData<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeCopyData(child); Object.freeze(value); }
  return value;
}
export function copyData(value: unknown, key: string, optional = false): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) copyFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor && optional) return undefined;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) copyFailure('invalid-input');
  return descriptor.value;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) copyFailure('invalid-input');
  for (const key of keys) copyData(value, key);
  return value as Record<string, unknown>;
}
export function copyPath(value: unknown): string {
  if (!isCanonicalWorkspacePath(value) || Buffer.byteLength(value) > 4096 || value.split('/').length > 33
    || value.split('/').some(part => Buffer.byteLength(part) > 255 || Buffer.from(part).toString('utf8') !== part)) copyFailure('invalid-input');
  return value;
}
function budget(value: unknown): PreparedPathCopyBudget {
  if (value === undefined) return PREPARED_PATH_COPY_LIMITS;
  const data = record(value, ['maxDepth', 'maxEntries', 'maxHashBytes']);
  for (const [key, minimum] of [['maxDepth', 0], ['maxEntries', 1], ['maxHashBytes', 0]] as const) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < minimum || (data[key] as number) > PREPARED_PATH_COPY_LIMITS[key]) copyFailure('invalid-input');
  }
  return freezeCopyData({ maxDepth: data.maxDepth as number, maxEntries: data.maxEntries as number, maxHashBytes: data.maxHashBytes as number });
}
function projections(value: unknown, sourcePath: string, kind: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const input = captureWorkspaceOperationNativePlanData(value, () => copyFailure('invalid-input'));
  if (!Array.isArray(input) || input.length > PREPARED_PATH_COPY_LIMITS.maxEntries) copyFailure('invalid-input');
  const paths = input.map(copyPath);
  if (new Set(paths).size !== paths.length || paths.some(p => p !== sourcePath && (!p.startsWith(sourcePath + '/') || kind === 'regular_file'))) copyFailure('invalid-input');
  return Object.freeze(paths.sort());
}
const derivedByteCopies = new WeakMap<CapturedPathCopyRequest, readonly Uint8Array[]>();
const maxDerivedFileBytes = 50 * 1024 ** 2, maxDerivedTotalBytes = 128 * 1024 ** 2;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
function derivedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (types.isProxy(value)) copyFailure('invalid-input');
  return record(value, keys);
}
function derivedIdentity(value: Record<string, unknown>, sourcePath: string, sourceKind: string): Omit<PreparedPathCopyDerivedFile, 'sizeBytes' | 'sha256'> {
  const pathname = copyPath(value.path);
  if (value.provider !== 'excalidraw' || !pathname.toLowerCase().endsWith('.excalidraw')
    || path.posix.basename(pathname).toLowerCase() === '.excalidraw'
    || pathname !== sourcePath && (!pathname.startsWith(sourcePath + '/') || sourceKind === 'regular_file')
    || pathname === sourcePath && sourceKind === 'directory') copyFailure('invalid-input');
  for (const key of ['documentId', 'lineageId'] as const) if (typeof value[key] !== 'string' || !value[key]
    || Buffer.byteLength(value[key] as string) > 256 || /[\u0000-\u001f\u007f]/u.test(value[key] as string)
    || Buffer.from(value[key] as string).toString('utf8') !== value[key]) copyFailure('invalid-input');
  if (!Number.isSafeInteger(value.lifecycleGeneration) || (value.lifecycleGeneration as number) < 1
    || typeof value.sourceContentProof !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceContentProof)) copyFailure('invalid-input');
  return { path: pathname, provider: 'excalidraw', documentId: value.documentId as string, lineageId: value.lineageId as string,
    lifecycleGeneration: value.lifecycleGeneration as number, sourceContentProof: value.sourceContentProof };
}
function derivedArray(value: unknown, limit: PreparedPathCopyBudget): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit.maxEntries
    || Reflect.ownKeys(value).length !== value.length + 1) copyFailure('invalid-input');
  const captured: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) copyFailure('invalid-input');
    captured.push(descriptor.value);
  }
  return captured;
}
function validateDerivedSet(files: readonly PreparedPathCopyDerivedFile[], projections: readonly string[]): void {
  const paths = [...projections, ...files.map(file => file.path)];
  if (new Set(paths).size !== paths.length || new Set(files.map(file => file.documentId)).size !== files.length
    || new Set(files.map(file => file.lineageId)).size !== files.length) copyFailure('invalid-input');
  const leaves = new Set(paths);
  if (paths.some(pathname => pathname.split('/').slice(0, -1).some((_, index, parts) => leaves.has(parts.slice(0, index + 1).join('/'))))) copyFailure('invalid-input');
}
function captureDerivedInputs(value: unknown, sourcePath: string, sourceKind: string, limit: PreparedPathCopyBudget,
  projections: readonly string[]): { files: readonly PreparedPathCopyDerivedFile[]; bytes: readonly Uint8Array[] } {
  let total = 0;
  // Inspect every descriptor and byte length before allocating any byte copy.
  const pending = derivedArray(value, limit).map(raw => {
    const item = derivedRecord(raw, ['path', 'provider', 'documentId', 'lineageId', 'lifecycleGeneration', 'sourceContentProof', 'bytes']);
    const metadata = derivedIdentity(item, sourcePath, sourceKind), bytes = item.bytes;
    if (types.isProxy(bytes) || !types.isUint8Array(bytes)) copyFailure('invalid-input');
    const buffer = typedArrayBuffer.call(bytes) as ArrayBuffer, offset = typedArrayOffset.call(bytes) as number, length = typedArrayLength.call(bytes) as number;
    if (!types.isArrayBuffer(buffer) || !Number.isSafeInteger(length) || length > maxDerivedFileBytes
      || length > limit.maxHashBytes || (total += length) > Math.min(maxDerivedTotalBytes, limit.maxHashBytes)) copyFailure('budget-exceeded');
    return { metadata, buffer, offset, length };
  }).sort((a, b) => a.metadata.path < b.metadata.path ? -1 : a.metadata.path > b.metadata.path ? 1 : 0);
  const files = pending.map(item => ({ ...item.metadata, sizeBytes: item.length, sha256: '' }));
  validateDerivedSet(files, projections);
  const outputNodes = new Set<string>();
  for (const file of files) {
    const relative = file.path === sourcePath ? '' : file.path.slice(sourcePath.length + 1), parts = relative ? relative.split('/') : [];
    if (parts.length > limit.maxDepth) copyFailure('budget-exceeded');
    outputNodes.add(relative);
    for (let depth = 0; depth < parts.length; depth++) outputNodes.add(parts.slice(0, depth).join('/'));
  }
  if (outputNodes.size > limit.maxEntries) copyFailure('budget-exceeded');
  const bytes = pending.map((item, index) => {
    const captured = new Uint8Array(item.length);
    try { Uint8Array.prototype.set.call(captured, new Uint8Array(item.buffer, item.offset, item.length)); }
    catch { return copyFailure('invalid-input'); }
    files[index].sha256 = createHash('sha256').update(captured).digest('hex'); return captured;
  });
  return { files: freezeCopyData(files), bytes };
}
function captureDerivedDescriptors(value: unknown, sourcePath: string, sourceKind: string, limit: PreparedPathCopyBudget,
  projections: readonly string[]): readonly PreparedPathCopyDerivedFile[] {
  let total = 0;
  const files = derivedArray(value, limit).map(raw => {
    const item = derivedRecord(raw, ['path', 'provider', 'documentId', 'lineageId', 'lifecycleGeneration', 'sourceContentProof', 'sizeBytes', 'sha256']);
    const metadata = derivedIdentity(item, sourcePath, sourceKind);
    if (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0 || (item.sizeBytes as number) > maxDerivedFileBytes
      || (total += item.sizeBytes as number) > Math.min(maxDerivedTotalBytes, limit.maxHashBytes)
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) copyFailure('invalid-input');
    return { ...metadata, sizeBytes: item.sizeBytes as number, sha256: item.sha256 };
  });
  if (files.some((file, index) => index > 0 && file.path <= files[index - 1].path)) copyFailure('invalid-input');
  validateDerivedSet(files, projections); return freezeCopyData(files);
}
/** Only the fresh preparation holds captured bytes. Recovery consumes the
 * already durable private payload and cannot synthesize new provider bytes. */
export function readPathCopyDerivedFileBytes(request: CapturedPathCopyRequest, index: number): Uint8Array {
  const bytes = derivedByteCopies.get(request)?.[index];
  if (!bytes || request.sourceProjectionPolicy !== 'provider-derived-files-v3') copyFailure('invalid-input');
  const copy = new Uint8Array(bytes.length); Uint8Array.prototype.set.call(copy, bytes); return copy;
}
export function capturePathCopyRequest(input: PreparedWorkspacePathCopyInput): CapturedPathCopyRequest {
  if (types.isProxy(input) || !input || typeof input !== 'object') copyFailure('invalid-input');
  const policy = copyData(input, 'sourceProjectionPolicy', true), v3 = policy === 'provider-derived-files-v3';
  if (Reflect.ownKeys(input).some(key => !['sourceWorkspace', 'destinationWorkspace', 'sourcePath', 'destinationPath', 'sourceKind', 'budget', 'projectionPaths', 'sourceProjectionPolicy', ...(v3 ? ['derivedFiles'] : [])].includes(key as string))) copyFailure('invalid-input');
  let sourceWorkspace: WorkspaceOperationJobScope, destinationWorkspace: WorkspaceOperationJobScope;
  try {
    const source = copyData(input, 'sourceWorkspace'), destination = copyData(input, 'destinationWorkspace');
    if (types.isProxy(source) || types.isProxy(destination)) copyFailure('invalid-input');
    sourceWorkspace = captureWorkspaceOperationJobScope(source as WorkspaceContext);
    destinationWorkspace = captureWorkspaceOperationJobScope(destination as WorkspaceContext);
  } catch { return copyFailure('invalid-input'); }
  const sourcePath = copyPath(copyData(input, 'sourcePath')), destinationPath = copyPath(copyData(input, 'destinationPath'));
  if (sourceWorkspace.workspaceId === destinationWorkspace.workspaceId && (!isDeepStrictEqual(sourceWorkspace, destinationWorkspace)
    || sourcePath === destinationPath || destinationPath.startsWith(sourcePath + '/') || sourcePath.startsWith(destinationPath + '/'))) copyFailure('invalid-input');
  if (sourceWorkspace.workspaceId !== destinationWorkspace.workspaceId && sourceWorkspace.rootPath === destinationWorkspace.rootPath) copyFailure('invalid-input');
  const sourceKind = copyData(input, 'sourceKind');
  if (!['regular_file', 'directory', 'projection_absent'].includes(sourceKind as string)) copyFailure('invalid-input');
  const sourceProjectionPolicy = copyData(input, 'sourceProjectionPolicy', true);
  if (Object.hasOwn(input, 'sourceProjectionPolicy') && sourceProjectionPolicy !== 'native-derived-leaves-v2' && !v3) copyFailure('invalid-input');
  const rawBudget = copyData(input, 'budget', true);
  const limit = budget(rawBudget === undefined ? undefined : captureWorkspaceOperationNativePlanData(rawBudget, () => copyFailure('invalid-input')));
  const projectionPaths = projections(copyData(input, 'projectionPaths', true), sourcePath, sourceKind as string);
  const captured = v3 ? captureDerivedInputs(copyData(input, 'derivedFiles'), sourcePath, sourceKind as string, limit, projectionPaths) : null;
  const request: CapturedPathCopyRequest = freezeCopyData({ sourceWorkspace, destinationWorkspace, sourcePath, destinationPath,
    sourceKind: sourceKind as PreparedWorkspacePathCopyInput['sourceKind'], budget: limit, projectionPaths,
    ...(sourceProjectionPolicy === undefined ? {} : { sourceProjectionPolicy: sourceProjectionPolicy as NonNullable<CapturedPathCopyRequest['sourceProjectionPolicy']> }),
    ...(captured ? { derivedFiles: captured.files } : {}) });
  if (captured) derivedByteCopies.set(request, captured.bytes);
  return request;
}
export function capturePathCopyRecoveryRequest(original: PreparedWorkspacePathCopyOriginal, sourceWorkspace: WorkspaceContext,
  destinationWorkspace: WorkspaceContext): CapturedPathCopyRequest {
  const common = capturePathCopyRequest({ sourceWorkspace, destinationWorkspace, sourcePath: original.sourcePath, destinationPath: original.destinationPath,
    sourceKind: original.source.kind === 'projection_file' ? 'regular_file' : original.source.kind, budget: original.budget,
    projectionPaths: original.projectionPaths, ...(original.version === 2 ? { sourceProjectionPolicy: original.sourceProjectionPolicy } : {}) });
  return original.version === 3 ? freezeCopyData({ ...common, sourceProjectionPolicy: original.sourceProjectionPolicy, derivedFiles: original.derivedFiles }) : common;
}
function identity(value: unknown): PreparedPathCopyIdentity {
  const data = record(value, ['device', 'inode', 'mode', 'uid', 'gid', 'linkCount', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']);
  for (const key of ['device', 'inode', 'linkCount', 'size'] as const) {
    if (typeof data[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(data[key] as string)
      || BigInt(data[key] as string) > BigInt('18446744073709551615')) copyFailure('invalid-input');
  }
  if (BigInt(data.inode as string) === BigInt(0) || BigInt(data.linkCount as string) === BigInt(0)) copyFailure('invalid-input');
  for (const key of ['mode', 'uid', 'gid'] as const) if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 0xffff_ffff) copyFailure('invalid-input');
  for (const key of ['birthtimeNs', 'mtimeNs', 'ctimeNs'] as const) if (typeof data[key] !== 'string' || !/^-?(?:0|[1-9][0-9]{0,29})$/u.test(data[key] as string)) copyFailure('invalid-input');
  return data as PreparedPathCopyIdentity;
}
function parents(value: unknown, pathname: string): PreparedPathCopyParents {
  const data = record(value, ['directories', 'missingPrefix']), components = pathname.split('/').slice(0, -1);
  if (!Array.isArray(data.directories) || data.directories.length > components.length) copyFailure('invalid-input');
  for (let index = 0; index < data.directories.length; index++) {
    const item = record(data.directories[index], ['relativePath', 'identity']);
    if (item.relativePath !== components.slice(0, index + 1).join('/')) copyFailure('invalid-input'); identity(item.identity);
  }
  if (data.missingPrefix !== (data.directories.length < components.length ? components.slice(0, data.directories.length + 1).join('/') : null)) copyFailure('invalid-input');
  return data as PreparedPathCopyParents;
}
function snapshot(value: unknown, limit: PreparedPathCopyBudget, rootPath: string, omitted: readonly string[], payload = false): PreparedPathCopySource {
  const data = record(value, Object.keys(value as object ?? {}));
  if (data.kind === 'projection_absent') { record(data, ['kind']); if (payload) copyFailure('invalid-input'); return data as PreparedPathCopySource; }
  const entry = (item: Record<string, unknown>, relative: string) => {
    const observed = identity(item.identity), directory = item.kind === 'directory';
    if ((observed.mode & 0o170000) !== (directory ? 0o040000 : 0o100000) || (observed.mode & 0o022)
      || !directory && observed.linkCount !== '1'
      || payload && (observed.mode & 0o7777) !== (directory ? 0o700 : 0o600)) copyFailure('invalid-input');
    if (item.kind === 'regular_file') {
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) copyFailure('invalid-input');
      if (!payload && omitted.includes(relative ? rootPath + '/' + relative : rootPath)) copyFailure('invalid-input');
      return BigInt((item.identity as PreparedPathCopyIdentity).size);
    }
    if (item.kind === 'projection_file') {
      if (payload || !omitted.includes(relative ? rootPath + '/' + relative : rootPath)) copyFailure('invalid-input');
    } else if (item.kind !== 'directory' || omitted.includes(relative ? rootPath + '/' + relative : rootPath)) copyFailure('invalid-input');
    return BigInt(0);
  };
  if (data.kind === 'regular_file' || data.kind === 'projection_file') {
    record(data, data.kind === 'regular_file' ? ['kind', 'identity', 'sha256'] : ['kind', 'identity']);
    if (entry(data, '') > BigInt(limit.maxHashBytes)) copyFailure('invalid-input'); return data as PreparedPathCopySource;
  }
  record(data, ['kind', 'entries']);
  if (data.kind !== 'directory' || !Array.isArray(data.entries) || !data.entries.length || data.entries.length > limit.maxEntries) copyFailure('invalid-input');
  let previous = '', bytes = BigInt(0); const seen = new Map<string, string>();
  for (const [index, raw] of data.entries.entries()) {
    const item = record(raw, raw?.kind === 'regular_file' ? ['relativePath', 'kind', 'identity', 'sha256'] : ['relativePath', 'kind', 'identity']);
    if (typeof item.relativePath !== 'string' || (index === 0 ? item.relativePath !== '' || item.kind !== 'directory' : !item.relativePath || item.relativePath <= previous)) copyFailure('invalid-input');
    const relative = item.relativePath;
    if (relative) {
      copyPath(relative); copyPath(rootPath + '/' + relative);
      if (relative.split('/').length > limit.maxDepth || seen.get(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative)) !== 'directory') copyFailure('invalid-input');
    }
    bytes += entry(item, relative); previous = relative; seen.set(relative, item.kind as string);
  }
  if (bytes > BigInt(limit.maxHashBytes)) copyFailure('invalid-input');
  return data as PreparedPathCopySource;
}
/** Reproduces which physical bytes are copied; identities of fresh nodes are
 * deliberately distinct from the source. Projection membership is owner data. */
export function assertPathCopyPayload(source: PreparedPathCopySource, payload: PreparedPathCopyPayload): void {
  const compare = (before: PreparedPathCopyEntry, after: PreparedPathCopyEntry) => {
    if (before.relativePath !== after.relativePath || before.kind !== after.kind
      || before.identity.device === after.identity.device && before.identity.inode === after.identity.inode
      || before.kind === 'regular_file' && (after.kind !== 'regular_file' || before.sha256 !== after.sha256
        || before.identity.size !== after.identity.size)) copyFailure('staging-changed');
  };
  if (source.kind === 'regular_file' && payload.kind === 'regular_file') {
    compare({ relativePath: '', ...source }, { relativePath: '', ...payload }); return;
  }
  if (source.kind !== 'directory' || payload.kind !== 'directory') copyFailure('staging-changed');
  const entries = source.entries.filter(entry => entry.kind !== 'projection_file');
  if (entries.length !== payload.entries.length) copyFailure('staging-changed');
  entries.forEach((entry, index) => compare(entry, payload.entries[index]));
}
export type PreparedPathCopyProviderPayloadEntry = Readonly<{
  relativePath: string; kind: 'directory' | 'regular_file';
  source?: Exclude<PreparedPathCopyEntry, { kind: 'projection_file' }>;
  derived?: PreparedPathCopyDerivedFile;
}>;
/** The exact mechanical output graph: ordinary physical nodes plus explicit
 * provider leaves and only the directories needed to contain those leaves. */
export function pathCopyProviderPayloadPlan(source: PreparedPathCopySource, sourcePath: string,
  derivedFiles: readonly PreparedPathCopyDerivedFile[], limit: PreparedPathCopyBudget): readonly PreparedPathCopyProviderPayloadEntry[] {
  const entries = new Map<string, PreparedPathCopyProviderPayloadEntry>();
  if (source.kind === 'regular_file') entries.set('', { relativePath: '', kind: 'regular_file', source: { relativePath: '', ...source } });
  if (source.kind === 'directory') for (const entry of source.entries) if (entry.kind !== 'projection_file') {
    entries.set(entry.relativePath, { relativePath: entry.relativePath, kind: entry.kind, source: entry });
  }
  for (const derived of derivedFiles) {
    const relative = derived.path === sourcePath ? '' : derived.path.slice(sourcePath.length + 1);
    if (entries.has(relative)) copyFailure('invalid-input');
    entries.set(relative, { relativePath: relative, kind: 'regular_file', derived });
    if (relative) {
      const components = relative.split('/');
      for (let depth = 0; depth < components.length; depth++) {
        const parent = components.slice(0, depth).join('/'), previous = entries.get(parent);
        if (previous?.kind === 'regular_file') copyFailure('invalid-input');
        if (!previous) entries.set(parent, { relativePath: parent, kind: 'directory' });
      }
    }
  }
  const result = [...entries.values()].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  let bytes = BigInt(0);
  if (result.length > limit.maxEntries) copyFailure('budget-exceeded');
  for (const entry of result) {
    if (entry.relativePath && entry.relativePath.split('/').length > limit.maxDepth) copyFailure('budget-exceeded');
    if (entry.kind === 'regular_file') bytes += entry.derived ? BigInt(entry.derived.sizeBytes) : BigInt(entry.source!.identity.size);
  }
  if (bytes > BigInt(limit.maxHashBytes)) copyFailure('budget-exceeded');
  return freezeCopyData(result);
}
export function assertPathCopyProviderPayload(source: PreparedPathCopySource, payload: PreparedPathCopyPayload,
  sourcePath: string, derivedFiles: readonly PreparedPathCopyDerivedFile[], limit: PreparedPathCopyBudget): void {
  const expected = pathCopyProviderPayloadPlan(source, sourcePath, derivedFiles, limit);
  const observed = payload.kind === 'regular_file' ? [{ relativePath: '', ...payload }] : payload.entries;
  if (!expected.length || expected.length !== observed.length || (expected[0].kind === 'directory') !== (payload.kind === 'directory')) copyFailure('staging-changed');
  expected.forEach((entry, index) => {
    const actual = observed[index];
    if (entry.relativePath !== actual.relativePath || entry.kind !== actual.kind
      || entry.source && entry.source.identity.device === actual.identity.device && entry.source.identity.inode === actual.identity.inode) copyFailure('staging-changed');
    if (entry.kind === 'regular_file') {
      const sha256 = entry.derived?.sha256 ?? (entry.source as Extract<PreparedPathCopyEntry, { kind: 'regular_file' }>).sha256;
      const size = entry.derived ? String(entry.derived.sizeBytes) : entry.source!.identity.size;
      if (actual.kind !== 'regular_file' || actual.sha256 !== sha256 || actual.identity.size !== size) copyFailure('staging-changed');
      const physical = source.kind === 'projection_file' && !entry.relativePath ? source
        : source.kind === 'directory' ? source.entries.find(item => item.relativePath === entry.relativePath && item.kind === 'projection_file') : undefined;
      if (physical && physical.identity.device === actual.identity.device && physical.identity.inode === actual.identity.inode) copyFailure('staging-changed');
    }
  });
}
export function decodePreparedWorkspacePathCopyOriginal(input: unknown): PreparedWorkspacePathCopyOriginal {
  const captured = captureWorkspaceOperationNativePlanData(input, reason => copyFailure(reason === 'too-large' ? 'budget-exceeded' : 'invalid-input'));
  if (copyData(captured, 'version') === 3) return decodePreparedWorkspacePathCopyOriginalV3(captured);
  if (copyData(captured, 'version') === 2) {
    const value = record(captured,
      ['version', 'sourceWorkspace', 'destinationWorkspace', 'sourcePath', 'destinationPath', 'budget', 'projectionPaths', 'filesystem', 'source', 'staging', 'sourceProjectionPolicy']);
    if (value.sourceProjectionPolicy !== 'native-derived-leaves-v2') copyFailure('invalid-input');
    const { sourceProjectionPolicy: _policy, ...legacy } = value;
    const original = decodePreparedWorkspacePathCopyOriginalV1({ ...legacy, version: 1 });
    return freezeCopyData({ ...original, version: 2 as const, sourceProjectionPolicy: 'native-derived-leaves-v2' as const });
  }
  return decodePreparedWorkspacePathCopyOriginalV1(captured);
}
function decodePreparedWorkspacePathCopyOriginalV3(input: unknown): PreparedWorkspacePathCopyOriginalV3 {
  const data = record(input, ['version', 'sourceWorkspace', 'destinationWorkspace', 'sourcePath', 'destinationPath', 'budget', 'projectionPaths',
    'filesystem', 'source', 'staging', 'sourceProjectionPolicy', 'derivedFiles']);
  if (data.version !== 3 || data.sourceProjectionPolicy !== 'provider-derived-files-v3') copyFailure('invalid-input');
  let sourceWorkspace: WorkspaceOperationJobScope, destinationWorkspace: WorkspaceOperationJobScope;
  try { sourceWorkspace = parseWorkspaceOperationJobScope(data.sourceWorkspace); destinationWorkspace = parseWorkspaceOperationJobScope(data.destinationWorkspace); }
  catch { return copyFailure('invalid-input'); }
  const kind = copyData(data.source, 'kind'), sourceKind = kind === 'projection_file' ? 'regular_file' : kind;
  const request = capturePathCopyRequest({ sourceWorkspace: sourceWorkspace as unknown as WorkspaceContext, destinationWorkspace: destinationWorkspace as unknown as WorkspaceContext,
    sourcePath: data.sourcePath as string, destinationPath: data.destinationPath as string, sourceKind: sourceKind as PreparedWorkspacePathCopyInput['sourceKind'],
    budget: data.budget as PreparedPathCopyBudget, projectionPaths: data.projectionPaths as string[] });
  if (!isDeepStrictEqual(request.projectionPaths, data.projectionPaths)) copyFailure('invalid-input');
  const derivedFiles = captureDerivedDescriptors(data.derivedFiles, request.sourcePath, sourceKind as string, request.budget, request.projectionPaths);
  const filesystem = record(data.filesystem, ['sourceRoot', 'destinationRoot', 'sourceParents', 'destinationParents']);
  for (const key of ['sourceRoot', 'destinationRoot']) {
    const root = record(filesystem[key], ['resolvedPath', 'identity']);
    if (typeof root.resolvedPath !== 'string' || !path.isAbsolute(root.resolvedPath) || path.resolve(root.resolvedPath) !== root.resolvedPath) copyFailure('invalid-input');
    identity(root.identity);
  }
  parents(filesystem.sourceParents, request.sourcePath); const targetParents = parents(filesystem.destinationParents, request.destinationPath);
  const source = snapshot(data.source, request.budget, request.sourcePath, [...request.projectionPaths, ...derivedFiles.map(file => file.path)]);
  if (source.kind !== 'projection_absent' && (filesystem.sourceParents as PreparedPathCopyParents).missingPrefix !== null) copyFailure('invalid-input');
  const expected = pathCopyProviderPayloadPlan(source, request.sourcePath, derivedFiles, request.budget);
  if (data.staging === null) { if (expected.length) copyFailure('invalid-input'); }
  else {
    const staged = record(data.staging, ['relativePath', 'identity', 'payload']), relativePath = copyPath(staged.relativePath);
    const containerIdentity = identity(staged.identity);
    if ((containerIdentity.mode & 0o170000) !== 0o040000 || (containerIdentity.mode & 0o7777) !== 0o700
      || !/^\.canvas-create-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(path.posix.basename(relativePath))
      || path.posix.dirname(relativePath) !== (targetParents.directories.at(-1)?.relativePath ?? '.')) copyFailure('invalid-input');
    const payload = snapshot(staged.payload, request.budget, request.destinationPath, [], true);
    if (payload.kind !== 'regular_file' && payload.kind !== 'directory') copyFailure('invalid-input');
    assertPathCopyProviderPayload(source, payload as PreparedPathCopyPayload, request.sourcePath, derivedFiles, request.budget);
  }
  return freezeCopyData(data as unknown as PreparedWorkspacePathCopyOriginalV3);
}
function decodePreparedWorkspacePathCopyOriginalV1(input: unknown): PreparedWorkspacePathCopyOriginalV1 {
  const data = record(input,
    ['version', 'sourceWorkspace', 'destinationWorkspace', 'sourcePath', 'destinationPath', 'budget', 'projectionPaths', 'filesystem', 'source', 'staging']);
  if (data.version !== 1) copyFailure('invalid-input');
  let sourceWorkspace: WorkspaceOperationJobScope, destinationWorkspace: WorkspaceOperationJobScope;
  try { sourceWorkspace = parseWorkspaceOperationJobScope(data.sourceWorkspace); destinationWorkspace = parseWorkspaceOperationJobScope(data.destinationWorkspace); } catch { return copyFailure('invalid-input'); }
  const sourceKind = copyData(data.source, 'kind');
  const request = capturePathCopyRequest({ sourceWorkspace: sourceWorkspace as unknown as WorkspaceContext, destinationWorkspace: destinationWorkspace as unknown as WorkspaceContext,
    sourcePath: data.sourcePath as string, destinationPath: data.destinationPath as string,
    sourceKind: (sourceKind === 'projection_file' ? 'regular_file' : sourceKind) as PreparedWorkspacePathCopyInput['sourceKind'],
    budget: data.budget as PreparedPathCopyBudget, projectionPaths: data.projectionPaths as string[] });
  if (!isDeepStrictEqual(request.projectionPaths, data.projectionPaths)) copyFailure('invalid-input');
  const filesystem = record(data.filesystem, ['sourceRoot', 'destinationRoot', 'sourceParents', 'destinationParents']);
  for (const key of ['sourceRoot', 'destinationRoot']) { const root = record(filesystem[key], ['resolvedPath', 'identity']); if (typeof root.resolvedPath !== 'string' || !path.isAbsolute(root.resolvedPath) || path.resolve(root.resolvedPath) !== root.resolvedPath) copyFailure('invalid-input'); identity(root.identity); }
  parents(filesystem.sourceParents, request.sourcePath); const targetParents = parents(filesystem.destinationParents, request.destinationPath);
  const source = snapshot(data.source, request.budget, request.sourcePath, request.projectionPaths);
  if (source.kind !== 'projection_absent' && (filesystem.sourceParents as PreparedPathCopyParents).missingPrefix !== null) copyFailure('invalid-input');
  if (data.staging === null) { if (!['projection_absent', 'projection_file'].includes(source.kind)) copyFailure('invalid-input'); }
  else {
    const staged = record(data.staging, ['relativePath', 'identity', 'payload']), relativePath = copyPath(staged.relativePath); identity(staged.identity);
    if (!/^\.canvas-create-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(path.posix.basename(relativePath))
      || path.posix.dirname(relativePath) !== (targetParents.directories.at(-1)?.relativePath ?? '.')) copyFailure('invalid-input');
    if (['projection_absent', 'projection_file'].includes(source.kind)) copyFailure('invalid-input');
    const payload = snapshot(staged.payload, request.budget, request.destinationPath, [], true);
    if (payload.kind !== source.kind) copyFailure('invalid-input');
    assertPathCopyPayload(source, payload as PreparedPathCopyPayload);
  }
  return freezeCopyData(data as unknown as PreparedWorkspacePathCopyOriginalV1);
}
export function preparedWorkspacePathCopyProof(value: PreparedWorkspacePathCopyOriginal): string {
  const canonical = (data: unknown): string => Array.isArray(data) ? '[' + data.map(canonical).join(',') + ']'
    : data && typeof data === 'object' ? '{' + Object.keys(data).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(data, key))).join(',') + '}' : JSON.stringify(data);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function capturePathCopyParentReceipts(input: unknown, original: PreparedWorkspacePathCopyOriginal,
  sharedParents: readonly PreparedWorkspacePathCopySharedParent[] = []): readonly PreparedWorkspacePathCopyParentReceipt[] {
  if (input === undefined) return Object.freeze([]);
  const value = captureWorkspaceOperationNativePlanData(input, () => copyFailure('invalid-input'));
  if (!Array.isArray(value) || value.length > 32 || !original.staging && value.length) copyFailure('invalid-input');
  const components = original.destinationPath.split('/').slice(0, -1), offset = original.filesystem.destinationParents.directories.length + sharedParents.length;
  for (const [index, raw] of value.entries()) {
    const item = record(raw, ['version', 'originalProof', 'relativePath', 'identity']);
    if (item.version !== 1 || item.originalProof !== preparedWorkspacePathCopyProof(original)
      || item.relativePath !== components.slice(0, offset + index + 1).join('/') || offset + index >= components.length) copyFailure('invalid-input'); identity(item.identity);
  }
  return freezeCopyData(value as PreparedWorkspacePathCopyParentReceipt[]);
}

export function capturePathCopySharedParents(input: unknown,
  consumer: PreparedWorkspacePathCopyOriginal): readonly PreparedWorkspacePathCopySharedParent[] {
  if (input === undefined) return Object.freeze([]);
  const value = captureWorkspaceOperationNativePlanData(input, reason => copyFailure(reason === 'too-large' ? 'budget-exceeded' : 'invalid-input'));
  if (!Array.isArray(value) || value.length > 32) copyFailure('invalid-input');
  const components = consumer.destinationPath.split('/').slice(0, -1), offset = consumer.filesystem.destinationParents.directories.length;
  const stableNode = (a: PreparedPathCopyIdentity, b: PreparedPathCopyIdentity) =>
    (['device', 'inode', 'mode', 'uid', 'gid', 'birthtimeNs'] as const).every(key => a[key] === b[key]);
  const publishedPayload = (before: PreparedPathCopyPayload, after: PreparedPathCopyPayload): void => {
    if (before.kind !== after.kind) copyFailure('invalid-input');
    const normalize = (payload: PreparedPathCopyPayload) => payload.kind === 'regular_file'
      ? [{ relativePath: '', ...payload }] : payload.entries;
    const old = normalize(before), observed = normalize(after);
    if (old.length !== observed.length || old.some((entry, index) => {
      const actual = observed[index];
      return entry.kind !== actual.kind || entry.relativePath !== actual.relativePath
        || !stableNode(entry.identity, actual.identity)
        || (['linkCount', 'size', 'mtimeNs'] as const).some(key => entry.identity[key] !== actual.identity[key])
        || index !== 0 && entry.identity.ctimeNs !== actual.identity.ctimeNs
        || entry.kind === 'regular_file' && (actual.kind !== 'regular_file' || entry.sha256 !== actual.sha256);
    })) copyFailure('invalid-input');
  };
  for (const [index, raw] of value.entries()) {
    const item = record(raw, ['producerOriginal', 'producerReceipt', 'parentReceipt']);
    const producer = decodePreparedWorkspacePathCopyOriginal(item.producerOriginal), proof = preparedWorkspacePathCopyProof(producer);
    if (!producer.staging || proof === preparedWorkspacePathCopyProof(consumer)
      || !isDeepStrictEqual(producer.sourceWorkspace, consumer.sourceWorkspace)
      || !isDeepStrictEqual(producer.destinationWorkspace, consumer.destinationWorkspace)
      || producer.filesystem.destinationRoot.resolvedPath !== consumer.filesystem.destinationRoot.resolvedPath
      || !stableNode(producer.filesystem.destinationRoot.identity, consumer.filesystem.destinationRoot.identity)
      || producer.filesystem.sourceRoot.resolvedPath !== consumer.filesystem.sourceRoot.resolvedPath
      || !stableNode(producer.filesystem.sourceRoot.identity, consumer.filesystem.sourceRoot.identity)
      || producer.destinationPath === consumer.destinationPath || producer.destinationPath.startsWith(consumer.destinationPath + '/')
      || consumer.destinationPath.startsWith(producer.destinationPath + '/')) copyFailure('invalid-input');
    const receipt = record(item.producerReceipt, ['version', 'original', 'createdParents', 'observation']);
    if (receipt.version !== 1 || !isDeepStrictEqual(decodePreparedWorkspacePathCopyOriginal(receipt.original), producer)
      || !Array.isArray(receipt.createdParents) || !receipt.createdParents.length || receipt.createdParents.length > 32) copyFailure('invalid-input');
    const producerParts = producer.destinationPath.split('/').slice(0, -1), producerOffset = producer.filesystem.destinationParents.directories.length;
    let previousDepth = -1;
    for (const birthValue of receipt.createdParents) {
      const birth = record(birthValue, ['version', 'originalProof', 'relativePath', 'identity']);
      const pathname = copyPath(birth.relativePath), depth = pathname.split('/').length;
      const observed = identity(birth.identity);
      if (birth.version !== 1 || birth.originalProof !== proof || depth <= producerOffset || depth > producerParts.length
        || pathname !== producerParts.slice(0, depth).join('/') || previousDepth !== -1 && depth !== previousDepth + 1
        || (observed.mode & 0o170000) !== 0o040000 || (observed.mode & 0o022)) copyFailure('invalid-input');
      previousDepth = depth;
    }
    const observation = record(receipt.observation, ['kind', 'method', 'copy']);
    if (observation.kind !== 'published' || observation.method !== 'rename-no-replace') copyFailure('invalid-input');
    const copy = snapshot(observation.copy, producer.budget, producer.destinationPath, [], true);
    if (copy.kind !== 'regular_file' && copy.kind !== 'directory') copyFailure('invalid-input');
    const payload: PreparedPathCopyPayload = copy.kind === 'regular_file' ? copy : {
      kind: 'directory', entries: copy.entries.map(entry => {
        if (entry.kind === 'projection_file') copyFailure('invalid-input');
        return entry;
      }),
    };
    publishedPayload(producer.staging.payload, payload);
    const birth = record(item.parentReceipt, ['version', 'originalProof', 'relativePath', 'identity']); identity(birth.identity);
    if (!receipt.createdParents.some(row => isDeepStrictEqual(row, birth)) || birth.version !== 1 || birth.originalProof !== proof
      || offset + index >= components.length || birth.relativePath !== components.slice(0, offset + index + 1).join('/')) copyFailure('invalid-input');
  }
  return freezeCopyData(value as unknown as PreparedWorkspacePathCopySharedParent[]);
}
