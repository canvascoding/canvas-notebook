import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getFdDirectoryInventoryBackend, getFdPathMoveBackend, getFdPublicationBackend,
  type FdDirectoryInventoryBackend, type FdPathMoveBackend, type FdPublicationBackend } from '../files/fd-publication';
import { capturePreparedWorkspacePathTrashes, captureRecoveredWorkspacePathTrashes,
  decodePreparedWorkspacePathTrashOriginal, decodePreparedWorkspacePathTrashReceipt,
  freezePathTrashData, pathTrashCanonicalPath, PreparedWorkspacePathTrashError,
  type PreparedPathTrashBudget, type PreparedPathTrashDirectory, type PreparedPathTrashEntry,
  type PreparedPathTrashErrorCode, type PreparedPathTrashIdentity, type PreparedPathTrashParents,
  type PreparedPathTrashScope, type PreparedPathTrashSource, type PreparedWorkspacePathTrashOriginal,
  type PreparedWorkspacePathTrashReceipt, type PreparedWorkspacePathTrashesInput,
  type RecoveredWorkspacePathTrashesInput } from './prepared-workspace-path-trash-contract';
import { trashRelativePathFor } from './workspace-trash-layout';

export * from './prepared-workspace-path-trash-contract';
declare const preparedBrand: unique symbol;
export type PreparedWorkspacePathTrash = Readonly<{ [preparedBrand]: true }>;
export type PreparedWorkspacePathTrashes = readonly Readonly<{ stepKey: string; cap: PreparedWorkspacePathTrash }>[];
type Pin = { fd: number; relativePath: string; parent?: Pin; name?: string; identity: PreparedPathTrashIdentity };
type Root = { configured: string; resolved: string; pin: Pin; anchors: Map<string, Pin> };
type Entry = { kind: 'directory' | 'regular_file' | 'other'; fd?: number; identity?: PreparedPathTrashIdentity };
type Request = {
  workspace: PreparedPathTrashScope; canonicalPath: string; trashEntryId: string; trashRelativePath: string;
  sourceKind: PreparedPathTrashSource['kind']; budget: PreparedPathTrashBudget;
  retentionDays: number; deletedAtMs: number; expiresAtMs: number;
};
type Stage = {
  request: Request; frame: Frame; cohortRequests: readonly Request[]; io: FdPublicationBackend; inventory: FdDirectoryInventoryBackend; move: FdPathMoveBackend;
  phase: 'preparing' | 'callback' | 'draining' | 'closed'; failure: Error | null;
  fds: Set<number>; closeFailures: unknown[]; roots: Root[]; workspaceRoot?: Root; dataRoot?: Root;
  sourceFd?: number; facts?: PreparedWorkspacePathTrashOriginal; receipt?: PreparedWorkspacePathTrashReceipt;
  disposition: 'pending' | 'already_moved' | 'projection_absent'; pending: Promise<unknown> | null;
  started: boolean; mutationAttempted: boolean; snapshotBudget: PreparedPathTrashBudget;
};
type Frame = { members: Stage[]; phase: 'preparing' | 'callback' | 'draining' | 'closed'; failure: Error | null };
const stages = new WeakMap<PreparedWorkspacePathTrash, Stage>();
const activeBatch = new AsyncLocalStorage<Frame>();
const chunkBytes = 256 * 1024;
const parentPath = (value: string) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const leaf = (value: string) => value.slice(value.lastIndexOf('/') + 1);
const codeOf = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
function failure(stage: Stage | undefined, code: PreparedPathTrashErrorCode): PreparedWorkspacePathTrashError {
  const error = new PreparedWorkspacePathTrashError(code, stage?.mutationAttempted ?? false);
  if (stage && !stage.failure) stage.failure = error;
  return error;
}
function poison(stage: Stage | undefined, error: unknown): Error {
  const normalized = error instanceof Error ? error : failure(stage, 'move-unconfirmed');
  if (stage && !stage.failure) stage.failure = normalized;
  for (const frame of new Set([stage?.frame, activeBatch.getStore()])) if (frame) {
    frame.failure ??= normalized;
    for (const member of frame.members) member.failure ??= normalized;
  }
  return normalized;
}
function internal(stage: Stage): void {
  if (stage.failure) throw stage.failure;
  if (stage.phase === 'closed') throw poison(stage, failure(stage, 'invalid-lifetime'));
}
function current(cap: PreparedWorkspacePathTrash): Stage {
  const stage = stages.get(cap), frame = activeBatch.getStore();
  if (!stage || !frame || frame.phase !== 'callback' || !frame.members.includes(stage) || stage.phase !== 'callback') {
    throw poison(stage, failure(stage, 'invalid-lifetime'));
  }
  if (frame.failure) throw frame.failure;
  internal(stage);
  if (frame.members.some(member => member.pending)) throw poison(stage, failure(stage, 'reentrant-operation'));
  return stage;
}
function identity(info: BigIntStats): PreparedPathTrashIdentity {
  return freezePathTrashData({ device: info.dev.toString(), inode: info.ino.toString(), mode: Number(info.mode),
    uid: Number(info.uid), gid: Number(info.gid), linkCount: info.nlink.toString(), size: info.size.toString(),
    birthtimeNs: info.birthtimeNs.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() });
}
function sameNode(left: PreparedPathTrashIdentity, right: PreparedPathTrashIdentity): boolean {
  return (['device', 'inode', 'mode', 'uid', 'gid', 'birthtimeNs'] as const).every(key => left[key] === right[key]);
}
function sameIdentity(left: PreparedPathTrashIdentity, right: PreparedPathTrashIdentity, allowRootCtime = false): boolean {
  return sameNode(left, right) && left.size === right.size && left.linkCount === right.linkCount && left.mtimeNs === right.mtimeNs
    && (allowRootCtime || left.ctimeNs === right.ctimeNs);
}
function stat(fd: number): BigIntStats { return fs.fstatSync(fd, { bigint: true }); }
function ownDirectory(stage: Stage, info: BigIntStats, privateDirectory = false): void {
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid!()) || info.nlink < BigInt(1)
    || (info.mode & BigInt(privateDirectory ? 0o077 : 0o022))) throw failure(stage, 'unsafe-path');
}
function ownFile(stage: Stage, info: BigIntStats): void {
  if (!info.isFile() || info.uid !== BigInt(process.geteuid!()) || info.nlink !== BigInt(1)
    || (info.mode & BigInt(0o022))) throw failure(stage, 'unsafe-path');
}
function owned(stage: Stage, fd: number): number { stage.fds.add(fd); return fd; }
function close(stage: Stage, fd: number): void {
  if (!stage.fds.delete(fd)) throw failure(stage, 'disposal-unconfirmed');
  try { fs.closeSync(fd); }
  catch (error) {
    stage.closeFailures.push(error);
    throw new PreparedWorkspacePathTrashError('disposal-unconfirmed', stage.mutationAttempted, { cause: error });
  }
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
    if (codeOf(error) === 'ENOENT') return null;
    if (['ELOOP', 'ENOTDIR', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR', 'EACCES', 'EPERM'].includes(codeOf(error))) return { kind: 'other' };
    throw error;
  }
}
/** Capture the legacy numeric Stats fingerprint from this very same FD. Never
 * derive milliseconds by rounding nanosecond identities through Number. */
function observedIdentity(stage: Stage, fd: number): { identity: PreparedPathTrashIdentity; filesystemFingerprint: string } {
  const before = identity(stat(fd)), numeric = fs.fstatSync(fd), after = identity(stat(fd));
  if (!sameIdentity(before, after) || [numeric.dev, numeric.ino, numeric.size].some(value => !Number.isSafeInteger(value) || value < 0)
    || [numeric.mtimeMs, numeric.ctimeMs].some(value => !Number.isFinite(value))
    || String(numeric.dev) !== before.device || String(numeric.ino) !== before.inode || String(numeric.size) !== before.size) throw failure(stage, 'source-changed');
  return { identity: before, filesystemFingerprint: `${numeric.dev}:${numeric.ino}:${numeric.size}:${numeric.mtimeMs}:${numeric.ctimeMs}` };
}
function verifyAnchors(stage: Stage): void {
  try {
    internal(stage);
    for (const root of stage.roots) {
      const configured = fs.lstatSync(root.configured, { bigint: true });
      if (!configured.isDirectory() || configured.isSymbolicLink() || fs.realpathSync(root.configured) !== root.resolved
        || !sameNode(identity(configured), root.pin.identity)) throw failure(stage, 'scope-changed');
      for (const pin of root.anchors.values()) {
        ownDirectory(stage, stat(pin.fd), root === stage.dataRoot
          && pin.relativePath === parentPath(stage.request.trashRelativePath));
        if (!sameNode(identity(stat(pin.fd)), pin.identity)) throw failure(stage, 'scope-changed');
        if (!pin.parent) continue;
        if (!stage.io.hasExactNameAt(pin.parent.fd, pin.name!)) throw failure(stage, 'scope-changed');
        let fd: number | undefined;
        try {
          fd = owned(stage, stage.io.openDirectoryAt(pin.parent.fd, pin.name!));
          if (!sameNode(identity(stat(fd)), pin.identity)) throw failure(stage, 'scope-changed');
        } finally { if (fd !== undefined) close(stage, fd); }
      }
    }
  } catch (error) {
    if (error instanceof PreparedWorkspacePathTrashError) throw error;
    throw new PreparedWorkspacePathTrashError('scope-changed', stage.mutationAttempted, { cause: error });
  }
}
function pinRoot(stage: Stage, configured: string): Root {
  const named = fs.lstatSync(configured, { bigint: true }); ownDirectory(stage, named);
  if (named.isSymbolicLink()) throw failure(stage, 'unsafe-path');
  const resolved = fs.realpathSync(configured);
  const fd = owned(stage, fs.openSync(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  const opened = stat(fd); ownDirectory(stage, opened);
  if (!sameNode(identity(named), identity(opened))) throw failure(stage, 'scope-changed');
  const pin: Pin = { fd, relativePath: '', identity: identity(opened) };
  const root: Root = { configured, resolved, pin, anchors: new Map([['', pin]]) }; stage.roots.push(root);
  return root;
}
function pinRoots(stage: Stage): void {
  stage.workspaceRoot = pinRoot(stage, stage.request.workspace.rootPath);
  stage.dataRoot = pinRoot(stage, stage.request.workspace.dataRoot);
  verifyAnchors(stage);
  if (stage.workspaceRoot.pin.identity.device !== stage.dataRoot.pin.identity.device) throw failure(stage, 'cross-device-move');
  validatePhysicalLayout(stage.cohortRequests.map(request => ({ ...request, workspace: { ...request.workspace,
    rootPath: stage.workspaceRoot!.resolved, dataRoot: stage.dataRoot!.resolved } })));
}
function parents(stage: Stage, root: Root, pathname: string): PreparedPathTrashParents {
  let parent = root.pin; const directories: PreparedPathTrashDirectory[] = [];
  const components = pathname.split('/').slice(0, -1);
  for (let index = 0; index < components.length; index++) {
    const relativePath = components.slice(0, index + 1).join('/'), name = components[index];
    const present = root.anchors.get(relativePath);
    if (present) { parent = present; directories.push({ relativePath, identity: present.identity }); continue; }
    const exact = stage.io.hasExactNameAt(parent.fd, name), entry = openEntry(stage, parent, name);
    if (!entry) return freezePathTrashData({ directories, missingPrefix: relativePath });
    if (!exact || entry.kind !== 'directory' || entry.fd === undefined) { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
    ownDirectory(stage, stat(entry.fd), root === stage.dataRoot
      && relativePath === parentPath(stage.request.trashRelativePath));
    const pin: Pin = { fd: entry.fd, relativePath, parent, name, identity: entry.identity! };
    root.anchors.set(relativePath, pin); parent = pin; directories.push({ relativePath, identity: pin.identity });
  }
  return freezePathTrashData({ directories, missingPrefix: null });
}
function assertParentFacts(stage: Stage, actual: PreparedPathTrashParents, expected: PreparedPathTrashParents): void {
  if (actual.missingPrefix !== expected.missingPrefix || actual.directories.length !== expected.directories.length
    || actual.directories.some((item, index) => item.relativePath !== expected.directories[index].relativePath
      || !sameNode(item.identity, expected.directories[index].identity))) throw failure(stage, 'recovery-conflict');
}
function assertAbsent(stage: Stage, root: Root, pathname: string, facts: PreparedPathTrashParents,
  code: PreparedPathTrashErrorCode): void {
  const missing = facts.missingPrefix ?? pathname, parent = root.anchors.get(parentPath(missing));
  if (!parent) throw failure(stage, code);
  const entry = openEntry(stage, parent, leaf(missing));
  if (entry) { disposeEntry(stage, entry); throw failure(stage, code); }
  if (stage.io.hasExactNameAt(parent.fd, leaf(missing))) throw failure(stage, code);
}
function originalIdentity(source: PreparedPathTrashSource): PreparedPathTrashIdentity | undefined {
  return source.kind === 'projection_absent' ? undefined : source.kind === 'regular_file' ? source.identity : source.entries[0].identity;
}
function sameSource(left: PreparedPathTrashSource, right: PreparedPathTrashSource, allowRootCtime = false): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'projection_absent' || right.kind === 'projection_absent') return true;
  if (left.kind === 'regular_file' && right.kind === 'regular_file') return left.sha256 === right.sha256
    && sameIdentity(left.identity, right.identity, allowRootCtime)
    && (allowRootCtime || left.filesystemFingerprint === right.filesystemFingerprint);
  if (left.kind !== 'directory' || right.kind !== 'directory' || left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return entry.relativePath === other.relativePath && entry.kind === other.kind
      && sameIdentity(entry.identity, other.identity, allowRootCtime && index === 0)
      && (allowRootCtime && index === 0 || entry.filesystemFingerprint === other.filesystemFingerprint)
      && (entry.kind !== 'regular_file' || other.kind === 'regular_file' && entry.sha256 === other.sha256);
  });
}
async function read(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buffer, 0, length, position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
}
async function hashFile(stage: Stage, fd: number, remainingBytes: bigint) {
  internal(stage); const before = stat(fd); ownFile(stage, before);
  if (before.size > remainingBytes || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure(stage, 'budget-exceeded');
  const observed = observedIdentity(stage, fd), buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256'); let position = 0;
  while (position < Number(before.size)) {
    internal(stage); const count = await read(fd, buffer, Math.min(buffer.length, Number(before.size) - position), position);
    if (!count) throw failure(stage, 'source-changed'); hash.update(buffer.subarray(0, count)); position += count;
  }
  if (await read(fd, buffer, 1, position) !== 0 || !sameIdentity(identity(stat(fd)), observed.identity)) throw failure(stage, 'source-changed');
  internal(stage); return { ...observed, sha256: hash.digest('hex') };
}
async function snapshot(stage: Stage, fd: number, kind: 'regular_file' | 'directory'):
  Promise<Exclude<PreparedPathTrashSource, { kind: 'projection_absent' }>> {
  if (kind === 'regular_file') {
    if (stage.snapshotBudget.maxEntries < 1) throw failure(stage, 'budget-exceeded');
    return freezePathTrashData({ kind, ...await hashFile(stage, fd, BigInt(stage.snapshotBudget.maxHashBytes)) });
  }
  const entries: PreparedPathTrashEntry[] = []; let bytes = BigInt(0);
  const visit = async (directory: Pin, relativePath: string, depth: number): Promise<void> => {
    internal(stage); const before = stat(directory.fd); ownDirectory(stage, before);
    if (depth > stage.snapshotBudget.maxDepth || entries.length >= stage.snapshotBudget.maxEntries) throw failure(stage, 'budget-exceeded');
    const observed = observedIdentity(stage, directory.fd);
    entries.push({ relativePath, kind: 'directory', ...observed });
    const names = [...stage.inventory.listDirectoryAt(directory.fd)].sort();
    if (names.length > stage.snapshotBudget.maxEntries - entries.length) throw failure(stage, 'budget-exceeded');
    for (const name of names) {
      const relative = relativePath ? relativePath + '/' + name : name;
      pathTrashCanonicalPath(stage.request.canonicalPath + '/' + relative); pathTrashCanonicalPath(stage.request.trashRelativePath + '/' + relative);
      if (depth + 1 > stage.snapshotBudget.maxDepth || entries.length >= stage.snapshotBudget.maxEntries) throw failure(stage, 'budget-exceeded');
      const entry = openEntry(stage, directory, name);
      if (!entry || entry.fd === undefined || entry.kind === 'other') { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
      try {
        if (entry.identity!.device !== stage.workspaceRoot!.pin.identity.device) throw failure(stage, 'unsafe-path');
        if (entry.kind === 'directory') await visit({ fd: entry.fd, relativePath: relative, identity: entry.identity! }, relative, depth + 1);
        else {
          const hashed = await hashFile(stage, entry.fd, BigInt(stage.snapshotBudget.maxHashBytes) - bytes);
          bytes += BigInt(hashed.identity.size); entries.push({ relativePath: relative, kind: 'regular_file', ...hashed });
        }
      } catch (error) { throw poison(stage, error); }
      finally { close(stage, entry.fd); }
    }
    if (!isDeepStrictEqual(names, [...stage.inventory.listDirectoryAt(directory.fd)].sort())
      || !sameIdentity(identity(before), identity(stat(directory.fd)))) throw failure(stage, 'source-changed');
  };
  await visit({ fd, relativePath: '', identity: identity(stat(fd)) }, '', 0);
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return freezePathTrashData({ kind, entries });
}
function leafEntry(stage: Stage, root: Root, pathname: string): Entry | null {
  const pin = root.anchors.get(parentPath(pathname)); return pin ? openEntry(stage, pin, leaf(pathname)) : null;
}
function exactLeaf(stage: Stage, root: Root, pathname: string): boolean {
  const pin = root.anchors.get(parentPath(pathname)); return !!pin && stage.io.hasExactNameAt(pin.fd, leaf(pathname));
}
function verifyEntryContents(stage: Stage, moved: boolean): void {
  const entry = stage.dataRoot!.anchors.get(parentPath(stage.request.trashRelativePath));
  if (!entry) throw failure(stage, 'recovery-conflict');
  const names = stage.inventory.listDirectoryAt(entry.fd);
  if (moved ? names.length !== 1 || names[0] !== leaf(stage.request.trashRelativePath) : names.length !== 0) {
    throw failure(stage, 'destination-occupied');
  }
}
function verifySourceVacant(stage: Stage): void {
  verifyAnchors(stage);
  assertParentFacts(stage, parents(stage, stage.workspaceRoot!, stage.request.canonicalPath), stage.facts!.filesystem.sourceParents);
  assertAbsent(stage, stage.workspaceRoot!, stage.request.canonicalPath, stage.facts!.filesystem.sourceParents, 'source-changed');
}
async function verifySourceAt(stage: Stage, root: Root, pathname: string, expected: PreparedPathTrashSource,
  allowRootCtime = false): Promise<PreparedPathTrashSource> {
  internal(stage); verifyAnchors(stage);
  if (expected.kind === 'projection_absent') { verifySourceVacant(stage); return expected; }
  if (!exactLeaf(stage, root, pathname)) throw failure(stage, 'source-changed');
  const entry = leafEntry(stage, root, pathname);
  try {
    if (!entry || entry.kind !== expected.kind || entry.fd === undefined || !entry.identity
      || !sameNode(entry.identity, originalIdentity(expected)!) || stage.sourceFd === undefined
      || !sameNode(identity(stat(stage.sourceFd)), entry.identity)) throw failure(stage, 'source-changed');
    const observed = await snapshot(stage, stage.sourceFd, expected.kind);
    if (!sameSource(observed, expected, allowRootCtime)) throw failure(stage, 'source-changed');
    const final = leafEntry(stage, root, pathname);
    try {
      if (!exactLeaf(stage, root, pathname) || !final?.identity || !sameIdentity(final.identity, originalIdentity(observed)!)) throw failure(stage, 'source-changed');
    } finally { disposeEntry(stage, final); }
    verifyAnchors(stage); return observed;
  } finally { disposeEntry(stage, entry); }
}
async function verifyCurrent(stage: Stage): Promise<void> {
  verifyAnchors(stage);
  const facts = stage.facts!;
  assertParentFacts(stage, parents(stage, stage.workspaceRoot!, facts.canonicalPath), facts.filesystem.sourceParents);
  assertParentFacts(stage, parents(stage, stage.dataRoot!, facts.trashRelativePath), facts.filesystem.trashParents);
  if (facts.source.kind === 'projection_absent') { verifySourceVacant(stage); verifyEntryContents(stage, false); return; }
  if (stage.disposition === 'already_moved') {
    const expected = stage.receipt?.observation.kind === 'moved' ? stage.receipt.observation.source : facts.source;
    await verifySourceAt(stage, stage.dataRoot!, facts.trashRelativePath, expected, !stage.receipt);
    verifySourceVacant(stage); verifyEntryContents(stage, true);
  } else {
    await verifySourceAt(stage, stage.workspaceRoot!, facts.canonicalPath, facts.source);
    assertAbsent(stage, stage.dataRoot!, facts.trashRelativePath, facts.filesystem.trashParents, 'destination-occupied');
    verifyEntryContents(stage, false);
  }
  internal(stage);
}
async function sync(stage: Stage, fd: number): Promise<void> {
  internal(stage); await new Promise<void>((resolve, reject) => fs.fsync(fd, error => error ? reject(error) : resolve())); internal(stage);
}
async function reserveTrashParents(stage: Stage): Promise<PreparedPathTrashParents> {
  const root = stage.dataRoot!, components = stage.request.trashRelativePath.split('/').slice(0, -1);
  let parent = root.pin;
  for (let index = 0; index < components.length; index++) {
    internal(stage); verifyAnchors(stage);
    const name = components[index], last = index === components.length - 1;
    let created = false;
    try { stage.io.mkdirAt(parent.fd, name, 0o700); created = true; }
    catch (error) {
      if (last || codeOf(error) !== 'EEXIST') throw new PreparedWorkspacePathTrashError(
        codeOf(error) === 'EEXIST' ? 'destination-occupied' : 'move-unconfirmed', false, { cause: error });
    }
    if (!stage.io.hasExactNameAt(parent.fd, name)) throw failure(stage, 'unsafe-path');
    const entry = openEntry(stage, parent, name);
    if (!entry || entry.kind !== 'directory' || entry.fd === undefined) { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
    // Shared namespace parents also serve the existing single-file trash and
    // may be owned 0755 directories. Only this exclusive entry must be 0700;
    // every parent still rejects foreign ownership, symlinks and write access.
    ownDirectory(stage, stat(entry.fd), last);
    const relativePath = components.slice(0, index + 1).join('/');
    const pin: Pin = { fd: entry.fd, relativePath, parent, name, identity: entry.identity! };
    root.anchors.set(relativePath, pin);
    if (created) { await sync(stage, pin.fd); await sync(stage, parent.fd); }
    parent = pin;
  }
  verifyAnchors(stage); verifyEntryContents(stage, false);
  return parents(stage, root, stage.request.trashRelativePath);
}
async function initialize(stage: Stage): Promise<void> {
  pinRoots(stage);
  const sourceParents = parents(stage, stage.workspaceRoot!, stage.request.canonicalPath);
  let source: PreparedPathTrashSource;
  if (stage.request.sourceKind === 'projection_absent') {
    assertAbsent(stage, stage.workspaceRoot!, stage.request.canonicalPath, sourceParents, 'source-changed'); source = { kind: 'projection_absent' };
  } else {
    if (sourceParents.missingPrefix || !exactLeaf(stage, stage.workspaceRoot!, stage.request.canonicalPath)) throw failure(stage, 'source-changed');
    const entry = leafEntry(stage, stage.workspaceRoot!, stage.request.canonicalPath);
    if (!entry || entry.kind !== stage.request.sourceKind || entry.fd === undefined) { disposeEntry(stage, entry); throw failure(stage, 'unsafe-path'); }
    stage.sourceFd = entry.fd;
    if (entry.identity!.device !== stage.workspaceRoot!.pin.identity.device) throw failure(stage, 'unsafe-path');
    source = await snapshot(stage, entry.fd, stage.request.sourceKind);
  }
  const trashParents = await reserveTrashParents(stage);
  stage.facts = decodePreparedWorkspacePathTrashOriginal({ version: 1,
    workspace: stage.request.workspace, canonicalPath: stage.request.canonicalPath,
    trashEntryId: stage.request.trashEntryId, trashRelativePath: stage.request.trashRelativePath,
    retentionDays: stage.request.retentionDays, deletedAtMs: stage.request.deletedAtMs, expiresAtMs: stage.request.expiresAtMs,
    budget: stage.request.budget, sourceFingerprint: source.kind === 'projection_absent' ? null
      : source.kind === 'regular_file' ? source.filesystemFingerprint : source.entries[0].filesystemFingerprint,
    filesystem: {
      workspaceRoot: { resolvedPath: stage.workspaceRoot!.resolved, identity: stage.workspaceRoot!.pin.identity },
      dataRoot: { resolvedPath: stage.dataRoot!.resolved, identity: stage.dataRoot!.pin.identity }, sourceParents, trashParents,
    }, source });
  stage.disposition = source.kind === 'projection_absent' ? 'projection_absent' : 'pending'; await verifyCurrent(stage);
}
async function recover(stage: Stage, original: PreparedWorkspacePathTrashOriginal): Promise<void> {
  stage.facts = original; pinRoots(stage);
  for (const [root, expected] of [[stage.workspaceRoot!, original.filesystem.workspaceRoot], [stage.dataRoot!, original.filesystem.dataRoot]] as const) {
    if (root.resolved !== expected.resolvedPath || !sameNode(root.pin.identity, expected.identity)) throw failure(stage, 'recovery-conflict');
  }
  assertParentFacts(stage, parents(stage, stage.workspaceRoot!, original.canonicalPath), original.filesystem.sourceParents);
  assertParentFacts(stage, parents(stage, stage.dataRoot!, original.trashRelativePath), original.filesystem.trashParents);
  if (original.source.kind === 'projection_absent') { stage.disposition = 'projection_absent'; await verifyCurrent(stage); return; }
  const source = leafEntry(stage, stage.workspaceRoot!, original.canonicalPath);
  const target = leafEntry(stage, stage.dataRoot!, original.trashRelativePath);
  const expected = originalIdentity(original.source)!; let keep: number | undefined;
  try {
    const atSource = source?.identity && sameNode(source.identity, expected);
    const atTarget = target?.identity && sameNode(target.identity, expected);
    if (atSource && !target && exactLeaf(stage, stage.workspaceRoot!, original.canonicalPath)) {
      if (source!.fd === undefined || source!.kind !== original.source.kind) throw failure(stage, 'recovery-conflict');
      keep = source!.fd; stage.sourceFd = keep; stage.disposition = 'pending';
    } else if (atTarget && !source && exactLeaf(stage, stage.dataRoot!, original.trashRelativePath)) {
      if (target!.fd === undefined || target!.kind !== original.source.kind) throw failure(stage, 'recovery-conflict');
      keep = target!.fd; stage.sourceFd = keep; stage.disposition = 'already_moved';
    } else throw failure(stage, 'recovery-conflict');
    await verifyCurrent(stage);
  } catch (error) {
    if (error instanceof PreparedWorkspacePathTrashError && error.code === 'disposal-unconfirmed') throw error;
    throw new PreparedWorkspacePathTrashError('recovery-conflict', false, { cause: error });
  } finally {
    if (source?.fd !== undefined && source.fd !== keep) close(stage, source.fd);
    if (target?.fd !== undefined && target.fd !== keep) close(stage, target.fd);
  }
}
function operation<T>(cap: PreparedWorkspacePathTrash, run: (stage: Stage) => Promise<T>): Promise<T> {
  let stage: Stage;
  try { stage = current(cap); } catch (error) { return Promise.reject(error); }
  const pending = Promise.resolve().then(() => run(stage)).catch(error => { throw poison(stage, error); });
  stage.pending = pending;
  void pending.then(() => { if (stage.pending === pending) stage.pending = null; }, () => { if (stage.pending === pending) stage.pending = null; });
  return pending;
}
export function readPreparedWorkspacePathTrash(cap: PreparedWorkspacePathTrash): PreparedWorkspacePathTrashOriginal { return current(cap).facts!; }
export function readPreparedWorkspacePathTrashDisposition(cap: PreparedWorkspacePathTrash): Stage['disposition'] { return current(cap).disposition; }
export function assertPreparedWorkspacePathTrashCurrent(cap: PreparedWorkspacePathTrash): Promise<void> { return operation(cap, verifyCurrent); }
/** Strong pending-cohort source vacancy. A new D2 at the old name, a new
 * ancestor, a symlink, or a renamed source parent is always a conflict. */
export function assertPreparedWorkspacePathTrashSourceVacant(cap: PreparedWorkspacePathTrash): Promise<void> {
  return operation(cap, async stage => {
    if (stage.disposition === 'pending') throw failure(stage, 'invalid-lifetime');
    await verifyCurrent(stage); verifySourceVacant(stage);
  });
}
function actualReceipt(stage: Stage, observation: PreparedWorkspacePathTrashReceipt['observation']): PreparedWorkspacePathTrashReceipt {
  const checked = decodePreparedWorkspacePathTrashReceipt({ version: 1, original: stage.facts!, observation });
  return freezePathTrashData({ version: 1 as const, original: stage.facts!, observation: checked.observation });
}
/** Re-read a completed same-cap receipt, or observe a genuinely recovered
 * already-moved/absent cap before other roots resume. This never renames and a
 * decoded DTO cannot substitute for the returned live observation. */
export function readPreparedWorkspacePathTrashReceipt(cap: PreparedWorkspacePathTrash): Promise<PreparedWorkspacePathTrashReceipt> {
  return operation(cap, async stage => {
    await verifyCurrent(stage);
    if (stage.receipt) return stage.receipt;
    if (stage.disposition === 'pending') throw failure(stage, 'invalid-lifetime');
    const original = stage.facts!;
    if (original.source.kind === 'projection_absent') {
      stage.receipt = actualReceipt(stage, { kind: 'projection_absent' });
    } else {
      const observed = await verifySourceAt(stage, stage.dataRoot!, original.trashRelativePath, original.source, true);
      if (observed.kind === 'projection_absent') throw failure(stage, 'recovery-conflict');
      verifySourceVacant(stage); verifyEntryContents(stage, true);
      const parentFds = new Set([stage.workspaceRoot!.anchors.get(parentPath(original.canonicalPath))!.fd,
        stage.dataRoot!.anchors.get(parentPath(original.trashRelativePath))!.fd]);
      for (const fd of parentFds) await sync(stage, fd);
      await verifySourceAt(stage, stage.dataRoot!, original.trashRelativePath, observed);
      verifySourceVacant(stage); verifyEntryContents(stage, true); internal(stage);
      stage.receipt = actualReceipt(stage, { kind: 'moved', method: 'rename-no-replace', source: observed });
    }
    stage.started = true; return stage.receipt;
  });
}
export function assertPreparedWorkspacePathTrashReceiptCurrent(cap: PreparedWorkspacePathTrash,
  receipt: PreparedWorkspacePathTrashReceipt): Promise<void> {
  return operation(cap, async stage => {
    if (arguments.length !== 2 || !stage.receipt || stage.receipt !== receipt) throw failure(stage, 'recovery-conflict');
    await verifyCurrent(stage); verifySourceVacant(stage);
  });
}
/** The owner MUST durably commit original intent and hold the real lifecycle/
 * actor/admission fence before invoking this. One no-replace rename, no copy,
 * overwrite, inverse move, timeout extension or cross-device fallback. */
export function trashPreparedWorkspacePath(cap: PreparedWorkspacePathTrash): Promise<PreparedWorkspacePathTrashReceipt> {
  return operation(cap, async stage => {
    if (stage.started) throw failure(stage, 'already-moved'); stage.started = true;
    await verifyCurrent(stage); internal(stage);
    const original = stage.facts!;
    if (original.source.kind === 'projection_absent') {
      const receipt = actualReceipt(stage, { kind: 'projection_absent' });
      stage.receipt = receipt; return receipt;
    }
    if (stage.disposition !== 'already_moved') {
      const sourceParent = stage.workspaceRoot!.anchors.get(parentPath(original.canonicalPath))!;
      const destinationParent = stage.dataRoot!.anchors.get(parentPath(original.trashRelativePath))!;
      stage.mutationAttempted = true;
      try { stage.move.renameNoReplaceAt(sourceParent.fd, leaf(original.canonicalPath), destinationParent.fd, leaf(original.trashRelativePath)); }
      catch (error) {
        throw new PreparedWorkspacePathTrashError(codeOf(error) === 'EXDEV' ? 'cross-device-move'
          : codeOf(error) === 'EEXIST' ? 'destination-occupied' : 'move-unconfirmed', true, { cause: error });
      }
      stage.disposition = 'already_moved';
    }
    const observed = await verifySourceAt(stage, stage.dataRoot!, original.trashRelativePath, original.source, true);
    if (observed.kind === 'projection_absent') throw failure(stage, 'move-unconfirmed');
    verifySourceVacant(stage); verifyEntryContents(stage, true);
    try {
      const parentFds = new Set([stage.workspaceRoot!.anchors.get(parentPath(original.canonicalPath))!.fd,
        stage.dataRoot!.anchors.get(parentPath(original.trashRelativePath))!.fd]);
      for (const fd of parentFds) await sync(stage, fd);
      await verifySourceAt(stage, stage.dataRoot!, original.trashRelativePath, observed);
      verifySourceVacant(stage); verifyEntryContents(stage, true); internal(stage);
    } catch (error) { throw new PreparedWorkspacePathTrashError('move-unconfirmed', true, { cause: error }); }
    const receipt = actualReceipt(stage, { kind: 'moved', method: 'rename-no-replace', source: observed });
    stage.receipt = receipt; return receipt;
  });
}
function validatePhysicalLayout(requests: readonly Request[]): void {
  const contains = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
  for (const source of requests) {
    const absoluteSource = path.join(source.workspace.rootPath, source.canonicalPath);
    for (const target of requests) {
      const entryDirectory = path.dirname(path.join(target.workspace.dataRoot, target.trashRelativePath));
      if (contains(absoluteSource, entryDirectory) || contains(entryDirectory, absoluteSource)) {
        throw new PreparedWorkspacePathTrashError('unsafe-path');
      }
    }
  }
}
async function run<T>(requests: readonly Readonly<{ stepKey: string; request: Request; original?: PreparedWorkspacePathTrashOriginal }>[],
  callback: (caps: PreparedWorkspacePathTrashes) => Promise<T>): Promise<T> {
  const inherited = activeBatch.getStore();
  if (inherited) throw poison(inherited.members[0], failure(inherited.members[0], 'reentrant-operation'));
  if (typeof callback !== 'function') throw failure(undefined, 'invalid-input');
  validatePhysicalLayout(requests.map(item => item.request));
  const frame: Frame = { members: [], phase: 'preparing', failure: null }, prepared: Array<{ stepKey: string; cap: PreparedWorkspacePathTrash }> = [];
  let value: T | undefined, primary: Error | undefined, entries = 0, bytes = BigInt(0);
  try {
    for (const item of requests) {
      const request = item.request;
      const stage: Stage = { request, frame, cohortRequests: requests.map(value => value.request), io: getFdPublicationBackend(), inventory: getFdDirectoryInventoryBackend(), move: getFdPathMoveBackend(),
        phase: 'preparing', failure: null, fds: new Set(), closeFailures: [], roots: [], disposition: 'pending', pending: null,
        started: false, mutationAttempted: false, snapshotBudget: { maxDepth: request.budget.maxDepth,
          maxEntries: request.budget.maxEntries - entries, maxHashBytes: request.budget.maxHashBytes - Number(bytes) } };
      frame.members.push(stage);
      if (item.original) await recover(stage, item.original); else await initialize(stage);
      const source = stage.facts!.source;
      entries += source.kind === 'projection_absent' ? 0 : source.kind === 'regular_file' ? 1 : source.entries.length;
      bytes += source.kind === 'projection_absent' ? BigInt(0) : source.kind === 'regular_file' ? BigInt(source.identity.size)
        : source.entries.reduce((total, entry) => total + (entry.kind === 'regular_file' ? BigInt(entry.identity.size) : BigInt(0)), BigInt(0));
      if (entries > request.budget.maxEntries || bytes > BigInt(request.budget.maxHashBytes)) throw failure(stage, 'budget-exceeded');
      const cap = Object.freeze({}) as PreparedWorkspacePathTrash; stages.set(cap, stage); prepared.push({ stepKey: item.stepKey, cap });
    }
    // A later reservation can share ancestors with an earlier reservation. Bind
    // every cap to the final prepared namespace before exposing any capability.
    for (const member of frame.members) await verifyCurrent(member);
    for (const member of frame.members) member.phase = 'callback'; frame.phase = 'callback';
    await activeBatch.run(frame, async () => {
      try { value = await callback(freezePathTrashData(prepared)); }
      catch (error) { primary = poison(frame.members[0], error); }
      finally {
        frame.phase = 'draining'; for (const member of frame.members) member.phase = 'draining';
        const pending = frame.members.flatMap(member => member.pending ? [member.pending] : []);
        if (pending.length) {
          primary ??= poison(frame.members[0], failure(frame.members[0], 'unawaited-operation'));
          await Promise.allSettled(pending);
        }
      }
    });
    if (frame.failure) throw frame.failure;
    for (const member of frame.members) if (member.failure) throw member.failure;
    if (primary) throw primary;
    return value as T;
  } catch (error) {
    primary = error instanceof Error ? error : failure(undefined, 'move-unconfirmed');
    frame.failure ??= primary; for (const member of frame.members) member.failure ??= primary; throw primary;
  } finally {
    frame.phase = 'closed';
    for (const member of frame.members) {
      member.phase = 'closed';
      for (const fd of [...member.fds].reverse()) try { close(member, fd); } catch { /* Retain all close failures below. */ }
    }
    const closes = frame.members.flatMap(member => member.closeFailures);
    if (closes.length) throw new PreparedWorkspacePathTrashError('disposal-unconfirmed', frame.members.some(member => member.mutationAttempted),
      { cause: new AggregateError([...(primary ? [primary] : []), ...closes], 'Batch descriptor disposal could not be confirmed.') });
    // Inert private reservations are deliberately retained on an uncertain
    // preparation/intent outcome. No absolute-path recursive cleanup is safe.
  }
}
export async function withPreparedWorkspacePathTrashes<T>(input: PreparedWorkspacePathTrashesInput,
  callback: (caps: PreparedWorkspacePathTrashes) => Promise<T>): Promise<T> {
  try {
    const captured = capturePreparedWorkspacePathTrashes(input);
    return await run(captured.selections.map(selection => ({ stepKey: selection.stepKey, request: {
      workspace: captured.workspace, canonicalPath: selection.canonicalPath, trashEntryId: selection.trashEntryId,
      trashRelativePath: trashRelativePathFor(captured.workspace, selection.trashEntryId, selection.canonicalPath),
      sourceKind: selection.sourceKind, budget: captured.budget, retentionDays: captured.retentionDays,
      deletedAtMs: captured.deletedAtMs, expiresAtMs: captured.expiresAtMs,
    } })), callback);
  } catch (error) { throw poison(activeBatch.getStore()?.members[0], error); }
}
export async function withRecoveredWorkspacePathTrashes<T>(input: RecoveredWorkspacePathTrashesInput,
  callback: (caps: PreparedWorkspacePathTrashes) => Promise<T>): Promise<T> {
  try {
    const captured = captureRecoveredWorkspacePathTrashes(input);
    return await run(captured.originals.map(item => ({ stepKey: item.stepKey, original: item.original, request: {
      workspace: captured.workspace, canonicalPath: item.original.canonicalPath, trashEntryId: item.original.trashEntryId,
      trashRelativePath: item.original.trashRelativePath, sourceKind: item.original.source.kind, budget: item.original.budget,
      retentionDays: item.original.retentionDays, deletedAtMs: item.original.deletedAtMs, expiresAtMs: item.original.expiresAtMs,
    } })), callback);
  } catch (error) { throw poison(activeBatch.getStore()?.members[0], error); }
}
