import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { resolveDataDir } from '../db/provider';
import { getFdPublicationBackend, getFdPathMoveBackend, type FdPublicationBackend } from '../files/fd-publication';
import { captureWorkspaceOperationJobScope } from '../files/workspace-operation-job-scope';
import { captureNativeCopyPhaseStage } from '../files/workspace-operation-native-copy-phase-contract';
import { assertNativeCopyManagedAssetRetirement, assertNativeCopyManagedAssetOwner,
  assertNativeCopyManagedAssetPublication } from '../files/workspace-operation-native-copy-owner';
import type { WorkspaceOperationManagedCopyStageV4 } from '../files/workspace-operation-managed-copy-stage';
import type { WorkspaceContext } from '../workspaces/types';
import { captureExcalidrawReadonlyAssetMetadata } from './readonly-assets';
import { captureExcalidrawCopyAssetOriginal, captureExcalidrawCopyAssetReceipt, copyDigest, copyFreeze, copyInvalid, copyJson,
  captureExcalidrawCopyBirthReceipt } from './copy-data';
import type { ExcalidrawCopyAssetOriginal, ExcalidrawCopyAssetReceipt, ExcalidrawCopyDirectoryIdentity,
  ExcalidrawCopyFileIdentity, ExcalidrawCopyAssetBlobOriginal, ExcalidrawCopyBirthReceipt } from './copy-contract';
export type { ExcalidrawCopyAssetOriginal, ExcalidrawCopyAssetReceipt } from './copy-contract';

declare const assetCap: unique symbol;
export type PreparedExcalidrawCopyAssets = Readonly<{ [assetCap]: true }>;
type Directory = { fd: number; absolute: string; identity: ExcalidrawCopyDirectoryIdentity; parent?: Directory; name?: string };
type Frame = { active: boolean; failed: unknown; busy: boolean; io: FdPublicationBackend;
  stage: WorkspaceOperationManagedCopyStageV4 | null;
  directories: Directory[]; root: Directory; workspace: Directory; privateDirectory: Directory;
  original: ExcalidrawCopyAssetOriginal; receipt: ExcalidrawCopyAssetReceipt | null };
const frames = new WeakMap<PreparedExcalidrawCopyAssets, Frame>(), context = new AsyncLocalStorage<Frame>();
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function changed(): never { return copyInvalid('EXCALIDRAW_COPY_CHANGED'); }
function uncertain(): never { return copyInvalid('EXCALIDRAW_COPY_PUBLICATION_UNCONFIRMED'); }
const rootPath = () => path.resolve(resolveDataDir());
const scopeHash = (workspaceId: string) => sha(workspaceId).slice(0, 32);
function identity(info: BigIntStats): ExcalidrawCopyDirectoryIdentity {
  return copyFreeze({ dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), mode: Number(info.mode & BigInt(0o7777)) });
}
function fileIdentity(info: BigIntStats): ExcalidrawCopyFileIdentity {
  return copyFreeze({ ...identity(info), sizeBytes: Number(info.size) });
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return equal(fileIdentity(a), fileIdentity(b)) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function safeDirectory(info: BigIntStats, root = false): void {
  if (!info.isDirectory() || info.nlink < BigInt(1) || info.uid !== BigInt(process.geteuid!())
    || (info.mode & BigInt(root ? 0o022 : 0o7777)) !== BigInt(root ? 0 : 0o700)) changed();
}
function check(frame: Frame, directory: Directory): void {
  const actual = fs.fstatSync(directory.fd, { bigint: true }); safeDirectory(actual, !directory.parent);
  if (!equal(identity(actual), directory.identity)) changed();
  if (directory.parent) {
    check(frame, directory.parent);
    if (!frame.io.hasExactNameAt(directory.parent.fd, directory.name!)) changed();
    const named = frame.io.openDirectoryAt(directory.parent.fd, directory.name!);
    try { if (!equal(identity(fs.fstatSync(named, { bigint: true })), directory.identity)) changed(); }
    finally { fs.closeSync(named); }
  } else if (rootPath() !== directory.absolute || fs.realpathSync(directory.absolute) !== directory.absolute
    || !equal(identity(fs.lstatSync(directory.absolute, { bigint: true })), directory.identity)) changed();
}
function child(frame: Frame, parent: Directory, name: string, create: boolean): Directory {
  check(frame, parent);
  if (!frame.io.hasExactNameAt(parent.fd, name)) {
    if (!create) changed();
    try { frame.io.mkdirAt(parent.fd, name, 0o700); }
    catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      if (code !== 'EEXIST' || !frame.io.hasExactNameAt(parent.fd, name)) throw error;
    }
  }
  // Confirm every prepared ancestor entry, including one retained after an
  // earlier failed attempt. A failed fsync is never an existence-only success.
  if (create) fs.fsyncSync(parent.fd);
  const fd = frame.io.openDirectoryAt(parent.fd, name);
  const directory = { fd, absolute: path.join(parent.absolute, name), identity: identity(fs.fstatSync(fd, { bigint: true })), parent, name };
  frame.directories.push(directory); check(frame, directory); return directory;
}
function open(workspaceId: string, privateName: string, create: boolean, stage: WorkspaceOperationManagedCopyStageV4 | null = null): Frame {
  const io = getFdPublicationBackend();
  const absolute = rootPath(), fd = fs.openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const root = { fd, absolute, identity: identity(fs.fstatSync(fd, { bigint: true })) };
  const frame = { active: true, failed: null, busy: false, io, stage, directories: [root], root,
    workspace: root, privateDirectory: root, original: null as unknown as ExcalidrawCopyAssetOriginal, receipt: null } as Frame;
  try {
    check(frame, root); let parent = root;
    for (const name of ['collaboration-assets', 'excalidraw', scopeHash(workspaceId)]) parent = child(frame, parent, name, create);
    frame.workspace = parent; frame.privateDirectory = child(frame, parent, privateName, create); return frame;
  } catch (error) { close(frame); throw error; }
}
function close(frame: Frame): void {
  frame.active = false; let failed = false;
  for (const directory of [...frame.directories].reverse()) try { fs.closeSync(directory.fd); } catch { failed = true; }
  frame.directories.length = 0; if (failed) uncertain();
}
function read(frame: Frame, directory: Directory, name: string, maximum: number, expected?: ExcalidrawCopyFileIdentity): { bytes: Buffer; identity: ExcalidrawCopyFileIdentity } {
  check(frame, directory); const fd = frame.io.openFileAt(directory.fd, name, 'readonly');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || before.uid !== BigInt(process.geteuid!())
      || (before.mode & BigInt(0o7777)) !== BigInt(0o600) || before.size < BigInt(0) || before.size > BigInt(maximum)
      || expected && !equal(fileIdentity(before), expected)) changed();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, Math.min(1024 * 1024, bytes.length - length), length); if (!count) break; length += count; }
    if (length !== Number(before.size) || !sameFile(before, fs.fstatSync(fd, { bigint: true }))) changed();
    const named = frame.io.openFileAt(directory.fd, name, 'readonly');
    try { if (!sameFile(before, fs.fstatSync(named, { bigint: true }))) changed(); }
    finally { fs.closeSync(named); }
    check(frame, directory); return { bytes: bytes.subarray(0, length), identity: fileIdentity(before) };
  } finally { fs.closeSync(fd); }
}
function write(frame: Frame, name: string, bytes: Uint8Array, manifestFd?: number): ExcalidrawCopyFileIdentity {
  const directory = frame.privateDirectory; check(frame, directory);
  if (manifestFd !== undefined && name !== 'original.json') changed();
  const fd = manifestFd ?? frame.io.openFileAt(directory.fd, name, 'private-wx');
  try { let offset = 0; while (offset < bytes.byteLength) {
    const count = fs.writeSync(fd, bytes, offset, Math.min(1024 * 1024, bytes.byteLength - offset), offset);
    if (!count) uncertain(); offset += count;
  } fs.fsyncSync(fd); } finally { if (manifestFd === undefined) fs.closeSync(fd); }
  fs.fsyncSync(directory.fd); return read(frame, directory, name, bytes.byteLength).identity;
}
function manifest(frame: Frame): void {
  const actual = read(frame, frame.privateDirectory, 'original.json', 4 * 1024 * 1024);
  const { sizeBytes: _sizeBytes, ...node } = actual.identity;
  if (!equal(node, frame.original.manifestIdentity) || actual.bytes.toString('utf8') !== copyJson(frame.original)) changed();
}
function verify(frame: Frame, published: boolean): ExcalidrawCopyAssetReceipt | null {
  const original = frame.original;
  if (original.configuredDataRoot !== resolveDataDir() || original.resolvedDataRoot !== rootPath()) changed();
  check(frame, frame.privateDirectory);
  const ancestors = frame.directories.slice(0, -1).map(directory => ({ name: directory.name ?? '', identity: directory.identity }));
  if (!equal(ancestors, original.ancestors) || !equal({ name: frame.privateDirectory.name, identity: frame.privateDirectory.identity }, original.privateDirectory)) changed();
  manifest(frame);
  const blobs = original.blobs.map(blob => {
    const targetExists = frame.io.hasExactNameAt(frame.workspace.fd, blob.contentHash);
    const preparedExists = frame.io.hasExactNameAt(frame.privateDirectory.fd, blob.contentHash);
    const target = blob.disposition === 'reuse' || !preparedExists ? frame.workspace : frame.privateDirectory;
    if (blob.disposition === 'reuse' && preparedExists || blob.disposition === 'birth' && targetExists && preparedExists
      || published && (!targetExists || preparedExists)) changed();
    const observed = read(frame, target, blob.contentHash, blob.sizeBytes, blob.identity);
    if (observed.bytes.length !== blob.sizeBytes || sha(observed.bytes) !== blob.contentHash) changed();
    return blob;
  });
  if (!published) return null;
  const body = { version: 1 as const, operationId: original.operationId, stageDigest: original.stageDigest,
    originalProof: original.originalProof, blobs };
  return captureExcalidrawCopyAssetReceipt({ ...body, receiptProof: copyDigest(body) }, original);
}
function use<T>(cap: PreparedExcalidrawCopyAssets, action: (frame: Frame) => T): T {
  const frame = frames.get(cap);
  if (!frame?.active || context.getStore() !== frame || frame.busy) changed();
  if (frame.failed) throw frame.failed;
  frame.busy = true;
  try {
    if (!frame.stage) changed(); assertNativeCopyManagedAssetOwner(frame.stage);
    return action(frame);
  } catch (error) { frame.failed = error; throw error; } finally { frame.busy = false; }
}
async function run<T>(frame: Frame, callback: (cap: PreparedExcalidrawCopyAssets) => T | Promise<T>): Promise<T> {
  const cap = Object.freeze({}) as PreparedExcalidrawCopyAssets; frames.set(cap, frame);
  try { return await context.run(frame, async () => { const result = await callback(cap); if (frame.failed) throw frame.failed; return result; }); }
  finally { frames.delete(cap); close(frame); }
}

/** Caller holds the genuine Copy owner's workspace kernel and SQL lifecycle
 * fences. No workspace root, database checkout, authority or transaction is made. */
export async function withPreparedExcalidrawCopyAssets<T>(input: Readonly<{ stage: WorkspaceOperationManagedCopyStageV4;
  destinationWorkspace: WorkspaceContext }>, callback: (cap: PreparedExcalidrawCopyAssets) => T | Promise<T>): Promise<T> {
  const stage = captureNativeCopyPhaseStage(input.stage); if (stage.version !== 4) changed();
  const scope = captureWorkspaceOperationJobScope(input.destinationWorkspace);
  if (!equal(scope, stage.origin.destinationScope)) changed();
  const metadata = new Map<string, ReturnType<typeof captureExcalidrawReadonlyAssetMetadata>>();
  const byHash = new Map<string, Uint8Array>(); let total = 0;
  for (const record of stage.sceneAssets) {
    const value = captureExcalidrawReadonlyAssetMetadata(record.asset.metadata), prior = metadata.get(value.fileId);
    if (prior && !equal(prior, value)) copyInvalid('EXCALIDRAW_COPY_ASSET_CONFLICT'); metadata.set(value.fileId, value);
    if (!byHash.has(value.contentHash)) { total += value.sizeBytes; if (total > 50 * 1024 * 1024) copyInvalid('EXCALIDRAW_COPY_TOO_LARGE'); byHash.set(value.contentHash, record.asset.bytes); }
  }
  // The Stage capture checks every byte view/count/total before publication IO.
  assertNativeCopyManagedAssetOwner(stage);
  const frame = open(scope.workspaceId, `.copy-${randomUUID()}`, true, stage);
  try {
    const blobs: ExcalidrawCopyAssetBlobOriginal[] = [];
    for (const [contentHash, bytes] of [...byHash].sort(([a], [b]) => a.localeCompare(b))) {
      if (sha(bytes) !== contentHash) changed();
      const reuse = frame.io.hasExactNameAt(frame.workspace.fd, contentHash);
      const observed = reuse ? read(frame, frame.workspace, contentHash, bytes.byteLength) : { identity: write(frame, contentHash, bytes), bytes };
      if (observed.bytes.byteLength !== bytes.byteLength || sha(observed.bytes) !== contentHash) copyInvalid('EXCALIDRAW_COPY_ASSET_CONFLICT');
      blobs.push({ contentHash, sizeBytes: bytes.byteLength, storageKey: `${scopeHash(scope.workspaceId)}/${contentHash}`,
        disposition: reuse ? 'reuse' : 'birth', identity: observed.identity });
    }
    // Create the actual manifest inode before computing its immutable body.
    // Its size/hash are deliberately absent from the self-describing original.
    const manifestFd = frame.io.openFileAt(frame.privateDirectory.fd, 'original.json', 'private-wx');
    try {
      const info = fs.fstatSync(manifestFd, { bigint: true });
      if (!info.isFile() || info.nlink !== BigInt(1) || info.size !== BigInt(0) || info.uid !== BigInt(process.geteuid!())
        || (info.mode & BigInt(0o7777)) !== BigInt(0o600)) changed();
      const manifestIdentity = copyFreeze({ dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), mode: 0o600 as const });
      const body = { version: 1 as const, operationId: stage.identity.operationId, stageDigest: stage.payloadSha256, destinationScope: scope,
        configuredDataRoot: resolveDataDir(), resolvedDataRoot: rootPath(),
        ancestors: frame.directories.slice(0, -1).map(directory => ({ name: directory.name ?? '', identity: directory.identity })),
        privateDirectory: { name: frame.privateDirectory.name!, identity: frame.privateDirectory.identity }, manifestIdentity,
        metadata: [...metadata.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)), blobs };
      frame.original = captureExcalidrawCopyAssetOriginal({ ...body, originalProof: copyDigest(body) });
      write(frame, 'original.json', Buffer.from(copyJson(frame.original)), manifestFd); verify(frame, false);
    } finally { fs.closeSync(manifestFd); }
  } catch (error) { close(frame); throw error; }
  // Callback failures retain the original: a lost B1 ACK may have committed it.
  return run(frame, callback);
}
export async function withRecoveredExcalidrawCopyAssets<T>(input: Readonly<{ stage: WorkspaceOperationManagedCopyStageV4;
  destinationWorkspace: WorkspaceContext; original: ExcalidrawCopyAssetOriginal }>,
callback: (cap: PreparedExcalidrawCopyAssets) => T | Promise<T>): Promise<T> {
  const stage = captureNativeCopyPhaseStage(input.stage), original = captureExcalidrawCopyAssetOriginal(input.original);
  if (stage.version !== 4 || original.operationId !== stage.identity.operationId || original.stageDigest !== stage.payloadSha256
    || !equal(original.destinationScope, stage.origin.destinationScope)
    || !equal(captureWorkspaceOperationJobScope(input.destinationWorkspace), original.destinationScope)) changed();
  assertNativeCopyManagedAssetOwner(stage);
  const frame = open(original.destinationScope.workspaceId, original.privateDirectory.name, false, stage); frame.original = original;
  try { verify(frame, false); } catch (error) { close(frame); throw error; }
  return run(frame, callback);
}
export function readPreparedExcalidrawCopyAssets(cap: PreparedExcalidrawCopyAssets): ExcalidrawCopyAssetOriginal {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Local Node FD-cap accessor; no React state or hook is used.
  return use(cap, frame => { verify(frame, false); return frame.original; });
}
export async function assertPreparedExcalidrawCopyAssetsCurrent(cap: PreparedExcalidrawCopyAssets): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Local Node FD-cap accessor; no React state or hook is used.
  use(cap, frame => { verify(frame, frame.receipt !== null); });
}
/** Mechanical receipt verification on the caller's fenced B2 path. No SQL,
 * last-reference clock, bootstrap or public-file mutation is performed. */
export async function assertPublishedExcalidrawCopyAssets(originalInput: ExcalidrawCopyAssetOriginal,
  receiptInput: ExcalidrawCopyAssetReceipt): Promise<void> {
  const original = captureExcalidrawCopyAssetOriginal(originalInput), receipt = captureExcalidrawCopyAssetReceipt(receiptInput, original);
  const frame = open(original.destinationScope.workspaceId, original.privateDirectory.name, false); frame.original = original;
  try { if (!equal(verify(frame, true), receipt)) changed(); } finally { close(frame); }
}
export async function publishPreparedExcalidrawCopyAssets(cap: PreparedExcalidrawCopyAssets): Promise<ExcalidrawCopyAssetReceipt> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Local Node FD-cap accessor; no React state or hook is used.
  return use(cap, frame => {
    const stage = frame.stage; if (!stage) changed();
    const publication = () => assertNativeCopyManagedAssetPublication(stage, frame.original);
    publication();
    verify(frame, false);
    for (const blob of frame.original.blobs) if (blob.disposition === 'birth') {
      publication(); if (!frame.io.hasExactNameAt(frame.privateDirectory.fd, blob.contentHash)) continue;
      publication();
      read(frame, frame.privateDirectory, blob.contentHash, blob.sizeBytes, blob.identity);
      publication();
      getFdPathMoveBackend().renameNoReplaceAt(frame.privateDirectory.fd, blob.contentHash, frame.workspace.fd, blob.contentHash);
      publication(); fs.fsyncSync(frame.workspace.fd);
      publication(); fs.fsyncSync(frame.privateDirectory.fd);
      publication();
      read(frame, frame.workspace, blob.contentHash, blob.sizeBytes, blob.identity);
    }
    publication();
    const receipt = verify(frame, true)!; frame.receipt = receipt; return receipt;
  });
}
export async function discardPreparedExcalidrawCopyAssets(cap: PreparedExcalidrawCopyAssets): Promise<void> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Local Node FD-cap accessor; no React state or hook is used.
  use(cap, frame => {
    verify(frame, false);
    if (frame.original.blobs.some(blob => blob.disposition === 'birth' && frame.io.hasExactNameAt(frame.workspace.fd, blob.contentHash))) uncertain();
    for (const blob of frame.original.blobs) if (blob.disposition === 'birth') frame.io.unlinkFileAt(frame.privateDirectory.fd, blob.contentHash,
      { dev: blob.identity.dev, ino: blob.identity.ino, uid: blob.identity.uid, mode: 0o600 });
    removeManifest(frame); frame.active = false;
  });
}
function removeManifest(frame: Frame): void {
  manifest(frame);
  // The immutable B1 identity, never a fresh replacement inode, authorizes unlink.
  frame.io.unlinkFileAt(frame.privateDirectory.fd, 'original.json', frame.original.manifestIdentity);
  fs.fsyncSync(frame.privateDirectory.fd);
  // rmdir is deliberately absent: retain the empty, inode-bound private parent.
}
/** Only private original artifacts are retired. This cannot remove or rewrite
 * a public blob, and never consults a later document/path/asset row. The owner
 * calls this after its actual durable B2 acknowledgement (or pinned history). */
export async function retireExcalidrawCopyAssetOriginal(supplied: ExcalidrawCopyAssetOriginal,
  birth: ExcalidrawCopyBirthReceipt): Promise<void> {
  const original = captureExcalidrawCopyAssetOriginal(supplied), completed = captureExcalidrawCopyBirthReceipt(birth);
  if (completed.intent.assetOriginal.originalProof !== original.originalProof || completed.intent.operationId !== original.operationId
    || completed.stageDigest !== original.stageDigest) changed();
  captureExcalidrawCopyAssetReceipt(completed.assetReceipt, original);
  await assertNativeCopyManagedAssetRetirement(original, completed);
  let frame: Frame | null = null;
  try {
    frame = open(original.destinationScope.workspaceId, original.privateDirectory.name, false); frame.original = original;
    check(frame, frame.privateDirectory);
    if (original.configuredDataRoot !== resolveDataDir() || original.resolvedDataRoot !== rootPath()
      || !equal(frame.directories.slice(0, -1).map(directory => ({ name: directory.name ?? '', identity: directory.identity })), original.ancestors)
      || !equal(frame.privateDirectory.identity, original.privateDirectory.identity)) changed();
    // Historical cleanup intentionally does not read any public blob (D2 safe).
    if (!frame.io.hasExactNameAt(frame.privateDirectory.fd, 'original.json')) return;
    for (const blob of original.blobs) if (frame.io.hasExactNameAt(frame.privateDirectory.fd, blob.contentHash)) uncertain();
    removeManifest(frame);
  } finally {
    try { await assertNativeCopyManagedAssetRetirement(original, completed); }
    finally { if (frame) close(frame); }
  }
}
