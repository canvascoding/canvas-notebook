import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { resolveCanvasDataRoot } from '../runtime-data-paths';
import { withWorkspaceMarkdownUploadAttempt, type MarkdownUploadAttemptSelection } from './workspace-markdown-upload-attempt';

/** Filesystem eligibility/intent only. Never a principal or native grant. */
type SessionBinding = Readonly<{ sessionId: string; userId?: string; workspaceId?: string }>;
type Mode = 'shared' | 'exclusive';
type Identity = { dev: string; ino: string; uid: number; mode: number };
type Observation = { birthFingerprint: string; expiresAtMs: number; sourceHash?: string; sourceBytes?: number;
  targetPath?: string; sourceProfile?: Record<string, unknown> };
export class WorkspaceUploadLiveError extends Error {
  readonly status: number;
  constructor(readonly code: string) {
    super(code); this.name = 'WorkspaceUploadLiveError';
    this.status = code === 'UPLOAD_NOT_FOUND' || code === 'UPLOAD_FILE_NOT_FOUND' ? 404 : code === 'UPLOAD_FORBIDDEN' ? 403
      : code === 'UPLOAD_EXPIRED' ? 410 : code === 'UPLOAD_LOCK_TIMEOUT' ? 503 : 409;
  }
}
const fail = (code: string): never => { throw new WorkspaceUploadLiveError(code); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const context = new AsyncLocalStorage<Frame>();
const scopes = new WeakMap<WorkspaceUploadLiveSession, Frame>();
type Frame = { binding: SessionBinding; mode: Mode; configuredRoot: string; resolvedRoot: string; root: FileHandle;
  identity: Identity; control?: Identity; session?: FileHandle; file?: FileHandle; fileId?: string;
  sessionProof?: Identity; fileProof?: Identity; fileName?: string;
  active: boolean; fileActive: boolean; birth?: string; accepting: boolean; queue: Promise<void>; pending: Set<Promise<unknown>> };
export type WorkspaceUploadLiveSession = Readonly<{
  assertCurrent(fileId?: string): Promise<void>;
  cancel(): Promise<void>;
  expire(nowMs: number): Promise<void>;
}>;

function capture(input: SessionBinding): SessionBinding {
  if (!input || !uuid.test(input.sessionId) || input.userId !== undefined && (typeof input.userId !== 'string' || !input.userId)
    || input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !input.workspaceId)
    || (input.userId === undefined) !== (input.workspaceId === undefined)) return fail('UPLOAD_NOT_FOUND');
  return Object.freeze({ sessionId: input.sessionId, ...(input.userId === undefined ? {} : { userId: input.userId, workspaceId: input.workspaceId }) });
}
function identity(stat: Stats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o7777 };
}
function same(left: Identity, right: Identity): boolean { return Object.keys(left).every(key => Reflect.get(left, key) === Reflect.get(right, key)); }
async function assertNamedRoot(frame: Frame): Promise<void> {
  const stat = await fs.lstat(frame.configuredRoot);
  if (resolveCanvasDataRoot() !== frame.configuredRoot || !stat.isDirectory() || stat.isSymbolicLink()
    || await fs.realpath(frame.configuredRoot) !== frame.resolvedRoot || !same(frame.identity, identity(stat))) fail('UPLOAD_STATE_UNCONFIRMED');
  if (frame.control) {
    const control = await fs.lstat(path.join(frame.resolvedRoot, 'canvas-upload-live'));
    if (!control.isDirectory() || control.isSymbolicLink() || !same(frame.control, identity(control))) fail('UPLOAD_STATE_UNCONFIRMED');
  }
  for (const [handle, proof, name] of [[frame.session, frame.sessionProof, `session-${frame.binding.sessionId}.lock`],
    [frame.file, frame.fileProof, frame.fileName]] as const) {
    if (!proof || !name) continue;
    const current = await fs.lstat(path.join(frame.resolvedRoot, 'canvas-upload-live', name));
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !same(proof, identity(current))) fail('UPLOAD_STATE_UNCONFIRMED');
    if (handle) {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !same(proof, identity(opened))) fail('UPLOAD_STATE_UNCONFIRMED');
    }
  }
}
async function assertRoot(frame: Frame): Promise<void> {
  if (!frame.active) fail('UPLOAD_SOURCE_CLOSED');
  await assertNamedRoot(frame);
  if (!same(frame.identity, identity(await frame.root.stat()))) fail('UPLOAD_STATE_UNCONFIRMED');
}
async function invoke<R>(frame: Frame, action: string, extra: Record<string, unknown> = {}, lock?: FileHandle): Promise<R> {
  await assertRoot(frame);
  const helper = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/runtime/workspace-upload-live.py');
  const result = await new Promise<R>((resolve, reject) => {
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', helper],
      { stdio: ['pipe', 'pipe', 'pipe', frame.root.fd, ...(lock ? [lock.fd] : [])] });
    let buffer = '', value: R | undefined, failure: Error | undefined;
    const acquiring = action.startsWith('acquire_') || action === 'initialize';
    const timer = setTimeout(() => { failure = new WorkspaceUploadLiveError(acquiring ? 'UPLOAD_LOCK_TIMEOUT' : 'UPLOAD_STATE_UNCONFIRMED'); child.kill('SIGKILL'); }, 30_000);
    child.stdin!.on('error', () => undefined); child.stderr!.on('data', () => undefined);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', bytes => {
      buffer += String(bytes);
      if (buffer.length > 2 * 1024 * 1024) { failure = new WorkspaceUploadLiveError('UPLOAD_STATE_UNCONFIRMED'); child.kill('SIGKILL'); return; }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const item = JSON.parse(line);
          if (item.stage) child.stdin!.write('continue\n');
          else if (typeof item.error === 'string') failure = new WorkspaceUploadLiveError(item.error);
          else if (item.result) value = item.result as R;
          else throw new Error('Invalid private upload response.');
        } catch { failure = new WorkspaceUploadLiveError('UPLOAD_STATE_UNCONFIRMED'); child.kill('SIGKILL'); }
      }
    });
    child.once('error', () => { failure = new WorkspaceUploadLiveError('UPLOAD_STATE_UNCONFIRMED'); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || value === undefined) reject(failure ?? new WorkspaceUploadLiveError('UPLOAD_STATE_UNCONFIRMED'));
      else resolve(value);
    });
    child.stdin!.write(JSON.stringify({ action, ...frame.binding, root: { path: frame.resolvedRoot, dev: frame.identity.dev, ino: frame.identity.ino }, ...extra }) + '\n');
  });
  await assertRoot(frame);
  return result;
}
async function openLock(frame: Frame, name: string): Promise<FileHandle> {
  await assertRoot(frame);
  const filename = path.join(frame.resolvedRoot, 'canvas-upload-live', name);
  const handle = await fs.open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat(), named = await fs.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0
      || !named.isFile() || !same(identity(stat), identity(named))) fail('UPLOAD_STATE_UNCONFIRMED');
    await assertRoot(frame); return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function current(frame: Frame, fileId?: string, source = false): Promise<Observation> {
  const observed = await invoke<Observation>(frame, source ? 'source' : 'inspect', fileId ? { fileId } : {});
  if (typeof observed.birthFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(observed.birthFingerprint)
    || !Number.isSafeInteger(observed.expiresAtMs) || observed.expiresAtMs <= Date.now()
    || frame.birth !== undefined && frame.birth !== observed.birthFingerprint) fail('UPLOAD_STATE_UNCONFIRMED');
  frame.birth ??= observed.birthFingerprint;
  return observed;
}
function run<V>(frame: Frame, operation: () => Promise<V>): Promise<V> {
  const promise = frame.queue.then(async () => {
    if (!frame.accepting) return fail('UPLOAD_SOURCE_CLOSED');
    const value = await operation();
    if (!frame.accepting) return fail('UPLOAD_SOURCE_CLOSED');
    return value;
  });
  frame.queue = promise.then(() => undefined, () => undefined); frame.pending.add(promise);
  promise.then(() => frame.pending.delete(promise), () => frame.pending.delete(promise));
  return promise;
}

/** Shared sessions admit parallel different-file callbacks. EX directly drains
 * every shared process; no lock upgrade and no process-local map as authority.
 * The consumer MUST return its complete operation promise. A later native entry
 * must return the whole execute/COMMIT/B-close/C-close promise, never detach it. */
export async function withWorkspaceUploadLiveSession<T>(input: SessionBinding, mode: Mode,
  operation: (lease: WorkspaceUploadLiveSession) => Promise<T>): Promise<T> {
  const binding = capture(input), inherited = context.getStore();
  if (inherited?.active && inherited.binding.sessionId === binding.sessionId) return fail('UPLOAD_LOCK_ORDER');
  const configuredRoot = resolveCanvasDataRoot(), resolvedRoot = await fs.realpath(configuredRoot);
  const rootIdentity = identity(await fs.lstat(resolvedRoot));
  const root = await fs.open(resolvedRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const frame: Frame = { binding, mode, configuredRoot, resolvedRoot, root, identity: rootIdentity, active: true, fileActive: false,
    accepting: true, queue: Promise.resolve(), pending: new Set() };
  const failures: unknown[] = []; let value: T | undefined;
  try {
    const initialized = await invoke<{ control: Identity }>(frame, 'initialize'); frame.control = initialized.control;
    frame.session = await openLock(frame, `session-${binding.sessionId}.lock`);
    frame.sessionProof = identity(await frame.session.stat());
    await invoke(frame, 'acquire_session', { mode }, frame.session);
    const lease: WorkspaceUploadLiveSession = Object.freeze({
      assertCurrent: fileId => run(frame, async () => { await current(frame, fileId); }),
      cancel: () => run(frame, async () => { if (mode !== 'exclusive') fail('UPLOAD_LOCK_ORDER'); await invoke(frame, 'cancel'); }),
      expire: nowMs => run(frame, async () => { if (mode !== 'exclusive' || !Number.isSafeInteger(nowMs) || nowMs < 0) fail('UPLOAD_LOCK_ORDER'); await invoke(frame, 'expire', { nowMs }); }),
    });
    scopes.set(lease, frame);
    try {
      if (mode === 'shared') await current(frame);
      value = await context.run(frame, () => operation(lease));
      if (mode === 'shared') await current(frame);
    } finally { scopes.delete(lease); }
  } catch (error) { failures.push(error); }
  frame.accepting = false;
  const unawaited = frame.pending.size > 0;
  await Promise.allSettled([...frame.pending]);
  if (unawaited) failures.push(new WorkspaceUploadLiveError('UPLOAD_UNAWAITED_IO'));
  // Never close parent kernel fds from a callback deadline/abort handler.
  // A killed Source helper leaves the parent's flock held through this exit.
  try { await assertRoot(frame); } catch (error) { failures.push(error); }
  frame.active = false;
  // Close DATA and check its original named identity while BOTH actual kernel
  // fds still hold the fences. Then close FileEX under SessionSH and close the
  // session last; every close failure survives alongside the primary failure.
  const close = async (handle: FileHandle): Promise<boolean> => {
    try { await handle.close(); return true; } catch (error) { failures.push(error); }
    // One bounded cleanup attempt on this exact handle, never reopen/raw-fd
    // close or report the operation successful after its first close error.
    try { await handle.close(); return true; } catch (error) { failures.push(error); return false; }
  };
  await close(root);
  try { await assertNamedRoot(frame); } catch (error) { failures.push(error); }
  for (const key of ['file', 'session'] as const) {
    const handle = frame[key];
    if (handle && await close(handle)) frame[key] = undefined;
    try { await assertNamedRoot(frame); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'UPLOAD_LIVE_CLOSURE_FAILED');
  return value as T;
}

/** Call INSIDE the old FileQueue, itself INSIDE SessionSH. Only our actual
 * private active session can mint a file scope; public ALS shapes do not. */
export function withWorkspaceUploadLiveFile<T>(lease: WorkspaceUploadLiveSession, fileId: string,
  operation: () => Promise<T>): Promise<T> {
  const frame = scopes.get(lease);
  const refusal = !frame?.active || !frame.accepting || frame.mode !== 'shared' || frame.fileActive || frame.file
    ? 'UPLOAD_LOCK_ORDER' : !uuid.test(fileId) ? 'UPLOAD_FILE_NOT_FOUND' : undefined;
  if (refusal) {
    const promise = Promise.reject<T>(new WorkspaceUploadLiveError(refusal));
    promise.catch(() => undefined); return promise;
  }
  // Reserve synchronously, before open/acquire can yield. Return this very
  // promise (no async wrapper) so the parent observes both actual settlements.
  const owner = frame!; owner.fileActive = true;
  const promise = (async () => {
    const failures: unknown[] = []; let value: T | undefined;
    try {
      const handle = await openLock(owner, `file-${hash(JSON.stringify([owner.binding.sessionId, fileId]))}.lock`);
      owner.file = handle; owner.fileId = fileId;
      owner.fileProof = identity(await handle.stat()); owner.fileName = `file-${hash(JSON.stringify([owner.binding.sessionId, fileId]))}.lock`;
      await invoke(owner, 'acquire_file', { fileId, mode: 'exclusive' }, handle);
      await current(owner, fileId);
      if (!owner.accepting) fail('UPLOAD_SOURCE_CLOSED');
      value = await operation(); await current(owner, fileId);
    } catch (error) { failures.push(error); }
    owner.fileActive = false; owner.fileId = undefined;
    try { await assertRoot(owner); } catch (error) { failures.push(error); }
    // Retain the actual file descriptor through outer DATA/session closure.
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'UPLOAD_LIVE_CLOSURE_FAILED');
    return value as T;
  })();
  owner.pending.add(promise);
  promise.then(() => owner.pending.delete(promise), () => owner.pending.delete(promise));
  return promise;
}

export type CurrentWorkspaceUploadFileSource = Readonly<{
  binding: Readonly<MarkdownUploadAttemptSelection & { sourceHash: string; sourceBytes: number; attemptFingerprint: string }>;
  assertCurrent(): Promise<void>;
  readSource(): Promise<Uint8Array>;
}>;
/** Inactive source seam for the later genuine native writer. No arbitrary
 * bytes/Workspace/validateAuthority input, native commit or completion output. */
export async function withCurrentWorkspaceUploadFile<T>(input: MarkdownUploadAttemptSelection,
  operation: (source: CurrentWorkspaceUploadFileSource) => Promise<T>): Promise<T> {
  const selection = Object.freeze({ ...input });
  return withWorkspaceUploadLiveSession({ sessionId: selection.uploadSessionId, userId: selection.actorUserId, workspaceId: selection.workspaceId }, 'shared', lease =>
    withWorkspaceUploadLiveFile(lease, selection.fileId, () => withWorkspaceMarkdownUploadAttempt(selection, async snapshot => {
      const frame = scopes.get(lease)!;
      const observed = await current(frame, selection.fileId, true);
      if (observed.targetPath !== selection.targetPath || typeof observed.sourceHash !== 'string'
        || !Number.isSafeInteger(observed.sourceBytes)) fail('UPLOAD_STATE_UNCONFIRMED');
      const binding = Object.freeze({ ...selection, sourceHash: observed.sourceHash!, sourceBytes: observed.sourceBytes!,
        attemptFingerprint: hash(JSON.stringify([selection, observed.birthFingerprint, observed.sourceHash, observed.sourceBytes, observed.sourceProfile])) });
      let active = true, queue = Promise.resolve(); const pending = new Set<Promise<unknown>>();
      const assert = async () => {
        if (!active || !frame.fileActive) fail('UPLOAD_SOURCE_CLOSED');
        const value = await current(frame, selection.fileId, true), saved = await snapshot.inspect();
        if (value.targetPath !== binding.targetPath || value.sourceHash !== binding.sourceHash || value.sourceBytes !== binding.sourceBytes
          || JSON.stringify(value.sourceProfile) !== JSON.stringify(observed.sourceProfile) || saved.uploadStatus !== 'available'
          || saved.state === 'abandoned' || saved.sourceHash !== binding.sourceHash || saved.sourceBytes !== binding.sourceBytes) fail('UPLOAD_STATE_UNCONFIRMED');
      };
      const run = <V>(action: () => Promise<V>): Promise<V> => {
        const promise = queue.then(async () => { await assert(); const value = await action(); await assert(); return value; });
        queue = promise.then(() => undefined, () => undefined); pending.add(promise);
        promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
      };
      const source: CurrentWorkspaceUploadFileSource = Object.freeze({ binding,
        assertCurrent: () => run(async () => undefined), readSource: () => run(() => snapshot.readSource()) });
      const failures: unknown[] = []; let value: T | undefined;
      try { await assert(); value = await operation(source); await assert(); } catch (error) { failures.push(error); }
      active = false; const unawaited = pending.size > 0; await Promise.allSettled([...pending]);
      if (unawaited) failures.push(new WorkspaceUploadLiveError('UPLOAD_UNAWAITED_IO'));
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'UPLOAD_LIVE_CLOSURE_FAILED');
      return value as T;
    })));
}
