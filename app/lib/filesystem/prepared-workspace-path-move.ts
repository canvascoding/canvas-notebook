import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { getFdDirectoryInventoryBackend, getFdPathMoveBackend, getFdPublicationBackend,
  type FdDirectoryInventoryBackend, type FdPathMoveBackend, type FdPublicationBackend } from '../files/fd-publication';
import { capturePathMoveRequest, capturePathMoveScope, capturePreparedWorkspacePathMoveParents,
  captureRecoveredWorkspacePathMoves,
  decodePreparedWorkspacePathMoveOriginal, freezePathMoveData, pathMoveCanonicalPath, pathMoveDataProperty,
  preparedWorkspacePathMoveProof, PreparedWorkspacePathMoveError,
  type PreparedPathMoveDirectory, type PreparedPathMoveEntry, type PreparedPathMoveErrorCode, type PreparedPathMoveIdentity,
  type PreparedPathMoveParents, type PreparedPathMoveSource, type PreparedWorkspacePathMoveInput,
  type PreparedWorkspacePathMoveOriginal, type PreparedWorkspacePathMoveParentReceipt,
  type PreparedWorkspacePathMoveReceipt, type RecoveredWorkspacePathMoveInput,
  type RecoveredWorkspacePathMovesInput } from './prepared-workspace-path-move-contract';

export * from './prepared-workspace-path-move-contract';
declare const preparedBrand: unique symbol;
export type PreparedWorkspacePathMove = Readonly<{ [preparedBrand]: true }>;
type Request = ReturnType<typeof capturePathMoveRequest>;
type Pin = { fd: number; relativePath: string; parent?: Pin; name?: string; identity: PreparedPathMoveIdentity };
type Entry = { kind: 'regular_file' | 'directory' | 'other'; fd?: number; identity?: PreparedPathMoveIdentity };
type Stage = {
  request: Request; io: FdPublicationBackend; inventory: FdDirectoryInventoryBackend; move: FdPathMoveBackend;
  phase: 'preparing' | 'callback' | 'draining' | 'closed'; failure: Error | null; fds: Set<number>; closeFailures: unknown[];
  root?: Pin; resolvedRoot?: string; anchors: Map<string, Pin>; sourceFd?: number;
  facts?: PreparedWorkspacePathMoveOriginal; createdParents: PreparedWorkspacePathMoveParentReceipt[];
  sharedParents?: PreparedWorkspacePathMoveParentReceipt[];
  disposition: 'pending' | 'already_moved' | 'projection_absent'; pending: Promise<unknown> | null;
  started: boolean; mutationAttempted: boolean; receipt?: PreparedWorkspacePathMoveReceipt;
  pendingParent?: PreparedWorkspacePathMoveParentReceipt;
};
const stages = new WeakMap<PreparedWorkspacePathMove, Stage>();
const activeStage = new AsyncLocalStorage<Stage>();
// A dedicated batch frame is explicit. Ordinary single callbacks still cannot
// nest, inherit another callback's cap, or create a batch from an ALS/DTO value.
const activeBatch = new AsyncLocalStorage<ReadonlySet<Stage>>();
const chunkBytes = 256 * 1024;
const parentPath = (value: string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const leaf = (value: string) => value.slice(value.lastIndexOf('/') + 1);
const codeOf = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
function failure(stage: Stage | undefined, code: PreparedPathMoveErrorCode): PreparedWorkspacePathMoveError {
  const error = new PreparedWorkspacePathMoveError(code, stage?.mutationAttempted ?? false);
  if (stage && !stage.failure) stage.failure = error;
  return error;
}
function poison(stage: Stage | undefined, error: unknown): Error {
  const normalized = error instanceof Error ? error : failure(stage, 'move-unconfirmed');
  if (stage && !stage.failure) stage.failure = normalized;
  const active = activeStage.getStore(); if (active && active !== stage && !active.failure) active.failure = normalized;
  for (const member of activeBatch.getStore() ?? []) if (!member.failure) member.failure = normalized;
  return normalized;
}
function internal(stage: Stage): void {
  if (stage.failure) throw stage.failure;
  if (stage.phase === 'closed') throw poison(stage, failure(stage, 'invalid-lifetime'));
}
function current(cap: PreparedWorkspacePathMove): Stage {
  const stage = stages.get(cap);
  const batch = activeBatch.getStore();
  if (!stage || activeStage.getStore() !== stage && !batch?.has(stage) || stage.phase !== 'callback') throw poison(stage, failure(stage, 'invalid-lifetime'));
  internal(stage);
  if (stage.pending || batch && [...batch].some(member => member.pending)) throw poison(stage, failure(stage, 'reentrant-operation'));
  return stage;
}
function identity(info: BigIntStats): PreparedPathMoveIdentity {
  return freezePathMoveData({ device: info.dev.toString(), inode: info.ino.toString(), mode: Number(info.mode),
    uid: Number(info.uid), gid: Number(info.gid), linkCount: info.nlink.toString(), size: info.size.toString(),
    birthtimeNs: info.birthtimeNs.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() });
}
function sameNode(left: PreparedPathMoveIdentity, right: PreparedPathMoveIdentity): boolean {
  return (['device', 'inode', 'mode', 'uid', 'gid', 'birthtimeNs'] as const).every(key => left[key] === right[key]);
}
function sameIdentity(left: PreparedPathMoveIdentity, right: PreparedPathMoveIdentity, allowRootCtime = false): boolean {
  return sameNode(left, right) && left.size === right.size && left.linkCount === right.linkCount && left.mtimeNs === right.mtimeNs
    && (allowRootCtime || left.ctimeNs === right.ctimeNs);
}
function stat(fd: number): BigIntStats { return fs.fstatSync(fd, { bigint: true }); }
function ownDirectory(stage: Stage, info: BigIntStats): void {
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid!()) || info.nlink < BigInt(1) || (info.mode & BigInt(0o022))) throw failure(stage, 'unsafe-path');
}
function ownFile(stage: Stage, info: BigIntStats): void {
  if (!info.isFile() || info.uid !== BigInt(process.geteuid!()) || info.nlink !== BigInt(1) || (info.mode & BigInt(0o022))) throw failure(stage, 'unsafe-path');
}
function owned(stage: Stage, fd: number): number { stage.fds.add(fd); return fd; }
function close(stage: Stage, fd: number): void {
  if (!stage.fds.delete(fd)) throw failure(stage, 'disposal-unconfirmed');
  try { fs.closeSync(fd); }
  catch (error) { stage.closeFailures.push(error); throw new PreparedWorkspacePathMoveError('disposal-unconfirmed', stage.mutationAttempted, { cause: error }); }
}
function disposeEntry(stage: Stage, entry: Entry | null): void { if (entry?.fd !== undefined) close(stage, entry.fd); }
function openEntry(stage: Stage, parent: Pin, name: string): Entry | null {
  internal(stage);
  try {
    const fd = owned(stage, stage.io.openDirectoryAt(parent.fd, name));
    return { kind: 'directory', fd, identity: identity(stat(fd)) };
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return null;
    if (code !== 'ENOTDIR') {
      if (['ELOOP', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR', 'EACCES', 'EPERM'].includes(code)) return { kind: 'other' };
      throw error;
    }
  }
  try {
    const fd = owned(stage, stage.io.openFileAt(parent.fd, name, 'readonly'));
    return { kind: 'regular_file', fd, identity: identity(stat(fd)) };
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return null;
    if (['ELOOP', 'ENOTDIR', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR', 'EACCES', 'EPERM'].includes(code)) return { kind: 'other' };
    throw error;
  }
}
function verifyAnchors(stage: Stage): void {
  try {
    internal(stage);
    const configured = fs.lstatSync(stage.request.workspace.rootPath, { bigint: true });
    if (!configured.isDirectory() || configured.isSymbolicLink() || fs.realpathSync(stage.request.workspace.rootPath) !== stage.resolvedRoot
      || !sameNode(identity(configured), stage.root!.identity)) throw failure(stage, 'scope-changed');
    for (const pin of stage.anchors.values()) {
      ownDirectory(stage, stat(pin.fd));
      if (!sameNode(identity(stat(pin.fd)), pin.identity)) throw failure(stage, 'scope-changed');
      if (!pin.parent) continue;
      if (!stage.io.hasExactNameAt(pin.parent.fd, pin.name!)) throw failure(stage, 'scope-changed');
      let fd: number | undefined;
      try {
        fd = owned(stage, stage.io.openDirectoryAt(pin.parent.fd, pin.name!));
        if (!sameNode(identity(stat(fd)), pin.identity)) throw failure(stage, 'scope-changed');
      } catch (error) { throw poison(stage, error); }
      finally { if (fd !== undefined) close(stage, fd); }
    }
  } catch (error) {
    if (error instanceof PreparedWorkspacePathMoveError) throw error;
    const mapped = new PreparedWorkspacePathMoveError('scope-changed', stage.mutationAttempted, { cause: error });
    if (stage.failure === error) stage.failure = mapped;
    throw mapped;
  }
}
function pinRoot(stage: Stage): void {
  const named = fs.lstatSync(stage.request.workspace.rootPath, { bigint: true }); ownDirectory(stage, named);
  if (named.isSymbolicLink()) throw failure(stage, 'unsafe-path');
  const resolved = fs.realpathSync(stage.request.workspace.rootPath);
  const fd = owned(stage, fs.openSync(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  const opened = stat(fd); ownDirectory(stage, opened);
  if (!sameNode(identity(named), identity(opened))) throw failure(stage, 'scope-changed');
  stage.resolvedRoot = resolved; stage.root = { fd, relativePath: '', identity: identity(opened) }; stage.anchors.set('', stage.root);
  verifyAnchors(stage);
}
function parents(stage: Stage, pathname: string): PreparedPathMoveParents {
  let parent = stage.root!; const directories: PreparedPathMoveDirectory[] = [];
  const components = pathname.split('/').slice(0, -1);
  for (let index = 0; index < components.length; index++) {
    const relativePath = components.slice(0, index + 1).join('/'), name = components[index];
    const present = stage.anchors.get(relativePath);
    if (present) { parent = present; directories.push({ relativePath, identity: present.identity }); continue; }
    const exact = stage.io.hasExactNameAt(parent.fd, name), entry = openEntry(stage, parent, name);
    if (!entry) return freezePathMoveData({ directories, missingPrefix: relativePath });
    if (!exact || entry.kind !== 'directory' || entry.fd === undefined) { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
    ownDirectory(stage, stat(entry.fd));
    const pin: Pin = { fd: entry.fd, relativePath, parent, name, identity: entry.identity! };
    stage.anchors.set(relativePath, pin); parent = pin; directories.push({ relativePath, identity: pin.identity });
  }
  return freezePathMoveData({ directories, missingPrefix: null });
}
function assertParentFacts(stage: Stage, actual: PreparedPathMoveParents, expected: PreparedPathMoveParents): void {
  if (actual.missingPrefix !== expected.missingPrefix || actual.directories.length !== expected.directories.length
    || actual.directories.some((item, index) => item.relativePath !== expected.directories[index].relativePath
      || !sameNode(item.identity, expected.directories[index].identity))) throw failure(stage, 'recovery-conflict');
}
function assertAbsent(stage: Stage, pathname: string, facts: PreparedPathMoveParents, code: PreparedPathMoveErrorCode): void {
  const missing = facts.missingPrefix ?? pathname, parent = stage.anchors.get(parentPath(missing));
  if (!parent) throw failure(stage, code);
  const entry = openEntry(stage, parent, leaf(missing));
  if (entry) { disposeEntry(stage, entry); throw failure(stage, code); }
  if (stage.io.hasExactNameAt(parent.fd, leaf(missing))) throw failure(stage, code);
}
function originalIdentity(source: PreparedPathMoveSource): PreparedPathMoveIdentity | undefined {
  return source.kind === 'projection_absent' ? undefined : source.kind === 'regular_file' ? source.identity : source.entries[0].identity;
}
function sameSource(left: PreparedPathMoveSource, right: PreparedPathMoveSource, allowRootCtime = false): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'projection_absent' || right.kind === 'projection_absent') return true;
  if (left.kind === 'regular_file' && right.kind === 'regular_file') return left.sha256 === right.sha256 && sameIdentity(left.identity, right.identity, allowRootCtime);
  if (left.kind !== 'directory' || right.kind !== 'directory' || left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return entry.relativePath === other.relativePath && entry.kind === other.kind
      && sameIdentity(entry.identity, other.identity, allowRootCtime && index === 0)
      && (entry.kind !== 'regular_file' || other.kind === 'regular_file' && entry.sha256 === other.sha256);
  });
}
async function read(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buffer, 0, length, position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
}
async function hashFile(stage: Stage, fd: number, remainingBytes: bigint): Promise<{ identity: PreparedPathMoveIdentity; sha256: string }> {
  internal(stage); const before = stat(fd); ownFile(stage, before);
  if (before.size > remainingBytes || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure(stage, 'budget-exceeded');
  const expected = identity(before), buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256'); let position = 0;
  while (position < Number(before.size)) {
    internal(stage); const count = await read(fd, buffer, Math.min(buffer.length, Number(before.size) - position), position);
    if (!count) throw failure(stage, 'source-changed'); hash.update(buffer.subarray(0, count)); position += count;
  }
  if (await read(fd, buffer, 1, position) !== 0 || !sameIdentity(identity(stat(fd)), expected)) throw failure(stage, 'source-changed');
  internal(stage); return { identity: expected, sha256: hash.digest('hex') };
}
async function snapshot(stage: Stage, fd: number, kind: 'regular_file' | 'directory'): Promise<Exclude<PreparedPathMoveSource, { kind: 'projection_absent' }>> {
  if (kind === 'regular_file') {
    if (stat(fd).size > BigInt(stage.request.budget.maxHashBytes)) throw failure(stage, 'budget-exceeded');
    return freezePathMoveData({ kind, ...await hashFile(stage, fd, BigInt(stage.request.budget.maxHashBytes)) });
  }
  const entries: PreparedPathMoveEntry[] = []; let bytes = BigInt(0);
  const visit = async (directory: Pin, relativePath: string, depth: number): Promise<void> => {
    internal(stage); const before = stat(directory.fd); ownDirectory(stage, before);
    if (depth > stage.request.budget.maxDepth || entries.length >= stage.request.budget.maxEntries) throw failure(stage, 'budget-exceeded');
    entries.push({ relativePath, kind: 'directory', identity: identity(before) });
    const names = [...stage.inventory.listDirectoryAt(directory.fd)].sort();
    for (const name of names) {
      const relative = relativePath ? relativePath + '/' + name : name;
      pathMoveCanonicalPath(stage.request.sourcePath + '/' + relative); pathMoveCanonicalPath(stage.request.destinationPath + '/' + relative);
      if (depth + 1 > stage.request.budget.maxDepth || entries.length >= stage.request.budget.maxEntries) throw failure(stage, 'budget-exceeded');
      const entry = openEntry(stage, directory, name);
      if (!entry || entry.fd === undefined || entry.kind === 'other') throw failure(stage, 'unsafe-path');
      try {
        if (entry.kind === 'directory') await visit({ fd: entry.fd, relativePath: relative, identity: entry.identity! }, relative, depth + 1);
        else {
          ownFile(stage, stat(entry.fd));
          const remainingBytes = BigInt(stage.request.budget.maxHashBytes) - bytes;
          if (stat(entry.fd).size > remainingBytes) throw failure(stage, 'budget-exceeded');
          const hashed = await hashFile(stage, entry.fd, remainingBytes);
          bytes += BigInt(hashed.identity.size);
          entries.push({ relativePath: relative, kind: 'regular_file', ...hashed });
        }
      } catch (error) { throw poison(stage, error); }
      finally { close(stage, entry.fd); }
    }
    if (!isDeepStrictEqual(names, [...stage.inventory.listDirectoryAt(directory.fd)].sort())
      || !sameIdentity(identity(before), identity(stat(directory.fd)))) throw failure(stage, 'source-changed');
  };
  await visit({ fd, relativePath: '', identity: identity(stat(fd)) }, '', 0);
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return freezePathMoveData({ kind, entries });
}
function leafEntry(stage: Stage, pathname: string): Entry | null {
  const pin = stage.anchors.get(parentPath(pathname));
  if (!pin) return null;
  return openEntry(stage, pin, leaf(pathname));
}
function exactLeaf(stage: Stage, pathname: string): boolean {
  const pin = stage.anchors.get(parentPath(pathname)); return !!pin && stage.io.hasExactNameAt(pin.fd, leaf(pathname));
}
function expectedDestinationParents(stage: Stage): PreparedPathMoveParents {
  const facts = stage.facts!, known = [...stage.createdParents, ...stage.sharedParents ?? []]
    .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
  const directories = [...facts.filesystem.destinationParents.directories,
    ...known.map(item => ({ relativePath: item.relativePath, identity: item.identity }))];
  const components = facts.destinationPath.split('/').slice(0, -1);
  if (directories.length > components.length || directories.some((entry, index) => entry.relativePath !== components.slice(0, index + 1).join('/'))) {
    throw failure(stage, 'recovery-conflict');
  }
  return { directories, missingPrefix: directories.length < components.length ? components.slice(0, directories.length + 1).join('/') : null };
}
function verifyVacancy(stage: Stage): void {
  const facts = stage.facts!;
  const targetParents = parents(stage, facts.destinationPath);
  assertParentFacts(stage, targetParents, expectedDestinationParents(stage));
  if (targetParents.missingPrefix) { assertAbsent(stage, facts.destinationPath, targetParents, 'destination-occupied'); return; }
  const exact = exactLeaf(stage, facts.destinationPath), entry = leafEntry(stage, facts.destinationPath);
  try {
    if (entry && !(facts.caseOnlyAlias && !exact && entry.identity && sameNode(entry.identity, originalIdentity(facts.source)!))) throw failure(stage, 'destination-occupied');
  } finally { disposeEntry(stage, entry); }
}
async function verifySourceAt(stage: Stage, pathname: string, expected: PreparedPathMoveSource, allowRootCtime = false): Promise<PreparedPathMoveSource> {
  internal(stage); verifyAnchors(stage);
  if (expected.kind === 'projection_absent') {
    assertAbsent(stage, pathname, stage.facts!.filesystem.sourceParents, 'source-changed'); return expected;
  }
  if (!exactLeaf(stage, pathname)) throw failure(stage, 'source-changed');
  const entry = leafEntry(stage, pathname);
  try {
    if (!entry || entry.kind !== expected.kind || entry.fd === undefined || !entry.identity
      || !sameNode(entry.identity, originalIdentity(expected)!) || stage.sourceFd === undefined
      || !sameNode(identity(stat(stage.sourceFd)), entry.identity)) throw failure(stage, 'source-changed');
    const observed = await snapshot(stage, stage.sourceFd, expected.kind);
    if (!sameSource(observed, expected, allowRootCtime)) throw failure(stage, 'source-changed');
    const final = leafEntry(stage, pathname);
    try {
      if (!exactLeaf(stage, pathname) || !final?.identity || !sameIdentity(final.identity, originalIdentity(observed)!)) throw failure(stage, 'source-changed');
    } finally { disposeEntry(stage, final); }
    verifyAnchors(stage); return observed;
  } finally { disposeEntry(stage, entry); }
}
function assertOriginalLeftSource(stage: Stage): void {
  if (!exactLeaf(stage, stage.facts!.sourcePath)) return;
  const entry = leafEntry(stage, stage.facts!.sourcePath);
  try { if (entry?.identity && sameNode(entry.identity, originalIdentity(stage.facts!.source)!)) throw failure(stage, 'recovery-conflict'); }
  finally { disposeEntry(stage, entry); }
}
async function verifyCurrent(stage: Stage): Promise<void> {
  verifyAnchors(stage);
  if (stage.facts!.source.kind === 'projection_absent') {
    assertAbsent(stage, stage.facts!.sourcePath, stage.facts!.filesystem.sourceParents, 'source-changed'); verifyVacancy(stage); return;
  }
  if (stage.receipt?.observation.kind === 'moved') {
    await verifySourceAt(stage, stage.facts!.destinationPath, stage.receipt.observation.source); assertOriginalLeftSource(stage);
  } else if (stage.disposition === 'already_moved') {
    await verifySourceAt(stage, stage.facts!.destinationPath, stage.facts!.source, true); assertOriginalLeftSource(stage);
  } else { await verifySourceAt(stage, stage.facts!.sourcePath, stage.facts!.source); verifyVacancy(stage); }
  internal(stage);
}
async function initialize(stage: Stage): Promise<void> {
  pinRoot(stage);
  const sourceParents = parents(stage, stage.request.sourcePath), destinationParents = parents(stage, stage.request.destinationPath);
  let source: PreparedPathMoveSource, caseOnlyAlias = false;
  if (stage.request.sourceKind === 'projection_absent') {
    assertAbsent(stage, stage.request.sourcePath, sourceParents, 'source-changed');
    assertAbsent(stage, stage.request.destinationPath, destinationParents, 'destination-occupied'); source = { kind: 'projection_absent' };
  } else {
    if (sourceParents.missingPrefix || !exactLeaf(stage, stage.request.sourcePath)) throw failure(stage, 'source-changed');
    const entry = leafEntry(stage, stage.request.sourcePath);
    if (!entry || entry.kind !== stage.request.sourceKind || entry.fd === undefined) { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
    stage.sourceFd = entry.fd; source = await snapshot(stage, entry.fd, stage.request.sourceKind);
    if (!destinationParents.missingPrefix) {
      const exact = exactLeaf(stage, stage.request.destinationPath), target = leafEntry(stage, stage.request.destinationPath);
      try {
        if (target) {
          caseOnlyAlias = !exact && parentPath(stage.request.sourcePath) === parentPath(stage.request.destinationPath)
            && !!target.identity && sameNode(target.identity, originalIdentity(source)!);
          if (!caseOnlyAlias) throw failure(stage, 'destination-occupied');
        }
      } finally { disposeEntry(stage, target); }
    }
  }
  stage.facts = decodePreparedWorkspacePathMoveOriginal({ version: 1, workspace: stage.request.workspace,
    sourcePath: stage.request.sourcePath, destinationPath: stage.request.destinationPath, budget: stage.request.budget, caseOnlyAlias,
    filesystem: { root: { resolvedPath: stage.resolvedRoot!, identity: stage.root!.identity }, sourceParents, destinationParents }, source });
  stage.disposition = source.kind === 'projection_absent' ? 'projection_absent' : 'pending'; await verifyCurrent(stage);
}
async function sync(stage: Stage, fd: number): Promise<void> {
  internal(stage); await new Promise<void>((resolve, reject) => fs.fsync(fd, error => error ? reject(error) : resolve())); internal(stage);
}
async function createParents(stage: Stage, onParentCreated?: (receipt: PreparedWorkspacePathMoveParentReceipt) => Promise<void>): Promise<void> {
  const currentParents = parents(stage, stage.facts!.destinationPath);
  if (!currentParents.missingPrefix) return;
  if (typeof onParentCreated !== 'function') throw failure(stage, 'parent-journal-required');
  const components = stage.facts!.destinationPath.split('/').slice(0, -1);
  let parent = stage.anchors.get(parentPath(currentParents.missingPrefix))!;
  for (let index = currentParents.directories.length; index < components.length; index++) {
    internal(stage); verifyAnchors(stage);
    const name = components[index], relativePath = components.slice(0, index + 1).join('/');
    const prior = openEntry(stage, parent, name);
    if (prior) { disposeEntry(stage, prior); throw failure(stage, 'destination-occupied'); }
    stage.mutationAttempted = true;
    try {
      stage.io.mkdirAt(parent.fd, name, 0o755);
      if (!stage.io.hasExactNameAt(parent.fd, name)) throw failure(stage, 'parent-create-unconfirmed');
      const fd = owned(stage, stage.io.openDirectoryAt(parent.fd, name));
      const pin: Pin = { fd, relativePath, parent, name, identity: identity(stat(fd)) }; ownDirectory(stage, stat(fd));
      stage.anchors.set(relativePath, pin);
      await sync(stage, fd); await sync(stage, parent.fd);
      const receipt = freezePathMoveData({ version: 1 as const, originalProof: preparedWorkspacePathMoveProof(stage.facts!), relativePath, identity: pin.identity });
      stage.pendingParent = receipt;
      try { await onParentCreated(receipt); internal(stage); stage.createdParents.push(receipt); parent = pin; }
      finally { stage.pendingParent = undefined; }
    } catch (error) {
      throw new PreparedWorkspacePathMoveError('parent-create-unconfirmed', true, { cause: error });
    }
  }
}
async function recover(stage: Stage, original: PreparedWorkspacePathMoveOriginal, created: readonly PreparedWorkspacePathMoveParentReceipt[]): Promise<void> {
  stage.facts = original; stage.createdParents.push(...created); pinRoot(stage);
  if (stage.resolvedRoot !== original.filesystem.root.resolvedPath || !sameNode(stage.root!.identity, original.filesystem.root.identity)) throw failure(stage, 'recovery-conflict');
  const sourceParents = parents(stage, original.sourcePath), destinationParents = parents(stage, original.destinationPath);
  assertParentFacts(stage, sourceParents, original.filesystem.sourceParents);
  assertParentFacts(stage, destinationParents, expectedDestinationParents(stage));
  if (original.source.kind === 'projection_absent') {
    if (created.length) throw failure(stage, 'recovery-conflict');
    stage.disposition = 'projection_absent'; await verifyCurrent(stage); return;
  }
  const sourceExact = exactLeaf(stage, original.sourcePath), destinationExact = exactLeaf(stage, original.destinationPath);
  const source = sourceExact ? leafEntry(stage, original.sourcePath) : null, destination = destinationExact ? leafEntry(stage, original.destinationPath) : null;
  const originalNode = originalIdentity(original.source)!; let keep: number | undefined;
  try {
    const atSource = !!source?.identity && sameNode(source.identity, originalNode);
    const atDestination = !!destination?.identity && sameNode(destination.identity, originalNode);
    if (atSource && !atDestination && !destinationExact) {
      if (source!.fd === undefined || source!.kind !== original.source.kind) throw failure(stage, 'recovery-conflict');
      keep = source!.fd; stage.sourceFd = keep; stage.disposition = 'pending'; await verifyCurrent(stage);
    } else if (atDestination && !atSource) {
      if (destination!.fd === undefined || destination!.kind !== original.source.kind) throw failure(stage, 'recovery-conflict');
      keep = destination!.fd; stage.sourceFd = keep; stage.disposition = 'already_moved'; await verifyCurrent(stage);
    } else throw failure(stage, 'recovery-conflict');
  } catch (error) {
    if (error instanceof PreparedWorkspacePathMoveError && error.code === 'disposal-unconfirmed') throw error;
    throw new PreparedWorkspacePathMoveError('recovery-conflict', false, { cause: error });
  } finally { if (source?.fd !== undefined && source.fd !== keep) close(stage, source.fd); if (destination?.fd !== undefined && destination.fd !== keep) close(stage, destination.fd); }
}
function operation<T>(cap: PreparedWorkspacePathMove, run: (stage: Stage) => Promise<T>): Promise<T> {
  let stage: Stage;
  try { stage = current(cap); } catch (error) { return Promise.reject(error); }
  const pending = Promise.resolve().then(() => run(stage)).catch(error => { throw poison(stage, error); });
  stage.pending = pending; void pending.then(() => { if (stage.pending === pending) stage.pending = null; }, () => { if (stage.pending === pending) stage.pending = null; });
  return pending;
}
export function readPreparedWorkspacePathMove(cap: PreparedWorkspacePathMove): PreparedWorkspacePathMoveOriginal { return current(cap).facts!; }
export function readPreparedWorkspacePathMoveDisposition(cap: PreparedWorkspacePathMove): Stage['disposition'] { return current(cap).disposition; }
export function assertPreparedWorkspacePathMoveCurrent(cap: PreparedWorkspacePathMove): Promise<void> { return operation(cap, verifyCurrent); }
/** Fixed synchronous birth observation for the durable ACK callback. It does
 * not reenter a pending FS operation or authorize the journal transaction. */
export function assertPreparedWorkspacePathMoveParentReceipt(cap: PreparedWorkspacePathMove,
  receipt: PreparedWorkspacePathMoveParentReceipt): void {
  const stage = stages.get(cap);
  if (arguments.length !== 2 || !stage || stage.phase !== 'callback'
    || activeStage.getStore() !== stage && !activeBatch.getStore()?.has(stage)) throw poison(stage, failure(stage, 'invalid-lifetime'));
  internal(stage);
  if (stage.pendingParent !== receipt && !stage.createdParents.includes(receipt)
    || receipt.originalProof !== preparedWorkspacePathMoveProof(stage.facts!)) throw poison(stage, failure(stage, 'recovery-conflict'));
}
/** Exact actual receipt and active cap only. This adds the stronger source-name
 * vacancy needed by a source collector; ordinary recovery deliberately permits D2. */
export function assertPreparedWorkspacePathMoveReceiptCurrent(cap: PreparedWorkspacePathMove,
  receipt: PreparedWorkspacePathMoveReceipt): Promise<void> {
  if (arguments.length !== 2) return Promise.reject(poison(stages.get(cap), failure(stages.get(cap), 'invalid-input')));
  return operation(cap, async stage => {
    if (!stage.receipt || stage.receipt !== receipt) throw failure(stage, 'recovery-conflict');
    await verifyCurrent(stage);
    if (exactLeaf(stage, stage.facts!.sourcePath)) throw failure(stage, 'recovery-conflict');
    internal(stage);
  });
}
/** The caller MUST durably commit the original intent before invoking this.
 * Parent receipts must be durably acknowledged by onParentCreated before the
 * next publication. Lost/unacknowledged parent births are recovery conflicts. */
export function movePreparedWorkspacePath(cap: PreparedWorkspacePathMove,
  onParentCreated?: (receipt: PreparedWorkspacePathMoveParentReceipt) => Promise<void>): Promise<PreparedWorkspacePathMoveReceipt> {
  if (arguments.length < 1 || arguments.length > 2 || onParentCreated !== undefined && typeof onParentCreated !== 'function') {
    return Promise.reject(poison(stages.get(cap), failure(stages.get(cap), 'invalid-input')));
  }
  return operation(cap, async stage => {
    if (stage.started) throw failure(stage, 'already-moved'); stage.started = true;
    await verifyCurrent(stage); internal(stage);
    if (stage.facts!.source.kind === 'projection_absent') {
      const receipt = freezePathMoveData({ version: 1 as const, original: stage.facts!, createdParents: [], observation: { kind: 'projection_absent' as const } });
      stage.receipt = receipt; return receipt;
    }
    if (stage.disposition !== 'already_moved') {
      await createParents(stage, onParentCreated); await verifyCurrent(stage); internal(stage);
      const sourceParent = stage.anchors.get(parentPath(stage.facts!.sourcePath))!, destinationParent = stage.anchors.get(parentPath(stage.facts!.destinationPath))!;
      stage.mutationAttempted = true;
      try { stage.move.renameNoReplaceAt(sourceParent.fd, leaf(stage.facts!.sourcePath), destinationParent.fd, leaf(stage.facts!.destinationPath)); }
      catch (error) { throw new PreparedWorkspacePathMoveError(codeOf(error) === 'EXDEV' ? 'cross-device-move' : codeOf(error) === 'EEXIST' ? 'destination-occupied' : 'move-unconfirmed', true, { cause: error }); }
      stage.disposition = 'already_moved';
    }
    const observed = await verifySourceAt(stage, stage.facts!.destinationPath, stage.facts!.source, true);
    assertOriginalLeftSource(stage); internal(stage);
    try {
      const parentFds = new Set([stage.anchors.get(parentPath(stage.facts!.sourcePath))!.fd, stage.anchors.get(parentPath(stage.facts!.destinationPath))!.fd]);
      for (const fd of parentFds) await sync(stage, fd);
      await verifySourceAt(stage, stage.facts!.destinationPath, observed); assertOriginalLeftSource(stage); internal(stage);
    } catch (error) { throw new PreparedWorkspacePathMoveError('move-unconfirmed', true, { cause: error }); }
    if (observed.kind === 'projection_absent') throw failure(stage, 'move-unconfirmed');
    const receipt = freezePathMoveData({ version: 1 as const, original: stage.facts!, createdParents: [...stage.createdParents],
      observation: { kind: 'moved' as const, method: 'rename-no-replace' as const, source: observed } });
    stage.receipt = receipt; return receipt;
  });
}
async function run<T>(request: Request, initializeStage: (stage: Stage) => Promise<void>, callback: (cap: PreparedWorkspacePathMove) => Promise<T>): Promise<T> {
  const active = activeStage.getStore(); if (active || activeBatch.getStore()) throw poison(active, failure(active, 'reentrant-operation'));
  if (typeof callback !== 'function') throw failure(undefined, 'invalid-input');
  const stage: Stage = { request, io: getFdPublicationBackend(), inventory: getFdDirectoryInventoryBackend(), move: getFdPathMoveBackend(),
    phase: 'preparing', failure: null, fds: new Set(), closeFailures: [], anchors: new Map(), createdParents: [], disposition: 'pending', pending: null, started: false, mutationAttempted: false };
  let value: T | undefined;
  try {
    await initializeStage(stage); const cap = Object.freeze({}) as PreparedWorkspacePathMove; stages.set(cap, stage); stage.phase = 'callback';
    await activeStage.run(stage, async () => {
      try { value = await callback(cap); } catch (error) { poison(stage, error); }
      finally {
        stage.phase = 'draining'; const pending = stage.pending;
        if (pending) { poison(stage, failure(stage, 'unawaited-operation')); await Promise.allSettled([pending]); }
      }
    });
    if (stage.failure) throw stage.failure; return value as T;
  } catch (error) { throw poison(stage, error); }
  finally {
    stage.phase = 'closed';
    for (const fd of [...stage.fds].reverse()) try { close(stage, fd); } catch { /* Every failed close is retained by close(). */ }
    if (stage.closeFailures.length) throw new PreparedWorkspacePathMoveError('disposal-unconfirmed', stage.mutationAttempted,
      { cause: new AggregateError([...(stage.failure ? [stage.failure] : []), ...stage.closeFailures], 'Descriptor disposal could not be confirmed.') });
  }
}
export async function withPreparedWorkspacePathMove<T>(input: PreparedWorkspacePathMoveInput, callback: (cap: PreparedWorkspacePathMove) => Promise<T>): Promise<T> {
  try { return await run(capturePathMoveRequest(input), initialize, callback); }
  catch (error) { throw poison(activeStage.getStore(), error); }
}
export async function withRecoveredWorkspacePathMove<T>(input: RecoveredWorkspacePathMoveInput, callback: (cap: PreparedWorkspacePathMove) => Promise<T>): Promise<T> {
  try {
    if (Reflect.ownKeys(input ?? {}).some(key => !['workspace', 'original', 'createdParents'].includes(key as string))) throw failure(undefined, 'invalid-input');
    const workspace = capturePathMoveScope(pathMoveDataProperty(input, 'workspace'));
    const original = decodePreparedWorkspacePathMoveOriginal(pathMoveDataProperty(input, 'original'));
    if (!isDeepStrictEqual(workspace, original.workspace)) throw failure(undefined, 'scope-changed');
    const descriptor = Object.getOwnPropertyDescriptor(input, 'createdParents');
    if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) throw failure(undefined, 'invalid-input');
    const created = capturePreparedWorkspacePathMoveParents(descriptor?.value, original);
    const request = capturePathMoveRequest({ workspace: workspace as PreparedWorkspacePathMoveInput['workspace'],
      sourcePath: original.sourcePath, destinationPath: original.destinationPath, sourceKind: original.source.kind, budget: original.budget });
    return await run(request, stage => recover(stage, original, created), callback);
  } catch (error) { throw poison(activeStage.getStore(), error); }
}

/** Consume an unchanged producer birth only after its durable journal ACK and
 * producer operation have finished. This proves FS mechanics, never membership
 * in a caller's journal or actor/claim authorization. */
export function bindPreparedWorkspacePathMoveSharedParent(consumerCap: PreparedWorkspacePathMove,
  producerCap: PreparedWorkspacePathMove, receipt: PreparedWorkspacePathMoveParentReceipt): Promise<void> {
  let consumer: Stage, producer: Stage;
  try {
    if (arguments.length !== 3) throw failure(undefined, 'invalid-input');
    consumer = current(consumerCap); producer = current(producerCap);
    const batch = activeBatch.getStore();
    if (!batch?.has(consumer) || !batch.has(producer) || consumer === producer || consumer.started
      || !producer.createdParents.includes(receipt) || receipt.originalProof !== preparedWorkspacePathMoveProof(producer.facts!)
      || !consumer.facts!.destinationPath.startsWith(receipt.relativePath + '/')
      || !consumer.facts!.filesystem.destinationParents.missingPrefix
      || ![receipt.relativePath, consumer.facts!.filesystem.destinationParents.missingPrefix].every(Boolean)
      || !(receipt.relativePath === consumer.facts!.filesystem.destinationParents.missingPrefix
        || receipt.relativePath.startsWith(consumer.facts!.filesystem.destinationParents.missingPrefix + '/'))
      || [...consumer.createdParents, ...consumer.sharedParents ?? []].some(parent => parent.relativePath === receipt.relativePath)) {
      throw failure(consumer, 'recovery-conflict');
    }
  } catch (error) { return Promise.reject(poison(stages.get(consumerCap), error)); }
  return operation(consumerCap, async stage => {
    internal(producer); stage.sharedParents ??= []; stage.sharedParents.push(receipt);
    await verifyCurrent(stage); internal(producer);
  });
}

export type PreparedWorkspacePathMoves = readonly Readonly<{ stepKey: string; cap: PreparedWorkspacePathMove }>[];
/** All inputs and the aggregate entry/hash budget are captured before any FD is
 * opened. The private frame admits exactly this bounded set for one callback;
 * every pending operation is drained and every held descriptor is closed. */
export async function withRecoveredWorkspacePathMoves<T>(input: RecoveredWorkspacePathMovesInput,
  callback: (prepared: PreparedWorkspacePathMoves) => Promise<T>): Promise<T> {
  const inherited = activeStage.getStore();
  if (inherited || activeBatch.getStore()) throw poison(inherited, failure(inherited, 'reentrant-operation'));
  const captured = captureRecoveredWorkspacePathMoves(input);
  if (typeof callback !== 'function') throw failure(undefined, 'invalid-input');
  const members: Stage[] = [], prepared: Array<{ stepKey: string; cap: PreparedWorkspacePathMove }> = [];
  let value: T | undefined, primary: Error | undefined;
  try {
    for (const move of captured.moves) {
      const original = move.original;
      const request = capturePathMoveRequest({ workspace: captured.workspace as PreparedWorkspacePathMoveInput['workspace'],
        sourcePath: original.sourcePath, destinationPath: original.destinationPath, sourceKind: original.source.kind, budget: original.budget });
      const stage: Stage = { request, io: getFdPublicationBackend(), inventory: getFdDirectoryInventoryBackend(), move: getFdPathMoveBackend(),
        phase: 'preparing', failure: null, fds: new Set(), closeFailures: [], anchors: new Map(), createdParents: [],
        sharedParents: captured.parents.filter(parent => parent.producerStep !== move.stepKey
          && parent.consumers.some(consumer => consumer.stepKey === move.stepKey)).map(parent => parent.receipt),
        disposition: 'pending', pending: null, started: false, mutationAttempted: false };
      members.push(stage);
      const created = captured.parents.filter(parent => parent.producerStep === move.stepKey).map(parent => parent.receipt)
        .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
      await recover(stage, original, created);
      const cap = Object.freeze({}) as PreparedWorkspacePathMove; stages.set(cap, stage);
      prepared.push({ stepKey: move.stepKey, cap });
    }
    for (const member of members) member.phase = 'callback';
    await activeBatch.run(new Set(members), async () => {
      try { value = await callback(freezePathMoveData(prepared)); }
      catch (error) { primary = poison(members[0], error); }
      finally {
        for (const member of members) member.phase = 'draining';
        const pending = members.flatMap(member => member.pending ? [member.pending] : []);
        if (pending.length) { primary ??= poison(members[0], failure(members[0], 'unawaited-operation')); await Promise.allSettled(pending); }
      }
    });
    for (const member of members) if (member.failure) throw member.failure;
    if (primary) throw primary;
    return value as T;
  } catch (error) {
    primary = error instanceof Error ? error : failure(undefined, 'move-unconfirmed');
    for (const member of members) member.failure ??= primary;
    throw primary;
  } finally {
    for (const member of members) {
      member.phase = 'closed';
      for (const fd of [...member.fds].reverse()) try { close(member, fd); } catch { /* Retain every close ACK failure below. */ }
    }
    const closes = members.flatMap(member => member.closeFailures);
    if (closes.length) throw new PreparedWorkspacePathMoveError('disposal-unconfirmed', members.some(member => member.mutationAttempted),
      { cause: new AggregateError([...(primary ? [primary] : []), ...closes], 'Batch descriptor disposal could not be confirmed.') });
  }
}
