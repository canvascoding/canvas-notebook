import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { absoluteDataPath, expiresAtFrom, retentionDays, trashRelativePathFor } from './workspace-trash-layout';

/** Mechanical observations only. The caller owns authorization, its exclusive
 * lifecycle lease and the durable original-target intent BEFORE calling move. */
export type PreparedSingleFileTrashIdentity = Readonly<{
  device: number; inode: number; size: number; mode: number; uid: number; gid: number;
  linkCount: number; birthtimeMs: number; mtimeMs: number; ctimeMs: number;
}>;
type Scope = Readonly<{ workspaceId: string; workspaceType: WorkspaceContext['workspaceType'];
  organizationId: string | null; rootPath: string; dataRoot: string }>;
type DirectoryFact = Readonly<{ segment: string; identity: PreparedSingleFileTrashIdentity }>;
type RootFact = Readonly<{ resolvedPath: string; identity: PreparedSingleFileTrashIdentity }>;
type FilesystemFacts = Readonly<{ workspaceRoot: RootFact; dataRoot: RootFact;
  sourceDirectories: readonly DirectoryFact[]; trashDirectories: readonly DirectoryFact[]; missingSourcePrefix: string | null }>;
export type PreparedSingleFileTrashOriginalFacts = Readonly<{
  version: 1; workspace: Scope; canonicalPath: string; trashEntryId: string; trashRelativePath: string;
  deletedAtMs: number; expiresAtMs: number; retentionDays: number; filesystem: FilesystemFacts;
  source: Readonly<{ kind: 'regular_file'; identity: PreparedSingleFileTrashIdentity; sha256: string }>
    | Readonly<{ kind: 'projection_absent' }>;
}>;
export type PreparedSingleFileTrashReceipt = Readonly<{
  version: 1; original: PreparedSingleFileTrashOriginalFacts;
  observation: Readonly<{ kind: 'moved'; method: 'rename'; identity: PreparedSingleFileTrashIdentity; sha256: string }>
    | Readonly<{ kind: 'projection_absent' }>;
}>;
declare const preparedBrand: unique symbol;
export type PreparedWorkspaceSingleFileTrash = Readonly<{ [preparedBrand]: true }>;
export type PreparedWorkspaceSingleFileTrashInput = Readonly<{
  workspace: WorkspaceContext; dataRoot: string; canonicalPath: string; trashEntryId: string;
}>;

export type RecoveredWorkspaceSingleFileTrashInput = Readonly<{ workspace: WorkspaceContext; dataRoot: string; original: PreparedSingleFileTrashOriginalFacts }>;

/** New, durable pre-restore observations. Historical trash/root pins remain in
 * trashReceipt; destination parents are captured for this Undo attempt only. */
export type PreparedSingleFileRestoreOriginalFacts = Readonly<{
  version: 1; trashReceipt: PreparedSingleFileTrashReceipt;
  destination: Readonly<{ kind: 'vacant'; directories: readonly DirectoryFact[] }>
    | Readonly<{ kind: 'projection_absent' }>;
}>;
export type PreparedSingleFileRestoreReceipt = Readonly<{
  version: 1; original: PreparedSingleFileRestoreOriginalFacts;
  observation: Readonly<{ kind: 'restored'; method: 'rename'; identity: PreparedSingleFileTrashIdentity; sha256: string }>
    | Readonly<{ kind: 'projection_absent' }>;
}>;
declare const restoreBrand: unique symbol;
export type PreparedWorkspaceSingleFileRestore = Readonly<{ [restoreBrand]: true }>;
export type PreparedWorkspaceSingleFileRestoreInput = Readonly<{
  workspace: WorkspaceContext; dataRoot: string; receipt: PreparedSingleFileTrashReceipt;
}>;
export type RecoveredWorkspaceSingleFileRestoreInput = Readonly<{
  workspace: WorkspaceContext; dataRoot: string; original: PreparedSingleFileRestoreOriginalFacts;
}>;
type PreparedFilesystemCapability = PreparedWorkspaceSingleFileTrash | PreparedWorkspaceSingleFileRestore;

type ErrorCode = 'invalid-input' | 'invalid-lifetime' | 'reentrant-operation' | 'already-moved'
  | 'scope-changed' | 'unsafe-path' | 'source-changed' | 'destination-occupied'
  | 'unawaited-operation' | 'cross-device-move' | 'move-unconfirmed' | 'recovery-conflict' | 'disposal-unconfirmed';
export class PreparedSingleFileTrashError extends Error {
  readonly status: 503 | undefined;
  constructor(readonly code: ErrorCode, readonly moveAttempted = false, options?: ErrorOptions) {
    super(code, options); this.name = 'PreparedSingleFileTrashError'; this.status = code === 'disposal-unconfirmed' ? 503 : undefined;
  }
}
type Pin = { absolutePath: string; handle: FileHandle; identity: PreparedSingleFileTrashIdentity };
type Stage = {
  input: { workspace: Scope; canonicalPath: string; trashEntryId: string; trashRelativePath: string;
    deletedAtMs: number; expiresAtMs: number; retentionDays: number };
  phase: 'preparing' | 'callback' | 'closing' | 'closed'; failure: Error | null;
  kind: 'trash' | 'restore'; restoreFacts?: PreparedSingleFileRestoreOriginalFacts;
  handles: FileHandle[]; pins: Map<string, Pin>; configuredRoots: { configured: string; resolved: string }[];
  sourcePath: string; destinationPath: string; entryDirectory: string; entryPin?: Pin; ownsNewReservation: boolean;
  missingPath?: string; sourceHandle?: FileHandle; facts?: PreparedSingleFileTrashOriginalFacts;
  recovery: 'none' | 'original_source' | 'already_moved' | 'projection_absent' | 'restore_pending' | 'already_restored';
  moveStarted: boolean; moveCompleted: boolean; renameAttempted: boolean; pending: Promise<unknown> | null;
};
const stages = new WeakMap<PreparedFilesystemCapability, Stage>();
const currentStage = new AsyncLocalStorage<Stage>();
const HASH_CHUNK_BYTES = 256 * 1024;
const MAX_DEPTH = 128;
const failure = (code: ErrorCode, attempted = false, cause?: unknown) => new PreparedSingleFileTrashError(code, attempted,
  cause === undefined ? undefined : { cause });
function normalizeError(error: unknown): Error { return error instanceof Error ? error : new Error('Trash operation failed', { cause: error }); }
function poison(stage: Stage | undefined, error: unknown): Error {
  const normalized = normalizeError(error);
  if (stage && !stage.failure) stage.failure = normalized;
  const active = currentStage.getStore();
  if (active && active !== stage && !active.failure) active.failure = normalized;
  return normalized;
}
function dataProperty(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') throw failure('invalid-input');
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && !('value' in descriptor)) throw failure('invalid-input');
  return descriptor?.value;
}
function boundedString(input: unknown, max = 256): string {
  if (typeof input !== 'string' || !input || input.length > max || /[\u0000-\u001f\u007f]/u.test(input)) throw failure('invalid-input');
  return input;
}
function absolutePath(input: unknown): string {
  const value = boundedString(input, 4096);
  if (!path.isAbsolute(value) || value.includes('\\')) throw failure('invalid-input');
  return path.resolve(value);
}
function capture(input: PreparedWorkspaceSingleFileTrashInput): Stage['input'] {
  const workspace = dataProperty(input, 'workspace');
  const workspaceId = boundedString(dataProperty(workspace, 'workspaceId'));
  const workspaceType = dataProperty(workspace, 'workspaceType');
  if (!['personal', 'organization', 'team', 'project'].some(value => value === workspaceType)) throw failure('invalid-input');
  const organization = dataProperty(workspace, 'organizationId');
  const organizationId = organization == null ? null : boundedString(organization);
  if ([workspaceId, organizationId].some(value => value === '.' || value === '..')) throw failure('invalid-input');
  const canonicalPath = dataProperty(input, 'canonicalPath');
  const trashEntryId = dataProperty(input, 'trashEntryId');
  if (!isCanonicalWorkspacePath(canonicalPath) || canonicalPath.split('/').length > MAX_DEPTH
    || typeof trashEntryId !== 'string' || !/^trash-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(trashEntryId)) throw failure('invalid-input');
  const scope = Object.freeze({ workspaceId, workspaceType: workspaceType as WorkspaceContext['workspaceType'], organizationId,
    rootPath: absolutePath(dataProperty(workspace, 'rootPath')), dataRoot: absolutePath(dataProperty(input, 'dataRoot')) });
  const days = retentionDays(), deletedAtMs = Date.now();
  return { workspace: scope, canonicalPath, trashEntryId, trashRelativePath: trashRelativePathFor(scope, trashEntryId, canonicalPath),
    retentionDays: days, deletedAtMs, expiresAtMs: expiresAtFrom(new Date(deletedAtMs), days).getTime() };
}
function identity(stat: Stats): PreparedSingleFileTrashIdentity {
  for (const value of [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink]) {
    if (!Number.isSafeInteger(value) || value < 0) throw failure('unsafe-path');
  }
  for (const value of [stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs]) if (!Number.isFinite(value)) throw failure('unsafe-path');
  return Object.freeze({ device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode,
    uid: stat.uid, gid: stat.gid, linkCount: stat.nlink, birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}
function sameNode(a: PreparedSingleFileTrashIdentity, b: PreparedSingleFileTrashIdentity): boolean {
  return a.device === b.device && a.inode === b.inode && a.birthtimeMs === b.birthtimeMs
    && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
function sameFile(a: PreparedSingleFileTrashIdentity, b: PreparedSingleFileTrashIdentity, afterRename = false): boolean {
  return sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.linkCount === b.linkCount
    && (afterRename || a.ctimeMs === b.ctimeMs);
}
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
async function exactEntry(parent: string, name: string): Promise<boolean> {
  const directory = await fs.opendir(parent);
  try { for (let entry = await directory.read(); entry; entry = await directory.read()) if (entry.name === name) return true; }
  finally { await directory.close(); }
  return false;
}
async function exactStat(absolute: string): Promise<Stats | null> {
  const exact = await exactEntry(path.dirname(absolute), path.basename(absolute));
  let stat: Stats;
  try { stat = await fs.lstat(absolute); } catch (error) { if (!exact && isMissing(error)) return null; throw error; }
  // A case-insensitive alias is neither the requested entry nor proven absence.
  if (!exact) throw failure('unsafe-path');
  return stat;
}
function assertInternal(stage: Stage): void {
  if (stage.failure) throw stage.failure;
  if (stage.phase !== 'callback') throw poison(stage, failure('invalid-lifetime', stage.renameAttempted));
}
function requireStage(prepared: PreparedFilesystemCapability, kind: Stage['kind'] = 'trash'): Stage {
  const stage = stages.get(prepared);
  if (!stage || currentStage.getStore() !== stage || stage.phase !== 'callback' || stage.kind !== kind) {
    throw poison(stage, failure('invalid-lifetime', stage?.renameAttempted));
  }
  if (stage.failure) throw stage.failure;
  return stage;
}
async function pinDirectory(stage: Stage, absolute: string): Promise<Pin> {
  const existing = stage.pins.get(absolute);
  if (existing) return existing;
  const before = await fs.lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink()) throw failure('unsafe-path');
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
  stage.handles.push(handle);
  const opened = await handle.stat();
  const pin = { absolutePath: absolute, handle, identity: identity(opened) };
  if (!opened.isDirectory() || !sameNode(identity(before), pin.identity)) throw failure('scope-changed');
  stage.pins.set(absolute, pin); return pin;
}
async function pinRoot(stage: Stage, configured: string): Promise<string> {
  const stat = await fs.lstat(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-path');
  const resolved = await fs.realpath(configured);
  const pin = await pinDirectory(stage, resolved);
  if (!sameNode(identity(stat), pin.identity)) throw failure('scope-changed');
  stage.configuredRoots.push({ configured, resolved }); return resolved;
}
async function verifyDirectories(stage: Stage): Promise<void> {
  for (const root of stage.configuredRoots) {
    const stat = await fs.lstat(root.configured);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root.configured) !== root.resolved
      || !sameNode(identity(stat), stage.pins.get(root.resolved)!.identity)) throw failure('scope-changed', stage.renameAttempted);
  }
  for (const pin of stage.pins.values()) {
    const named = await fs.lstat(pin.absolutePath), held = await pin.handle.stat();
    if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory()
      || !sameNode(identity(named), pin.identity) || !sameNode(identity(held), pin.identity)
      || await fs.realpath(pin.absolutePath) !== pin.absolutePath) throw failure('scope-changed', stage.renameAttempted);
    if (stage.configuredRoots.every(root => root.resolved !== pin.absolutePath)
      && !await exactEntry(path.dirname(pin.absolutePath), path.basename(pin.absolutePath))) throw failure('scope-changed', stage.renameAttempted);
  }
}
async function hashFile(handle: FileHandle, expected: PreparedSingleFileTrashIdentity, afterRename = false): Promise<string> {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || !sameFile(identity(before), expected, afterRename)) throw failure('source-changed');
  const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, expected.size + 1));
  let position = 0;
  while (position < expected.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - position), position);
    if (!bytesRead) throw failure('source-changed');
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  if ((await handle.read(buffer, 0, 1, position)).bytesRead !== 0) throw failure('source-changed');
  const after = await handle.stat();
  if (!after.isFile() || !sameFile(identity(after), expected, afterRename)) throw failure('source-changed');
  return hash.digest('hex');
}
async function verifyEntryContents(stage: Stage, moved: boolean): Promise<void> {
  const directory = await fs.opendir(stage.entryDirectory); let count = 0;
  try {
    for (let entry = await directory.read(); entry; entry = await directory.read()) {
      if (!moved || ++count > 1 || entry.name !== path.basename(stage.destinationPath)) throw failure('destination-occupied', stage.renameAttempted);
    }
    if (moved && count !== 1) throw failure('source-changed', stage.renameAttempted);
  } finally { await directory.close(); }
}
async function assertAbsent(absolute: string): Promise<void> {
  if (await exactStat(absolute)) throw failure('source-changed');
}
async function verifySource(stage: Stage, afterRename = false): Promise<void> {
  await verifyDirectories(stage);
  const source = stage.facts!.source;
  if (source.kind === 'projection_absent') {
    if (stage.recovery !== 'projection_absent') await assertAbsent(stage.missingPath!);
    return;
  }
  if (afterRename) {
    if (stage.recovery === 'already_moved') {
      const current = await exactStat(stage.sourcePath);
      if (current && current.dev === source.identity.device && current.ino === source.identity.inode) throw failure('recovery-conflict');
    } else await assertAbsent(stage.sourcePath);
  }
  const target = afterRename ? stage.destinationPath : stage.sourcePath;
  const stat = await exactStat(target);
  if (!stat?.isFile() || stat.nlink !== 1 || !sameFile(identity(stat), source.identity, afterRename)
    || await hashFile(stage.sourceHandle!, source.identity, afterRename) !== source.sha256) throw failure('source-changed', stage.renameAttempted);
  await verifyDirectories(stage);
  const final = await fs.lstat(target);
  if (!final.isFile() || !sameFile(identity(final), source.identity, afterRename)) throw failure('source-changed', stage.renameAttempted);
}
async function prepare(stage: Stage): Promise<void> {
  const root = await pinRoot(stage, stage.input.workspace.rootPath);
  const dataRoot = await pinRoot(stage, stage.input.workspace.dataRoot);
  stage.sourcePath = path.join(root, stage.input.canonicalPath);
  stage.destinationPath = absoluteDataPath(stage.input.trashRelativePath, dataRoot);
  stage.entryDirectory = path.dirname(stage.destinationPath);
  if (stage.sourcePath === stage.destinationPath || stage.entryDirectory === root || root.startsWith(`${stage.entryDirectory}${path.sep}`)) throw failure('unsafe-path');
  let parent = root; const sourceDirectories: DirectoryFact[] = [], trashDirectories: DirectoryFact[] = [];
  const segments = stage.input.canonicalPath.split('/');
  for (const segment of segments.slice(0, -1)) {
    const child = path.join(parent, segment), stat = await exactStat(child);
    if (!stat) { stage.missingPath = child; break; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-path');
    const pin = await pinDirectory(stage, child);
    sourceDirectories.push(Object.freeze({ segment, identity: pin.identity })); parent = child;
  }
  let source: PreparedSingleFileTrashOriginalFacts['source'];
  const original = stage.missingPath ? null : await exactStat(stage.sourcePath);
  if (!original) { stage.missingPath ??= stage.sourcePath; source = Object.freeze({ kind: 'projection_absent' }); }
  else {
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) throw failure('unsafe-path');
    const handle = await fs.open(stage.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    stage.handles.push(handle); stage.sourceHandle = handle;
    const before = identity(original), sha256 = await hashFile(handle, before);
    source = Object.freeze({ kind: 'regular_file', identity: before, sha256 });
  }
  // Reserve a private, new entry directory. Never borrow/delete an existing one.
  parent = dataRoot;
  const directorySegments = path.relative(dataRoot, stage.entryDirectory).split(path.sep);
  for (const [index, segment] of directorySegments.entries()) {
    const child = path.join(parent, segment), last = index === directorySegments.length - 1;
    await verifyDirectories(stage);
    try { await fs.mkdir(child, { mode: 0o700 }); }
    catch (error) { if (last || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    if (!await exactEntry(parent, segment)) throw failure('unsafe-path');
    const pin = await pinDirectory(stage, child);
    trashDirectories.push(Object.freeze({ segment, identity: pin.identity }));
    if (last) {
      if ((pin.identity.mode & 0o077) !== 0 || typeof process.getuid === 'function' && pin.identity.uid !== process.getuid()) throw failure('unsafe-path');
      stage.entryPin = pin; stage.ownsNewReservation = true;
    }
    parent = child;
  }
  const filesystem = Object.freeze({ workspaceRoot: Object.freeze({ resolvedPath: root, identity: stage.pins.get(root)!.identity }),
    dataRoot: Object.freeze({ resolvedPath: dataRoot, identity: stage.pins.get(dataRoot)!.identity }),
    sourceDirectories: Object.freeze(sourceDirectories), trashDirectories: Object.freeze(trashDirectories),
    missingSourcePrefix: stage.missingPath ? path.relative(root, stage.missingPath).split(path.sep).join('/') : null });
  stage.facts = Object.freeze({ version: 1, ...stage.input, filesystem, source });
  await verifySource(stage);
  if (await exactStat(stage.destinationPath)) throw failure('destination-occupied');
}

async function observedMovedIdentity(stage: Stage, expected: PreparedSingleFileTrashIdentity): Promise<PreparedSingleFileTrashIdentity> {
  const stat = await stage.sourceHandle!.stat(); assertInternal(stage);
  const observed = identity(stat);
  if (!stat.isFile() || !sameFile(observed, expected, true)) throw failure('source-changed', stage.renameAttempted);
  return observed;
}

/** Frozen historical facts; no file descriptors or write/admission capabilities escape. */
export function readPreparedWorkspaceSingleFileTrash(prepared: PreparedWorkspaceSingleFileTrash): PreparedSingleFileTrashOriginalFacts {
  return requireStage(prepared).facts!;
}
/** Single rename only. No cross-device copy, rollback or overwrite compensation.
 * A rejected attempted rename requires caller-led recovery from its durable intent.
 * A missing projection is only absence evidence, never native document authority. */
export function movePreparedWorkspaceSingleFileTrash(prepared: PreparedWorkspaceSingleFileTrash): Promise<PreparedSingleFileTrashReceipt> {
  let stage: Stage;
  try {
    stage = requireStage(prepared);
    if (stage.moveStarted) throw poison(stage, failure(stage.pending ? 'reentrant-operation' : 'already-moved', stage.renameAttempted));
    stage.moveStarted = true;
  } catch (error) { return Promise.reject(error); }
  const operation = (async (): Promise<PreparedSingleFileTrashReceipt> => {
    try {
      if (stage.recovery === 'already_moved') {
        await verifySource(stage, true); await verifyEntryContents(stage, true); assertInternal(stage);
        const source = stage.facts!.source;
        if (source.kind !== 'regular_file') throw failure('recovery-conflict');
        const after = await observedMovedIdentity(stage, source.identity); stage.moveCompleted = true;
        return Object.freeze({ version: 1, original: stage.facts!, observation: Object.freeze({ kind: 'moved', method: 'rename',
          identity: after, sha256: source.sha256 }) });
      }
      await verifySource(stage); assertInternal(stage);
      await verifyEntryContents(stage, false);
      if (await exactStat(stage.destinationPath)) throw failure('destination-occupied');
      assertInternal(stage);
      const source = stage.facts!.source;
      if (source.kind === 'projection_absent') {
        await verifySource(stage); await verifyEntryContents(stage, false); assertInternal(stage);
        stage.moveCompleted = true;
        return Object.freeze({ version: 1, original: stage.facts!, observation: Object.freeze({ kind: 'projection_absent' }) });
      }
      // Node has no portable renameat2(NOREPLACE). The exclusive 0700 directory
      // and caller's real lifecycle lease are prerequisites, not an admin fence.
      try { stage.renameAttempted = true; await fs.rename(stage.sourcePath, stage.destinationPath); }
      catch (error) {
        const crossDevice = !!error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV';
        throw failure(crossDevice ? 'cross-device-move' : 'move-unconfirmed', true, error);
      }
      await verifySource(stage, true); await verifyEntryContents(stage, true); assertInternal(stage);
      const after = await observedMovedIdentity(stage, source.identity); stage.moveCompleted = true;
      return Object.freeze({ version: 1, original: stage.facts!, observation: Object.freeze({ kind: 'moved', method: 'rename', identity: after, sha256: source.sha256 }) });
    } catch (error) {
      const observed = stage.renameAttempted && (!(error instanceof PreparedSingleFileTrashError) || !error.moveAttempted)
        ? failure(error instanceof PreparedSingleFileTrashError ? error.code : 'move-unconfirmed', true, error) : error;
      throw poison(stage, observed);
    }
  })();
  return trackPending(stage, operation);
}

function trackPending<T>(stage: Stage, operation: Promise<T>): Promise<T> {
  stage.pending = operation;
  // Observe failures even if a faulty caller detaches the returned promise.
  const settled = () => { if (stage.pending === operation) stage.pending = null; };
  void operation.then(settled, settled);
  return operation;
}

/** Rejection-only verification of the observed move before a caller records
 * SQL/completion. It grants no authority and never moves/restores a pathname.
 * An original projection_absent means only the historical original observation:
 * its reservation is rechecked while a new D2 at source remains untouched. */
export function assertPreparedWorkspaceSingleFileTrashCurrent(prepared: PreparedWorkspaceSingleFileTrash): Promise<void> {
  let stage: Stage;
  try {
    stage = requireStage(prepared);
    if (stage.pending) throw poison(stage, failure('reentrant-operation', stage.renameAttempted));
    if (!stage.moveCompleted) throw poison(stage, failure('invalid-lifetime', stage.renameAttempted));
  } catch (error) { return Promise.reject(error); }
  const operation = (async () => {
    try {
      if (stage.facts!.source.kind === 'projection_absent') {
        await verifyDirectories(stage); await verifyEntryContents(stage, false); assertInternal(stage);
      } else {
        await verifySource(stage, true); await verifyEntryContents(stage, true);
        await observedMovedIdentity(stage, stage.facts!.source.identity); assertInternal(stage);
      }
    } catch (error) { throw poison(stage, error); }
  })();
  return trackPending(stage, operation);
}

/** Callback-scoped pure FS preparation. A reserved entry is retained after the
 * callback sees its facts, including callback failure: only the caller's durable
 * intent/recovery layer knows whether that reservation can be discarded safely.
 * Recovery uses a separate explicit entry. Neither entry opens/commits SQL or
 * claims authority. */
async function runCaptured<T, Capability extends PreparedFilesystemCapability = PreparedWorkspaceSingleFileTrash>(
  captured: Stage['input'], initialize: (stage: Stage) => Promise<void>,
  operation: (prepared: Capability) => Promise<T>, kind: Stage['kind'] = 'trash'): Promise<T> {
  const active = currentStage.getStore();
  if (active) throw poison(active, failure('reentrant-operation', active.renameAttempted));
  if (typeof operation !== 'function') throw failure('invalid-input');
  const stage: Stage = { input: captured, phase: 'preparing', failure: null, kind, handles: [], pins: new Map(), configuredRoots: [],
    sourcePath: '', destinationPath: '', entryDirectory: '', ownsNewReservation: false, recovery: 'none', moveStarted: false, moveCompleted: false, renameAttempted: false, pending: null };
  let value: T | undefined; let exposed = false;
  try {
    await initialize(stage);
    const cap = Object.freeze({}) as Capability;
    stages.set(cap, stage); stage.phase = 'callback'; exposed = true;
    await currentStage.run(stage, async () => {
      try { value = await operation(cap); } catch (error) { poison(stage, error); }
      finally {
        stage.phase = 'closing';
        const pending = stage.pending;
        if (pending) { poison(stage, failure('unawaited-operation', stage.renameAttempted)); await Promise.allSettled([pending]); }
      }
    });
    if (stage.failure) throw stage.failure;
    return value as T;
  } catch (error) { throw poison(stage, error); } finally {
    stage.phase = 'closed';
    const closed = await Promise.allSettled([...stage.handles].reverse().map(handle => Promise.resolve().then(() => handle.close())));
    // Preparation never exposed an intent path; remove only our still-empty,
    // inode-matched reservation, never a payload or an existing directory.
    if (!exposed && stage.ownsNewReservation && stage.entryPin) {
      try {
        const stat = await fs.lstat(stage.entryDirectory);
        if (stat.isDirectory() && !stat.isSymbolicLink() && sameNode(identity(stat), stage.entryPin.identity)) await fs.rmdir(stage.entryDirectory);
      } catch { /* An uncertain/occupied entry stays available for recovery. */ }
    }
    const closeFailures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (closeFailures.length) {
      const errors = [...(stage.failure ? [stage.failure] : []), ...closeFailures];
      throw new PreparedSingleFileTrashError('disposal-unconfirmed', stage.renameAttempted,
        { cause: new AggregateError(errors, 'Trash descriptor disposal could not be confirmed.') });
    }
  }
}

export async function withPreparedWorkspaceSingleFileTrash<T>(input: PreparedWorkspaceSingleFileTrashInput,
  operation: (prepared: PreparedWorkspaceSingleFileTrash) => Promise<T>): Promise<T> {
  try { return await runCaptured(capture(input), prepare, operation); }
  catch (error) { throw poison(currentStage.getStore(), error); }
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).length !== keys.length) throw failure('invalid-input');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw failure('invalid-input');
    result[key] = descriptor.value;
  }
  return result;
}
const identityKeys = ['device', 'inode', 'size', 'mode', 'uid', 'gid', 'linkCount', 'birthtimeMs', 'mtimeMs', 'ctimeMs'] as const;
function captureIdentity(input: unknown): PreparedSingleFileTrashIdentity {
  const raw = record(input, identityKeys);
  for (const key of identityKeys) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)
      || !key.endsWith('timeMs') && (!Number.isSafeInteger(value) || value < 0)) throw failure('invalid-input');
  }
  return Object.freeze(raw) as PreparedSingleFileTrashIdentity;
}
function captureRoot(input: unknown): RootFact {
  const raw = record(input, ['resolvedPath', 'identity']), resolvedPath = absolutePath(raw.resolvedPath);
  if (resolvedPath !== raw.resolvedPath) throw failure('invalid-input');
  return Object.freeze({ resolvedPath, identity: captureIdentity(raw.identity) });
}
function captureDirectories(input: unknown): readonly DirectoryFact[] {
  if (!Array.isArray(input) || input.length > MAX_DEPTH || Reflect.ownKeys(input).length !== input.length + 1) throw failure('invalid-input');
  const result: DirectoryFact[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor)) throw failure('invalid-input');
    const raw = record(descriptor.value, ['segment', 'identity']);
    if (!isCanonicalWorkspacePath(raw.segment) || raw.segment.includes('/')) throw failure('invalid-input');
    result.push(Object.freeze({ segment: raw.segment, identity: captureIdentity(raw.identity) }));
  }
  return Object.freeze(result);
}
function captureRecovery(input: RecoveredWorkspaceSingleFileTrashInput): { captured: Stage['input']; original: PreparedSingleFileTrashOriginalFacts } {
  const raw = record(dataProperty(input, 'original'), ['version', 'workspace', 'canonicalPath', 'trashEntryId', 'trashRelativePath',
    'deletedAtMs', 'expiresAtMs', 'retentionDays', 'source', 'filesystem']);
  const captured = capture({ workspace: dataProperty(input, 'workspace') as WorkspaceContext, dataRoot: dataProperty(input, 'dataRoot') as string,
    canonicalPath: raw.canonicalPath as string, trashEntryId: raw.trashEntryId as string });
  const scope = record(raw.workspace, ['workspaceId', 'workspaceType', 'organizationId', 'rootPath', 'dataRoot']);
  if (raw.version !== 1 || Object.entries(captured.workspace).some(([key, value]) => scope[key] !== value)
    || raw.trashRelativePath !== captured.trashRelativePath) throw failure('invalid-input');
  for (const value of [raw.deletedAtMs, raw.expiresAtMs, raw.retentionDays]) if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw failure('invalid-input');
  if ((raw.retentionDays as number) < 1 || (raw.retentionDays as number) > 3650
    || raw.expiresAtMs !== (raw.deletedAtMs as number) + (raw.retentionDays as number) * 86400000) throw failure('invalid-input');
  const sourceKind = dataProperty(raw.source, 'kind'); let source: PreparedSingleFileTrashOriginalFacts['source'];
  if (sourceKind === 'projection_absent') { record(raw.source, ['kind']); source = Object.freeze({ kind: 'projection_absent' }); }
  else {
    const sourceRaw = record(raw.source, ['kind', 'identity', 'sha256']);
    if (sourceRaw.kind !== 'regular_file' || typeof sourceRaw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceRaw.sha256)) throw failure('invalid-input');
    source = Object.freeze({ kind: 'regular_file', identity: captureIdentity(sourceRaw.identity), sha256: sourceRaw.sha256 });
    if (source.identity.linkCount !== 1) throw failure('invalid-input');
  }
  const rawFs = record(raw.filesystem, ['workspaceRoot', 'dataRoot', 'sourceDirectories', 'trashDirectories', 'missingSourcePrefix']);
  const filesystem: FilesystemFacts = Object.freeze({ workspaceRoot: captureRoot(rawFs.workspaceRoot), dataRoot: captureRoot(rawFs.dataRoot),
    sourceDirectories: captureDirectories(rawFs.sourceDirectories), trashDirectories: captureDirectories(rawFs.trashDirectories),
    missingSourcePrefix: rawFs.missingSourcePrefix as string | null });
  const sourceSegments = captured.canonicalPath.split('/'), sourceDirs = filesystem.sourceDirectories;
  if (sourceDirs.some((dir, index) => dir.segment !== sourceSegments[index]) || sourceDirs.length >= sourceSegments.length) throw failure('invalid-input');
  if (source.kind === 'regular_file' ? sourceDirs.length !== sourceSegments.length - 1 || filesystem.missingSourcePrefix !== null
    : filesystem.missingSourcePrefix !== sourceSegments.slice(0, sourceDirs.length + 1).join('/')) throw failure('invalid-input');
  const trashSegments = path.posix.dirname(captured.trashRelativePath).split('/');
  if (filesystem.trashDirectories.length !== trashSegments.length
    || filesystem.trashDirectories.some((dir, index) => dir.segment !== trashSegments[index])) throw failure('invalid-input');
  captured.deletedAtMs = raw.deletedAtMs as number; captured.expiresAtMs = raw.expiresAtMs as number; captured.retentionDays = raw.retentionDays as number;
  return { captured, original: Object.freeze({ version: 1, ...captured, source, filesystem }) };
}
async function recover(stage: Stage, original: PreparedSingleFileTrashOriginalFacts): Promise<void> {
  const root = await pinRestoreRootsAndTrash(stage, original);
  const facts = original.filesystem;
  // Reopen only the historical chains. A newly present D2 is never adopted as
  // the original source or read for content, including a previously absent tree.
  let parent = root;
  for (const expected of facts.sourceDirectories) {
    const child = path.join(parent, expected.segment), stat = await exactStat(child);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw failure('recovery-conflict');
    const actual = await pinDirectory(stage, child);
    if (!sameNode(actual.identity, expected.identity)) throw failure('recovery-conflict');
    parent = child;
  }
  if (original.source.kind === 'projection_absent') {
    stage.recovery = 'projection_absent'; await verifyDirectories(stage); await verifyEntryContents(stage, false); return;
  }
  const expected = original.source.identity;
  const source = await exactStat(stage.sourcePath), dest = await exactStat(stage.destinationPath);
  const sourceIsOriginal = !!source && source.dev === expected.device && source.ino === expected.inode;
  if ((sourceIsOriginal && dest) || (!sourceIsOriginal && !dest)) throw failure('recovery-conflict');
  const target = dest ? stage.destinationPath : stage.sourcePath, observed = dest ?? source;
  if (!observed?.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || !sameFile(identity(observed), expected, !!dest)) throw failure('recovery-conflict');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  stage.handles.push(handle); stage.sourceHandle = handle;
  if (await hashFile(handle, expected, !!dest) !== original.source.sha256) throw failure('recovery-conflict');
  stage.recovery = dest ? 'already_moved' : 'original_source';
  await verifySource(stage, !!dest); await verifyEntryContents(stage, !!dest);
}

/** Resume requires the caller's immutable historical intent, not facts captured
 * from the current pathname. It grants no SQL/native authority. Recreated source
 * nodes remain untouched when the original is proven at its reserved destination.
 * Both/neither original locations, changed pins or payloads fail closed. */
export async function withRecoveredWorkspaceSingleFileTrash<T>(input: RecoveredWorkspaceSingleFileTrashInput,
  operation: (prepared: PreparedWorkspaceSingleFileTrash) => Promise<T>): Promise<T> {
  try {
    const { captured, original } = captureRecovery(input);
    return await runCaptured(captured, stage => recover(stage, original), operation);
  } catch (error) { throw poison(currentStage.getStore(), error); }
}

function captureRestoreInput(input: PreparedWorkspaceSingleFileRestoreInput): {
  captured: Stage['input']; receipt: PreparedSingleFileTrashReceipt;
} {
  const raw = record(dataProperty(input, 'receipt'), ['version', 'original', 'observation']);
  const { captured, original } = captureRecovery({ workspace: dataProperty(input, 'workspace') as WorkspaceContext,
    dataRoot: dataProperty(input, 'dataRoot') as string, original: raw.original as PreparedSingleFileTrashOriginalFacts });
  if (raw.version !== 1) throw failure('invalid-input');
  let observation: PreparedSingleFileTrashReceipt['observation'];
  if (original.source.kind === 'projection_absent') {
    const observed = record(raw.observation, ['kind']);
    if (observed.kind !== 'projection_absent') throw failure('invalid-input');
    observation = Object.freeze({ kind: 'projection_absent' });
  } else {
    const observed = record(raw.observation, ['kind', 'method', 'identity', 'sha256']);
    const observedIdentity = captureIdentity(observed.identity);
    if (observed.kind !== 'moved' || observed.method !== 'rename' || observed.sha256 !== original.source.sha256
      || !sameFile(observedIdentity, original.source.identity, true)) throw failure('invalid-input');
    observation = Object.freeze({ kind: 'moved', method: 'rename', identity: observedIdentity, sha256: original.source.sha256 });
  }
  return { captured, receipt: Object.freeze({ version: 1, original, observation }) };
}

function captureRestoreRecovery(input: RecoveredWorkspaceSingleFileRestoreInput): {
  captured: Stage['input']; original: PreparedSingleFileRestoreOriginalFacts;
} {
  const raw = record(dataProperty(input, 'original'), ['version', 'trashReceipt', 'destination']);
  const { captured, receipt } = captureRestoreInput({ workspace: dataProperty(input, 'workspace') as WorkspaceContext,
    dataRoot: dataProperty(input, 'dataRoot') as string, receipt: raw.trashReceipt as PreparedSingleFileTrashReceipt });
  if (raw.version !== 1) throw failure('invalid-input');
  let destination: PreparedSingleFileRestoreOriginalFacts['destination'];
  if (receipt.observation.kind === 'projection_absent') {
    if (record(raw.destination, ['kind']).kind !== 'projection_absent') throw failure('invalid-input');
    destination = Object.freeze({ kind: 'projection_absent' });
  } else {
    const target = record(raw.destination, ['kind', 'directories']), directories = captureDirectories(target.directories);
    const expected = captured.canonicalPath.split('/').slice(0, -1);
    if (target.kind !== 'vacant' || directories.length !== expected.length
      || directories.some((directory, index) => directory.segment !== expected[index])) throw failure('invalid-input');
    destination = Object.freeze({ kind: 'vacant', directories });
  }
  return { captured, original: Object.freeze({ version: 1, trashReceipt: receipt, destination }) };
}

async function pinRestoreRootsAndTrash(stage: Stage, original: PreparedSingleFileTrashOriginalFacts): Promise<string> {
  const root = await pinRoot(stage, stage.input.workspace.rootPath), dataRoot = await pinRoot(stage, stage.input.workspace.dataRoot);
  const facts = original.filesystem;
  if (root !== facts.workspaceRoot.resolvedPath || dataRoot !== facts.dataRoot.resolvedPath
    || !sameNode(stage.pins.get(root)!.identity, facts.workspaceRoot.identity)
    || !sameNode(stage.pins.get(dataRoot)!.identity, facts.dataRoot.identity)) throw failure('recovery-conflict');
  let parent = dataRoot;
  for (const expected of facts.trashDirectories) {
    const child = path.join(parent, expected.segment), stat = await exactStat(child);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw failure('recovery-conflict');
    const actual = await pinDirectory(stage, child);
    if (!sameNode(actual.identity, expected.identity)) throw failure('recovery-conflict');
    parent = child;
  }
  stage.sourcePath = path.join(root, stage.input.canonicalPath);
  stage.destinationPath = absoluteDataPath(stage.input.trashRelativePath, dataRoot);
  stage.entryDirectory = path.dirname(stage.destinationPath); stage.entryPin = stage.pins.get(stage.entryDirectory);
  if (!stage.entryPin || (stage.entryPin.identity.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && stage.entryPin.identity.uid !== process.getuid()) throw failure('recovery-conflict');
  stage.facts = original;
  return root;
}

async function pinRestoreDestination(stage: Stage, root: string, expected?: readonly DirectoryFact[]): Promise<readonly DirectoryFact[]> {
  let parent = root; const directories: DirectoryFact[] = [];
  for (const [index, segment] of stage.input.canonicalPath.split('/').slice(0, -1).entries()) {
    const child = path.join(parent, segment), stat = await exactStat(child);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw failure('recovery-conflict');
    const actual = await pinDirectory(stage, child);
    if (expected && !sameNode(actual.identity, expected[index].identity)) throw failure('recovery-conflict');
    directories.push(Object.freeze({ segment, identity: actual.identity })); parent = child;
  }
  return Object.freeze(directories);
}

async function openRestorePayload(stage: Stage, restored: boolean): Promise<void> {
  const observed = stage.restoreFacts!.trashReceipt.observation;
  if (observed.kind !== 'moved') throw failure('recovery-conflict');
  const target = restored ? stage.sourcePath : stage.destinationPath, named = await exactStat(target);
  if (!named?.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || !sameFile(identity(named), observed.identity, restored)) throw failure('recovery-conflict');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  stage.handles.push(handle); stage.sourceHandle = handle;
  if (await hashFile(handle, observed.identity, restored) !== observed.sha256) throw failure('recovery-conflict');
}

async function verifyRestore(stage: Stage, restored: boolean): Promise<void> {
  await verifyDirectories(stage);
  const observed = stage.restoreFacts!.trashReceipt.observation;
  if (observed.kind === 'projection_absent') {
    // Historical absence is not permission to inspect or overwrite a new D2.
    await verifyEntryContents(stage, false); return;
  }
  await verifyEntryContents(stage, !restored);
  const target = restored ? stage.sourcePath : stage.destinationPath;
  const named = await exactStat(target);
  if (!named?.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || !sameFile(identity(named), observed.identity, restored)
    || await hashFile(stage.sourceHandle!, observed.identity, restored) !== observed.sha256) throw failure('source-changed', stage.renameAttempted);
  await verifyDirectories(stage);
  const final = await exactStat(target);
  if (!final?.isFile() || !sameFile(identity(final), observed.identity, restored)) throw failure('source-changed', stage.renameAttempted);
  // Last asynchronous check before rename is the exact destination vacancy.
  if (await exactStat(restored ? stage.destinationPath : stage.sourcePath)) throw failure('destination-occupied', stage.renameAttempted);
}

async function prepareRestore(stage: Stage, receipt: PreparedSingleFileTrashReceipt): Promise<void> {
  const root = await pinRestoreRootsAndTrash(stage, receipt.original);
  const destination = receipt.observation.kind === 'projection_absent' ? Object.freeze({ kind: 'projection_absent' as const })
    : Object.freeze({ kind: 'vacant' as const, directories: await pinRestoreDestination(stage, root) });
  stage.restoreFacts = Object.freeze({ version: 1, trashReceipt: receipt, destination });
  if (receipt.observation.kind === 'moved') await openRestorePayload(stage, false);
  stage.recovery = 'restore_pending'; await verifyRestore(stage, false);
}

async function recoverRestore(stage: Stage, original: PreparedSingleFileRestoreOriginalFacts): Promise<void> {
  const root = await pinRestoreRootsAndTrash(stage, original.trashReceipt.original);
  stage.restoreFacts = original;
  if (original.destination.kind === 'projection_absent') {
    stage.recovery = 'projection_absent'; await verifyRestore(stage, false); return;
  }
  await pinRestoreDestination(stage, root, original.destination.directories);
  const observed = original.trashReceipt.observation;
  if (observed.kind !== 'moved') throw failure('recovery-conflict');
  const source = await exactStat(stage.sourcePath), trash = await exactStat(stage.destinationPath);
  const restored = !!source && source.dev === observed.identity.device && source.ino === observed.identity.inode;
  if (source ? !restored || !!trash : !trash) throw failure('recovery-conflict');
  await openRestorePayload(stage, restored);
  stage.recovery = restored ? 'already_restored' : 'restore_pending'; await verifyRestore(stage, restored);
}

/** Caller must persist these NEW destination-parent facts in its immutable Undo
 * intent before restore. This capability carries no authorization or SQL proof. */
export function readPreparedWorkspaceSingleFileRestore(prepared: PreparedWorkspaceSingleFileRestore): PreparedSingleFileRestoreOriginalFacts {
  return requireStage(prepared, 'restore').restoreFacts!;
}

/** Exactly one reverse rename under the caller's genuine exclusive lifecycle
 * fence. Portable Node rename has no NOREPLACE: freshness plus that cooperative
 * writer fence is required; this is not a fence against uncooperative host I/O. */
export function restorePreparedWorkspaceSingleFileTrash(prepared: PreparedWorkspaceSingleFileRestore): Promise<PreparedSingleFileRestoreReceipt> {
  let stage: Stage;
  try {
    stage = requireStage(prepared, 'restore');
    if (stage.moveStarted) throw poison(stage, failure(stage.pending ? 'reentrant-operation' : 'already-moved', stage.renameAttempted));
    stage.moveStarted = true;
  } catch (error) { return Promise.reject(error); }
  const operation = (async (): Promise<PreparedSingleFileRestoreReceipt> => {
    try {
      const original = stage.restoreFacts!, observed = original.trashReceipt.observation;
      const restored = stage.recovery === 'already_restored';
      await verifyRestore(stage, restored); assertInternal(stage);
      if (observed.kind === 'projection_absent') {
        stage.moveCompleted = true;
        return Object.freeze({ version: 1, original, observation: Object.freeze({ kind: 'projection_absent' }) });
      }
      if (!restored) {
        try { stage.renameAttempted = true; await fs.rename(stage.destinationPath, stage.sourcePath); }
        catch (error) {
          const crossDevice = !!error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV';
          throw failure(crossDevice ? 'cross-device-move' : 'move-unconfirmed', true, error);
        }
      }
      await verifyRestore(stage, true); assertInternal(stage);
      const after = await observedMovedIdentity(stage, observed.identity); stage.moveCompleted = true;
      return Object.freeze({ version: 1, original, observation: Object.freeze({ kind: 'restored', method: 'rename', identity: after, sha256: observed.sha256 }) });
    } catch (error) {
      const observed = stage.renameAttempted && (!(error instanceof PreparedSingleFileTrashError) || !error.moveAttempted)
        ? failure(error instanceof PreparedSingleFileTrashError ? error.code : 'move-unconfirmed', true, error) : error;
      throw poison(stage, observed);
    }
  })();
  return trackPending(stage, operation);
}

/** Rejection-only post-restore check; never writes or adopts a current D2. */
export function assertPreparedWorkspaceSingleFileRestoreCurrent(prepared: PreparedWorkspaceSingleFileRestore): Promise<void> {
  let stage: Stage;
  try {
    stage = requireStage(prepared, 'restore');
    if (stage.pending) throw poison(stage, failure('reentrant-operation', stage.renameAttempted));
    if (!stage.moveCompleted) throw poison(stage, failure('invalid-lifetime', stage.renameAttempted));
  } catch (error) { return Promise.reject(error); }
  const operation = (async () => {
    try { await verifyRestore(stage, true); assertInternal(stage); }
    catch (error) { throw poison(stage, error); }
  })();
  return trackPending(stage, operation);
}

export async function withPreparedWorkspaceSingleFileRestore<T>(input: PreparedWorkspaceSingleFileRestoreInput,
  operation: (prepared: PreparedWorkspaceSingleFileRestore) => Promise<T>): Promise<T> {
  try {
    const { captured, receipt } = captureRestoreInput(input);
    return await runCaptured<T, PreparedWorkspaceSingleFileRestore>(captured, stage => prepareRestore(stage, receipt), operation, 'restore');
  } catch (error) { throw poison(currentStage.getStore(), error); }
}

/** Resume only the exact pre-rename Undo facts from the caller's durable intent.
 * Original payload at the restored target with empty trash is a verified no-op;
 * replacement D2, missing/both payload locations or changed parent pins reject. */
export async function withRecoveredWorkspaceSingleFileRestore<T>(input: RecoveredWorkspaceSingleFileRestoreInput,
  operation: (prepared: PreparedWorkspaceSingleFileRestore) => Promise<T>): Promise<T> {
  try {
    const { captured, original } = captureRestoreRecovery(input);
    return await runCaptured<T, PreparedWorkspaceSingleFileRestore>(captured, stage => recoverRestore(stage, original), operation, 'restore');
  } catch (error) { throw poison(currentStage.getStore(), error); }
}
