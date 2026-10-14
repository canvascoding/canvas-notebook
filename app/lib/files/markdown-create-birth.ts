import 'server-only';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import syncFs, { constants, promises as fs, type Stats, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { resolveCanvasDataRoot } from '../runtime-data-paths';
import { getFdPublicationBackend, type FdPublicationBackend } from './fd-publication';
import { isDeepStrictEqual } from 'node:util';

type Identity = Readonly<{ dev: string; ino: string; uid: number; mode: number }>;
type Observation = Readonly<{ state: 'intent' | 'prepared' | 'born' | 'complete'; fingerprint: string;
  serializedHash: string | null; revisionId: string | null; intent: Record<string, unknown> }>;
/** Private storage proof only. The genuine request/Owner/native coordinator
 * must separately authorize every publication and finalization. */
export type MarkdownCreateBirthClaim = Readonly<{
  id: string; fingerprint: string; assertRoot(): Promise<void>; verify(): Promise<Observation>;
  publish(serialized: string, beforeBoundary: (stage?: string) => Promise<void>, assertWithinTurn: () => void): Promise<Observation>;
  complete(serializedHash: string, revisionId: string, beforeBoundary: (stage?: string) => Promise<void>): Promise<void>;
}>;
export class MarkdownCreateBirthError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MarkdownCreateBirthError'; }
}

/** Historical private storage evidence only. This entry cannot initialize a
 * store/claim, consume an upload source or mutate either namespace. */
export async function observeMarkdownCreateBirth(input: { workspaceRoot: string; workspaceId: string; operationId: string }): Promise<{
  id: string; fingerprint: string; intent: Record<string, unknown>; complete: boolean; revisionId: string | null; serializedHash: string | null;
}> {
  const configuredData = resolveCanvasDataRoot(), configuredWorkspace = input.workspaceRoot;
  const backend = getFdPublicationBackend(), opened: number[] = [], errors: unknown[] = [];
  let data: FileHandle | undefined, workspace: FileHandle | undefined, frame: Frame | undefined;
  let value: Awaited<ReturnType<typeof observeMarkdownCreateBirth>> | undefined;
  const own = (fd: number) => { opened.push(fd); return fd; };
  const readFile = (parent: number, name: string, limit: number, mode: number): { bytes: Buffer; info: BigIntStats } => {
    const fd = own(backend.openFileAt(parent, name, 'readonly')), before = syncFs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || before.uid !== BigInt(process.geteuid!())
      || (before.mode & BigInt(0o7777)) !== BigInt(mode) || before.size > BigInt(limit)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const chunks: Buffer[] = []; let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length)), count = syncFs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break; length += count; if (length > limit) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks), after = syncFs.fstatSync(fd, { bigint: true });
    const named = own(backend.openFileAt(parent, name, 'readonly'));
    if (!backend.hasExactNameAt(parent, name) || !stableFile(before, after)
      || !stableFile(after, syncFs.fstatSync(named, { bigint: true }))) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return { bytes, info: after };
  };
  const read = (parent: number, name: string): Record<string, unknown> => {
    const { bytes } = readFile(parent, name, 128 * 1024, 0o600);
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype || !canonical(parsed).equals(bytes)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return parsed;
  };
  const optional = (parent: number, name: string): Record<string, unknown> | null => {
    try { return read(parent, name); } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null;
      throw error;
    }
  };
  try {
    data = await fs.open(configuredData, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    workspace = await fs.open(configuredWorkspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    frame = { active: true, configuredData, resolvedData: await fs.realpath(configuredData), configuredWorkspace,
      resolvedWorkspace: await fs.realpath(configuredWorkspace), data, workspace, backend,
      dataIdentity: identity(await data.stat()), workspaceIdentity: identity(await workspace.stat()), intent: {},
      key: sha(JSON.stringify(['canvas-markdown-first-birth-v1', input.workspaceId, input.operationId])) };
    await root(frame);
    const pin = readStorePointer(frame); frame.storePin = pin;
    const store = own(backend.openDirectoryAt(data.fd, pin.name)), claim = own(backend.openDirectoryAt(store, frame.key));
    if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(store, { bigint: true })), pin.directory)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    for (const [parent, name, fd] of [[data.fd, pin.name, store], [store, frame.key, claim]] as const) {
      const info = syncFs.fstatSync(fd, { bigint: true }); syncDirectory(info);
      if ((info.mode & BigInt(0o077)) !== BigInt(0) || !backend.hasExactNameAt(parent, name)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    }
    const intent = read(claim, 'intent.json');
    if (!isDeepStrictEqual(intent.dataRoot, frame.dataIdentity) || !isDeepStrictEqual(intent.workspaceRoot, frame.workspaceIdentity)
      || intent.operationId !== input.operationId || typeof intent.targetPath !== 'string') return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const fingerprint = sha(canonical(intent).toString('utf8')); frame.fingerprint = fingerprint;
    const prepared = optional(claim, 'prepared.json'), born = optional(claim, 'born.json');
    const completed = optional(claim, 'completed.json'), settled = optional(claim, 'settled.json');
    if (completed && (!prepared || !born || !settled || !isDeepStrictEqual(prepared, born)
      || Object.keys(completed).sort().join(',') !== 'file,revisionId,serializedHash,version'
      || !isDeepStrictEqual(completed, { ...prepared, revisionId: completed.revisionId })
      || !isDeepStrictEqual(settled.file, prepared.file) || typeof settled.ctimeNs !== 'string'
      || typeof completed.revisionId !== 'string' || typeof completed.serializedHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(completed.serializedHash))) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    if (completed) {
      // A retained receipt cannot confirm a deleted/replaced physical birth.
      // A later legitimate peer projection is conservatively recovery_required;
      // this historical observer cannot adopt a new inode from byte equality.
      const segments = (intent.targetPath as string).split('/');
      if (segments.some(name => !name || name === '.' || name === '..' || /[\\\u0000-\u001f\u007f]/u.test(name))) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      const initial = intent.ancestors as Record<string, unknown>;
      if (!initial || typeof initial !== 'object') return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      const ancestors: Array<{ parent: number; name: string; expected: unknown }> = [];
      let parent = workspace.fd, relative = '';
      for (const name of segments.slice(0, -1)) {
        relative = relative ? relative + '/' + name : name;
        const recorded = optional(claim, 'parent-' + sha(relative) + '.json');
        if (recorded && (recorded.path !== relative || Object.keys(recorded).sort().join(',') !== 'identity,path')) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
        const expected = initial[relative] || recorded?.identity;
        const child = own(backend.openDirectoryAt(parent, name));
        if (!expected || !backend.hasExactNameAt(parent, name)
          || !isDeepStrictEqual(syncDirectory(syncFs.fstatSync(child, { bigint: true })), expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
        ancestors.push({ parent, name, expected }); parent = child;
      }
      const target = readFile(parent, segments.at(-1)!, 5 * 1024 * 1024, 0o644);
      if (!fileMatches(target.info, prepared!.file) || !fileMatches(target.info, settled!.file)
        || target.info.ctimeNs.toString() !== settled!.ctimeNs
        || createHash('sha256').update(target.bytes).digest('hex') !== completed.serializedHash) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      for (const ancestor of ancestors) {
        const child = own(backend.openDirectoryAt(ancestor.parent, ancestor.name));
        if (!backend.hasExactNameAt(ancestor.parent, ancestor.name)
          || !isDeepStrictEqual(syncDirectory(syncFs.fstatSync(child, { bigint: true })), ancestor.expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      }
    }
    readStorePointer(frame); await root(frame);
    value = { id: frame.key, fingerprint, intent, complete: completed !== null,
      revisionId: completed?.revisionId as string ?? null, serializedHash: completed?.serializedHash as string ?? null };
  } catch (error) { errors.push(error); }
  for (const fd of opened.reverse()) { try { syncFs.closeSync(fd); } catch (error) { errors.push(error); } }
  for (const handle of [workspace, data]) if (handle) { try { await handle.close(); } catch (error) { errors.push(error); } }
  if (frame) { try { await named(frame); } catch (error) { errors.push(error); } frame.active = false; }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'MARKDOWN_CREATE_BIRTH_OBSERVATION_UNCONFIRMED');
  return value!;
}
const fail = (code: string): never => { throw new MarkdownCreateBirthError(code); };
const identity = (value: Stats): Identity => ({ dev: String(value.dev), ino: String(value.ino), uid: value.uid, mode: value.mode & 0o7777 });
const same = (a: Identity, b: Identity) => Object.keys(a).every(key => Reflect.get(a, key) === Reflect.get(b, key));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type StorePin = Readonly<{ name: string; directory: Identity; file: BigIntStats; bytes: Buffer }>;
type Frame = { active: boolean; configuredData: string; resolvedData: string; configuredWorkspace: string;
  resolvedWorkspace: string; data: FileHandle; workspace: FileHandle; dataIdentity: Identity; workspaceIdentity: Identity;
  key: string; intent: Record<string, unknown>; fingerprint?: string; backend: FdPublicationBackend; storePin?: StorePin };
async function named(frame: Frame): Promise<void> {
  const data = await fs.lstat(frame.configuredData), workspace = await fs.stat(frame.configuredWorkspace);
  if (!frame.active || resolveCanvasDataRoot() !== frame.configuredData || !data.isDirectory() || data.isSymbolicLink()
    || !workspace.isDirectory() || await fs.realpath(frame.configuredData) !== frame.resolvedData
    || await fs.realpath(frame.configuredWorkspace) !== frame.resolvedWorkspace
    || !same(identity(data), frame.dataIdentity) || !same(identity(workspace), frame.workspaceIdentity)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
}
async function root(frame: Frame): Promise<void> {
  await named(frame);
  if (!same(identity(await frame.data.stat()), frame.dataIdentity) || !same(identity(await frame.workspace.stat()), frame.workspaceIdentity)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
}
async function invoke(frame: Frame, action: 'open' | 'verify' | 'prepare' | 'observe' | 'complete',
  boundary: (stage?: string) => Promise<void>, fields: Record<string, unknown> = {}): Promise<Observation> {
  await root(frame); await boundary();
  if (frame.storePin) readStorePointer(frame);
  const helper = path.join(process.env.CANVAS_APP_ROOT?.trim() || process.cwd(), 'scripts/runtime/markdown-create-birth.py');
  const observed = await new Promise<Observation>((resolve, reject) => {
    const child = spawn(process.env.CANVAS_PYTHON_PATH?.trim() || 'python3', ['-I', helper], {
      stdio: ['pipe', 'pipe', 'pipe', frame.data.fd, frame.workspace.fd],
    });
    let buffer = '', value: Observation | undefined, hasFailure = false, failure: unknown;
    let pending = Promise.resolve();
    const rejectChild = (error: unknown) => { if (!hasFailure) { hasFailure = true; failure = error; } child.kill('SIGKILL'); };
    const timer = setTimeout(() => rejectChild(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED')), 30_000);
    child.stdin!.on('error', () => undefined);
    child.stderr!.on('data', () => undefined);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 256 * 1024) { rejectChild(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED')); return; }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        pending = pending.then(async () => {
          if (hasFailure) return;
          const result = JSON.parse(line);
          if (typeof result.stage === 'string') { await root(frame); await boundary(result.stage); child.stdin!.write('continue\n'); }
          else if (typeof result.error === 'string') rejectChild(new MarkdownCreateBirthError(result.error));
          else if (result.result) value = result.result as Observation;
          else rejectChild(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED'));
        }).catch(rejectChild);
      }
    });
    child.once('error', rejectChild);
    child.once('close', code => {
      clearTimeout(timer);
      // Drain the exact authorization/ACK work before observing child closure.
      void pending.then(() => {
        if (hasFailure) reject(failure);
        else if (code !== 0 || !value || !['intent', 'prepared', 'born', 'complete'].includes(value.state)
          || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || frame.fingerprint && value.fingerprint !== frame.fingerprint) reject(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED'));
        else resolve(value);
      }, reject);
    });
    child.stdin!.write(JSON.stringify({ action, key: frame.key, intent: frame.intent, ...fields }) + '\n');
  });
  await root(frame); await boundary();
  if (frame.storePin) readStorePointer(frame);
  return observed;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const canonical = (value: unknown): Buffer => {
  const sorted = (current: unknown): Json => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isSafeInteger(current)) return current;
    if (Array.isArray(current)) return current.map(sorted);
    if (current && Object.getPrototypeOf(current) === Object.prototype) return Object.fromEntries(Object.keys(current).sort().map(key => [key, sorted(Reflect.get(current, key))]));
    return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
  };
  return Buffer.from(JSON.stringify(sorted(value)).replace(/[^\x00-\x7e]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')));
};
const syncDirectory = (info: BigIntStats): Identity => {
  if (!info.isDirectory() || info.uid !== BigInt(process.geteuid!()) || (info.mode & BigInt(0o022)) !== BigInt(0)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
  return { dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid), mode: Number(info.mode & BigInt(0o7777)) };
};
const stableFile = (a: BigIntStats, b: BigIntStats): boolean => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => Reflect.get(a, key) === Reflect.get(b, key));
function fileMatches(info: BigIntStats, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || Object.keys(expected).sort().join(',') !== 'birthTime,dev,ino,mode,mtimeNs,size,uid'
    || !info.isFile() || info.uid !== BigInt(process.geteuid!())) return false;
  const row = expected as Record<string, unknown>;
  if (row.dev !== info.dev.toString() || row.ino !== info.ino.toString() || row.uid !== Number(info.uid)
    || row.mode !== Number(info.mode & BigInt(0o7777)) || row.size !== Number(info.size) || row.mtimeNs !== info.mtimeNs.toString()) return false;
  if (row.birthTime === 'None') return process.platform === 'linux';
  if (typeof row.birthTime !== 'string') return false;
  if (/^[0-9]{16,20}$/u.test(row.birthTime)) return row.birthTime === info.birthtimeNs.toString();
  // CPython's Darwin stat float is seconds + 1e-9 * nanoseconds. Compare
  // that exact binary float; no tolerance or byte-only inode adoption.
  return Number(row.birthTime) === Number(info.birthtimeNs / BigInt(1_000_000_000)) + 1e-9 * Number(info.birthtimeNs % BigInt(1_000_000_000));
}
/** Mechanical private namespace proof. It grants no write permission and has
 * no orphan discovery, path fallback, pointer mutation or pending cleanup. */
function readStorePointer(frame: Frame): StorePin {
  const opened: number[] = [], failures: unknown[] = []; let result: StorePin | undefined;
  const own = (fd: number) => { opened.push(fd); return fd; };
  const backend = frame.backend;
  const read = (parent: number, name: string): { bytes: Buffer; info: BigIntStats } => {
    const fd = own(backend.openFileAt(parent, name, 'readonly')), before = syncFs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.geteuid!()) || before.nlink !== BigInt(1)
      || before.size > BigInt(128 * 1024) || (before.mode & BigInt(0o7777)) !== BigInt(0o600)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const bytes = Buffer.alloc(Math.min(64 * 1024, 128 * 1024 + 1 - size)), count = syncFs.readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break; size += count; if (size > 128 * 1024) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED'); chunks.push(bytes.subarray(0, count)); }
    const after = syncFs.fstatSync(fd, { bigint: true }), named = own(backend.openFileAt(parent, name, 'readonly'));
    if (!backend.hasExactNameAt(parent, name) || !stableFile(before, after) || !stableFile(after, syncFs.fstatSync(named, { bigint: true }))) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    return { bytes: Buffer.concat(chunks), info: after };
  };
  const directory = (parent: number, name: string): number => {
    const fd = own(backend.openDirectoryAt(parent, name)), info = syncFs.fstatSync(fd, { bigint: true });
    syncDirectory(info);
    if ((info.mode & BigInt(0o077)) !== BigInt(0) || !backend.hasExactNameAt(parent, name)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    return fd;
  };
  try {
    const anchor = read(frame.data.fd, 'canvas-markdown-create-births-anchor.json'), value = JSON.parse(anchor.bytes.toString('utf8')) as Record<string, unknown>;
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || !canonical(value).equals(anchor.bytes)
      || !isDeepStrictEqual(value.data, frame.dataIdentity)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    let name: string;
    if (value.version === 1 && Object.keys(value).sort().join(',') === 'data,store,version') name = 'canvas-markdown-create-births';
    else if (value.version === 2 && Object.keys(value).sort().join(',') === 'data,pendingName,pointerFile,store,storeName,version'
      && typeof value.storeName === 'string' && /^canvas-markdown-create-births-[a-f0-9]{32}$/u.test(value.storeName)
      && value.pendingName === 'anchor.pending' && isDeepStrictEqual(value.pointerFile, { dev: anchor.info.dev.toString(), ino: anchor.info.ino.toString(),
        uid: Number(anchor.info.uid), mode: 0o600 })) name = value.storeName;
    else return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    const store = directory(frame.data.fd, name), observed = syncDirectory(syncFs.fstatSync(store, { bigint: true }));
    if (!isDeepStrictEqual(observed, value.store) || !isDeepStrictEqual(syncDirectory(syncFs.fstatSync(directory(frame.data.fd, name), { bigint: true })), observed)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    if (frame.fingerprint) {
      const claim = directory(store, frame.key), intent = read(claim, 'intent.json');
      const parsed = JSON.parse(intent.bytes.toString('utf8'));
      if (!canonical(parsed).equals(intent.bytes) || sha(intent.bytes.toString('utf8')) !== frame.fingerprint) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    }
    result = { name, directory: observed, file: anchor.info, bytes: anchor.bytes };
    const expected = frame.storePin;
    if (expected && (name !== expected.name || !same(observed, expected.directory) || !stableFile(anchor.info, expected.file)
      || !anchor.bytes.equals(expected.bytes))) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
  } catch (error) { failures.push(error); }
  for (const fd of opened.reverse()) { try { syncFs.closeSync(fd); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'MARKDOWN_CREATE_BIRTH_STORE_CLOSURE_FAILED');
  return result!;
}
function synchronousBirth(frame: Frame, serialized: string, assertWithinTurn: () => void): void {
  const backend = frame.backend, opened = new Set<number>(), failures: unknown[] = [];
  const own = (fd: number): number => { opened.add(fd); return fd; };
  const directoryAt = (fd: number, name: string): number => {
    const value = own(backend.openDirectoryAt(fd, name));
    if (!backend.hasExactNameAt(fd, name)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
    return value;
  };
  const read = (fd: number, name: string, limit: number, links: number, mode?: number): { bytes: Buffer; info: BigIntStats } => {
    const file = own(backend.openFileAt(fd, name, 'readonly')), before = syncFs.fstatSync(file, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.geteuid!()) || before.nlink !== BigInt(links) || before.size > BigInt(limit)
      || mode !== undefined && (before.mode & BigInt(0o7777)) !== BigInt(mode)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size)), count = syncFs.readSync(file, chunk, 0, chunk.length, null);
      if (!count) break; size += count; if (size > limit) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED'); chunks.push(chunk.subarray(0, count)); }
    const after = syncFs.fstatSync(file, { bigint: true }), named = own(backend.openFileAt(fd, name, 'readonly'));
    if (!backend.hasExactNameAt(fd, name) || !stableFile(before, after) || !stableFile(after, syncFs.fstatSync(named, { bigint: true }))) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return { bytes: Buffer.concat(chunks), info: after };
  };
  const record = (fd: number, name: string): Record<string, unknown> => {
    const value = read(fd, name, 128 * 1024, 1, 0o600), parsed = JSON.parse(value.bytes.toString('utf8')) as Record<string, unknown>;
    if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype || !canonical(parsed).equals(value.bytes)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return parsed;
  };
  const optional = (fd: number, name: string): Record<string, unknown> | null => {
    try { return record(fd, name); } catch (error) { if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null; throw error; }
  };
  const writeRecord = (fd: number, name: string, value: Record<string, unknown>): void => {
    const prior = optional(fd, name); if (prior) { if (!isDeepStrictEqual(prior, value)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED'); return; }
    const bytes = canonical(value); if (bytes.length > 128 * 1024) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const pending = name + '.pending', file = own(backend.openFileAt(fd, pending, 'private-wx'));
    let offset = 0; while (offset < bytes.length) { const count = syncFs.writeSync(file, bytes, offset, bytes.length - offset); if (!count) return fail('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED'); offset += count; }
    syncFs.fsyncSync(file); const info = syncFs.fstatSync(file, { bigint: true });
    backend.linkAt(fd, pending, fd, name); syncFs.fsyncSync(fd);
    const actual = read(fd, pending, 128 * 1024, 2, 0o600); if (actual.info.dev !== info.dev || actual.info.ino !== info.ino || !actual.bytes.equals(bytes)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    backend.unlinkFileAt(fd, pending, { dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid), mode: 0o600 }); syncFs.fsyncSync(fd);
    if (!isDeepStrictEqual(record(fd, name), value)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
  };
  const rootCurrent = () => {
    const data = syncFs.lstatSync(frame.configuredData), workspace = syncFs.statSync(frame.configuredWorkspace);
    if (!frame.active || resolveCanvasDataRoot() !== frame.configuredData || data.isSymbolicLink() || !data.isDirectory() || !workspace.isDirectory()
      || syncFs.realpathSync(frame.configuredData) !== frame.resolvedData || syncFs.realpathSync(frame.configuredWorkspace) !== frame.resolvedWorkspace
      || !same(identity(data), frame.dataIdentity) || !same(identity(workspace), frame.workspaceIdentity)
      || !same(syncDirectory(syncFs.fstatSync(frame.data.fd, { bigint: true })), frame.dataIdentity)
      || !same(syncDirectory(syncFs.fstatSync(frame.workspace.fd, { bigint: true })), frame.workspaceIdentity)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
  };
  const sourceCurrent = (intent: Record<string, unknown>): number => {
    const selected = intent.source as Record<string, unknown>, expected = intent.sourceAttribution as Record<string, unknown>;
    const uploads = directoryAt(frame.data.fd, '.uploads'), workspace = directoryAt(uploads, 'workspace'), session = directoryAt(workspace, selected.uploadSessionId as string);
    const manifestRead = read(session, 'session.json', 16 * 1024 * 1024, 1, 0o600), manifest = JSON.parse(manifestRead.bytes.toString('utf8')) as Record<string, unknown>;
    if (manifest.id !== selected.uploadSessionId || manifest.userId !== selected.actorUserId || manifest.workspaceId !== selected.workspaceId
      || manifest.status !== 'receiving' || typeof manifest.expiresAt !== 'string' || manifest.expiresAt.length > 64
      || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(manifest.expiresAt) || !Number.isFinite(Date.parse(manifest.expiresAt))) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    const files = manifest.files; if (!Array.isArray(files) || files.length < 1 || files.length > 1000) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    const matches = files.filter(value => value && value.id === selected.fileId); if (matches.length !== 1) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    const file = matches[0] as Record<string, unknown>;
    if ('officeAttempt' in file || file.targetPath !== selected.targetPath || !Number.isSafeInteger(file.size) || file.size !== selected.sourceBytes) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    let progress: Record<string, unknown> = file, progressInfo: BigIntStats | null = null;
    try { const value = read(session, selected.fileId + '.part.json', 128 * 1024, 1, 0o600); progress = JSON.parse(value.bytes.toString('utf8')); progressInfo = value.info; }
    catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error; }
    if (!(file.size === 0 ? ['pending', 'uploaded'] : ['uploaded']).includes(progress.status as string)
      || !Number.isSafeInteger(progress.uploadedBytes) || progress.uploadedBytes !== file.size) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    const part = read(session, selected.fileId + '.part', 5 * 1024 * 1024, 1, 0o600);
    if (part.bytes.length !== selected.sourceBytes || createHash('sha256').update(part.bytes).digest('hex') !== selected.sourceHash
      || !fileMatches(part.info, expected.part) || (progressInfo ? !fileMatches(progressInfo, expected.progress) : expected.progress !== null)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    if (!isDeepStrictEqual([uploads, workspace, session].map(fd => syncDirectory(syncFs.fstatSync(fd, { bigint: true }))), expected.directories)
      || !isDeepStrictEqual({ dev: manifestRead.info.dev.toString(), ino: manifestRead.info.ino.toString(), uid: Number(manifestRead.info.uid), mode: Number(manifestRead.info.mode & BigInt(0o7777)) }, expected.manifestInode)
      || !isDeepStrictEqual(Object.fromEntries(['id', 'userId', 'workspaceId', 'targetDir', 'createdAt', 'expiresAt'].map(key => [key, manifest[key] ?? null])), expected.header)
      || !isDeepStrictEqual(Object.fromEntries(['id', 'sourceIndex', 'relativePath', 'targetPath', 'size', 'mimeType'].map(key => [key, file[key] ?? null])), expected.selected)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    if (!stableFile(manifestRead.info, read(session, 'session.json', 16 * 1024 * 1024, 1, 0o600).info)
      || progressInfo && !stableFile(progressInfo, read(session, selected.fileId + '.part.json', 128 * 1024, 1, 0o600).info)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    // The reads above pin inodes; close the named-directory attribution too.
    // A replaced upload ancestor must not authorize bytes from a detached FD.
    for (const [parent, name, fd] of [[frame.data.fd, '.uploads', uploads], [uploads, 'workspace', workspace],
      [workspace, selected.uploadSessionId as string, session]] as const) {
      const current = directoryAt(parent, name);
      if (!same(syncDirectory(syncFs.fstatSync(current, { bigint: true })), syncDirectory(syncFs.fstatSync(fd, { bigint: true })))) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    }
    const expiresAt = Date.parse(manifest.expiresAt);
    if (Date.now() >= expiresAt) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_EXPIRED');
    return expiresAt;
  };
  try {
    rootCurrent(); const selected = readStorePointer(frame), store = directoryAt(frame.data.fd, selected.name), claim = directoryAt(store, frame.key);
    if (!same(syncDirectory(syncFs.fstatSync(store, { bigint: true })), selected.directory)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
    const intent = record(claim, 'intent.json'); if (sha(canonical(intent).toString()) !== frame.fingerprint) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const prepared = record(claim, 'prepared.json'); if (prepared.version !== 1 || prepared.serializedHash !== sha(serialized)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
    const initial = intent.ancestors as Record<string, unknown>, segments = (intent.targetPath as string).split('/'), ancestry: { parent: number; name: string; child: number; expected: unknown }[] = [];
    let parent = frame.workspace.fd, relative = '';
    for (const name of segments.slice(0, -1)) {
      relative = relative ? relative + '/' + name : name;
      const recordName = 'parent-' + sha(relative) + '.json', prior = optional(claim, recordName);
      if (prior && (prior.path !== relative || Object.keys(prior).sort().join(',') !== 'identity,path')) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      let expected = initial[relative] || prior?.identity;
      if (!expected) { assertWithinTurn(); backend.mkdirAt(parent, name, 0o755); syncFs.fsyncSync(parent); const born = directoryAt(parent, name);
        expected = syncDirectory(syncFs.fstatSync(born, { bigint: true })); writeRecord(claim, recordName, { path: relative, identity: expected }); ancestry.push({ parent, name, child: born, expected }); parent = born; }
      else { const child = directoryAt(parent, name); if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(child, { bigint: true })), expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
        ancestry.push({ parent, name, child, expected }); parent = child; }
    }
    const name = segments.at(-1)!; let target: { bytes: Buffer; info: BigIntStats } | null = null;
    const complete = optional(claim, 'completed.json'), settled = optional(claim, 'settled.json');
    try { target = read(parent, name, 5 * 1024 * 1024, complete && settled ? 1 : 2, 0o644); }
    catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error; }
    if (target) {
      if (!fileMatches(target.info, prepared.file) || createHash('sha256').update(target.bytes).digest('hex') !== prepared.serializedHash) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      if (target.info.nlink === BigInt(1)) { if (!settled || !fileMatches(target.info, settled.file) || settled.ctimeNs !== target.info.ctimeNs.toString()) return fail('MARKDOWN_CREATE_BIRTH_RECOVERY_REQUIRED'); }
      else { const twin = read(claim, 'content.tmp', 5 * 1024 * 1024, 2, 0o644); if (!fileMatches(twin.info, prepared.file) || twin.info.dev !== target.info.dev || twin.info.ino !== target.info.ino || !twin.bytes.equals(target.bytes)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED'); }
    } else {
      const staged = read(claim, 'content.tmp', 5 * 1024 * 1024, 1, 0o644);
      if (!fileMatches(staged.info, prepared.file) || !staged.bytes.equals(Buffer.from(serialized))) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      rootCurrent(); const expiresAt = sourceCurrent(intent); readStorePointer(frame);
      for (const ancestor of ancestry) { const named = directoryAt(ancestor.parent, ancestor.name); if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(named, { bigint: true })), ancestor.expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED'); }
      assertWithinTurn();
      if (Date.now() >= expiresAt) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_EXPIRED');
      // Every call in this final turn is synchronous and descriptor-bound.
      // The stopped preparation child has no target-write operation to resume.
      backend.linkAt(claim, 'content.tmp', parent, name); syncFs.fsyncSync(parent);
      const actual = read(parent, name, 5 * 1024 * 1024, 2, 0o644); if (!fileMatches(actual.info, prepared.file) || !actual.bytes.equals(staged.bytes)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      writeRecord(claim, 'born.json', prepared);
    }
    rootCurrent();
  } catch (error) { failures.push(error); }
  for (const fd of [...opened].reverse()) { try { syncFs.closeSync(fd); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'MARKDOWN_CREATE_BIRTH_PARENT_CLOSURE_FAILED');
}

/** Called only inside the actual OwnerA coordinator. Both pinned descriptors
 * and every helper/ACK promise close before this whole callback settles. */
export async function withMarkdownCreateBirthClaim<T>(input: { workspaceRoot: string; targetPath: string;
  origin: Readonly<Record<string, unknown>>; source: Readonly<Record<string, unknown>>; operationId: string },
  beforeBoundary: () => Promise<void>, operation: (claim: MarkdownCreateBirthClaim) => Promise<T>): Promise<T> {
  const configuredData = resolveCanvasDataRoot(), configuredWorkspace = input.workspaceRoot;
  // Availability is established before the coordinator can perform native DML.
  const backend = getFdPublicationBackend();
  const captured = structuredClone(input);
  const data = await fs.open(configuredData, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let workspace: FileHandle | undefined, frame: Frame | undefined;
  const errors: unknown[] = []; let value: T | undefined;
  try {
    const resolvedData = await fs.realpath(configuredData), resolvedWorkspace = await fs.realpath(configuredWorkspace);
    workspace = await fs.open(resolvedWorkspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const dataIdentity = identity(await data.stat()), workspaceIdentity = identity(await workspace.stat());
    const intent = { version: 1, targetPath: captured.targetPath, origin: captured.origin, source: captured.source,
      operationId: captured.operationId, dataRoot: dataIdentity, workspaceRoot: workspaceIdentity };
    const current: Frame = { configuredData, resolvedData, configuredWorkspace, resolvedWorkspace, data, workspace,
      dataIdentity, workspaceIdentity, key: sha(JSON.stringify(['canvas-markdown-first-birth-v1', captured.origin.workspaceId, captured.operationId])),
      intent, active: true, backend };
    frame = current;
    const first = await invoke(current, 'open', beforeBoundary); current.fingerprint = first.fingerprint;
    current.storePin = readStorePointer(current);
    let accepting = true, queue = Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    const observe = <V>(result: Promise<V>): Promise<V> => {
      pending.add(result);
      result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
    const run = <V>(action: () => Promise<V>): Promise<V> => {
      const result = queue.then(() => {
        if (!accepting) return fail('MARKDOWN_CREATE_BIRTH_CLOSED');
        return action();
      });
      queue = result.then(() => undefined, () => undefined);
      return observe(result);
    };
    const claim: MarkdownCreateBirthClaim = Object.freeze({ id: current.key, fingerprint: first.fingerprint,
      // Root checks are read-only and may run from this helper's own ACK. They
      // must not queue behind the publication they are certifying.
      assertRoot: () => observe(accepting ? root(current) : Promise.reject(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_CLOSED'))),
      verify: () => run(() => invoke(current, 'verify', beforeBoundary)),
      publish: (serialized, boundary, assertWithinTurn) => run(async () => {
        await invoke(current, 'prepare', boundary, { bytes: Buffer.from(serialized).toString('base64'), serializedHash: sha(serialized) });
        // invoke resolves only after the actual helper close and ACK drain.
        await root(current); await boundary('parent_link');
        synchronousBirth(current, serialized, assertWithinTurn);
        return invoke(current, 'observe', boundary);
      }),
      complete: (serializedHash, revisionId, boundary) => run(async () => { await invoke(current, 'complete', boundary, { serializedHash, revisionId }); }),
    });
    try { value = await operation(claim); } catch (error) { errors.push(error); }
    accepting = false;
    const unfinished = pending.size > 0;
    const settlements = await Promise.allSettled([...pending]);
    if (unfinished) errors.push(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_UNAWAITED_IO'));
    for (const settlement of settlements) if (settlement.status === 'rejected') errors.push(settlement.reason);
  } catch (error) { errors.push(error); }
  if (frame) { try { await root(frame); await beforeBoundary(); } catch (error) { errors.push(error); } }
  const close = async (handle: FileHandle) => {
    try { await handle.close(); } catch (error) {
      errors.push(error);
      // Keep the original descriptor and settle one transient pre-close fault.
      try { await handle.close(); } catch (retryError) { errors.push(retryError); }
    }
  };
  if (workspace) await close(workspace);
  await close(data);
  if (frame) { try { await named(frame); await beforeBoundary(); } catch (error) { errors.push(error); } frame.active = false; }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'MARKDOWN_CREATE_BIRTH_CLOSURE_FAILED');
  return value as T;
}
