import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
export type PreparedWorkspacePathCopyOriginal = PreparedWorkspacePathCopyOriginalV1 | PreparedWorkspacePathCopyOriginalV2;
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
export type PreparedWorkspacePathCopyInput = Readonly<{
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext; sourcePath: string; destinationPath: string;
  sourceKind: 'regular_file' | 'directory' | 'projection_absent'; budget?: PreparedPathCopyBudget;
  /** Exact owner-proven native paths, never globs, extensions or a permission. */
  projectionPaths?: readonly string[];
  sourceProjectionPolicy?: 'native-derived-leaves-v2';
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
export function capturePathCopyRequest(input: PreparedWorkspacePathCopyInput) {
  if (Reflect.ownKeys(input ?? {}).some(key => !['sourceWorkspace', 'destinationWorkspace', 'sourcePath', 'destinationPath', 'sourceKind', 'budget', 'projectionPaths', 'sourceProjectionPolicy'].includes(key as string))) copyFailure('invalid-input');
  let sourceWorkspace: WorkspaceOperationJobScope, destinationWorkspace: WorkspaceOperationJobScope;
  try {
    sourceWorkspace = captureWorkspaceOperationJobScope(copyData(input, 'sourceWorkspace') as WorkspaceContext);
    destinationWorkspace = captureWorkspaceOperationJobScope(copyData(input, 'destinationWorkspace') as WorkspaceContext);
  } catch { return copyFailure('invalid-input'); }
  const sourcePath = copyPath(copyData(input, 'sourcePath')), destinationPath = copyPath(copyData(input, 'destinationPath'));
  if (sourceWorkspace.workspaceId === destinationWorkspace.workspaceId && (!isDeepStrictEqual(sourceWorkspace, destinationWorkspace)
    || sourcePath === destinationPath || destinationPath.startsWith(sourcePath + '/') || sourcePath.startsWith(destinationPath + '/'))) copyFailure('invalid-input');
  if (sourceWorkspace.workspaceId !== destinationWorkspace.workspaceId && sourceWorkspace.rootPath === destinationWorkspace.rootPath) copyFailure('invalid-input');
  const sourceKind = copyData(input, 'sourceKind');
  if (!['regular_file', 'directory', 'projection_absent'].includes(sourceKind as string)) copyFailure('invalid-input');
  const sourceProjectionPolicy = copyData(input, 'sourceProjectionPolicy', true);
  if (Object.hasOwn(input, 'sourceProjectionPolicy') && sourceProjectionPolicy !== 'native-derived-leaves-v2') copyFailure('invalid-input');
  return freezeCopyData({ sourceWorkspace, destinationWorkspace, sourcePath, destinationPath,
    sourceKind: sourceKind as PreparedWorkspacePathCopyInput['sourceKind'], budget: budget(copyData(input, 'budget', true)),
    projectionPaths: projections(copyData(input, 'projectionPaths', true), sourcePath, sourceKind as string),
    ...(sourceProjectionPolicy === undefined ? {} : { sourceProjectionPolicy: 'native-derived-leaves-v2' as const }) });
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
export function decodePreparedWorkspacePathCopyOriginal(input: unknown): PreparedWorkspacePathCopyOriginal {
  const captured = captureWorkspaceOperationNativePlanData(input, reason => copyFailure(reason === 'too-large' ? 'budget-exceeded' : 'invalid-input'));
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
