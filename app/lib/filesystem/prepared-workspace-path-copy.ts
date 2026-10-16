import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getFdDirectoryInventoryBackend, getFdPathMoveBackend, getFdPublicationBackend,
  type FdDirectoryInventoryBackend, type FdPathMoveBackend, type FdPublicationBackend } from '../files/fd-publication';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { assertPathCopyPayload, capturePathCopyParentReceipts, capturePathCopyRequest, copyData, copyPath,
  decodePreparedWorkspacePathCopyOriginal, freezeCopyData, preparedWorkspacePathCopyProof, PreparedWorkspacePathCopyError,
  type PreparedPathCopyDirectory, type PreparedPathCopyEntry, type PreparedPathCopyErrorCode, type PreparedPathCopyIdentity,
  type PreparedPathCopyParents, type PreparedPathCopyPayload, type PreparedPathCopySource,
  type PreparedWorkspacePathCopyInput, type PreparedWorkspacePathCopyOriginal, type PreparedWorkspacePathCopyParentReceipt,
  type PreparedWorkspacePathCopyReceipt, type RecoveredWorkspacePathCopyInput } from './prepared-workspace-path-copy-contract';

export * from './prepared-workspace-path-copy-contract';
declare const copyBrand: unique symbol;
export type PreparedWorkspacePathCopy = Readonly<{ [copyBrand]: true }>;
type Request = ReturnType<typeof capturePathCopyRequest>;
type Pin = { fd: number; relativePath: string; identity: PreparedPathCopyIdentity; parent?: Pin; name?: string };
type Space = { root: Pin; resolved: string; scope: Request['sourceWorkspace']; anchors: Map<string, Pin> };
type Entry = { kind: 'directory' | 'regular_file' | 'other'; fd?: number; identity?: PreparedPathCopyIdentity };
type Stage = {
  request: Request; io: FdPublicationBackend; inventory: FdDirectoryInventoryBackend; move: FdPathMoveBackend;
  phase: 'preparing' | 'callback' | 'draining' | 'closed'; failure: Error | null; pending: Promise<unknown> | null;
  fds: Set<number>; closeFailures: unknown[]; source?: Space; destination?: Space; sourceFd?: number; payloadFd?: number;
  container?: Pin; containerRemoved: boolean; bornHere: boolean; built: Map<string, { kind: 'directory' | 'regular_file'; identity: PreparedPathCopyIdentity }>;
  facts?: PreparedWorkspacePathCopyOriginal; createdParents: PreparedWorkspacePathCopyParentReceipt[];
  pendingParent?: PreparedWorkspacePathCopyParentReceipt; receipt?: PreparedWorkspacePathCopyReceipt;
  disposition: 'pending' | 'already_published' | 'projection_absent'; started: boolean; mutationAttempted: boolean; discarded: boolean;
};
const stages = new WeakMap<PreparedWorkspacePathCopy, Stage>();
const activeStage = new AsyncLocalStorage<Stage>();
const chunkBytes = 256 * 1024;
const parentPath = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const leaf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const codeOf = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
function failure(stage: Stage | undefined, code: PreparedPathCopyErrorCode): PreparedWorkspacePathCopyError {
  const error = new PreparedWorkspacePathCopyError(code, stage?.mutationAttempted ?? false);
  if (stage && !stage.failure) stage.failure = error;
  return error;
}
function poison(stage: Stage | undefined, error: unknown): Error {
  const normalized = error instanceof Error ? error
    : new PreparedWorkspacePathCopyError('publication-unconfirmed', stage?.mutationAttempted ?? false, { cause: error });
  if (stage && !stage.failure) stage.failure = normalized;
  const outer = activeStage.getStore(); if (outer && outer !== stage && !outer.failure) outer.failure = normalized;
  return normalized;
}
function internal(stage: Stage, cleanup = false): void {
  if (!cleanup && stage.failure) throw stage.failure;
  if (stage.phase === 'closed') throw failure(stage, 'invalid-lifetime');
}
function current(cap: PreparedWorkspacePathCopy, cleanup = false): Stage {
  const stage = stages.get(cap);
  if (!stage || activeStage.getStore() !== stage || stage.phase !== 'callback') throw poison(stage, failure(stage, 'invalid-lifetime'));
  internal(stage, cleanup);
  if (stage.pending) throw poison(stage, failure(stage, 'reentrant-operation'));
  if (stage.discarded && !cleanup) throw failure(stage, 'invalid-lifetime');
  return stage;
}
function identity(info: BigIntStats): PreparedPathCopyIdentity {
  return freezeCopyData({ device: info.dev.toString(), inode: info.ino.toString(), mode: Number(info.mode), uid: Number(info.uid), gid: Number(info.gid),
    linkCount: info.nlink.toString(), size: info.size.toString(), birthtimeNs: info.birthtimeNs.toString(), mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() });
}
const stat = (fd: number) => fs.fstatSync(fd, { bigint: true });
const sameNode = (a: PreparedPathCopyIdentity, b: PreparedPathCopyIdentity) =>
  (['device', 'inode', 'mode', 'uid', 'gid', 'birthtimeNs'] as const).every(key => a[key] === b[key]);
const sameIdentity = (a: PreparedPathCopyIdentity, b: PreparedPathCopyIdentity, allowRootCtime = false) => sameNode(a, b)
  && a.size === b.size && a.linkCount === b.linkCount && a.mtimeNs === b.mtimeNs && (allowRootCtime || a.ctimeNs === b.ctimeNs);
function own(stage: Stage, info: BigIntStats, directory: boolean, privateNode = false): void {
  if (directory ? !info.isDirectory() : !info.isFile()) throw failure(stage, 'unsafe-path');
  if (info.uid !== BigInt(process.geteuid!()) || info.nlink < BigInt(1) || !directory && info.nlink !== BigInt(1)
    || (info.mode & BigInt(0o022)) || privateNode && (info.mode & BigInt(0o7777)) !== BigInt(directory ? 0o700 : 0o600)) throw failure(stage, 'unsafe-path');
}
function owned(stage: Stage, fd: number): number { stage.fds.add(fd); return fd; }
function close(stage: Stage, fd: number): void {
  if (!stage.fds.delete(fd)) throw failure(stage, 'disposal-unconfirmed');
  try { fs.closeSync(fd); }
  catch (error) { stage.closeFailures.push(error); throw new PreparedWorkspacePathCopyError('disposal-unconfirmed', stage.mutationAttempted, { cause: error }); }
}
function dispose(stage: Stage, entry: Entry | null): void { if (entry?.fd !== undefined) close(stage, entry.fd); }
function openEntry(stage: Stage, parent: Pin, name: string, cleanup = false): Entry | null {
  internal(stage, cleanup);
  try { const fd = owned(stage, stage.io.openDirectoryAt(parent.fd, name)); return { kind: 'directory', fd, identity: identity(stat(fd)) }; }
  catch (error) {
    const code = codeOf(error); if (code === 'ENOENT') return null;
    if (code !== 'ENOTDIR') {
      if (['ELOOP', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR', 'EACCES', 'EPERM'].includes(code)) return { kind: 'other' };
      throw error;
    }
  }
  try { const fd = owned(stage, stage.io.openFileAt(parent.fd, name, 'readonly')); return { kind: 'regular_file', fd, identity: identity(stat(fd)) }; }
  catch (error) {
    const code = codeOf(error); if (code === 'ENOENT') return null;
    if (['ELOOP', 'ENOTDIR', 'FD_PUBLICATION_NAMESPACE_CHANGED', 'FD_PUBLICATION_NON_REGULAR', 'EACCES', 'EPERM'].includes(code)) return { kind: 'other' };
    throw error;
  }
}
function verifySpace(stage: Stage, space: Space, cleanup = false): void {
  internal(stage, cleanup);
  const named = fs.lstatSync(space.scope.rootPath, { bigint: true }); own(stage, named, true);
  if (named.isSymbolicLink() || fs.realpathSync(space.scope.rootPath) !== space.resolved || !sameNode(identity(named), space.root.identity)) throw failure(stage, 'scope-changed');
  for (const pin of space.anchors.values()) {
    own(stage, stat(pin.fd), true);
    if (!sameNode(identity(stat(pin.fd)), pin.identity)) throw failure(stage, 'scope-changed');
    if (!pin.parent) continue;
    let actual: Entry | null = null;
    try {
      if (!stage.io.hasExactNameAt(pin.parent.fd, pin.name!)) throw failure(stage, 'scope-changed');
      actual = openEntry(stage, pin.parent, pin.name!, cleanup);
      if (!actual || actual.kind !== 'directory' || !actual.identity || !sameNode(actual.identity, pin.identity)) throw failure(stage, 'scope-changed');
    } finally { dispose(stage, actual); }
  }
}
function verifySpaces(stage: Stage, cleanup = false): void { verifySpace(stage, stage.source!, cleanup); verifySpace(stage, stage.destination!, cleanup); }
function pinRoot(stage: Stage, scope: Request['sourceWorkspace']): Space {
  const named = fs.lstatSync(scope.rootPath, { bigint: true }); own(stage, named, true);
  if (named.isSymbolicLink()) throw failure(stage, 'unsafe-path');
  const resolved = fs.realpathSync(scope.rootPath), fd = owned(stage, fs.openSync(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  own(stage, stat(fd), true);
  if (!sameNode(identity(named), identity(stat(fd)))) throw failure(stage, 'scope-changed');
  const root = { fd, relativePath: '', identity: identity(stat(fd)) }, space = { root, resolved, scope, anchors: new Map([['', root]]) };
  verifySpace(stage, space); return space;
}
function parents(stage: Stage, space: Space, pathname: string): PreparedPathCopyParents {
  let parent = space.root; const directories: PreparedPathCopyDirectory[] = [], components = pathname.split('/').slice(0, -1);
  for (let index = 0; index < components.length; index++) {
    const relativePath = components.slice(0, index + 1).join('/'), name = components[index], known = space.anchors.get(relativePath);
    if (known) { parent = known; directories.push({ relativePath, identity: known.identity }); continue; }
    const exact = stage.io.hasExactNameAt(parent.fd, name), entry = openEntry(stage, parent, name);
    if (!entry) return freezeCopyData({ directories, missingPrefix: relativePath });
    if (!exact || entry.kind !== 'directory' || entry.fd === undefined) { dispose(stage, entry); throw failure(stage, 'unsafe-path'); }
    own(stage, stat(entry.fd), true);
    const pin: Pin = { fd: entry.fd, relativePath, identity: entry.identity!, parent, name }; space.anchors.set(relativePath, pin); parent = pin;
    directories.push({ relativePath, identity: pin.identity });
  }
  return freezeCopyData({ directories, missingPrefix: null });
}
function sameParents(stage: Stage, actual: PreparedPathCopyParents, expected: PreparedPathCopyParents): void {
  if (actual.missingPrefix !== expected.missingPrefix || actual.directories.length !== expected.directories.length
    || actual.directories.some((d, i) => d.relativePath !== expected.directories[i].relativePath || !sameNode(d.identity, expected.directories[i].identity))) throw failure(stage, 'recovery-conflict');
}
function leafEntry(stage: Stage, space: Space, pathname: string, cleanup = false): Entry | null {
  const parent = space.anchors.get(parentPath(pathname)); return parent ? openEntry(stage, parent, leaf(pathname), cleanup) : null;
}
function exactLeaf(stage: Stage, space: Space, pathname: string): boolean {
  const parent = space.anchors.get(parentPath(pathname)); return !!parent && stage.io.hasExactNameAt(parent.fd, leaf(pathname));
}
function assertAbsent(stage: Stage, space: Space, pathname: string, facts: PreparedPathCopyParents, code: PreparedPathCopyErrorCode): void {
  const missing = facts.missingPrefix ?? pathname, parent = space.anchors.get(parentPath(missing));
  if (!parent) throw failure(stage, code);
  const entry = openEntry(stage, parent, leaf(missing));
  if (entry) { dispose(stage, entry); throw failure(stage, code); }
  if (stage.io.hasExactNameAt(parent.fd, leaf(missing))) throw failure(stage, code);
}
async function read(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => fs.read(fd, buffer, 0, length, position, (error, count) => error ? reject(error) : resolve(count)));
}
async function sync(stage: Stage, fd: number, cleanup = false): Promise<void> {
  internal(stage, cleanup); await new Promise<void>((resolve, reject) => fs.fsync(fd, error => error ? reject(error) : resolve())); internal(stage, cleanup);
}
async function hashFile(stage: Stage, fd: number, remaining: bigint, privateNode: boolean) {
  internal(stage); const before = stat(fd); own(stage, before, false, privateNode);
  if (before.size > remaining || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure(stage, 'budget-exceeded');
  const expected = identity(before), buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256'); let position = 0;
  while (position < Number(before.size)) {
    internal(stage); const count = await read(fd, buffer, Math.min(buffer.length, Number(before.size) - position), position);
    if (!count) throw failure(stage, 'source-changed'); hash.update(buffer.subarray(0, count)); position += count;
  }
  if (await read(fd, buffer, 1, position) !== 0 || !sameIdentity(identity(stat(fd)), expected)) throw failure(stage, 'source-changed');
  internal(stage); return { identity: expected, sha256: hash.digest('hex') };
}
function rootIdentity(source: PreparedPathCopySource): PreparedPathCopyIdentity | undefined {
  return source.kind === 'projection_absent' ? undefined : source.kind === 'directory' ? source.entries[0].identity : source.identity;
}
function sameSnapshot(a: PreparedPathCopySource, b: PreparedPathCopySource, rootCtime = false): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'projection_absent' || b.kind === 'projection_absent') return true;
  if (a.kind === 'directory' && b.kind === 'directory') return a.entries.length === b.entries.length && a.entries.every((entry, i) => {
    const other = b.entries[i]; return entry.relativePath === other.relativePath && entry.kind === other.kind
      && sameIdentity(entry.identity, other.identity, rootCtime && i === 0)
      && (entry.kind !== 'regular_file' || other.kind === 'regular_file' && entry.sha256 === other.sha256);
  });
  if (a.kind === 'directory' || b.kind === 'directory') return false;
  return sameIdentity(a.identity, b.identity, rootCtime) && (a.kind !== 'regular_file' || b.kind === 'regular_file' && a.sha256 === b.sha256);
}
async function snapshot(stage: Stage, fd: number, kind: 'regular_file' | 'directory', source: boolean): Promise<PreparedPathCopySource> {
  const projected = (relative: string) => source && stage.request.projectionPaths.includes(relative ? stage.request.sourcePath + '/' + relative : stage.request.sourcePath);
  if (kind === 'regular_file') {
    own(stage, stat(fd), false, !source);
    return projected('') ? freezeCopyData({ kind: 'projection_file' as const, identity: identity(stat(fd)) })
      : freezeCopyData({ kind, ...await hashFile(stage, fd, BigInt(stage.request.budget.maxHashBytes), !source) });
  }
  const entries: PreparedPathCopyEntry[] = []; let bytes = BigInt(0);
  const visit = async (parent: Pin, relativePath: string, depth: number): Promise<void> => {
    internal(stage); const before = stat(parent.fd); own(stage, before, true, !source);
    if (depth > stage.request.budget.maxDepth || entries.length >= stage.request.budget.maxEntries) throw failure(stage, 'budget-exceeded');
    if (projected(relativePath)) throw failure(stage, 'unsafe-path');
    entries.push({ relativePath, kind: 'directory', identity: identity(before) });
    const names = [...stage.inventory.listDirectoryAt(parent.fd)].sort();
    for (const name of names) {
      const relative = relativePath ? relativePath + '/' + name : name;
      copyPath(stage.request.sourcePath + '/' + relative); copyPath(stage.request.destinationPath + '/' + relative);
      if (isInternalWorkspaceStagingPath(name)) throw failure(stage, 'unsafe-path');
      if (depth + 1 > stage.request.budget.maxDepth || entries.length >= stage.request.budget.maxEntries) throw failure(stage, 'budget-exceeded');
      const entry = openEntry(stage, parent, name);
      if (!entry || entry.fd === undefined || entry.kind === 'other') throw failure(stage, 'unsafe-path');
      try {
        if (entry.kind === 'directory') await visit({ fd: entry.fd, relativePath: relative, identity: entry.identity! }, relative, depth + 1);
        else {
          own(stage, stat(entry.fd), false, !source);
          if (projected(relative)) entries.push({ relativePath: relative, kind: 'projection_file', identity: identity(stat(entry.fd)) });
          else {
            const hashed = await hashFile(stage, entry.fd, BigInt(stage.request.budget.maxHashBytes) - bytes, !source);
            bytes += BigInt(hashed.identity.size); entries.push({ relativePath: relative, kind: 'regular_file', ...hashed });
          }
        }
      } finally { close(stage, entry.fd); }
    }
    if (!isDeepStrictEqual(names, [...stage.inventory.listDirectoryAt(parent.fd)].sort()) || !sameIdentity(identity(before), identity(stat(parent.fd)))) throw failure(stage, 'source-changed');
  };
  await visit({ fd, relativePath: '', identity: identity(stat(fd)) }, '', 0);
  entries.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return freezeCopyData({ kind, entries });
}
async function copyFile(stage: Stage, sourceFd: number, parent: Pin, name: string, relative: string,
  expected: Extract<PreparedPathCopyEntry, { kind: 'regular_file' }>): Promise<void> {
  own(stage, stat(sourceFd), false);
  if (!sameIdentity(identity(stat(sourceFd)), expected.identity)) throw failure(stage, 'source-changed');
  const fd = owned(stage, stage.io.openFileAt(parent.fd, name, 'private-wx'));
  stage.built.set(relative, { kind: 'regular_file', identity: identity(stat(fd)) });
  try {
    own(stage, stat(fd), false, true);
    const buffer = Buffer.alloc(chunkBytes), hash = createHash('sha256'); let position = 0;
    while (position < Number(expected.identity.size)) {
      internal(stage); const count = await read(sourceFd, buffer, Math.min(buffer.length, Number(expected.identity.size) - position), position);
      if (!count) throw failure(stage, 'source-changed'); hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = await new Promise<number>((resolve, reject) => fs.write(fd, buffer, offset, count - offset, position + offset,
          (error, bytes) => error ? reject(error) : resolve(bytes)));
        internal(stage); if (!written) throw failure(stage, 'staging-changed'); offset += written;
      }
      position += count;
    }
    if (await read(sourceFd, buffer, 1, position) !== 0 || !sameIdentity(identity(stat(sourceFd)), expected.identity) || hash.digest('hex') !== expected.sha256) throw failure(stage, 'source-changed');
    await sync(stage, fd);
  } finally { close(stage, fd); }
  const observed = openEntry(stage, parent, name);
  try {
    if (!observed || observed.kind !== 'regular_file' || observed.fd === undefined || !observed.identity
      || !sameNode(observed.identity, stage.built.get(relative)!.identity)) throw failure(stage, 'staging-changed');
    const hashed = await hashFile(stage, observed.fd, BigInt(expected.identity.size), true);
    if (hashed.sha256 !== expected.sha256) throw failure(stage, 'staging-changed');
    stage.built.set(relative, { kind: 'regular_file', identity: hashed.identity });
  } finally { dispose(stage, observed); }
}
async function build(stage: Stage, source: PreparedPathCopySource): Promise<PreparedPathCopyPayload | null> {
  if (source.kind === 'projection_absent' || source.kind === 'projection_file') return null;
  const destination = stage.destination!, facts = parents(stage, destination, stage.request.destinationPath);
  const base = destination.anchors.get(facts.directories.at(-1)?.relativePath ?? '')!, name = `.canvas-create-${randomUUID()}.tmp`;
  stage.io.mkdirAt(base.fd, name, 0o700);
  const fd = owned(stage, stage.io.openDirectoryAt(base.fd, name)); own(stage, stat(fd), true, true);
  stage.container = { fd, relativePath: base.relativePath ? base.relativePath + '/' + name : name, identity: identity(stat(fd)), parent: base, name };
  stage.bornHere = true;
  if (!stage.io.hasExactNameAt(base.fd, name)) throw failure(stage, 'staging-changed');
  if (source.kind === 'regular_file') await copyFile(stage, stage.sourceFd!, stage.container, 'payload', '', { relativePath: '', ...source });
  else {
    const expected = new Map(source.entries.map(entry => [entry.relativePath, entry]));
    const visit = async (sourceParent: Pin, targetParent: Pin, targetName: string, relativePath: string): Promise<void> => {
      const before = expected.get(relativePath)!;
      if (before.kind !== 'directory' || !sameIdentity(identity(stat(sourceParent.fd)), before.identity)) throw failure(stage, 'source-changed');
      stage.io.mkdirAt(targetParent.fd, targetName, 0o700);
      const nextFd = owned(stage, stage.io.openDirectoryAt(targetParent.fd, targetName)); own(stage, stat(nextFd), true, true);
      const target: Pin = { fd: nextFd, relativePath, identity: identity(stat(nextFd)) }; stage.built.set(relativePath, { kind: 'directory', identity: target.identity });
      try {
        const names = [...stage.inventory.listDirectoryAt(sourceParent.fd)].sort();
        for (const childName of names) {
          const relative = relativePath ? relativePath + '/' + childName : childName, item = expected.get(relative);
          if (!item) throw failure(stage, 'source-changed');
          const actual = openEntry(stage, sourceParent, childName);
          if (!actual || actual.fd === undefined || !actual.identity || actual.kind === 'other' || !sameIdentity(actual.identity, item.identity)) { dispose(stage, actual); throw failure(stage, 'source-changed'); }
          try {
            if (item.kind === 'projection_file') { if (actual.kind !== 'regular_file') throw failure(stage, 'unsafe-path'); own(stage, stat(actual.fd), false); }
            else if (item.kind === 'directory') { if (actual.kind !== 'directory') throw failure(stage, 'source-changed'); await visit({ fd: actual.fd, relativePath: relative, identity: actual.identity }, target, childName, relative); }
            else { if (actual.kind !== 'regular_file') throw failure(stage, 'source-changed'); await copyFile(stage, actual.fd, target, childName, relative, item); }
          } finally { close(stage, actual.fd); }
        }
        if (!isDeepStrictEqual(names, [...stage.inventory.listDirectoryAt(sourceParent.fd)].sort()) || !sameIdentity(identity(stat(sourceParent.fd)), before.identity)) throw failure(stage, 'source-changed');
        await sync(stage, nextFd);
      } finally { close(stage, nextFd); }
    };
    await visit({ fd: stage.sourceFd!, relativePath: '', identity: source.entries[0].identity }, stage.container, 'payload', '');
  }
  const payload = openEntry(stage, stage.container, 'payload');
  if (!payload || payload.fd === undefined || payload.kind !== source.kind) { dispose(stage, payload); throw failure(stage, 'staging-changed'); }
  stage.payloadFd = payload.fd;
  const observed = await snapshot(stage, payload.fd, payload.kind, false) as PreparedPathCopyPayload;
  assertPathCopyPayload(source, observed); await sync(stage, payload.fd); await sync(stage, fd); await sync(stage, base.fd);
  return observed;
}
function expectedParents(stage: Stage): PreparedPathCopyParents {
  const original = stage.facts!, directories = [...original.filesystem.destinationParents.directories,
    ...stage.createdParents.map(receipt => ({ relativePath: receipt.relativePath, identity: receipt.identity }))];
  const parts = original.destinationPath.split('/').slice(0, -1);
  if (directories.length > parts.length || directories.some((item, index) => item.relativePath !== parts.slice(0, index + 1).join('/'))) throw failure(stage, 'recovery-conflict');
  return { directories, missingPrefix: directories.length < parts.length ? parts.slice(0, directories.length + 1).join('/') : null };
}
function verifyContainer(stage: Stage, missingAllowed: boolean, cleanup = false): void {
  const container = stage.container;
  if (!container) { if (missingAllowed) return; throw failure(stage, 'staging-changed'); }
  const entry = openEntry(stage, container.parent!, container.name!, cleanup);
  try {
    if (!stage.io.hasExactNameAt(container.parent!.fd, container.name!)) {
      if (missingAllowed && !entry) return;
      throw failure(stage, 'staging-changed');
    }
    if (!entry || entry.kind !== 'directory' || entry.fd === undefined || !entry.identity || !sameNode(entry.identity, container.identity)) throw failure(stage, 'staging-changed');
    own(stage, stat(entry.fd), true, true);
  } finally { dispose(stage, entry); }
}
async function verifySource(stage: Stage): Promise<void> {
  const original = stage.facts!, source = original.source;
  if (source.kind === 'projection_absent') { assertAbsent(stage, stage.source!, original.sourcePath, original.filesystem.sourceParents, 'source-changed'); return; }
  const entry = leafEntry(stage, stage.source!, original.sourcePath);
  try {
    if (!exactLeaf(stage, stage.source!, original.sourcePath) || !entry || entry.fd === undefined || !entry.identity
      || entry.kind !== (source.kind === 'projection_file' ? 'regular_file' : source.kind)
      || !sameNode(entry.identity, rootIdentity(source)!) || stage.sourceFd === undefined
      || !sameNode(identity(stat(stage.sourceFd)), entry.identity)) throw failure(stage, 'source-changed');
    const observed = await snapshot(stage, stage.sourceFd, entry.kind, true);
    if (!sameSnapshot(observed, source)) throw failure(stage, 'source-changed');
    const final = leafEntry(stage, stage.source!, original.sourcePath);
    try { if (!exactLeaf(stage, stage.source!, original.sourcePath) || !final?.identity || !sameIdentity(final.identity, rootIdentity(observed)!)) throw failure(stage, 'source-changed'); }
    finally { dispose(stage, final); }
  } finally { dispose(stage, entry); }
}
async function verifyPayloadAt(stage: Stage, target: boolean, expected: PreparedPathCopyPayload, rootCtime = false): Promise<PreparedPathCopyPayload> {
  const parent = target ? stage.destination!.anchors.get(parentPath(stage.facts!.destinationPath))! : stage.container!;
  const name = target ? leaf(stage.facts!.destinationPath) : 'payload', entry = openEntry(stage, parent, name);
  try {
    if (!stage.io.hasExactNameAt(parent.fd, name) || !entry || entry.fd === undefined || !entry.identity || entry.kind !== expected.kind
      || !sameNode(entry.identity, rootIdentity(expected)!) || stage.payloadFd === undefined
      || !sameNode(identity(stat(stage.payloadFd)), entry.identity)) throw failure(stage, target ? 'recovery-conflict' : 'staging-changed');
    const observed = await snapshot(stage, stage.payloadFd, entry.kind, false) as PreparedPathCopyPayload;
    if (!sameSnapshot(observed, expected, rootCtime)) throw failure(stage, target ? 'recovery-conflict' : 'staging-changed');
    const final = openEntry(stage, parent, name);
    try { if (!stage.io.hasExactNameAt(parent.fd, name) || !final?.identity || !sameIdentity(final.identity, rootIdentity(observed)!)) throw failure(stage, 'staging-changed'); }
    finally { dispose(stage, final); }
    return observed;
  } finally { dispose(stage, entry); }
}
async function verifyCurrent(stage: Stage): Promise<void> {
  internal(stage); verifySpaces(stage);
  const original = stage.facts!;
  sameParents(stage, parents(stage, stage.source!, original.sourcePath), original.filesystem.sourceParents);
  sameParents(stage, parents(stage, stage.destination!, original.destinationPath), expectedParents(stage));
  if (stage.disposition === 'already_published') {
    const expected = stage.receipt?.observation.kind === 'published' ? stage.receipt.observation.copy : original.staging!.payload;
    await verifyPayloadAt(stage, true, expected, !stage.receipt);
    if (stage.container && !stage.containerRemoved) {
      verifyContainer(stage, true);
      if (stage.io.hasExactNameAt(stage.container.parent!.fd, stage.container.name!) && stage.inventory.listDirectoryAt(stage.container.fd).length) throw failure(stage, 'staging-changed');
    }
  } else {
    await verifySource(stage);
    assertAbsent(stage, stage.destination!, original.destinationPath, expectedParents(stage), 'destination-occupied');
    if (original.staging) {
      verifyContainer(stage, false);
      if (!isDeepStrictEqual([...stage.inventory.listDirectoryAt(stage.container!.fd)].sort(), ['payload'])) throw failure(stage, 'staging-changed');
      await verifyPayloadAt(stage, false, original.staging.payload);
    }
  }
  verifySpaces(stage); internal(stage);
}
async function initialize(stage: Stage): Promise<void> {
  stage.source = pinRoot(stage, stage.request.sourceWorkspace); stage.destination = pinRoot(stage, stage.request.destinationWorkspace);
  const absoluteSource = path.join(stage.source.resolved, stage.request.sourcePath), absoluteTarget = path.join(stage.destination.resolved, stage.request.destinationPath);
  if (absoluteSource === absoluteTarget || absoluteTarget.startsWith(absoluteSource + path.sep) || absoluteSource.startsWith(absoluteTarget + path.sep)
    || sameNode(stage.source.root.identity, stage.destination.root.identity) && stage.request.sourceWorkspace.workspaceId !== stage.request.destinationWorkspace.workspaceId) throw failure(stage, 'unsafe-path');
  if (isInternalWorkspaceStagingPath(stage.request.sourcePath) || isInternalWorkspaceStagingPath(stage.request.destinationPath)) throw failure(stage, 'unsafe-path');
  const sourceParents = parents(stage, stage.source, stage.request.sourcePath), destinationParents = parents(stage, stage.destination, stage.request.destinationPath);
  assertAbsent(stage, stage.destination, stage.request.destinationPath, destinationParents, 'destination-occupied');
  let source: PreparedPathCopySource;
  if (stage.request.sourceKind === 'projection_absent') {
    assertAbsent(stage, stage.source, stage.request.sourcePath, sourceParents, 'source-changed'); source = { kind: 'projection_absent' };
  } else {
    const entry = leafEntry(stage, stage.source, stage.request.sourcePath);
    if (sourceParents.missingPrefix || !exactLeaf(stage, stage.source, stage.request.sourcePath) || !entry || entry.fd === undefined || entry.kind !== stage.request.sourceKind) { dispose(stage, entry); throw failure(stage, 'unsafe-path'); }
    stage.sourceFd = entry.fd; source = await snapshot(stage, entry.fd, entry.kind, true);
  }
  const payload = await build(stage, source);
  stage.facts = decodePreparedWorkspacePathCopyOriginal({ version: 1, sourceWorkspace: stage.request.sourceWorkspace, destinationWorkspace: stage.request.destinationWorkspace,
    sourcePath: stage.request.sourcePath, destinationPath: stage.request.destinationPath, budget: stage.request.budget, projectionPaths: stage.request.projectionPaths,
    filesystem: { sourceRoot: { resolvedPath: stage.source.resolved, identity: stage.source.root.identity },
      destinationRoot: { resolvedPath: stage.destination.resolved, identity: stage.destination.root.identity }, sourceParents, destinationParents }, source,
    staging: payload ? { relativePath: stage.container!.relativePath, identity: stage.container!.identity, payload } : null });
  stage.disposition = payload ? 'pending' : 'projection_absent'; await verifyCurrent(stage);
}
async function createParents(stage: Stage, acknowledge?: (receipt: PreparedWorkspacePathCopyParentReceipt) => Promise<void>): Promise<void> {
  const original = stage.facts!, actual = parents(stage, stage.destination!, original.destinationPath);
  if (!actual.missingPrefix) return;
  if (typeof acknowledge !== 'function') throw failure(stage, 'parent-journal-required');
  const parts = original.destinationPath.split('/').slice(0, -1);
  let parent = stage.destination!.anchors.get(parentPath(actual.missingPrefix))!;
  for (let index = actual.directories.length; index < parts.length; index++) {
    internal(stage); verifySpaces(stage); const name = parts[index], relativePath = parts.slice(0, index + 1).join('/'), prior = openEntry(stage, parent, name);
    if (prior) { dispose(stage, prior); throw failure(stage, 'destination-occupied'); }
    stage.mutationAttempted = true;
    try {
      stage.io.mkdirAt(parent.fd, name, 0o755);
      const fd = owned(stage, stage.io.openDirectoryAt(parent.fd, name)); own(stage, stat(fd), true);
      if (!stage.io.hasExactNameAt(parent.fd, name)) throw failure(stage, 'parent-create-unconfirmed');
      const pin: Pin = { fd, relativePath, identity: identity(stat(fd)), parent, name }; stage.destination!.anchors.set(relativePath, pin);
      await sync(stage, fd); await sync(stage, parent.fd);
      const receipt = freezeCopyData({ version: 1 as const, originalProof: preparedWorkspacePathCopyProof(original), relativePath, identity: pin.identity });
      stage.pendingParent = receipt;
      try { await acknowledge(receipt); internal(stage); stage.createdParents.push(receipt); parent = pin; }
      finally { stage.pendingParent = undefined; }
    } catch (error) { throw new PreparedWorkspacePathCopyError('parent-create-unconfirmed', true, { cause: error }); }
  }
}

/** Directory removal has no API3 primitive. Only our private, exact namespace
 * is removed below after FD/name/root checks; this is observational binding,
 * never an atomic inode-CAS claim. Unknown nodes are retained, never adopted. */
async function cleanup(stage: Stage, discard: boolean): Promise<void> {
  if (!stage.container || stage.containerRemoved) return;
  const container = stage.container; verifySpaces(stage, true); verifyContainer(stage, false, true);
  const names = [...stage.inventory.listDirectoryAt(container.fd)].sort();
  if (!discard && names.length || discard && names.some(name => name !== 'payload')) throw failure(stage, 'cleanup-unconfirmed');
  const expected = stage.facts?.staging?.payload;
  const known = expected ? new Map((expected.kind === 'regular_file' ? [{ relativePath: '', kind: 'regular_file' as const, identity: expected.identity }] : expected.entries)
    .map(entry => [entry.relativePath, { kind: entry.kind, identity: entry.identity }])) : stage.built;
  const verifyPrivateParents = (pin: Pin): void => {
    if (pin === container) return;
    if (!pin.parent || !pin.name) throw failure(stage, 'cleanup-unconfirmed');
    verifyPrivateParents(pin.parent);
    own(stage, stat(pin.fd), true, true);
    const named = openEntry(stage, pin.parent, pin.name, true);
    try {
      if (!stage.io.hasExactNameAt(pin.parent.fd, pin.name) || named?.kind !== 'directory'
        || !named.identity || !sameNode(named.identity, pin.identity)) throw failure(stage, 'cleanup-unconfirmed');
    } finally { dispose(stage, named); }
  };
  const remove = async (parent: Pin, name: string, relative: string): Promise<void> => {
    verifyPrivateParents(parent);
    const entry = openEntry(stage, parent, name, true), original = known.get(relative);
    if (!entry || entry.fd === undefined || !entry.identity || entry.kind === 'other' || !original
      || entry.kind !== original.kind || !sameNode(entry.identity, original.identity)) { dispose(stage, entry); throw failure(stage, 'cleanup-unconfirmed'); }
    try {
      own(stage, stat(entry.fd), entry.kind === 'directory', true); verifySpaces(stage, true); verifyContainer(stage, false, true);
      if (entry.kind === 'directory') {
        const pin: Pin = { fd: entry.fd, relativePath: relative, identity: entry.identity, parent, name };
        for (const child of stage.inventory.listDirectoryAt(entry.fd)) await remove(pin, child, relative ? relative + '/' + child : child);
        await sync(stage, entry.fd, true);
        if (stage.inventory.listDirectoryAt(entry.fd).length) throw failure(stage, 'cleanup-unconfirmed');
        const named = openEntry(stage, parent, name, true);
        try { if (!stage.io.hasExactNameAt(parent.fd, name) || !named?.identity || !sameNode(named.identity, entry.identity)) throw failure(stage, 'cleanup-unconfirmed'); }
        finally { dispose(stage, named); }
        verifySpaces(stage, true); verifyContainer(stage, false, true); verifyPrivateParents(parent);
        const absolute = path.join(stage.destination!.resolved, container.relativePath, 'payload', ...relative.split('/').filter(Boolean));
        fs.rmdirSync(absolute);
      } else {
        stage.io.unlinkFileAt(parent.fd, name, { dev: entry.identity.device, ino: entry.identity.inode, uid: entry.identity.uid, mode: 0o600 });
      }
    } finally { close(stage, entry.fd); }
  };
  if (discard && names.includes('payload')) await remove(container, 'payload', '');
  verifySpaces(stage, true); verifyContainer(stage, false, true);
  if (stage.inventory.listDirectoryAt(container.fd).length) throw failure(stage, 'cleanup-unconfirmed');
  await sync(stage, container.fd, true);
  fs.rmdirSync(path.join(stage.destination!.resolved, container.relativePath)); stage.containerRemoved = true;
  await sync(stage, container.parent!.fd, true);
}
async function recover(stage: Stage, original: PreparedWorkspacePathCopyOriginal, created: readonly PreparedWorkspacePathCopyParentReceipt[]): Promise<void> {
  stage.facts = original; stage.createdParents.push(...created);
  stage.source = pinRoot(stage, stage.request.sourceWorkspace); stage.destination = pinRoot(stage, stage.request.destinationWorkspace);
  if (stage.source.resolved !== original.filesystem.sourceRoot.resolvedPath || !sameNode(stage.source.root.identity, original.filesystem.sourceRoot.identity)
    || stage.destination.resolved !== original.filesystem.destinationRoot.resolvedPath || !sameNode(stage.destination.root.identity, original.filesystem.destinationRoot.identity)) throw failure(stage, 'recovery-conflict');
  sameParents(stage, parents(stage, stage.source, original.sourcePath), original.filesystem.sourceParents);
  sameParents(stage, parents(stage, stage.destination, original.destinationPath), expectedParents(stage));
  if (!original.staging) {
    if (created.length) throw failure(stage, 'recovery-conflict');
    if (original.source.kind !== 'projection_absent') {
      const source = leafEntry(stage, stage.source, original.sourcePath);
      if (!source || source.fd === undefined || source.kind !== 'regular_file') { dispose(stage, source); throw failure(stage, 'recovery-conflict'); }
      stage.sourceFd = source.fd;
    }
    stage.disposition = 'projection_absent'; await verifyCurrent(stage); return;
  }
  const base = stage.destination.anchors.get(parentPath(original.staging.relativePath));
  if (!base) throw failure(stage, 'recovery-conflict');
  const container = openEntry(stage, base, leaf(original.staging.relativePath));
  if (container) {
    if (container.fd === undefined || container.kind !== 'directory' || !container.identity || !sameNode(container.identity, original.staging.identity)) { dispose(stage, container); throw failure(stage, 'recovery-conflict'); }
    own(stage, stat(container.fd), true, true);
    stage.container = { fd: container.fd, relativePath: original.staging.relativePath, identity: original.staging.identity, parent: base, name: leaf(original.staging.relativePath) };
  }
  const target = leafEntry(stage, stage.destination, original.destinationPath), staged = stage.container ? openEntry(stage, stage.container, 'payload') : null;
  let keep: number | undefined;
  try {
    const atTarget = !!target?.identity && sameNode(target.identity, rootIdentity(original.staging.payload)!);
    const atStage = !!staged?.identity && sameNode(staged.identity, rootIdentity(original.staging.payload)!);
    if (atTarget && !staged && target!.fd !== undefined && target!.kind === original.staging.payload.kind) {
      keep = target!.fd; stage.payloadFd = keep; stage.disposition = 'already_published'; stage.containerRemoved = !container;
    } else if (atStage && !target && staged!.fd !== undefined && staged!.kind === original.staging.payload.kind) {
      keep = staged!.fd; stage.payloadFd = keep; stage.disposition = 'pending';
      const source = leafEntry(stage, stage.source, original.sourcePath);
      if (!source || source.fd === undefined || source.kind !== original.staging.payload.kind) { dispose(stage, source); throw failure(stage, 'recovery-conflict'); }
      stage.sourceFd = source.fd;
    } else throw failure(stage, 'recovery-conflict');
    await verifyCurrent(stage);
  } finally { if (target?.fd !== undefined && target.fd !== keep) close(stage, target.fd); if (staged?.fd !== undefined && staged.fd !== keep) close(stage, staged.fd); }
}
function operation<T>(cap: PreparedWorkspacePathCopy, execute: (stage: Stage) => Promise<T>, disposing = false): Promise<T> {
  let stage: Stage;
  try { stage = current(cap, disposing); } catch (error) { return Promise.reject(error); }
  const pending = Promise.resolve().then(() => execute(stage)).catch(error => { throw poison(stage, error); });
  stage.pending = pending; void pending.then(() => { if (stage.pending === pending) stage.pending = null; }, () => { if (stage.pending === pending) stage.pending = null; });
  return pending;
}
export function readPreparedWorkspacePathCopy(cap: PreparedWorkspacePathCopy): PreparedWorkspacePathCopyOriginal { return current(cap).facts!; }
export function readPreparedWorkspacePathCopyDisposition(cap: PreparedWorkspacePathCopy): Stage['disposition'] { return current(cap).disposition; }
export function assertPreparedWorkspacePathCopyCurrent(cap: PreparedWorkspacePathCopy): Promise<void> { return operation(cap, verifyCurrent); }
export function assertPreparedWorkspacePathCopyParentReceipt(cap: PreparedWorkspacePathCopy, receipt: PreparedWorkspacePathCopyParentReceipt): void {
  const stage = stages.get(cap);
  if (arguments.length !== 2 || !stage || activeStage.getStore() !== stage || stage.phase !== 'callback') throw poison(stage, failure(stage, 'invalid-lifetime'));
  internal(stage);
  if (stage.pendingParent !== receipt && !stage.createdParents.includes(receipt) || receipt.originalProof !== preparedWorkspacePathCopyProof(stage.facts!)) throw failure(stage, 'recovery-conflict');
}
export function assertPreparedWorkspacePathCopyReceiptCurrent(cap: PreparedWorkspacePathCopy, receipt: PreparedWorkspacePathCopyReceipt): Promise<void> {
  return operation(cap, async stage => { if (!stage.receipt || stage.receipt !== receipt) throw failure(stage, 'recovery-conflict'); await verifyCurrent(stage); });
}
export function discardPreparedWorkspacePathCopy(cap: PreparedWorkspacePathCopy): Promise<void> {
  return operation(cap, async stage => {
    try { await cleanup(stage, stage.disposition !== 'already_published'); stage.discarded = true; }
    catch (error) { throw new PreparedWorkspacePathCopyError('cleanup-unconfirmed', stage.mutationAttempted, { cause: error }); }
  }, true);
}
export function publishPreparedWorkspacePathCopy(cap: PreparedWorkspacePathCopy,
  onParentCreated?: (receipt: PreparedWorkspacePathCopyParentReceipt) => Promise<void>): Promise<PreparedWorkspacePathCopyReceipt> {
  if (arguments.length < 1 || arguments.length > 2 || onParentCreated !== undefined && typeof onParentCreated !== 'function') return Promise.reject(poison(stages.get(cap), failure(stages.get(cap), 'invalid-input')));
  return operation(cap, async stage => {
    if (stage.started) throw failure(stage, 'already-published'); stage.started = true;
    await verifyCurrent(stage);
    if (!stage.facts!.staging) {
      const receipt = freezeCopyData({ version: 1 as const, original: stage.facts!, createdParents: [], observation: { kind: 'projection_absent' as const } });
      stage.receipt = receipt; return receipt;
    }
    if (stage.disposition !== 'already_published') {
      await createParents(stage, onParentCreated); await verifyCurrent(stage);
      const destination = stage.destination!.anchors.get(parentPath(stage.facts!.destinationPath))!;
      stage.mutationAttempted = true;
      try { stage.move.renameNoReplaceAt(stage.container!.fd, 'payload', destination.fd, leaf(stage.facts!.destinationPath)); }
      catch (error) { throw new PreparedWorkspacePathCopyError(codeOf(error) === 'EXDEV' ? 'cross-device-copy' : codeOf(error) === 'EEXIST' ? 'destination-occupied' : 'publication-unconfirmed', true, { cause: error }); }
      stage.disposition = 'already_published';
    }
    const observed = await verifyPayloadAt(stage, true, stage.facts!.staging.payload, true);
    try {
      await sync(stage, stage.payloadFd!);
      const fds = new Set([stage.destination!.anchors.get(parentPath(stage.facts!.destinationPath))!.fd,
        stage.destination!.anchors.get(parentPath(stage.facts!.staging.relativePath))!.fd]);
      if (stage.container && !stage.containerRemoved) fds.add(stage.container.fd);
      for (const fd of fds) await sync(stage, fd);
      await verifyPayloadAt(stage, true, observed); verifySpaces(stage);
      if (!stage.containerRemoved) await cleanup(stage, false);
      await verifyPayloadAt(stage, true, observed); verifySpaces(stage);
    } catch (error) { throw new PreparedWorkspacePathCopyError('publication-unconfirmed', true, { cause: error }); }
    const receipt = freezeCopyData({ version: 1 as const, original: stage.facts!, createdParents: [...stage.createdParents],
      observation: { kind: 'published' as const, method: 'rename-no-replace' as const, copy: observed } });
    stage.receipt = receipt; return receipt;
  });
}
async function run<T>(request: Request, prepare: (stage: Stage) => Promise<void>, callback: (cap: PreparedWorkspacePathCopy) => Promise<T>): Promise<T> {
  const active = activeStage.getStore(); if (active) throw poison(active, failure(active, 'reentrant-operation'));
  if (typeof callback !== 'function') throw failure(undefined, 'invalid-input');
  const stage: Stage = { request, io: getFdPublicationBackend(), inventory: getFdDirectoryInventoryBackend(), move: getFdPathMoveBackend(),
    phase: 'preparing', failure: null, pending: null, fds: new Set(), closeFailures: [], built: new Map(), createdParents: [],
    containerRemoved: false, bornHere: false, disposition: 'pending', started: false, mutationAttempted: false, discarded: false };
  let value: T | undefined;
  try {
    await prepare(stage); const cap = Object.freeze({}) as PreparedWorkspacePathCopy; stages.set(cap, stage); stage.phase = 'callback';
    await activeStage.run(stage, async () => {
      try { value = await callback(cap); } catch (error) { poison(stage, error); }
      finally { stage.phase = 'draining'; if (stage.pending) { poison(stage, failure(stage, 'unawaited-operation')); await Promise.allSettled([stage.pending]); } }
    });
    if (stage.failure) throw stage.failure; return value as T;
  } catch (error) {
    const original = poison(stage, error);
    if (stage.phase === 'preparing' && stage.bornHere && stage.container) try { await cleanup(stage, true); }
    catch (cleanupError) { throw new PreparedWorkspacePathCopyError('cleanup-unconfirmed', stage.mutationAttempted, { cause: new AggregateError([original, cleanupError]) }); }
    throw original;
  } finally {
    stage.phase = 'closed';
    for (const fd of [...stage.fds].reverse()) try { close(stage, fd); } catch { /* All failures retained; no unsafe second close. */ }
    if (stage.closeFailures.length) throw new PreparedWorkspacePathCopyError('disposal-unconfirmed', stage.mutationAttempted,
      { cause: new AggregateError([...(stage.failure ? [stage.failure] : []), ...stage.closeFailures], 'Descriptor disposal could not be confirmed.') });
  }
}
/** Builds a new private snapshot before the callback. Fully prepared resources
 * remain available for original-intent recovery until publish or explicit
 * discard; every FD closes on exit, including detached-operation drain. */
export async function withPreparedWorkspacePathCopy<T>(input: PreparedWorkspacePathCopyInput,
  callback: (cap: PreparedWorkspacePathCopy) => Promise<T>): Promise<T> {
  try { return await run(capturePathCopyRequest(input), initialize, callback); }
  catch (error) { throw poison(activeStage.getStore(), error); }
}
export async function withRecoveredWorkspacePathCopy<T>(input: RecoveredWorkspacePathCopyInput,
  callback: (cap: PreparedWorkspacePathCopy) => Promise<T>): Promise<T> {
  try {
    if (Reflect.ownKeys(input ?? {}).some(key => !['sourceWorkspace', 'destinationWorkspace', 'original', 'createdParents'].includes(key as string))) throw failure(undefined, 'invalid-input');
    const original = decodePreparedWorkspacePathCopyOriginal(copyData(input, 'original'));
    const request = capturePathCopyRequest({ sourceWorkspace: copyData(input, 'sourceWorkspace') as PreparedWorkspacePathCopyInput['sourceWorkspace'],
      destinationWorkspace: copyData(input, 'destinationWorkspace') as PreparedWorkspacePathCopyInput['destinationWorkspace'],
      sourcePath: original.sourcePath, destinationPath: original.destinationPath,
      sourceKind: original.source.kind === 'projection_file' ? 'regular_file' : original.source.kind, budget: original.budget, projectionPaths: original.projectionPaths });
    if (!isDeepStrictEqual(request.sourceWorkspace, original.sourceWorkspace) || !isDeepStrictEqual(request.destinationWorkspace, original.destinationWorkspace)) throw failure(undefined, 'scope-changed');
    const created = capturePathCopyParentReceipts(copyData(input, 'createdParents', true), original);
    return await run(request, stage => recover(stage, original, created), callback);
  } catch (error) { throw poison(activeStage.getStore(), error); }
}
