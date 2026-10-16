import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';

export type PreparedPathMoveIdentity = Readonly<{
  device: string; inode: string; mode: number; uid: number; gid: number;
  linkCount: string; size: string; birthtimeNs: string; mtimeNs: string; ctimeNs: string;
}>;
export type PreparedPathMoveBudget = Readonly<{ maxDepth: number; maxEntries: number; maxHashBytes: number }>;
export const PREPARED_PATH_MOVE_LIMITS: PreparedPathMoveBudget = Object.freeze({ maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 });
export type PreparedPathMoveScope = Readonly<{ workspaceId: string; workspaceType: WorkspaceContext['workspaceType'];
  organizationId: string | null; rootPath: string }>;
export type PreparedPathMoveDirectory = Readonly<{ relativePath: string; identity: PreparedPathMoveIdentity }>;
export type PreparedPathMoveParents = Readonly<{ directories: readonly PreparedPathMoveDirectory[]; missingPrefix: string | null }>;
export type PreparedPathMoveEntry = Readonly<{ relativePath: string; kind: 'directory'; identity: PreparedPathMoveIdentity }>
  | Readonly<{ relativePath: string; kind: 'regular_file'; identity: PreparedPathMoveIdentity; sha256: string }>;
export type PreparedPathMoveSource = Readonly<{ kind: 'regular_file'; identity: PreparedPathMoveIdentity; sha256: string }>
  | Readonly<{ kind: 'directory'; entries: readonly PreparedPathMoveEntry[] }>
  | Readonly<{ kind: 'projection_absent' }>;
/** Observations only. Provenance, actor authority and the original durable
 * intent belong to the job owner, never to a decoded JSON object or hash. */
export type PreparedWorkspacePathMoveOriginal = Readonly<{
  version: 1; workspace: PreparedPathMoveScope; sourcePath: string; destinationPath: string;
  budget: PreparedPathMoveBudget; caseOnlyAlias: boolean;
  filesystem: Readonly<{ root: Readonly<{ resolvedPath: string; identity: PreparedPathMoveIdentity }>;
    sourceParents: PreparedPathMoveParents; destinationParents: PreparedPathMoveParents }>;
  source: PreparedPathMoveSource;
}>;
export type PreparedWorkspacePathMoveParentReceipt = Readonly<{ version: 1; originalProof: string;
  relativePath: string; identity: PreparedPathMoveIdentity }>;
export type PreparedWorkspacePathMoveReceipt = Readonly<{ version: 1; original: PreparedWorkspacePathMoveOriginal;
  createdParents: readonly PreparedWorkspacePathMoveParentReceipt[];
  observation: Readonly<{ kind: 'moved'; method: 'rename-no-replace'; source: Exclude<PreparedPathMoveSource, { kind: 'projection_absent' }> }>
    | Readonly<{ kind: 'projection_absent' }> }>;
export type PreparedWorkspacePathMoveInput = Readonly<{ workspace: WorkspaceContext; sourcePath: string; destinationPath: string;
  sourceKind: PreparedPathMoveSource['kind']; budget?: PreparedPathMoveBudget }>;
export type RecoveredWorkspacePathMoveInput = Readonly<{ workspace: WorkspaceContext; original: PreparedWorkspacePathMoveOriginal;
  createdParents?: readonly PreparedWorkspacePathMoveParentReceipt[] }>;
export type PreparedPathMoveErrorCode = 'invalid-input' | 'invalid-lifetime' | 'reentrant-operation' | 'already-moved'
  | 'scope-changed' | 'unsafe-path' | 'source-changed' | 'destination-occupied' | 'budget-exceeded'
  | 'parent-journal-required' | 'parent-create-unconfirmed' | 'unawaited-operation' | 'cross-device-move'
  | 'move-unconfirmed' | 'recovery-conflict' | 'disposal-unconfirmed';
export class PreparedWorkspacePathMoveError extends Error {
  readonly status: 503 | undefined;
  constructor(readonly code: PreparedPathMoveErrorCode, readonly mutationAttempted = false, options?: ErrorOptions) {
    super('The prepared path operation could not be confirmed.', options); this.name = 'PreparedWorkspacePathMoveError';
    this.status = code === 'disposal-unconfirmed' ? 503 : undefined;
  }
}
export function pathMoveFailure(code: PreparedPathMoveErrorCode, attempted = false): never {
  throw new PreparedWorkspacePathMoveError(code, attempted);
}
export function freezePathMoveData<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezePathMoveData(child); Object.freeze(value); }
  return value;
}
export function pathMoveDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) pathMoveFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) pathMoveFailure('invalid-input');
  return descriptor.value;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) pathMoveFailure('invalid-input');
  for (const key of keys) pathMoveDataProperty(value, key);
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.from(value).toString('utf8') !== value) pathMoveFailure('invalid-input');
  return value;
}
export function pathMoveCanonicalPath(value: unknown): string {
  if (!isCanonicalWorkspacePath(value) || Buffer.byteLength(value) > 4096 || value.split('/').length > 33
    || value.split('/').some(part => Buffer.byteLength(part) > 255 || Buffer.from(part).toString('utf8') !== part)) pathMoveFailure('invalid-input');
  return value;
}
function absolute(value: unknown): string {
  const supplied = text(value, 4096);
  if (!path.isAbsolute(supplied) || supplied.includes('\\')) pathMoveFailure('invalid-input');
  return path.resolve(supplied);
}
export function capturePathMoveScope(value: unknown): PreparedPathMoveScope {
  const workspaceId = text(pathMoveDataProperty(value, 'workspaceId'));
  const type = pathMoveDataProperty(value, 'workspaceType');
  if (!['personal', 'organization', 'team', 'project'].includes(type as string)) pathMoveFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'organizationId');
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) pathMoveFailure('invalid-input');
  const org = descriptor?.value, organizationId = org == null ? null : text(org);
  if ([workspaceId, organizationId].some(name => name === '.' || name === '..')) pathMoveFailure('invalid-input');
  return freezePathMoveData({ workspaceId, workspaceType: type as WorkspaceContext['workspaceType'], organizationId,
    rootPath: absolute(pathMoveDataProperty(value, 'rootPath')) });
}
export function capturePathMoveBudget(value: unknown): PreparedPathMoveBudget {
  if (value === undefined) return PREPARED_PATH_MOVE_LIMITS;
  const data = record(value, ['maxDepth', 'maxEntries', 'maxHashBytes']);
  for (const [key, minimum] of [['maxDepth', 0], ['maxEntries', 1], ['maxHashBytes', 0]] as const) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < minimum
      || (data[key] as number) > PREPARED_PATH_MOVE_LIMITS[key]) pathMoveFailure('invalid-input');
  }
  return freezePathMoveData({ maxDepth: data.maxDepth as number, maxEntries: data.maxEntries as number, maxHashBytes: data.maxHashBytes as number });
}
export function capturePathMoveRequest(input: PreparedWorkspacePathMoveInput) {
  const fields = Reflect.ownKeys(input ?? {});
  if (fields.some(key => !['workspace', 'sourcePath', 'destinationPath', 'sourceKind', 'budget'].includes(key as string))) pathMoveFailure('invalid-input');
  const workspace = capturePathMoveScope(pathMoveDataProperty(input, 'workspace'));
  const sourcePath = pathMoveCanonicalPath(pathMoveDataProperty(input, 'sourcePath'));
  const destinationPath = pathMoveCanonicalPath(pathMoveDataProperty(input, 'destinationPath'));
  if (sourcePath === destinationPath || destinationPath.startsWith(sourcePath + '/') || sourcePath.startsWith(destinationPath + '/')) pathMoveFailure('invalid-input');
  const sourceKind = pathMoveDataProperty(input, 'sourceKind');
  if (!['regular_file', 'directory', 'projection_absent'].includes(sourceKind as string)) pathMoveFailure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'budget');
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) pathMoveFailure('invalid-input');
  return freezePathMoveData({ workspace, sourcePath, destinationPath, sourceKind: sourceKind as PreparedPathMoveSource['kind'],
    budget: capturePathMoveBudget(descriptor?.value) });
}
function identity(value: unknown): PreparedPathMoveIdentity {
  const data = record(value, ['device', 'inode', 'mode', 'uid', 'gid', 'linkCount', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']);
  for (const key of ['device', 'inode', 'linkCount', 'size'] as const) {
    if (typeof data[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(data[key] as string)
      || BigInt(data[key] as string) > BigInt('18446744073709551615')) pathMoveFailure('invalid-input');
  }
  if (BigInt(data.inode as string) === BigInt(0) || BigInt(data.linkCount as string) === BigInt(0)) pathMoveFailure('invalid-input');
  for (const key of ['mode', 'uid', 'gid'] as const) if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 0xffff_ffff) pathMoveFailure('invalid-input');
  for (const key of ['birthtimeNs', 'mtimeNs', 'ctimeNs'] as const) if (typeof data[key] !== 'string' || !/^-?(?:0|[1-9][0-9]{0,29})$/u.test(data[key] as string)) pathMoveFailure('invalid-input');
  return data as PreparedPathMoveIdentity;
}
function parents(value: unknown, pathname: string): PreparedPathMoveParents {
  const data = record(value, ['directories', 'missingPrefix']);
  const components = pathname.split('/').slice(0, -1);
  if (!Array.isArray(data.directories) || data.directories.length > components.length) pathMoveFailure('invalid-input');
  for (let index = 0; index < data.directories.length; index++) {
    const item = record(data.directories[index], ['relativePath', 'identity']);
    if (item.relativePath !== components.slice(0, index + 1).join('/')) pathMoveFailure('invalid-input');
    identity(item.identity);
  }
  const missing = data.directories.length < components.length ? components.slice(0, data.directories.length + 1).join('/') : null;
  if (data.missingPrefix !== missing) pathMoveFailure('invalid-input');
  return data as PreparedPathMoveParents;
}
function plainCopy(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 400_000 || depth > 40) pathMoveFailure('invalid-input');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) pathMoveFailure('invalid-input'); return value; }
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 16 * 1024 * 1024) pathMoveFailure('invalid-input'); return value; }
    if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) pathMoveFailure('invalid-input');
    if (Array.isArray(value)) {
      if (value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) pathMoveFailure('invalid-input');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) pathMoveFailure('invalid-input');
        return visit(descriptor.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) pathMoveFailure('invalid-input');
      bytes += Buffer.byteLength(key); if (bytes > 16 * 1024 * 1024) pathMoveFailure('invalid-input');
      result[key] = visit(pathMoveDataProperty(value, key), depth + 1);
    }
    return result;
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) pathMoveFailure('invalid-input');
  return result;
}
export function decodePreparedWorkspacePathMoveOriginal(input: unknown): PreparedWorkspacePathMoveOriginal {
  const data = record(plainCopy(input), ['version', 'workspace', 'sourcePath', 'destinationPath', 'budget', 'caseOnlyAlias', 'filesystem', 'source']);
  if (data.version !== 1 || typeof data.caseOnlyAlias !== 'boolean') pathMoveFailure('invalid-input');
  const scopeData = record(data.workspace, ['workspaceId', 'workspaceType', 'organizationId', 'rootPath']);
  const workspace = capturePathMoveScope(scopeData), source = record(data.source, Object.keys(data.source as object ?? {}));
  const request = capturePathMoveRequest({ workspace: workspace as WorkspaceContext, sourcePath: data.sourcePath as string,
    destinationPath: data.destinationPath as string, sourceKind: source.kind as PreparedPathMoveSource['kind'], budget: capturePathMoveBudget(data.budget) });
  const filesystem = record(data.filesystem, ['root', 'sourceParents', 'destinationParents']);
  const root = record(filesystem.root, ['resolvedPath', 'identity']);
  if (absolute(root.resolvedPath) !== root.resolvedPath) pathMoveFailure('invalid-input'); identity(root.identity);
  parents(filesystem.sourceParents, request.sourcePath); parents(filesystem.destinationParents, request.destinationPath);
  if (source.kind === 'projection_absent') { record(source, ['kind']); if (data.caseOnlyAlias) pathMoveFailure('invalid-input'); }
  else if (source.kind === 'regular_file') { record(source, ['kind', 'identity', 'sha256']); identity(source.identity);
    if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)
      || BigInt((source.identity as PreparedPathMoveIdentity).size) > BigInt(request.budget.maxHashBytes)) pathMoveFailure('invalid-input'); }
  else if (source.kind === 'directory') {
    record(source, ['kind', 'entries']);
    if (!Array.isArray(source.entries) || !source.entries.length || source.entries.length > request.budget.maxEntries) pathMoveFailure('invalid-input');
    const seen = new Map<string, string>(); let previous = '', totalBytes = BigInt(0);
    for (let index = 0; index < source.entries.length; index++) {
      const entry = source.entries[index] as Record<string, unknown>;
      record(entry, entry?.kind === 'directory' ? ['relativePath', 'kind', 'identity'] : ['relativePath', 'kind', 'identity', 'sha256']);
      if (!['regular_file', 'directory'].includes(entry.kind as string) || typeof entry.relativePath !== 'string') pathMoveFailure('invalid-input');
      if (index === 0 ? entry.relativePath !== '' || entry.kind !== 'directory' : !entry.relativePath || entry.relativePath <= previous) pathMoveFailure('invalid-input');
      if (entry.relativePath) {
        pathMoveCanonicalPath(entry.relativePath);
        if (entry.relativePath.split('/').length > request.budget.maxDepth) pathMoveFailure('invalid-input');
        pathMoveCanonicalPath(request.sourcePath + '/' + entry.relativePath); pathMoveCanonicalPath(request.destinationPath + '/' + entry.relativePath);
        const parent = entry.relativePath.includes('/') ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/')) : '';
        if (seen.get(parent) !== 'directory') pathMoveFailure('invalid-input');
      }
      const observed = identity(entry.identity);
      if (entry.kind === 'regular_file') {
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) pathMoveFailure('invalid-input');
        totalBytes += BigInt(observed.size);
      }
      previous = entry.relativePath; seen.set(entry.relativePath, entry.kind as string);
    }
    if (totalBytes > BigInt(request.budget.maxHashBytes)) pathMoveFailure('invalid-input');
  } else pathMoveFailure('invalid-input');
  if (source.kind !== 'projection_absent' && (filesystem.sourceParents as PreparedPathMoveParents).missingPrefix !== null) pathMoveFailure('invalid-input');
  if (data.caseOnlyAlias && path.posix.dirname(request.sourcePath) !== path.posix.dirname(request.destinationPath)) pathMoveFailure('invalid-input');
  return freezePathMoveData(data as unknown as PreparedWorkspacePathMoveOriginal);
}
export function preparedWorkspacePathMoveProof(value: PreparedWorkspacePathMoveOriginal): string {
  const canonical = (data: unknown): string => Array.isArray(data) ? '[' + data.map(canonical).join(',') + ']'
    : data && typeof data === 'object' ? '{' + Object.keys(data).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(data, key))).join(',') + '}' : JSON.stringify(data);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function capturePreparedWorkspacePathMoveParents(input: unknown, original: PreparedWorkspacePathMoveOriginal): readonly PreparedWorkspacePathMoveParentReceipt[] {
  const data = plainCopy(input ?? []);
  if (!Array.isArray(data) || data.length > 32) pathMoveFailure('invalid-input');
  const components = original.destinationPath.split('/').slice(0, -1), offset = original.filesystem.destinationParents.directories.length;
  if (data.length > components.length - offset) pathMoveFailure('invalid-input');
  for (let index = 0; index < data.length; index++) {
    const item = record(data[index], ['version', 'originalProof', 'relativePath', 'identity']); identity(item.identity);
    if (item.version !== 1 || item.originalProof !== preparedWorkspacePathMoveProof(original)
      || item.relativePath !== components.slice(0, offset + index + 1).join('/')) pathMoveFailure('invalid-input');
  }
  return freezePathMoveData(data);
}
