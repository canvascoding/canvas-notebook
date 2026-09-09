import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { normalizeDataScopeId, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { acquireKernelLock } from '@/app/lib/files/workspace-mutation-lock';

import {
  MAX_TOOL_OUTPUT_FILE_BYTES,
  MAX_TOOL_OUTPUT_SESSION_BYTES,
  TOOL_OUTPUT_POLICY_VERSION,
} from './tool-output-policy';

const STORAGE_DIRECTORY = 'tool-outputs';
const LOCK_DIRECTORY = '.locks';
const LOCK_WAIT_MS = 5_000;
const OUTPUT_FILE_PATTERN = /^output-[a-f0-9]{32}\.(?:txt|json)$/u;
const STORED_FILE_PATTERN = /^output-[a-f0-9]{32}\.(?:txt|json)(?:\.manifest\.json)?$/u;
const CALL_DIRECTORY_PATTERN = /^call-[a-f0-9]{64}$/u;
const TOOL_OUTPUT_REFERENCE_PATTERN = /^tool-output:\/\/(call-[a-f0-9]{64})\/(output-[a-f0-9]{32}\.(?:txt|json)(?:\.manifest\.json)?)$/u;

export type ToolOutputIdentity = {
  organizationId: string | null;
  userId: string;
  sessionId: string;
  workspaceId?: string;
};

export type ToolOutputSource = {
  url?: string;
  title?: string;
  provider?: string;
};

export type StoreToolOutputInput = {
  identity: ToolOutputIdentity;
  toolCallId: string;
  content: string;
  format: 'text' | 'json';
  source?: ToolOutputSource;
  complete?: boolean;
};

export type StoreToolOutputResult =
  | {
    ok: true;
    reference: string;
    manifestReference: string;
    bytes: number;
    sha256: string;
    characters: number;
    complete: boolean;
  }
  | { ok: false; error: string };

export type ToolOutputUsage = {
  bytes: number;
  files: number;
  directories: number;
};

type StoredManifest = {
  policyVersion: string;
  identity: Pick<ToolOutputIdentity, 'organizationId' | 'userId' | 'sessionId' | 'workspaceId'>;
  toolCallId: string;
  callDirectory: string;
  fileName: string;
  format: 'text' | 'json';
  source?: ToolOutputSource;
  storedAt: string;
  bytes: number;
  characters: number;
  sha256: string;
  complete: boolean;
};

type ParsedReference = { callDirectory: string; fileName: string };

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function runtimeUid(): number | undefined {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function validatePrivateDirectory(stats: Stats, label: string): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private.`);
  }
  const uid = runtimeUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${label} must be owned by the runtime user.`);
  }
}

function validatePrivateRegularFile(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} must be a private regular file.`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private.`);
  }
  const uid = runtimeUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${label} must be owned by the runtime user.`);
  }
}

function normalizedIdentity(identity: ToolOutputIdentity): ToolOutputIdentity {
  const organizationId = identity.organizationId === null
    ? null
    : normalizeDataScopeId(identity.organizationId, 'tool output organizationId');
  const userId = normalizeDataScopeId(identity.userId, 'tool output userId');
  const sessionId = normalizeDataScopeId(identity.sessionId, 'tool output sessionId');
  const workspaceId = identity.workspaceId === undefined
    ? undefined
    : normalizeDataScopeId(identity.workspaceId, 'tool output workspaceId');
  return { organizationId, userId, sessionId, ...(workspaceId === undefined ? {} : { workspaceId }) };
}

function callDirectoryFor(toolCallId: string): string {
  if (!toolCallId.trim()) throw new Error('A tool output call ID is required.');
  // Provider call IDs are opaque and can include arbitrary punctuation.  Hash
  // them before they become either a path segment or a portable reference.
  return `call-${createHash('sha256').update(toolCallId).digest('hex')}`;
}

function orgDirectory(identity: ToolOutputIdentity): string {
  return identity.organizationId === null ? 'org-none' : `org-id-${identity.organizationId}`;
}

/** The only root that parent path guards may allow for tool-output references. */
export function getToolOutputRoot(): string {
  return path.join(resolveCanvasDataRoot(), STORAGE_DIRECTORY);
}

export function getToolOutputSessionDirectory(identity: ToolOutputIdentity): string {
  const normalized = normalizedIdentity(identity);
  return path.join(getToolOutputRoot(), orgDirectory(normalized), `user-${normalized.userId}`, `session-${normalized.sessionId}`);
}

function getIdentityLockName(identity: ToolOutputIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash('sha256')
    .update(JSON.stringify([normalized.organizationId, normalized.userId, normalized.sessionId]))
    .digest('hex');
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const stats = await fs.lstat(directory);
  validatePrivateDirectory(stats, label);
}

async function ensureStorageRoot(): Promise<void> {
  const dataRoot = resolveCanvasDataRoot();
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataStats = await fs.lstat(dataRoot);
  if (!dataStats.isDirectory() || dataStats.isSymbolicLink()) {
    throw new Error('Canvas data root must be a non-symlink directory.');
  }
  await ensurePrivateDirectory(getToolOutputRoot(), 'Tool output root');
  await ensurePrivateDirectory(path.join(getToolOutputRoot(), LOCK_DIRECTORY), 'Tool output lock directory');
}

async function ensureSessionDirectory(identity: ToolOutputIdentity): Promise<string> {
  const normalized = normalizedIdentity(identity);
  await ensureStorageRoot();
  const org = path.join(getToolOutputRoot(), orgDirectory(normalized));
  const user = path.join(org, `user-${normalized.userId}`);
  const session = path.join(user, `session-${normalized.sessionId}`);
  await ensurePrivateDirectory(org, 'Tool output organization directory');
  await ensurePrivateDirectory(user, 'Tool output user directory');
  await ensurePrivateDirectory(session, 'Tool output session directory');
  return session;
}

async function inspectExistingSessionDirectory(identity: ToolOutputIdentity): Promise<string | null> {
  const normalized = normalizedIdentity(identity);
  const dataRoot = resolveCanvasDataRoot();
  let stats: Stats;
  try {
    stats = await fs.lstat(dataRoot);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Canvas data root must be a non-symlink directory.');

  const directories = [
    [getToolOutputRoot(), 'Tool output root'],
    [path.join(getToolOutputRoot(), orgDirectory(normalized)), 'Tool output organization directory'],
    [path.join(getToolOutputRoot(), orgDirectory(normalized), `user-${normalized.userId}`), 'Tool output user directory'],
    [getToolOutputSessionDirectory(normalized), 'Tool output session directory'],
  ] as const;
  for (const [directory, label] of directories) {
    try {
      stats = await fs.lstat(directory);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    validatePrivateDirectory(stats, label);
  }
  return getToolOutputSessionDirectory(normalized);
}

async function acquireSessionLock(identity: ToolOutputIdentity): Promise<() => Promise<void>> {
  await ensureStorageRoot();
  const lockPath = path.join(getToolOutputRoot(), LOCK_DIRECTORY, `${getIdentityLockName(identity)}.lock`);
  const deadline = performance.now() + LOCK_WAIT_MS;
  const handle = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    validatePrivateRegularFile(await handle.stat(), 'Tool output lockfile');
    await acquireKernelLock(handle, deadline);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return async () => {
    await handle.close();
  };
}

async function withSessionLock<T>(identity: ToolOutputIdentity, operation: () => Promise<T>): Promise<T> {
  const release = await acquireSessionLock(identity);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withSessionLocks<T>(identities: ToolOutputIdentity[], operation: () => Promise<T>): Promise<T> {
  const unique = [...new Map(identities.map((identity) => [getIdentityLockName(identity), identity])).values()]
    .sort((left, right) => getIdentityLockName(left).localeCompare(getIdentityLockName(right)));
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const identity of unique) releases.push(await acquireSessionLock(identity));
    return await operation();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

function parseReference(reference: string): ParsedReference {
  const match = TOOL_OUTPUT_REFERENCE_PATTERN.exec(reference);
  if (!match) throw new Error('Invalid tool output reference.');
  return { callDirectory: match[1], fileName: match[2] };
}

function referenceFor(callDirectory: string, fileName: string): string {
  return `tool-output://${callDirectory}/${fileName}`;
}

function manifestFileNameFor(fileName: string): string {
  if (!OUTPUT_FILE_PATTERN.test(fileName)) throw new Error('Invalid tool output filename.');
  return `${fileName}.manifest.json`;
}

function manifestIdentity(identity: ToolOutputIdentity): StoredManifest['identity'] {
  const normalized = normalizedIdentity(identity);
  return {
    organizationId: normalized.organizationId,
    userId: normalized.userId,
    sessionId: normalized.sessionId,
    ...(normalized.workspaceId === undefined ? {} : { workspaceId: normalized.workspaceId }),
  };
}

function manifestMatchesIdentity(manifest: StoredManifest, identity: ToolOutputIdentity): boolean {
  const expected = manifestIdentity(identity);
  return manifest.identity?.organizationId === expected.organizationId
    && manifest.identity?.userId === expected.userId
    && manifest.identity?.sessionId === expected.sessionId
    && manifest.identity?.workspaceId === expected.workspaceId;
}

async function assertSafeChildDirectory(parent: string, child: string, label: string): Promise<string> {
  const candidate = path.join(parent, child);
  if (path.dirname(candidate) !== parent) throw new Error('Tool output path escaped its session directory.');
  const stats = await fs.lstat(candidate);
  validatePrivateDirectory(stats, label);
  return candidate;
}

async function openSafeReadFile(filePath: string, label: string): Promise<FileHandle> {
  const before = await fs.lstat(filePath);
  validatePrivateRegularFile(before, label);
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    validatePrivateRegularFile(after, label);
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error(`${label} changed while being opened.`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readSafeFile(filePath: string, label: string): Promise<Buffer> {
  const handle = await openSafeReadFile(filePath, label);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeAtomicFile(directory: string, name: string, content: Buffer): Promise<void> {
  if (path.dirname(path.join(directory, name)) !== directory) throw new Error('Tool output filename escaped its call directory.');
  const temporaryName = `.${name}.${randomBytes(16).toString('hex')}.tmp`;
  const temporaryPath = path.join(directory, temporaryName);
  const targetPath = path.join(directory, name);
  const handle = await fs.open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function inspectDirectoryUsage(directory: string): Promise<ToolOutputUsage> {
  const usage: ToolOutputUsage = { bytes: 0, files: 0, directories: 0 };
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink()) throw new Error('Tool output storage contains a symbolic link.');
      if (stats.isDirectory()) {
        validatePrivateDirectory(stats, 'Tool output directory');
        usage.directories += 1;
        pending.push(entryPath);
      } else {
        validatePrivateRegularFile(stats, 'Tool output file');
        usage.files += 1;
        usage.bytes += stats.size;
      }
    }
  }
  return usage;
}

export async function inspectToolOutputUsage(identity: ToolOutputIdentity): Promise<ToolOutputUsage> {
  const sessionDirectory = await inspectExistingSessionDirectory(identity);
  return sessionDirectory ? inspectDirectoryUsage(sessionDirectory) : { bytes: 0, files: 0, directories: 0 };
}

export async function resolveToolOutputReference(identity: ToolOutputIdentity, reference: string): Promise<string> {
  const sessionDirectory = await inspectExistingSessionDirectory(identity);
  if (!sessionDirectory) throw new Error('Tool output reference was not found for this session.');
  const { callDirectory: callDirectoryName, fileName } = parseReference(reference);
  if (!CALL_DIRECTORY_PATTERN.test(callDirectoryName)) throw new Error('Invalid tool output call directory.');
  const callDirectory = await assertSafeChildDirectory(
    sessionDirectory,
    callDirectoryName,
    'Tool output call directory',
  ).catch((error: unknown) => {
    if (isNotFound(error)) throw new Error('Tool output reference was not found for this session.');
    throw error;
  });
  if (!STORED_FILE_PATTERN.test(fileName)) throw new Error('Invalid tool output filename.');
  const filePath = path.join(callDirectory, fileName);
  if (path.dirname(filePath) !== callDirectory) throw new Error('Tool output path escaped its call directory.');
  const stats = await fs.lstat(filePath).catch((error: unknown) => {
    if (isNotFound(error)) throw new Error('Tool output reference was not found for this session.');
    throw error;
  });
  validatePrivateRegularFile(stats, 'Tool output file');
  const manifestPath = fileName.endsWith('.manifest.json')
    ? filePath
    : path.join(callDirectory, manifestFileNameFor(fileName));
  let manifest: StoredManifest;
  try {
    manifest = JSON.parse((await readSafeFile(manifestPath, 'Tool output manifest')).toString('utf8')) as StoredManifest;
  } catch {
    throw new Error('Tool output reference has an invalid manifest.');
  }
  if (!manifestMatchesIdentity(manifest, identity)) throw new Error('Tool output reference was not found for this session.');
  return filePath;
}

export async function readStoredToolOutput(
  identity: ToolOutputIdentity,
  reference: string,
): Promise<{ content: string; sha256: string; bytes: number }> {
  const filePath = await resolveToolOutputReference(identity, reference);
  const data = await readSafeFile(filePath, 'Tool output file');
  return {
    content: data.toString('utf8'),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
  };
}

function validSource(source: ToolOutputSource | undefined): ToolOutputSource | undefined {
  if (!source) return undefined;
  const result: ToolOutputSource = {};
  for (const key of ['url', 'title', 'provider'] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string') throw new Error(`Tool output source ${key} must be a string.`);
      result[key] = source[key];
    }
  }
  return result;
}

export async function storeToolOutput(input: StoreToolOutputInput): Promise<StoreToolOutputResult> {
  try {
    if (typeof input.content !== 'string') throw new Error('Tool output content must be a string.');
    const identity = normalizedIdentity(input.identity);
    const toolCallId = input.toolCallId;
    const callDirectoryName = callDirectoryFor(toolCallId);
    if (input.format !== 'text' && input.format !== 'json') throw new Error('Tool output format must be text or json.');
    if (input.format === 'json') JSON.parse(input.content);
    const content = Buffer.from(input.content, 'utf8');
    if (content.byteLength > MAX_TOOL_OUTPUT_FILE_BYTES) {
      return { ok: false, error: `Tool output exceeds the ${MAX_TOOL_OUTPUT_FILE_BYTES}-byte per-file limit and was not stored.` };
    }
    const complete = input.complete ?? true;
    const source = validSource(input.source);
    return await withSessionLock(identity, async () => {
      const sessionDirectory = await ensureSessionDirectory(identity);
      const callDirectory = path.join(sessionDirectory, callDirectoryName);
      let createdCallDirectory = false;
      try {
        await fs.mkdir(callDirectory, { mode: 0o700 });
        createdCallDirectory = true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          const stats = await fs.lstat(callDirectory);
          validatePrivateDirectory(stats, 'Tool output call directory');
        } else {
          throw error;
        }
      }
      let fileName: string | undefined;
      try {
        fileName = `output-${randomBytes(16).toString('hex')}.${input.format === 'json' ? 'json' : 'txt'}`;
        const sha256 = createHash('sha256').update(content).digest('hex');
        const manifest: StoredManifest = {
          policyVersion: TOOL_OUTPUT_POLICY_VERSION,
          identity: manifestIdentity(identity),
          toolCallId,
          callDirectory: callDirectoryName,
          fileName,
          format: input.format,
          ...(source ? { source } : {}),
          storedAt: new Date().toISOString(),
          bytes: content.byteLength,
          characters: input.content.length,
          sha256,
          complete,
        };
        const manifestName = manifestFileNameFor(fileName);
        const manifestContent = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
        if (manifestContent.byteLength > MAX_TOOL_OUTPUT_FILE_BYTES) {
          throw new Error('Tool output manifest exceeds the per-file limit and was not stored.');
        }
        const usage = await inspectDirectoryUsage(sessionDirectory);
        if (usage.bytes + content.byteLength + manifestContent.byteLength > MAX_TOOL_OUTPUT_SESSION_BYTES) {
          throw new Error(`Tool output session quota exceeded: storing this result would exceed the ${MAX_TOOL_OUTPUT_SESSION_BYTES}-byte limit.`);
        }
        await writeAtomicFile(callDirectory, fileName, content);
        await writeAtomicFile(callDirectory, manifestName, manifestContent);
        const storedContent = await readSafeFile(path.join(callDirectory, fileName), 'Tool output file');
        const storedManifest = await readSafeFile(path.join(callDirectory, manifestName), 'Tool output manifest');
        if (!storedContent.equals(content) || !storedManifest.equals(manifestContent)) {
          throw new Error('Tool output verification failed.');
        }
        const actualUsage = await inspectDirectoryUsage(sessionDirectory);
        if (actualUsage.bytes > MAX_TOOL_OUTPUT_SESSION_BYTES) {
          throw new Error(`Tool output session quota exceeded: stored data exceeds the ${MAX_TOOL_OUTPUT_SESSION_BYTES}-byte limit.`);
        }
        return {
          ok: true,
          reference: referenceFor(callDirectoryName, fileName),
          manifestReference: referenceFor(callDirectoryName, manifestName),
          bytes: content.byteLength,
          sha256,
          characters: input.content.length,
          complete,
        };
      } catch (error) {
        if (fileName) {
          await fs.unlink(path.join(callDirectory, fileName)).catch(() => undefined);
          await fs.unlink(path.join(callDirectory, manifestFileNameFor(fileName))).catch(() => undefined);
        }
        if (createdCallDirectory) await fs.rmdir(callDirectory).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Tool output session quota exceeded:') || message.startsWith('Tool output manifest exceeds')) return { ok: false, error: message };
    if (message.startsWith('Tool output content') || message.startsWith('Tool output format') || message.startsWith('A tool output call ID')) {
      return { ok: false, error: message };
    }
    return { ok: false, error: 'Tool output could not be stored safely.' };
  }
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const sourceStats = await fs.lstat(source);
  validatePrivateDirectory(sourceStats, 'Tool output source directory');
  await ensurePrivateDirectory(target, 'Tool output clone directory');
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink()) throw new Error('Tool output storage contains a symbolic link.');
    if (stats.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else {
      validatePrivateRegularFile(stats, 'Tool output source file');
      await writeAtomicFile(target, entry.name, await readSafeFile(sourcePath, 'Tool output source file'));
    }
  }
}

async function rebindManifestIdentities(directory: string, identity: ToolOutputIdentity): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) throw new Error('Tool output storage contains a symbolic link.');
    if (stats.isDirectory()) {
      validatePrivateDirectory(stats, 'Tool output clone directory');
      await rebindManifestIdentities(entryPath, identity);
      continue;
    }
    validatePrivateRegularFile(stats, 'Tool output clone file');
    if (!entry.name.endsWith('.manifest.json')) continue;
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse((await readSafeFile(entryPath, 'Tool output clone manifest')).toString('utf8')) as StoredManifest;
    } catch {
      throw new Error('Tool output clone contains an invalid manifest.');
    }
    manifest.identity = manifestIdentity(identity);
    await writeAtomicFile(directory, entry.name, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
  }
}

async function removeDirectoryContents(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stats = await fs.lstat(child);
    if (stats.isSymbolicLink()) throw new Error('Tool output storage contains a symbolic link.');
    if (stats.isDirectory()) {
      validatePrivateDirectory(stats, 'Tool output directory');
      await removeDirectoryContents(child);
      await fs.rmdir(child);
    } else {
      validatePrivateRegularFile(stats, 'Tool output file');
      await fs.unlink(child);
    }
  }
}

export async function cloneToolOutputs(
  sourceIdentity: ToolOutputIdentity,
  targetIdentity: ToolOutputIdentity,
  options: { references?: readonly string[] } = {},
): Promise<void> {
  const source = normalizedIdentity(sourceIdentity);
  const target = normalizedIdentity(targetIdentity);
  if (getIdentityLockName(source) === getIdentityLockName(target)) {
    throw new Error('Tool output clone source and target must be different sessions.');
  }
  await withSessionLocks([source, target], async () => {
    const sourceDirectory = await inspectExistingSessionDirectory(source);
    if (!sourceDirectory) {
      if (options.references?.length) throw new Error('Requested tool output references were not found for the source session.');
      return;
    }
    const targetDirectory = await inspectExistingSessionDirectory(target);
    if (targetDirectory) throw new Error('Tool output clone target already exists.');

    const references = options.references === undefined
      ? undefined
      : [...new Map(options.references.map((reference) => {
        const parsed = parseReference(reference);
        if (!CALL_DIRECTORY_PATTERN.test(parsed.callDirectory) || !STORED_FILE_PATTERN.test(parsed.fileName)) {
          throw new Error('Invalid tool output reference.');
        }
        return [`${parsed.callDirectory}/${parsed.fileName}`, parsed] as const;
      })).values()];
    if (references?.length === 0) return;

    const targetParent = path.dirname(getToolOutputSessionDirectory(target));
    await ensureStorageRoot();
    await ensurePrivateDirectory(path.dirname(targetParent), 'Tool output clone organization directory');
    await ensurePrivateDirectory(targetParent, 'Tool output clone user directory');
    const staging = path.join(targetParent, `.session-clone-${randomBytes(16).toString('hex')}`);
    try {
      if (references === undefined) {
        await copyDirectory(sourceDirectory, staging);
      } else {
        await ensurePrivateDirectory(staging, 'Tool output clone staging directory');
        const copied = new Set<string>();
        for (const reference of references) {
          const sourceCallDirectory = await assertSafeChildDirectory(
            sourceDirectory,
            reference.callDirectory,
            'Tool output call directory',
          );
          const targetCallDirectory = path.join(staging, reference.callDirectory);
          await ensurePrivateDirectory(targetCallDirectory, 'Tool output clone call directory');
          const outputName = reference.fileName.endsWith('.manifest.json')
            ? reference.fileName.slice(0, -'.manifest.json'.length)
            : reference.fileName;
          const names = [outputName, manifestFileNameFor(outputName)];
          for (const name of names) {
            const copyKey = `${reference.callDirectory}/${name}`;
            if (copied.has(copyKey)) continue;
            const sourceFile = path.join(sourceCallDirectory, name);
            const stats = await fs.lstat(sourceFile);
            validatePrivateRegularFile(stats, 'Tool output source file');
            await writeAtomicFile(targetCallDirectory, name, await readSafeFile(sourceFile, 'Tool output source file'));
            copied.add(copyKey);
          }
        }
      }
      await rebindManifestIdentities(staging, target);
      const usage = await inspectDirectoryUsage(staging);
      if (usage.bytes > MAX_TOOL_OUTPUT_SESSION_BYTES) throw new Error('Tool output clone exceeds the session quota.');
      await fs.rename(staging, getToolOutputSessionDirectory(target));
    } catch (error) {
      const stagingStats = await fs.lstat(staging).catch((statError: unknown) => {
        if (isNotFound(statError)) return null;
        throw statError;
      });
      if (stagingStats) {
        validatePrivateDirectory(stagingStats, 'Tool output clone staging directory');
        await removeDirectoryContents(staging);
        await fs.rmdir(staging);
      }
      throw error;
    }
  });
}

export async function deleteToolOutputs(identity: ToolOutputIdentity): Promise<void> {
  const normalized = normalizedIdentity(identity);
  await withSessionLock(normalized, async () => {
    const sessionDirectory = await inspectExistingSessionDirectory(normalized);
    if (!sessionDirectory) return;
    await removeDirectoryContents(sessionDirectory);
    await fs.rmdir(sessionDirectory);
  });
}

/**
 * Lists only private session directories owned by a user/org scope.  Callers
 * use this to compare with their database-backed session list; this store
 * deliberately has no database dependency or autonomous orphan cleanup.
 */
export async function listToolOutputSessionsForOwner(
  owner: Pick<ToolOutputIdentity, 'organizationId' | 'userId'>,
): Promise<Array<{ identity: ToolOutputIdentity; modifiedAt: number }>> {
  const normalized = normalizedIdentity({ ...owner, sessionId: 'listing-placeholder' });
  const dataRoot = resolveCanvasDataRoot();
  const organizationDirectory = path.join(getToolOutputRoot(), orgDirectory(normalized));
  const userDirectory = path.join(getToolOutputRoot(), orgDirectory(normalized), `user-${normalized.userId}`);
  try {
    const dataStats = await fs.lstat(dataRoot);
    if (!dataStats.isDirectory() || dataStats.isSymbolicLink()) throw new Error('Canvas data root must be a non-symlink directory.');
    validatePrivateDirectory(await fs.lstat(getToolOutputRoot()), 'Tool output root');
    validatePrivateDirectory(await fs.lstat(organizationDirectory), 'Tool output organization directory');
    const userStats = await fs.lstat(userDirectory);
    validatePrivateDirectory(userStats, 'Tool output user directory');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const sessions: Array<{ identity: ToolOutputIdentity; modifiedAt: number }> = [];
  for (const entry of await fs.readdir(userDirectory, { withFileTypes: true })) {
    if (!entry.name.startsWith('session-')) continue;
    const sessionId = entry.name.slice('session-'.length);
    let normalizedSessionId: string;
    try {
      normalizedSessionId = normalizeDataScopeId(sessionId, 'tool output sessionId');
    } catch {
      throw new Error('Tool output user directory contains an invalid session directory.');
    }
    const sessionPath = path.join(userDirectory, entry.name);
    const stats = await fs.lstat(sessionPath);
    validatePrivateDirectory(stats, 'Tool output session directory');
    sessions.push({
      identity: { organizationId: normalized.organizationId, userId: normalized.userId, sessionId: normalizedSessionId },
      modifiedAt: stats.mtimeMs,
    });
  }
  return sessions;
}
