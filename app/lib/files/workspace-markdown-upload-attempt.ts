import 'server-only';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { resolveCanvasDataRoot } from '../runtime-data-paths';
import { withWorkspaceMutationLock } from '../secrets/file-mutation-lock';

/** Request intent only. These identifiers are neither authentication nor grants. */
export type MarkdownUploadAttemptSelection = Readonly<{
  uploadSessionId: string; fileId: string; workspaceId: string; targetPath: string;
  actorUserId: string; actorSessionId: string; requestId: string; operationId: string;
}>;
export type MarkdownUploadAttemptObservation = Readonly<{
  state: 'staged' | 'retained' | 'abandoned';
  uploadStatus: 'available' | 'missing' | 'expired' | 'completed' | 'changed';
  sourceHash: string; sourceBytes: number;
}>;
/** Private callback lifetime. A future writer must separately own genuine
 * current Auth/native/target authority. No filesystem descriptor escapes. */
export type MarkdownUploadAttemptAccess = Readonly<{
  inspect(): Promise<MarkdownUploadAttemptObservation>;
  readSource(): Promise<Uint8Array>;
  retainForRecovery(): Promise<void>;
  abandon(): Promise<void>;
}>;
export class MarkdownUploadAttemptError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MarkdownUploadAttemptError'; }
}
const fail = (code: string): never => { throw new MarkdownUploadAttemptError(code); };
const keys = ['uploadSessionId', 'fileId', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'requestId', 'operationId'] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
function capture(input: MarkdownUploadAttemptSelection): MarkdownUploadAttemptSelection {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length
    || keys.some(key => {
      const field = Object.getOwnPropertyDescriptor(input, key);
      return !field?.enumerable || !Object.hasOwn(field, 'value') || typeof field.value !== 'string';
    }) || !uuid.test(input.uploadSessionId) || !uuid.test(input.fileId)
    || keys.filter(key => !['targetPath', 'uploadSessionId', 'fileId'].includes(key)).some(key => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input[key]))
    || input.targetPath.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(input.targetPath)
    || input.targetPath.split('/').some(segment => !segment || segment === '.' || segment === '..')
    || !/\.(?:md|markdown)$/iu.test(input.targetPath)) return fail('MARKDOWN_UPLOAD_ATTEMPT_INVALID_INPUT');
  return Object.freeze(Object.fromEntries(keys.map(key => [key, input[key]])) as MarkdownUploadAttemptSelection);
}
type Frame = { handle: FileHandle; configuredRoot: string; resolvedRoot: string; identity: { dev: string; ino: string; uid: number; mode: number };
  selection: MarkdownUploadAttemptSelection; key: string; active: boolean };
type Action = 'initialize' | 'stage' | 'inspect' | 'read' | 'retain' | 'abandon';
type Result = { observation: MarkdownUploadAttemptObservation; bytes?: string };
async function assertNamedRoot(frame: Frame): Promise<void> {
  try {
    const current = await fs.lstat(frame.configuredRoot);
    if (resolveCanvasDataRoot() !== frame.configuredRoot || current.isSymbolicLink() || !current.isDirectory()
      || await fs.realpath(frame.configuredRoot) !== frame.resolvedRoot
      || String(current.dev) !== frame.identity.dev || String(current.ino) !== frame.identity.ino
      || current.uid !== frame.identity.uid || (current.mode & 0o7777) !== frame.identity.mode) fail('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED');
  } catch { fail('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED'); }
}
async function assertRoot(frame: Frame): Promise<void> {
  await assertNamedRoot(frame);
  const opened = await frame.handle.stat();
  if (!frame.active || !opened.isDirectory() || String(opened.dev) !== frame.identity.dev || String(opened.ino) !== frame.identity.ino
    || opened.uid !== frame.identity.uid || (opened.mode & 0o7777) !== frame.identity.mode) fail('MARKDOWN_UPLOAD_ATTEMPT_NAMESPACE_CHANGED');
}
async function invoke(frame: Frame, action: Action): Promise<Result> {
  await assertRoot(frame);
  const helper = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/runtime/markdown-upload-attempt.py');
  const result = await new Promise<Result>((resolve, reject) => {
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'pipe', frame.handle.fd] });
    let buffer = '', final: Result | undefined, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'); child.kill('SIGKILL'); }, 30_000);
    child.stdin!.on('error', () => undefined);
    child.stderr!.on('data', () => undefined); // Private helper failures have finite codes, never raw paths/metadata logs.
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 8 * 1024 * 1024) { failure = new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'); child.kill('SIGKILL'); return; }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.stage) child.stdin!.write('continue\n');
          else if (typeof value.error === 'string') failure = new MarkdownUploadAttemptError(value.error);
          else if (value.result) final = value.result as Result;
          else throw new Error('Invalid private helper response.');
        } catch { failure = new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'); child.kill('SIGKILL'); }
      }
    });
    child.once('error', error => { failure = new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'); void error; });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !final) reject(failure ?? new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED'));
      else resolve(final);
    });
    child.stdin!.write(JSON.stringify({ action, selection: frame.selection, key: frame.key,
      root: { path: frame.resolvedRoot, dev: frame.identity.dev, ino: frame.identity.ino } }) + '\n');
  });
  await assertRoot(frame);
  return result;
}

/** Inactive internal snapshot/journal only. Old upload cleanup may delete the
 * original session; historical bytes alone must NEVER reanimate it. The helper
 * refuses consumption on missing/expired/completed/changed uploads. Retain is a
 * conservative recovery marker, not a native-commit receipt. Abandon is an
 * immutable tombstone and does not unlink snapshots, journals or lockfiles. */
export async function withWorkspaceMarkdownUploadAttempt<T>(input: MarkdownUploadAttemptSelection,
  operation: (access: MarkdownUploadAttemptAccess) => Promise<T>): Promise<T> {
  const selection = capture(input), configuredRoot = resolveCanvasDataRoot();
  if (typeof operation !== 'function') return fail('MARKDOWN_UPLOAD_ATTEMPT_INVALID_INPUT');
  const resolvedRoot = await fs.realpath(configuredRoot);
  const handle = await fs.open(resolvedRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let frame: Frame | undefined, closed = false;
  try {
    const stat = await handle.stat();
    const current: Frame = { selection, configuredRoot, resolvedRoot, handle, active: true,
      identity: { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o7777 }, key: createHash('sha256').update(JSON.stringify([selection.uploadSessionId, selection.fileId])).digest('hex') };
    frame = current;
    await withWorkspaceMutationLock('markdown-upload-attempt-root-v1', () => invoke(current, 'initialize'));
    return await withWorkspaceMutationLock(`markdown-upload-attempt-file-v1:${current.key}`, async () => {
      let active = true;
      let queue = Promise.resolve();
      const pending = new Set<Promise<unknown>>();
      const run = <V>(action: Action, map: (value: Result) => V): Promise<V> => {
        const result = queue.then(async () => {
          if (!active) return fail('MARKDOWN_UPLOAD_ATTEMPT_CLOSED');
          const value = await invoke(current, action);
          if (!active) return fail('MARKDOWN_UPLOAD_ATTEMPT_CLOSED');
          return map(value);
        });
        queue = result.then(() => undefined, () => undefined);
        pending.add(result);
        // Observe the exact facade promise, including its close/conversion
        // error. An unawaited rejection must never crash the Node process.
        result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      };
      const access: MarkdownUploadAttemptAccess = Object.freeze({
        inspect: () => run('inspect', result => Object.freeze(result.observation)),
        readSource: () => run('read', result => {
          if (typeof result.bytes !== 'string') return fail('MARKDOWN_UPLOAD_ATTEMPT_IO_UNCONFIRMED');
          return Uint8Array.from(Buffer.from(result.bytes, 'base64'));
        }),
        retainForRecovery: () => run('retain', () => undefined),
        abandon: () => run('abandon', () => undefined),
      });
      const errors: unknown[] = []; let value: T | undefined;
      try { await invoke(current, 'stage'); value = await operation(access); }
      catch (error) { errors.push(error); }
      active = false;
      const unawaited = pending.size > 0;
      await Promise.allSettled([...pending]);
      if (unawaited) errors.push(new MarkdownUploadAttemptError('MARKDOWN_UPLOAD_ATTEMPT_UNAWAITED_IO'));
      try { await assertRoot(current); } catch (error) { errors.push(error); }
      current.active = false; closed = true;
      try { await handle.close(); } catch (error) { errors.push(error); }
      // Descriptor close is an awaited IO boundary. Verify the original named
      // namespace afterward under the same fence, without statting a closed fd.
      try { await assertNamedRoot(current); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'MARKDOWN_UPLOAD_ATTEMPT_CLOSURE_FAILED');
      return value as T;
    });
  } finally { if (frame) frame.active = false; if (!closed) await handle.close(); }
}
