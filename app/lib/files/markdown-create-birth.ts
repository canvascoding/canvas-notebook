import 'server-only';

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import syncFs, { constants, promises as fs, type Stats, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { resolveCanvasDataRoot } from '../runtime-data-paths';
import { getFdPublicationBackend, type FdPublicationBackend } from './fd-publication';
import { isDeepStrictEqual, types } from 'node:util';
import { inCollaborationProjectionPhase } from '../collaboration/projection-errors';

type Identity = Readonly<{ dev: string; ino: string; uid: number; mode: number }>;
type Observation = Readonly<{ state: 'intent' | 'prepared' | 'born' | 'complete'; fingerprint: string;
  serializedHash: string | null; revisionId: string | null; intent: Record<string, unknown> }>;
export type MarkdownCreateBirthStorageInput = Readonly<{ workspaceRoot: string; targetPath: string;
  origin: Readonly<Record<string, unknown>>; source: Readonly<Record<string, unknown>>; operationId: string }>;
export type MarkdownCreateBirthOriginal = Readonly<{ id: string; fingerprint: string; intent: Readonly<Record<string, unknown>>;
  complete: boolean; revisionId: string | null; serializedHash: string | null }>;
export type DirectMcpMarkdownCreateSourceBinding = Readonly<{
  kind: 'direct-mcp-markdown-v1'; workspaceId: string; targetPath: string; actorUserId: string; actorSessionId: string;
  clientId: string; tool: 'create_knowledge_source' | 'import_knowledge_file'; operationId: string; requestId: string;
  ingestRequestFingerprint: string; sourceHash: string; sourceBytes: number; fileId: string | null;
  declaredMimeType: string | null; ingestValidationJson: string;
}>;
export type AgentMarkdownCreateSourceBinding = Readonly<{
  kind: 'agent-markdown-v1'; workspaceId: string; targetPath: string; actorUserId: string; actorSessionId: string;
  agentId: string; toolName: 'write' | 'pdf_to_markdown'; toolCallId: string;
  operationId: string; requestId: string; requestFingerprint: string; sourceHash: string; sourceBytes: number;
}>;
/** Private storage proof only. The genuine request/Owner/native coordinator
 * must separately authorize every publication and finalization. */
export type MarkdownCreateBirthClaim = Readonly<{
  id: string; fingerprint: string; assertRoot(): Promise<void>; verify(): Promise<Observation>;
  publish(serialized: string, beforeBoundary: (stage?: string) => Promise<void>, assertWithinTurn: () => void): Promise<Observation>;
  complete(serializedHash: string, revisionId: string, beforeBoundary: (stage?: string) => Promise<void>): Promise<void>;
}>;
/** The coordinator may own one genuine database phase around a whole helper
 * action. This callback supplies no authority; fixed source guards still run. */
export type MarkdownCreateBirthStoragePhase = <T>(operation: () => Promise<T>) => Promise<T>;
export class MarkdownCreateBirthError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MarkdownCreateBirthError'; }
}

/** Historical private storage evidence only. This entry cannot initialize a
 * store/claim, consume an upload source or mutate either namespace. */
export async function observeMarkdownCreateBirth(input: { workspaceRoot: string; workspaceId: string; operationId: string }): Promise<{
  id: string; fingerprint: string; intent: Record<string, unknown>; complete: boolean; revisionId: string | null; serializedHash: string | null;
}> {
  const observed = await readMarkdownCreateBirthOriginal(input, false);
  if (!observed) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
  return observed;
}
/** Data-only original lookup. A missing trusted anchor or this operation's
 * exact claim name is absence; an existing but damaged claim is never absent. */
export async function observeOptionalMarkdownCreateBirth(input: Readonly<{
  workspaceRoot: string; workspaceId: string; operationId: string;
}>): Promise<MarkdownCreateBirthOriginal | null> {
  if (!plainBirthData(input, ['workspaceRoot', 'workspaceId', 'operationId'])
    || typeof input.workspaceRoot !== 'string' || !input.workspaceRoot || typeof input.workspaceId !== 'string' || !input.workspaceId
    || typeof input.operationId !== 'string' || !input.operationId) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
  return readMarkdownCreateBirthOriginal(Object.freeze({ workspaceRoot: input.workspaceRoot, workspaceId: input.workspaceId,
    operationId: input.operationId }), true);
}
async function readMarkdownCreateBirthOriginal(input: Readonly<{
  workspaceRoot: string; workspaceId: string; operationId: string;
}>, allowAbsent: boolean): Promise<MarkdownCreateBirthOriginal | null> {
  const configuredData = resolveCanvasDataRoot(), configuredWorkspace = input.workspaceRoot;
  const backend = getFdPublicationBackend(), opened: number[] = [], errors: unknown[] = [];
  let data: FileHandle | undefined, workspace: FileHandle | undefined, frame: Frame | undefined;
  let value: MarkdownCreateBirthOriginal | null | undefined;
  const own = (fd: number) => { opened.push(fd); return fd; };
  const openOptional = (parent: number, name: string, directory: boolean): number | null => {
    // Catch only this exact open. ENOENT from later record/pointer/close work
    // cannot turn an existing or unconfirmed original into a fresh operation.
    try { return own(directory ? backend.openDirectoryAt(parent, name) : backend.openFileAt(parent, name, 'readonly')); }
    catch (error) {
      if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error;
      if (backend.hasExactNameAt(parent, name)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
      return null;
    }
  };
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
    const current = frame, observedData = data, observedWorkspace = workspace;
    const inspect = async (): Promise<MarkdownCreateBirthOriginal | null> => {
      if (allowAbsent && openOptional(observedData.fd, 'canvas-markdown-create-births-anchor.json', false) === null) {
        await root(current);
        if (openOptional(observedData.fd, 'canvas-markdown-create-births-anchor.json', false) !== null) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
        return null;
      }
      const pin = readStorePointer(current); current.storePin = pin;
      const store = own(backend.openDirectoryAt(observedData.fd, pin.name));
      const claim = allowAbsent ? openOptional(store, current.key, true) : own(backend.openDirectoryAt(store, current.key));
      if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(store, { bigint: true })), pin.directory)) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
      if (claim === null) {
        readStorePointer(current); await root(current);
        if (openOptional(store, current.key, true) !== null) return fail('MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED');
        readStorePointer(current); await root(current);
        return null;
      }
      for (const [parent, name, fd] of [[observedData.fd, pin.name, store], [store, current.key, claim]] as const) {
        const info = syncFs.fstatSync(fd, { bigint: true }); syncDirectory(info);
        if ((info.mode & BigInt(0o077)) !== BigInt(0) || !backend.hasExactNameAt(parent, name)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      }
      const intent = read(claim, 'intent.json');
      if (!isDeepStrictEqual(intent.dataRoot, current.dataIdentity) || !isDeepStrictEqual(intent.workspaceRoot, current.workspaceIdentity)
        || intent.operationId !== input.operationId || typeof intent.targetPath !== 'string') return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      const agentSource = !!intent.source && typeof intent.source === 'object' && Reflect.get(intent.source,'kind') === 'agent-markdown-v1';
      if (agentSource && !isDeepStrictEqual(agentMarkdownCreateAttribution(intent),intent.sourceAttribution)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
      const fileLimit = agentSource ? 8 * 1024 * 1024 : 5 * 1024 * 1024;
      const fingerprint = sha(canonical(intent).toString('utf8')); current.fingerprint = fingerprint;
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
        let parent = observedWorkspace.fd, relative = '';
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
        const target = readFile(parent, segments.at(-1)!, fileLimit, 0o644);
        if (!fileMatches(target.info, prepared!.file) || !fileMatches(target.info, settled!.file)
          || target.info.ctimeNs.toString() !== settled!.ctimeNs
          || createHash('sha256').update(target.bytes).digest('hex') !== completed.serializedHash) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
        for (const ancestor of ancestors) {
          const child = own(backend.openDirectoryAt(ancestor.parent, ancestor.name));
          if (!backend.hasExactNameAt(ancestor.parent, ancestor.name)
            || !isDeepStrictEqual(syncDirectory(syncFs.fstatSync(child, { bigint: true })), ancestor.expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
        }
      }
      readStorePointer(current); await root(current);
      return { id: current.key, fingerprint, intent, complete: completed !== null,
        revisionId: completed?.revisionId as string ?? null, serializedHash: completed?.serializedHash as string ?? null };
    };
    value = await inspect();
  } catch (error) { errors.push(error); }
  for (const fd of opened.reverse()) { try { syncFs.closeSync(fd); } catch (error) { errors.push(error); } }
  for (const handle of [workspace, data]) if (handle) { try { await handle.close(); } catch (error) { errors.push(error); } }
  if (frame) { try { await named(frame); } catch (error) { errors.push(error); } frame.active = false; }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'MARKDOWN_CREATE_BIRTH_OBSERVATION_UNCONFIRMED');
  if (value === undefined) return fail('MARKDOWN_CREATE_BIRTH_OBSERVATION_UNCONFIRMED');
  return value;
}
const fail = (code: string): never => { throw new MarkdownCreateBirthError(code); };
const identity = (value: Stats): Identity => ({ dev: String(value.dev), ino: String(value.ino), uid: value.uid, mode: value.mode & 0o7777 });
const same = (a: Identity, b: Identity) => Object.keys(a).every(key => Reflect.get(a, key) === Reflect.get(b, key));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const directMcpSourceKeys = ['kind', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'clientId', 'tool',
  'operationId', 'requestId', 'ingestRequestFingerprint', 'sourceHash', 'sourceBytes', 'fileId', 'declaredMimeType', 'ingestValidationJson'] as const;
function plainBirthRecord(value: unknown): value is Record<string, unknown> {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(value);
  return names.every(key => typeof key === 'string' && descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
}
function plainBirthData(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return plainBirthRecord(value) && keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}
function directMcpValidationJson(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 32 * 1024) return false;
  let validation: unknown;
  try { validation = JSON.parse(value); } catch { return false; }
  if (!plainBirthData(validation, ['mimeType', 'markdown', 'warnings']) || JSON.stringify(validation) !== value
    || typeof validation.mimeType !== 'string' || validation.mimeType.length > 200
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(validation.mimeType)
    || !Array.isArray(validation.warnings) || validation.warnings.length > 64) return false;
  if (validation.markdown !== null && (!plainBirthData(validation.markdown, ['mode'], ['reason'])
    || !['rich', 'normalizable', 'source'].includes(validation.markdown.mode as string)
    || Object.hasOwn(validation.markdown, 'reason') && (typeof validation.markdown.reason !== 'string' || validation.markdown.reason.length > 200))) return false;
  return validation.warnings.every(item => plainBirthData(item, ['code', 'message']) && typeof item.code === 'string'
    && item.code.length > 0 && item.code.length <= 200 && typeof item.message === 'string' && item.message.length <= 4096);
}
/** Exact durable attribution, never an authority grant or a source-byte store. */
export function directMcpMarkdownCreateAttribution(intent: Record<string, unknown>): DirectMcpMarkdownCreateSourceBinding {
  if (!plainBirthRecord(intent)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  const selected = intent.source, origin = intent.origin;
  if (!plainBirthData(selected, directMcpSourceKeys) || !plainBirthRecord(origin)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  const boundedId = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;
  const source = selected as Record<string, unknown>, attribution = origin as Record<string, unknown>;
  if (source.kind !== 'direct-mcp-markdown-v1' || !['create_knowledge_source', 'import_knowledge_file'].includes(source.tool as string)
    || !boundedId(source.workspaceId) || !['actorUserId', 'actorSessionId', 'clientId'].every(key => boundedId(source[key], 256))
    || !['operationId', 'ingestRequestFingerprint', 'sourceHash'].every(key => typeof source[key] === 'string' && /^[a-f0-9]{64}$/u.test(source[key] as string))
    || source.requestId !== `mcp-create:${source.operationId}` || source.operationId !== intent.operationId
    || source.workspaceId !== attribution.workspaceId || source.actorUserId !== attribution.userId
    || source.actorSessionId !== attribution.sessionId || source.clientId !== attribution.clientId || source.tool !== attribution.tool
    || typeof source.targetPath !== 'string' || source.targetPath.length > 1024 || source.targetPath !== intent.targetPath
    || !/\.(?:md|markdown)$/iu.test(source.targetPath) || source.targetPath.split('/').some(name => !name || name.startsWith('.') || /[\\\u0000-\u001f\u007f]/u.test(name))
    || !Number.isSafeInteger(source.sourceBytes) || Number(source.sourceBytes) < 0 || Number(source.sourceBytes) > 512 * 1024
    || !directMcpValidationJson(source.ingestValidationJson)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  if (source.tool === 'create_knowledge_source' ? source.fileId !== null || source.declaredMimeType !== null
    : !boundedId(source.fileId) || source.declaredMimeType !== null && (typeof source.declaredMimeType !== 'string'
      || !source.declaredMimeType.length || source.declaredMimeType.length > 200)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  return Object.freeze(Object.fromEntries(directMcpSourceKeys.map(key => [key, source[key]]))) as DirectMcpMarkdownCreateSourceBinding;
}

/** Original PI attribution only; the private Create owner supplies authority. */
export function agentMarkdownCreateAttribution(intent: Record<string, unknown>): AgentMarkdownCreateSourceBinding {
  const keys = ['kind','workspaceId','targetPath','actorUserId','actorSessionId','agentId','toolName','toolCallId',
    'operationId','requestId','requestFingerprint','sourceHash','sourceBytes'] as const;
  if (!plainBirthRecord(intent) || !plainBirthData(intent.source,keys) || !plainBirthRecord(intent.origin)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  const source = intent.source as Record<string, unknown>, origin = intent.origin as Record<string, unknown>;
  if (source.kind !== 'agent-markdown-v1' || !['write','pdf_to_markdown'].includes(source.toolName as string)
    || !['workspaceId','actorUserId','actorSessionId','agentId'].every(key => typeof source[key] === 'string'
      && (source[key] as string).length > 0 && (source[key] as string).length <= 256)
    || typeof source.toolCallId !== 'string' || !source.toolCallId || source.toolCallId.length > 4096
    || !['operationId','requestFingerprint','sourceHash'].every(key => typeof source[key] === 'string' && /^[a-f0-9]{64}$/u.test(source[key] as string))
    || source.requestId !== `agent-create:${source.operationId}` || source.operationId !== intent.operationId
    || source.workspaceId !== origin.workspaceId || source.actorUserId !== origin.userId || source.actorSessionId !== origin.piSessionId
    || source.agentId !== origin.agentId || source.toolName !== origin.toolName || source.toolCallId !== origin.toolCallId
    || typeof source.targetPath !== 'string' || !source.targetPath || source.targetPath.length > 4096 || source.targetPath !== intent.targetPath
    || !/\.(?:md|markdown)$/iu.test(source.targetPath) || source.targetPath.split('/').some(name => !name || name === '.' || name === '..' || /[\\\u0000-\u001f\u007f]/u.test(name))
    || !Number.isSafeInteger(source.sourceBytes) || Number(source.sourceBytes) < 0 || Number(source.sourceBytes) > 8 * 1024 * 1024) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  return Object.freeze(Object.fromEntries(keys.map(key => [key,source[key]]))) as AgentMarkdownCreateSourceBinding;
}
type StorePin = Readonly<{ name: string; directory: Identity; file: BigIntStats; bytes: Buffer }>;
type Frame = { active: boolean; configuredData: string; resolvedData: string; configuredWorkspace: string;
  resolvedWorkspace: string; data: FileHandle; workspace: FileHandle; dataIdentity: Identity; workspaceIdentity: Identity;
  key: string; intent: Record<string, unknown>; fingerprint?: string; backend: FdPublicationBackend; storePin?: StorePin;
  fixedSourceWithinTurn?: () => void; withStoragePhase?: MarkdownCreateBirthStoragePhase };
function manualEmptyAttribution(intent: Record<string, unknown>): Record<string, unknown> {
  const selected = intent.source as Record<string, unknown>, origin = intent.origin as Record<string, unknown>;
  const keys = ['kind', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'requestId', 'operationId', 'sourceHash', 'sourceBytes'];
  if (!selected || Object.getPrototypeOf(selected) !== Object.prototype || Reflect.ownKeys(selected).length !== keys.length
    || Object.keys(selected).some(key => !keys.includes(key)) || selected.kind !== 'manual-empty-v1'
    || selected.sourceBytes !== 0 || selected.sourceHash !== sha('') || !origin || selected.workspaceId !== origin.workspaceId
    || selected.actorUserId !== origin.userId || selected.actorSessionId !== origin.sessionId || selected.targetPath !== intent.targetPath
    || selected.operationId !== intent.operationId || selected.requestId !== selected.operationId || typeof selected.operationId !== 'string'
    || !/^manual-create:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(selected.operationId)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  return { ...selected };
}
function captureBirthInput(input: { workspaceRoot: string; targetPath: string; origin: Readonly<Record<string, unknown>>;
  source: Readonly<Record<string, unknown>>; operationId: string }): typeof input {
  const fields = ['workspaceRoot', 'targetPath', 'origin', 'source', 'operationId'];
  const data = (value: object, keys?: string[]) => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(value);
    if (names.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))
      || keys && (names.length !== keys.length || names.some(key => !keys.includes(key as string)))) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return Object.fromEntries(names.map(key => [key, descriptors[key as string].value]));
  };
  const top = data(input, fields);
  const primitives = (value: object) => Object.freeze(Object.fromEntries(Object.entries(data(value)).map(([key, field]) => {
    if (field !== null && !['string', 'boolean', 'number'].includes(typeof field)
      || typeof field === 'number' && !Number.isSafeInteger(field)) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
    return [key, field];
  })));
  if (['workspaceRoot', 'targetPath', 'operationId'].some(key => typeof top[key] !== 'string')) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
  return Object.freeze({ workspaceRoot: top.workspaceRoot, targetPath: top.targetPath, operationId: top.operationId,
    origin: primitives(top.origin), source: primitives(top.source) }) as typeof input;
}
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
  const phase = { open: 'birth_open', verify: 'birth_verify', prepare: 'birth_prepare', observe: 'birth_observe', complete: 'birth_complete' } as const;
  const operation = async () => {
    const agentSource = !!frame.intent.source && typeof frame.intent.source === 'object' && Reflect.get(frame.intent.source,'kind') === 'agent-markdown-v1';
    if (agentSource) agentMarkdownCreateAttribution(frame.intent);
    const message = JSON.stringify({action,key:frame.key,intent:frame.intent,...fields}) + '\n';
    // Agent content is already bounded to 8 MiB before B. The existing wire
    // uses base64; 64 MiB also bounds worst-case JSON escaping plus metadata.
    if (agentSource ? Buffer.byteLength(message,'utf8') > 64 * 1024 * 1024 : message.length > 8 * 1024 * 1024) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
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
      child.stdin!.write(message);
    });
    await root(frame); await boundary();
    if (frame.storePin) readStorePointer(frame);
    return observed;
  };
  return inCollaborationProjectionPhase(phase[action], () =>
    frame.withStoragePhase ? frame.withStoragePhase(operation) : operation());
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
  const sourceCurrent = (intent: Record<string, unknown>): number | null => {
    const selected = intent.source as Record<string, unknown>, expected = intent.sourceAttribution as Record<string, unknown>;
    if (Object.hasOwn(selected, 'kind')) {
      const attribution = selected.kind === 'manual-empty-v1' ? manualEmptyAttribution(intent)
        : selected.kind === 'direct-mcp-markdown-v1' ? directMcpMarkdownCreateAttribution(intent)
          : selected.kind === 'agent-markdown-v1' ? agentMarkdownCreateAttribution(intent)
          : fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
      if (selected.kind === 'manual-empty-v1' && serialized !== '' || !frame.fixedSourceWithinTurn
        || !isDeepStrictEqual(attribution, expected)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
      frame.fixedSourceWithinTurn();
      return null; // Fixed provenance has no upload staging TTL.
    }
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
    const agentSource = !!intent.source && typeof intent.source === 'object' && Reflect.get(intent.source,'kind') === 'agent-markdown-v1';
    if (agentSource && !isDeepStrictEqual(agentMarkdownCreateAttribution(intent),intent.sourceAttribution)) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    const fileLimit = agentSource ? 8 * 1024 * 1024 : 5 * 1024 * 1024;
    const prepared = record(claim, 'prepared.json'); if (prepared.version !== 1 || prepared.serializedHash !== sha(serialized)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
    const initial = intent.ancestors as Record<string, unknown>, segments = (intent.targetPath as string).split('/'), ancestry: { parent: number; name: string; child: number; expected: unknown }[] = [];
    let parent = frame.workspace.fd, relative = '';
    for (const name of segments.slice(0, -1)) {
      relative = relative ? relative + '/' + name : name;
      const recordName = 'parent-' + sha(relative) + '.json', prior = optional(claim, recordName);
      if (prior && (prior.path !== relative || Object.keys(prior).sort().join(',') !== 'identity,path')) return fail('MARKDOWN_CREATE_BIRTH_RECORD_CHANGED');
      let expected = initial[relative] || prior?.identity;
      if (!expected) { frame.fixedSourceWithinTurn?.(); assertWithinTurn(); backend.mkdirAt(parent, name, 0o755); syncFs.fsyncSync(parent); const born = directoryAt(parent, name);
        expected = syncDirectory(syncFs.fstatSync(born, { bigint: true })); writeRecord(claim, recordName, { path: relative, identity: expected }); ancestry.push({ parent, name, child: born, expected }); parent = born; }
      else { const child = directoryAt(parent, name); if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(child, { bigint: true })), expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
        ancestry.push({ parent, name, child, expected }); parent = child; }
    }
    const name = segments.at(-1)!; let target: { bytes: Buffer; info: BigIntStats } | null = null;
    const complete = optional(claim, 'completed.json'), settled = optional(claim, 'settled.json');
    try { target = read(parent, name, fileLimit, complete && settled ? 1 : 2, 0o644); }
    catch (error) { if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT') throw error; }
    if (target) {
      if (!fileMatches(target.info, prepared.file) || createHash('sha256').update(target.bytes).digest('hex') !== prepared.serializedHash) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      if (target.info.nlink === BigInt(1)) { if (!settled || !fileMatches(target.info, settled.file) || settled.ctimeNs !== target.info.ctimeNs.toString()) return fail('MARKDOWN_CREATE_BIRTH_RECOVERY_REQUIRED'); }
      else { const twin = read(claim, 'content.tmp', fileLimit, 2, 0o644); if (!fileMatches(twin.info, prepared.file) || twin.info.dev !== target.info.dev || twin.info.ino !== target.info.ino || !twin.bytes.equals(target.bytes)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED'); }
    } else {
      const staged = read(claim, 'content.tmp', fileLimit, 1, 0o644);
      if (!fileMatches(staged.info, prepared.file) || !staged.bytes.equals(Buffer.from(serialized))) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
      rootCurrent(); const expiresAt = sourceCurrent(intent); readStorePointer(frame);
      for (const ancestor of ancestry) { const named = directoryAt(ancestor.parent, ancestor.name); if (!isDeepStrictEqual(syncDirectory(syncFs.fstatSync(named, { bigint: true })), ancestor.expected)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED'); }
      assertWithinTurn();
      if (expiresAt !== null && Date.now() >= expiresAt) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_EXPIRED');
      // Every call in this final turn is synchronous and descriptor-bound.
      // The stopped preparation child has no target-write operation to resume.
      frame.fixedSourceWithinTurn?.();
      backend.linkAt(claim, 'content.tmp', parent, name); syncFs.fsyncSync(parent);
      const actual = read(parent, name, fileLimit, 2, 0o644); if (!fileMatches(actual.info, prepared.file) || !actual.bytes.equals(staged.bytes)) return fail('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
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
  beforeBoundary: () => Promise<void>, operation: (claim: MarkdownCreateBirthClaim) => Promise<T>,
  withStoragePhase?: MarkdownCreateBirthStoragePhase): Promise<T> {
  const captured = captureBirthInput(input);
  if (withStoragePhase !== undefined && (typeof withStoragePhase !== 'function'
    || captured.source.kind !== 'agent-markdown-v1')) return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
  let fixedSourceGuard: ((stage: string) => Promise<void>) | undefined, fixedSourceWithinTurn: (() => void) | undefined;
  if (Object.hasOwn(captured.source, 'kind')) {
    const context = await import('../collaboration/markdown-file-import-persistence');
    // This fixed validator checks a genuine private A lifetime and reserves
    // exactly this invocation before any store/claim initialization is possible.
    if (captured.source.kind === 'manual-empty-v1') {
      manualEmptyAttribution(captured);
      fixedSourceGuard = stage => context.assertAuthenticatedManualMarkdownBirthStorageAllowed(captured, stage);
      fixedSourceWithinTurn = () => context.assertAuthenticatedManualMarkdownBirthWithinTurn(captured);
    } else if (captured.source.kind === 'direct-mcp-markdown-v1') {
      directMcpMarkdownCreateAttribution(captured);
      fixedSourceGuard = stage => context.assertAuthenticatedDirectMcpMarkdownBirthStorageAllowed(captured, stage);
      fixedSourceWithinTurn = () => context.assertAuthenticatedDirectMcpMarkdownBirthWithinTurn(captured);
    } else if (captured.source.kind === 'agent-markdown-v1') {
      agentMarkdownCreateAttribution(captured);
      fixedSourceGuard = stage => context.assertAuthenticatedAgentMarkdownBirthStorageAllowed(captured, stage);
      fixedSourceWithinTurn = () => context.assertAuthenticatedAgentMarkdownBirthWithinTurn(captured);
    } else return fail('MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED');
    await fixedSourceGuard('entry');
  }
  const boundary = async (stage = 'boundary') => { await fixedSourceGuard?.(stage); await beforeBoundary(); };
  const configuredData = resolveCanvasDataRoot(), configuredWorkspace = captured.workspaceRoot;
  // Availability is established before the coordinator can perform native DML.
  const backend = getFdPublicationBackend();
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
      intent, active: true, backend, ...(fixedSourceWithinTurn ? { fixedSourceWithinTurn } : {}),
      ...(withStoragePhase ? { withStoragePhase } : {}) };
    frame = current;
    const first = await invoke(current, 'open', boundary); current.fingerprint = first.fingerprint;
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
      verify: () => run(() => invoke(current, 'verify', boundary)),
      publish: (serialized, boundary, assertWithinTurn) => run(async () => {
        const publicationBoundary = async (stage = 'boundary') => { await fixedSourceGuard?.(stage); await boundary(stage); };
        await invoke(current, 'prepare', publicationBoundary, { bytes: Buffer.from(serialized).toString('base64'), serializedHash: sha(serialized) });
        // invoke resolves only after the actual helper close and ACK drain.
        await inCollaborationProjectionPhase('birth_publish', async () => {
          await root(current); await publicationBoundary('parent_link');
          synchronousBirth(current, serialized, assertWithinTurn);
        });
        return invoke(current, 'observe', publicationBoundary);
      }),
      complete: (serializedHash, revisionId, completionBoundary) => run(async () => {
        await invoke(current, 'complete', async stage => { await fixedSourceGuard?.(stage ?? 'boundary'); await completionBoundary(stage); }, { serializedHash, revisionId });
      }),
    });
    try { value = await operation(claim); } catch (error) { errors.push(error); }
    accepting = false;
    const unfinished = pending.size > 0;
    const settlements = await Promise.allSettled([...pending]);
    if (unfinished) errors.push(new MarkdownCreateBirthError('MARKDOWN_CREATE_BIRTH_UNAWAITED_IO'));
    for (const settlement of settlements) if (settlement.status === 'rejected') errors.push(settlement.reason);
  } catch (error) { errors.push(error); }
  if (frame) { try { await root(frame); await boundary(); } catch (error) { errors.push(error); } }
  const close = async (handle: FileHandle) => {
    try { await handle.close(); } catch (error) {
      errors.push(error);
      // Keep the original descriptor and settle one transient pre-close fault.
      try { await handle.close(); } catch (retryError) { errors.push(retryError); }
    }
  };
  if (workspace) await close(workspace);
  await close(data);
  if (frame) { try { await named(frame); await boundary(); } catch (error) { errors.push(error); } frame.active = false; }
  try { await fixedSourceGuard?.('closed'); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'MARKDOWN_CREATE_BIRTH_CLOSURE_FAILED');
  return value as T;
}
