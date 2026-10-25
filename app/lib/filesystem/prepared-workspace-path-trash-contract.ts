import 'server-only';

import path from 'node:path';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { retentionDays, trashRelativePathFor } from './workspace-trash-layout';

export type PreparedPathTrashIdentity = Readonly<{
  device: string; inode: string; mode: number; uid: number; gid: number;
  linkCount: string; size: string; birthtimeNs: string; mtimeNs: string; ctimeNs: string;
}>;
export type PreparedPathTrashBudget = Readonly<{ maxDepth: number; maxEntries: number; maxHashBytes: number }>;
export const PREPARED_PATH_TRASH_LIMITS: PreparedPathTrashBudget = Object.freeze({
  maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3,
});
export type PreparedPathTrashScope = Readonly<{
  workspaceId: string; workspaceType: WorkspaceContext['workspaceType']; organizationId: string | null;
  rootPath: string; dataRoot: string;
}>;
export type PreparedPathTrashDirectory = Readonly<{ relativePath: string; identity: PreparedPathTrashIdentity }>;
export type PreparedPathTrashParents = Readonly<{
  directories: readonly PreparedPathTrashDirectory[]; missingPrefix: string | null;
}>;
export type PreparedPathTrashEntry = Readonly<{
  relativePath: string; kind: 'directory'; identity: PreparedPathTrashIdentity; filesystemFingerprint: string;
}> | Readonly<{
  relativePath: string; kind: 'regular_file'; identity: PreparedPathTrashIdentity;
  filesystemFingerprint: string; sha256: string;
}>;
export type PreparedPathTrashSource = Readonly<{ kind: 'projection_absent' }>
  | Readonly<{ kind: 'regular_file'; identity: PreparedPathTrashIdentity; filesystemFingerprint: string; sha256: string }>
  | Readonly<{ kind: 'directory'; entries: readonly PreparedPathTrashEntry[] }>;
/** Detached observations only. They do not authorize a rename, B1/B2, actor,
 * admission or membership in an operation. The owner provides those fences. */
export type PreparedWorkspacePathTrashOriginal = Readonly<{
  version: 1; workspace: PreparedPathTrashScope; canonicalPath: string; trashEntryId: string; trashRelativePath: string;
  retentionDays: number; deletedAtMs: number; expiresAtMs: number; budget: PreparedPathTrashBudget;
  sourceFingerprint: string | null;
  filesystem: Readonly<{
    workspaceRoot: Readonly<{ resolvedPath: string; identity: PreparedPathTrashIdentity }>;
    dataRoot: Readonly<{ resolvedPath: string; identity: PreparedPathTrashIdentity }>;
    sourceParents: PreparedPathTrashParents; trashParents: PreparedPathTrashParents;
  }>;
  source: PreparedPathTrashSource;
}>;
export type PreparedWorkspacePathTrashReceipt = Readonly<{
  version: 1; original: PreparedWorkspacePathTrashOriginal;
  observation: Readonly<{ kind: 'projection_absent' }>
    | Readonly<{ kind: 'moved'; method: 'rename-no-replace'; source: Exclude<PreparedPathTrashSource, { kind: 'projection_absent' }> }>;
}>;
export type PreparedWorkspacePathTrashSelection = Readonly<{
  stepKey: string; canonicalPath: string; trashEntryId: string; sourceKind: PreparedPathTrashSource['kind'];
}>;
export type PreparedWorkspacePathTrashesInput = Readonly<{
  workspace: WorkspaceContext; dataRoot: string; selections: readonly PreparedWorkspacePathTrashSelection[];
  nowMs?: number; budget?: PreparedPathTrashBudget;
}>;
export type RecoveredWorkspacePathTrashesInput = Readonly<{
  workspace: WorkspaceContext; dataRoot: string;
  originals: readonly Readonly<{ stepKey: string; original: PreparedWorkspacePathTrashOriginal }>[];
}>;
export type PreparedPathTrashErrorCode = 'invalid-input' | 'invalid-lifetime' | 'reentrant-operation' | 'already-moved'
  | 'scope-changed' | 'unsafe-path' | 'source-changed' | 'destination-occupied' | 'budget-exceeded'
  | 'unawaited-operation' | 'cross-device-move' | 'move-unconfirmed' | 'recovery-conflict' | 'disposal-unconfirmed';
export class PreparedWorkspacePathTrashError extends Error {
  readonly status: 503 | undefined;
  constructor(readonly code: PreparedPathTrashErrorCode, readonly mutationAttempted = false, options?: ErrorOptions) {
    super('The prepared trash operation could not be confirmed.', options);
    this.name = 'PreparedWorkspacePathTrashError'; this.status = code === 'disposal-unconfirmed' ? 503 : undefined;
  }
}
export function pathTrashFailure(code: PreparedPathTrashErrorCode): never { throw new PreparedWorkspacePathTrashError(code); }
export function freezePathTrashData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePathTrashData(child); Object.freeze(value);
  }
  return value;
}
export function pathTrashRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) pathTrashFailure('invalid-input');
  for (const key of keys) pathTrashDataProperty(value, key);
  return value as Record<string, unknown>;
}
export function pathTrashDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) pathTrashFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) pathTrashFailure('invalid-input');
  return descriptor.value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.from(value).toString('utf8') !== value) pathTrashFailure('invalid-input');
  return value;
}
export function pathTrashCanonicalPath(value: unknown): string {
  if (!isCanonicalWorkspacePath(value) || Buffer.byteLength(value) > 4096 || value.split('/').length > 33
    || value.split('/').some(part => Buffer.byteLength(part) > 255 || Buffer.from(part).toString('utf8') !== part)) pathTrashFailure('invalid-input');
  return value;
}
function absolute(value: unknown): string {
  const input = text(value, 4096);
  if (!path.isAbsolute(input) || input.includes('\\') || path.resolve(input) !== input) pathTrashFailure('invalid-input');
  return input;
}
export function capturePathTrashScope(workspace: unknown, dataRoot: unknown): PreparedPathTrashScope {
  const workspaceId = text(pathTrashDataProperty(workspace, 'workspaceId'));
  const workspaceType = pathTrashDataProperty(workspace, 'workspaceType');
  if (!['personal', 'organization', 'team', 'project'].includes(workspaceType as string)) pathTrashFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'organizationId');
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) pathTrashFailure('invalid-input');
  const organizationId = descriptor?.value == null ? null : text(descriptor.value);
  if ([workspaceId, organizationId].some(item => item === '.' || item === '..')) pathTrashFailure('invalid-input');
  return freezePathTrashData({ workspaceId, workspaceType: workspaceType as WorkspaceContext['workspaceType'], organizationId,
    rootPath: absolute(pathTrashDataProperty(workspace, 'rootPath')), dataRoot: absolute(dataRoot) });
}
function budget(value: unknown): PreparedPathTrashBudget {
  if (value === undefined) return PREPARED_PATH_TRASH_LIMITS;
  const data = pathTrashRecord(value, ['maxDepth', 'maxEntries', 'maxHashBytes']);
  for (const [key, minimum] of [['maxDepth', 0], ['maxEntries', 1], ['maxHashBytes', 0]] as const) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < minimum
      || (data[key] as number) > PREPARED_PATH_TRASH_LIMITS[key]) pathTrashFailure('invalid-input');
  }
  return freezePathTrashData({ maxDepth: data.maxDepth as number, maxEntries: data.maxEntries as number,
    maxHashBytes: data.maxHashBytes as number });
}
function entryId(value: unknown): string {
  if (typeof value !== 'string' || !/^trash-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) pathTrashFailure('invalid-input');
  return value;
}
function detached(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 400_000 || depth > 40) pathTrashFailure('invalid-input');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) pathTrashFailure('invalid-input'); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 16 * 1024 * 1024) pathTrashFailure('invalid-input'); return value; }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) pathTrashFailure('invalid-input');
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) pathTrashFailure('invalid-input');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) pathTrashFailure('invalid-input');
        return visit(descriptor.value, depth + 1);
      });
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) pathTrashFailure('invalid-input');
      bytes += Buffer.byteLength(key); if (bytes > 16 * 1024 * 1024) pathTrashFailure('invalid-input');
      copy[key] = visit(pathTrashDataProperty(value, key), depth + 1);
    }
    return copy;
  };
  const copy = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > 16 * 1024 * 1024) pathTrashFailure('invalid-input');
  return copy;
}
function identity(value: unknown): PreparedPathTrashIdentity {
  const data = pathTrashRecord(value, ['device', 'inode', 'mode', 'uid', 'gid', 'linkCount', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']);
  for (const key of ['device', 'inode', 'linkCount', 'size'] as const) {
    if (typeof data[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(data[key] as string)
      || BigInt(data[key] as string) > BigInt('18446744073709551615')) pathTrashFailure('invalid-input');
  }
  if (BigInt(data.inode as string) === BigInt(0) || BigInt(data.linkCount as string) === BigInt(0)) pathTrashFailure('invalid-input');
  for (const key of ['mode', 'uid', 'gid'] as const) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 0xffff_ffff) pathTrashFailure('invalid-input');
  }
  for (const key of ['birthtimeNs', 'mtimeNs', 'ctimeNs'] as const) {
    if (typeof data[key] !== 'string' || !/^-?(?:0|[1-9][0-9]{0,29})$/u.test(data[key] as string)) pathTrashFailure('invalid-input');
  }
  return data as PreparedPathTrashIdentity;
}
function fingerprint(value: unknown, observed: PreparedPathTrashIdentity): string {
  if (typeof value !== 'string' || value.length > 256) pathTrashFailure('invalid-input');
  const parts = value.split(':');
  if (parts.length !== 5 || parts.slice(0, 3).some(part => !Number.isSafeInteger(Number(part)) || Number(part) < 0) || parts.slice(0, 3).some((part, index) => part !== [observed.device, observed.inode, observed.size][index])
    || parts.slice(3).some(part => !Number.isFinite(Number(part)) || String(Number(part)) !== part)) pathTrashFailure('invalid-input');
  return value;
}
function parents(value: unknown, pathname: string): PreparedPathTrashParents {
  const data = pathTrashRecord(value, ['directories', 'missingPrefix']);
  const components = pathname.split('/').slice(0, -1);
  if (!Array.isArray(data.directories) || data.directories.length > components.length) pathTrashFailure('invalid-input');
  for (let index = 0; index < data.directories.length; index++) {
    const item = pathTrashRecord(data.directories[index], ['relativePath', 'identity']);
    if (item.relativePath !== components.slice(0, index + 1).join('/')) pathTrashFailure('invalid-input');
    const observed = identity(item.identity);
    if ((observed.mode & 0o170000) !== 0o040000 || (observed.mode & 0o022)) pathTrashFailure('invalid-input');
  }
  const missing = data.directories.length < components.length ? components.slice(0, data.directories.length + 1).join('/') : null;
  if (data.missingPrefix !== missing) pathTrashFailure('invalid-input');
  return data as PreparedPathTrashParents;
}
function source(value: unknown, limits: PreparedPathTrashBudget, canonicalPath: string, trashPath: string): PreparedPathTrashSource {
  const data = pathTrashRecord(value, Object.keys(value as object ?? {}));
  if (data.kind === 'projection_absent') { pathTrashRecord(data, ['kind']); return data as PreparedPathTrashSource; }
  if (data.kind === 'regular_file') {
    pathTrashRecord(data, ['kind', 'identity', 'filesystemFingerprint', 'sha256']);
    const observed = identity(data.identity); fingerprint(data.filesystemFingerprint, observed);
    if ((observed.mode & 0o170000) !== 0o100000 || observed.linkCount !== '1' || (observed.mode & 0o022)
      || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(data.sha256)
      || BigInt(observed.size) > BigInt(limits.maxHashBytes)) pathTrashFailure('invalid-input');
    return data as PreparedPathTrashSource;
  }
  if (data.kind !== 'directory') pathTrashFailure('invalid-input');
  pathTrashRecord(data, ['kind', 'entries']);
  if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > limits.maxEntries) pathTrashFailure('invalid-input');
  const seen = new Map<string, string>(); let previous = '', bytes = BigInt(0);
  for (let index = 0; index < data.entries.length; index++) {
    const item = data.entries[index] as Record<string, unknown>;
    pathTrashRecord(item, item?.kind === 'directory'
      ? ['relativePath', 'kind', 'identity', 'filesystemFingerprint'] : ['relativePath', 'kind', 'identity', 'filesystemFingerprint', 'sha256']);
    if (!['directory', 'regular_file'].includes(item.kind as string) || typeof item.relativePath !== 'string'
      || (index === 0 ? item.relativePath !== '' || item.kind !== 'directory' : !item.relativePath || item.relativePath <= previous)) pathTrashFailure('invalid-input');
    if (item.relativePath) {
      pathTrashCanonicalPath(item.relativePath);
      if (item.relativePath.split('/').length > limits.maxDepth) pathTrashFailure('invalid-input');
      pathTrashCanonicalPath(canonicalPath + '/' + item.relativePath); pathTrashCanonicalPath(trashPath + '/' + item.relativePath);
      const parent = item.relativePath.includes('/') ? item.relativePath.slice(0, item.relativePath.lastIndexOf('/')) : '';
      if (seen.get(parent) !== 'directory') pathTrashFailure('invalid-input');
    }
    const observed = identity(item.identity); fingerprint(item.filesystemFingerprint, observed);
    if ((observed.mode & 0o022) || (observed.mode & 0o170000) !== (item.kind === 'directory' ? 0o040000 : 0o100000)) pathTrashFailure('invalid-input');
    if (item.kind === 'regular_file') {
      if (observed.linkCount !== '1' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) pathTrashFailure('invalid-input');
      bytes += BigInt(observed.size);
    }
    previous = item.relativePath; seen.set(item.relativePath, item.kind as string);
  }
  if (bytes > BigInt(limits.maxHashBytes)) pathTrashFailure('invalid-input');
  return data as PreparedPathTrashSource;
}
export function decodePreparedWorkspacePathTrashOriginal(input: unknown): PreparedWorkspacePathTrashOriginal {
  const data = pathTrashRecord(detached(input), ['version', 'workspace', 'canonicalPath', 'trashEntryId', 'trashRelativePath',
    'retentionDays', 'deletedAtMs', 'expiresAtMs', 'budget', 'sourceFingerprint', 'filesystem', 'source']);
  if (data.version !== 1) pathTrashFailure('invalid-input');
  const scopeData = pathTrashRecord(data.workspace, ['workspaceId', 'workspaceType', 'organizationId', 'rootPath', 'dataRoot']);
  const workspace = capturePathTrashScope(scopeData, scopeData.dataRoot);
  const canonicalPath = pathTrashCanonicalPath(data.canonicalPath), trashEntryId = entryId(data.trashEntryId);
  const trashPath = pathTrashCanonicalPath(data.trashRelativePath);
  if (trashPath !== trashRelativePathFor(workspace, trashEntryId, canonicalPath)) pathTrashFailure('invalid-input');
  if (!Number.isSafeInteger(data.retentionDays) || (data.retentionDays as number) < 1 || (data.retentionDays as number) > 3650
    || !Number.isSafeInteger(data.deletedAtMs) || (data.deletedAtMs as number) < 0 || !Number.isSafeInteger(data.expiresAtMs)
    || data.expiresAtMs !== (data.deletedAtMs as number) + (data.retentionDays as number) * 86_400_000) pathTrashFailure('invalid-input');
  const filesystem = pathTrashRecord(data.filesystem, ['workspaceRoot', 'dataRoot', 'sourceParents', 'trashParents']);
  for (const key of ['workspaceRoot', 'dataRoot'] as const) {
    const root = pathTrashRecord(filesystem[key], ['resolvedPath', 'identity']); absolute(root.resolvedPath);
    const observed = identity(root.identity);
    if ((observed.mode & 0o170000) !== 0o040000 || (observed.mode & 0o022)) pathTrashFailure('invalid-input');
  }
  const sourceParents = parents(filesystem.sourceParents, canonicalPath), trashParents = parents(filesystem.trashParents, trashPath);
  if (trashParents.missingPrefix || !trashParents.directories.length
    || trashParents.directories.some((item, index) => (item.identity.mode
      & (index === trashParents.directories.length - 1 ? 0o077 : 0o022)) !== 0)) pathTrashFailure('invalid-input');
  const limits = budget(data.budget), capturedSource = source(data.source, limits, canonicalPath, trashPath);
  if (capturedSource.kind !== 'projection_absent' && sourceParents.missingPrefix) pathTrashFailure('invalid-input');
  const rootFingerprint = capturedSource.kind === 'projection_absent' ? null
    : capturedSource.kind === 'regular_file' ? capturedSource.filesystemFingerprint : capturedSource.entries[0].filesystemFingerprint;
  if (data.sourceFingerprint !== rootFingerprint) pathTrashFailure('invalid-input');
  return freezePathTrashData({ ...data, workspace, budget: limits, source: capturedSource }) as PreparedWorkspacePathTrashOriginal;
}
export function decodePreparedWorkspacePathTrashReceipt(input: unknown): PreparedWorkspacePathTrashReceipt {
  const data = pathTrashRecord(detached(input), ['version', 'original', 'observation']);
  if (data.version !== 1) pathTrashFailure('invalid-input');
  const original = decodePreparedWorkspacePathTrashOriginal(data.original);
  const observation = pathTrashRecord(data.observation, Object.keys(data.observation as object ?? {}));
  if (original.source.kind === 'projection_absent') {
    if (pathTrashRecord(observation, ['kind']).kind !== 'projection_absent') pathTrashFailure('invalid-input');
  } else {
    pathTrashRecord(observation, ['kind', 'method', 'source']);
    if (observation.kind !== 'moved' || observation.method !== 'rename-no-replace') pathTrashFailure('invalid-input');
    const moved = source(observation.source, original.budget, original.canonicalPath, original.trashRelativePath);
    if (moved.kind !== original.source.kind) pathTrashFailure('invalid-input');
    const beforeEntries = original.source.kind === 'directory' ? original.source.entries : [{ relativePath: '', ...original.source }];
    const afterEntries = moved.kind === 'directory' ? moved.entries : moved.kind === 'regular_file' ? [{ relativePath: '', ...moved }] : [];
    if (beforeEntries.length !== afterEntries.length || beforeEntries.some((before, index) => {
      const after = afterEntries[index];
      return before.relativePath !== after.relativePath || before.kind !== after.kind
        || Object.keys(before.identity).some(key => key !== 'ctimeNs' || index !== 0
          ? Reflect.get(before.identity, key) !== Reflect.get(after.identity, key) : false)
        || before.kind === 'regular_file' && (after.kind !== 'regular_file' || before.sha256 !== after.sha256);
    })) pathTrashFailure('invalid-input');
  }
  return freezePathTrashData({ version: 1, original, observation }) as PreparedWorkspacePathTrashReceipt;
}
export function preparedWorkspacePathTrashNamespaceFingerprints(original: PreparedWorkspacePathTrashOriginal) {
  const data = decodePreparedWorkspacePathTrashOriginal(original);
  return freezePathTrashData(data.source.kind === 'projection_absent' ? [] : data.source.kind === 'regular_file'
    ? [{ relativePath: '', filesystemFingerprint: data.source.filesystemFingerprint }]
    : data.source.entries.map(item => ({ relativePath: item.relativePath, filesystemFingerprint: item.filesystemFingerprint })));
}
function disjoint(selections: readonly PreparedWorkspacePathTrashSelection[]): void {
  const paths = new Set<string>(), keys = new Set<string>(), ids = new Set<string>();
  let previous = '';
  for (const item of [...selections].sort((left, right) => left.canonicalPath < right.canonicalPath ? -1 : left.canonicalPath > right.canonicalPath ? 1 : 0)) {
    if (keys.has(item.stepKey) || ids.has(item.trashEntryId) || paths.has(item.canonicalPath)
      || item.canonicalPath <= previous || [...paths].some(value => item.canonicalPath.startsWith(value + '/') || value.startsWith(item.canonicalPath + '/'))) pathTrashFailure('invalid-input');
    paths.add(item.canonicalPath); keys.add(item.stepKey); ids.add(item.trashEntryId); previous = item.canonicalPath;
  }
}
export function capturePreparedWorkspacePathTrashes(input: PreparedWorkspacePathTrashesInput) {
  const fields = Reflect.ownKeys(input ?? {});
  if (fields.some(key => !['workspace', 'dataRoot', 'selections', 'nowMs', 'budget'].includes(key as string))) pathTrashFailure('invalid-input');
  const workspace = capturePathTrashScope(pathTrashDataProperty(input, 'workspace'), pathTrashDataProperty(input, 'dataRoot'));
  const selected = detached(pathTrashDataProperty(input, 'selections'));
  if (!Array.isArray(selected) || !selected.length || selected.length > 1000) pathTrashFailure('invalid-input');
  const selections = selected.map(value => {
    const item = pathTrashRecord(value, ['stepKey', 'canonicalPath', 'trashEntryId', 'sourceKind']);
    if (!['regular_file', 'directory', 'projection_absent'].includes(item.sourceKind as string)) pathTrashFailure('invalid-input');
    return { stepKey: text(item.stepKey), canonicalPath: pathTrashCanonicalPath(item.canonicalPath), trashEntryId: entryId(item.trashEntryId),
      sourceKind: item.sourceKind as PreparedPathTrashSource['kind'] };
  });
  disjoint(selections);
  const time = Object.hasOwn(input, 'nowMs') ? pathTrashDataProperty(input, 'nowMs') : Date.now();
  if (!Number.isSafeInteger(time) || (time as number) < 0) pathTrashFailure('invalid-input');
  const days = retentionDays(), expires = (time as number) + days * 86_400_000;
  if (!Number.isSafeInteger(expires)) pathTrashFailure('invalid-input');
  const limits = budget(Object.hasOwn(input, 'budget') ? pathTrashDataProperty(input, 'budget') : undefined);
  return freezePathTrashData({ workspace, selections, budget: limits, deletedAtMs: time as number, retentionDays: days, expiresAtMs: expires });
}
export function captureRecoveredWorkspacePathTrashes(input: RecoveredWorkspacePathTrashesInput) {
  const data = pathTrashRecord(input, ['workspace', 'dataRoot', 'originals']);
  const workspace = capturePathTrashScope(data.workspace, data.dataRoot), values = detached(data.originals);
  if (!Array.isArray(values) || !values.length || values.length > 1000) pathTrashFailure('invalid-input');
  const originals = values.map(value => {
    const item = pathTrashRecord(value, ['stepKey', 'original']);
    const original = decodePreparedWorkspacePathTrashOriginal(item.original);
    if (Object.keys(workspace).some(key => Reflect.get(workspace, key) !== Reflect.get(original.workspace, key))) pathTrashFailure('scope-changed');
    return { stepKey: text(item.stepKey), original };
  });
  disjoint(originals.map(item => ({ stepKey: item.stepKey, canonicalPath: item.original.canonicalPath,
    trashEntryId: item.original.trashEntryId, sourceKind: item.original.source.kind })));
  const first = originals[0].original, limits = first.budget;
  if (originals.some(item => Object.keys(limits).some(key => Reflect.get(limits, key) !== Reflect.get(item.original.budget, key))
    || item.original.retentionDays !== first.retentionDays || item.original.deletedAtMs !== first.deletedAtMs
    || item.original.expiresAtMs !== first.expiresAtMs)) pathTrashFailure('invalid-input');
  let entries = 0, bytes = BigInt(0);
  for (const item of originals) {
    const selected = item.original.source;
    entries += selected.kind === 'projection_absent' ? 0 : selected.kind === 'regular_file' ? 1 : selected.entries.length;
    bytes += selected.kind === 'projection_absent' ? BigInt(0) : selected.kind === 'regular_file' ? BigInt(selected.identity.size)
      : selected.entries.reduce((total, entry) => total + (entry.kind === 'regular_file' ? BigInt(entry.identity.size) : BigInt(0)), BigInt(0));
    if (entries > limits.maxEntries || bytes > BigInt(limits.maxHashBytes)) pathTrashFailure('budget-exceeded');
  }
  return freezePathTrashData({ workspace, originals, budget: limits });
}
