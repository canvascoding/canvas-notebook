import {
  createReadStream as createLocalReadStream,
  createWriteStream as createLocalWriteStream,
  promises as fs,
  accessSync,
  constants,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import type { BigIntStats } from 'fs';
import os from 'os';
import path from 'path';
import {Readable} from 'stream';
import { pipeline } from 'stream/promises';
import type { FileNode } from '@/app/lib/files/types';
import { createLegacyPersonalWorkspaceContext, resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import {
  ensureWorkspaceRoot,
  resolveDirectoryCreationPath as resolveDirectoryCreationPathForContext,
  resolveExistingWorkspacePath as resolveExistingWorkspacePathForContext,
  resolveWritableWorkspacePath as resolveWritableWorkspacePathForContext,
  resolveWorkspacePath,
  normalizeWorkspaceRelativePath,
  assertWorkspacePathHasNoAliases,
  WorkspacePathAliasError,
} from '@/app/lib/workspaces/path-guard';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { AsyncSemaphore } from '@/app/lib/utils/async-semaphore';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { withWorkspaceFileLifecycleGuards } from '@/app/lib/files/workspace-file-lifecycle-guard';
import { assertOfficePublicationAllowed } from '@/app/lib/office/publication-context';
import { assertExcalidrawPublicationAllowed, ExcalidrawPublicationRequiredError } from '@/app/lib/excalidraw-collaboration/publication-context';
import { filesystemFileVersion } from './file-version';
import { isInternalWorkspaceStagingPath } from '@/app/lib/files/internal-staging-path';
import type { WorkspaceNativeCopyDependencies } from '@/app/lib/collaboration/workspace-native-copy';

export type { FileNode } from '@/app/lib/files/types';

export interface WorkspaceFileOperationOptions {
  workspace?: WorkspaceContext;
  includeMetadata?: boolean;
  /** Fail the listing if any visible child's metadata cannot be inspected. */
  strictMetadata?: boolean;
  includeSymlinks?: boolean;
  mutationActorUserId?: string;
  mutationActorSessionId?: string;
  /** Stable private operation binding supplied by the existing file-operation journal. */
  mutationOperationId?: string;
}

/** Opaque, process-local proof of the inode published by one exclusive write. */
export type WorkspaceExclusiveFilePublication = Readonly<object>;
const exclusivePublications = new WeakMap<WorkspaceExclusiveFilePublication, {
  filePath: string; fullPath: string; options?: WorkspaceFileOperationOptions;
  device: number; inode: number; sha256: string; active: boolean;
}>();

function getDataDir(): string {
  return resolveWorkspaceDataRoot();
}

function getWorkspace(options?: WorkspaceFileOperationOptions): WorkspaceContext {
  return options?.workspace ?? createLegacyPersonalWorkspaceContext();
}

/** Shared filesystem primitives never grant scene publication from request options. */
async function assertWorkspaceExcalidrawPublicationAllowed(
  filePath: string, options: WorkspaceFileOperationOptions | undefined, kind: 'create' | 'replace',
): Promise<void> {
  const workspace = getWorkspace(options);
  const resolved = resolveWorkspacePath(workspace, filePath);
  let actualPath: string | null = null;
  try { actualPath = await fs.realpath(resolved.absolutePath); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (!resolved.relativePath.toLowerCase().endsWith('.excalidraw') && !actualPath?.toLowerCase().endsWith('.excalidraw')) return;
  await assertWorkspacePathHasNoAliases(workspace, resolved.relativePath);
  assertExcalidrawPublicationAllowed(workspace.workspaceId, resolved.relativePath, kind);
  if (actualPath) {
    const realRoot = await fs.realpath(workspace.rootPath);
    const actualRelativePath = path.relative(realRoot, actualPath).split(path.sep).join('/');
    assertExcalidrawPublicationAllowed(workspace.workspaceId, actualRelativePath, kind);
  }
}

async function assertNoActiveRawCopyPath(workspace: WorkspaceContext, relativePath: string, absolutePath: string,
  controlledPaths: ReadonlySet<string> = new Set()): Promise<void> {
  const stats = await fs.lstat(absolutePath);
  if (stats.isSymbolicLink() || !stats.isDirectory() && !stats.isFile()) {
    throw Object.assign(new Error('Special-file destinations cannot be overwritten safely.'),
      { status: 409, code: 'UNSAFE_OVERWRITE_DESTINATION' });
  }
  if (stats.isDirectory()) {
    for (const child of await fs.readdir(absolutePath)) {
      await assertNoActiveRawCopyPath(workspace, path.posix.join(relativePath, child), path.join(absolutePath, child), controlledPaths);
    }
    return;
  }
  if (controlledPaths.has(relativePath)) return;
  const { detectFileCollaborationStrategy, readFileCollaborationState } = await import('@/app/lib/files/collaboration-policy');
  const strategy = detectFileCollaborationStrategy(relativePath);
  if (strategy !== 'crdt_text' && strategy !== 'excalidraw_scene') return;
  const state = await readFileCollaborationState({ workspace, path: relativePath });
  if (state.document) {
    throw Object.assign(new Error(`Active collaborative file cannot be copied through raw file operations: ${relativePath}`),
      { status: 409, code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });
  }
}

/** Only Office files and directory scopes require the Office lease repository. */
export async function assertWorkspaceOfficePathMutationAllowed(
  filePaths: readonly string[],
  options?: WorkspaceFileOperationOptions,
): Promise<void> {
  const workspace = getWorkspace(options);
  const scopes: string[] = [];
  for (const filePath of filePaths) {
    const resolution = resolveWorkspacePath(workspace, filePath);
    const normalizedPath = resolution.relativePath;
    if (normalizedPath.toLowerCase().endsWith('.docx') || !path.posix.extname(normalizedPath)) {
      scopes.push(normalizedPath);
      continue;
    }
    try {
      const actualPath = await resolveExistingWorkspacePath(normalizedPath, options);
      if ((await fs.stat(actualPath)).isDirectory() || actualPath.toLowerCase().endsWith('.docx')) scopes.push(normalizedPath);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  if (scopes.length) {
    const { assertNoActiveOfficeLeases } = await import('@/app/lib/files/collaboration-policy');
    await assertNoActiveOfficeLeases(workspace, scopes);
  }
}

const IGNORED_WORKSPACE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.canvas-brand', '.canvas-copy-backups']);
const CANVAS_SKILL_DRAFTS_DIR = '.canvas-skill-drafts';
const HIDDEN_WORKSPACE_METADATA_FILES = new Set(['.gitkeep', '.keep']);
const FILE_METADATA_CONCURRENCY = 32;
const FILE_TREE_DIRECTORY_CONCURRENCY = 16;
export async function withWorkspaceFileMutationLock<T>(
  filePath: string,
  options: WorkspaceFileOperationOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFileMutationLocks([filePath], options, operation);
}

export async function withWorkspaceFileMutationLocks<T>(
  filePaths: readonly string[],
  options: WorkspaceFileOperationOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  // All path hierarchies previously included the workspace root. Preserve that
  // ordering while extending exclusion across runtime processes and nested calls.
  void filePaths;
  return withWorkspaceMutationLock(getWorkspace(options).workspaceId, operation);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

export function validatePath(userPath: string, options?: WorkspaceFileOperationOptions): string {
  return resolveWorkspacePath(getWorkspace(options), userPath).absolutePath;
}

async function getWorkspaceRealBase(options?: WorkspaceFileOperationOptions): Promise<string> {
  return ensureWorkspaceRoot(getWorkspace(options));
}

export async function resolveExistingWorkspacePath(
  userPath: string,
  options?: WorkspaceFileOperationOptions
): Promise<string> {
  return resolveExistingWorkspacePathForContext(getWorkspace(options), userPath);
}

async function resolveWritableWorkspacePath(
  userPath: string,
  options?: WorkspaceFileOperationOptions
): Promise<string> {
  return resolveWritableWorkspacePathForContext(getWorkspace(options), userPath);
}

async function resolveDirectoryCreationPath(
  userPath: string,
  options?: WorkspaceFileOperationOptions
): Promise<string> {
  return resolveDirectoryCreationPathForContext(getWorkspace(options), userPath);
}

export async function listDirectory(
  dirPath: string = '.',
  options?: WorkspaceFileOperationOptions
): Promise<FileNode[]> {
  const fullPath = await resolveExistingWorkspacePath(dirPath, options);
  const entries = await fs.readdir(fullPath, {withFileTypes: true});
  const includeMetadata = options?.includeMetadata ?? true;
  const workspaceRoot = await fs.realpath(getWorkspace(options).rootPath).catch(() => path.resolve(getWorkspace(options).rootPath));
  const isWorkspaceRoot = fullPath === workspaceRoot;

  const visibleEntries = entries.filter((entry) => {
    if (isWorkspaceRoot && entry.isDirectory() && entry.name === CANVAS_SKILL_DRAFTS_DIR) {
      return false;
    }
    if (options?.includeSymlinks === false && entry.isSymbolicLink()) {
      return false;
    }
    if (entry.isDirectory()) {
      return !IGNORED_WORKSPACE_DIRS.has(entry.name);
    }
    return !HIDDEN_WORKSPACE_METADATA_FILES.has(entry.name) && !isInternalWorkspaceStagingPath(entry.name);
  });
  const toNode = (entry: import('fs').Dirent): FileNode => ({
    name: entry.name,
    path: dirPath === '.' ? entry.name : path.posix.join(dirPath, entry.name),
    type: entry.isDirectory() ? 'directory' : 'file',
  });

  if (!includeMetadata) {
    return visibleEntries.map(toNode);
  }

  const nodes = await mapWithConcurrency<import('fs').Dirent, FileNode | null>(
    visibleEntries,
    FILE_METADATA_CONCURRENCY,
    async (entry) => {
    const node = toNode(entry);
    const entryPath = path.join(fullPath, entry.name);
    const stats = options?.strictMetadata ? await fs.stat(entryPath) : await safeStat(entryPath);
    if (!stats) return null;

    return {
      ...node,
      size: stats.size,
      modified: Math.floor(stats.mtimeMs / 1000),
      created: stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs / 1000) : undefined,
      permissions: stats.mode?.toString(8),
    };
    },
  );
  return nodes.filter((node): node is FileNode => node !== null);
}

export async function readFile(filePath: string, options?: WorkspaceFileOperationOptions): Promise<Buffer> {
  const fullPath = await resolveExistingWorkspacePath(filePath, options);
  return fs.readFile(fullPath);
}

export async function readDataFile(filePath: string): Promise<Buffer> {
  const fullPath = path.resolve(/*turbopackIgnore: true*/ getDataDir(), filePath);
  return fs.readFile(fullPath);
}

export async function getDataFileStats(filePath: string) {
  const fullPath = path.resolve(/*turbopackIgnore: true*/ getDataDir(), filePath);
  const stats = await fs.stat(fullPath);

  let totalSize = stats.size;
  if (stats.isDirectory()) {
    totalSize = await calculateDirectorySize(fullPath);
  }

  return {
    size: totalSize,
    modified: Math.floor(stats.mtimeMs / 1000),
    created: stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs / 1000) : undefined,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode?.toString(8),
  };
}

export async function createReadStream(
  filePath: string,
  options?: {start?: number; end?: number; highWaterMark?: number},
  workspaceOptions?: WorkspaceFileOperationOptions
): Promise<{stream: Readable; close: () => Promise<void>}> {
  const fullPath = await resolveExistingWorkspacePath(filePath, workspaceOptions);
  return {
    stream: createLocalReadStream(fullPath, options) as unknown as Readable,
    close: async () => {},
  };
}

export async function writeFile(
  filePath: string,
  content: Buffer | string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
  onStaged?: (identity: { dev: string; ino: string }) => Promise<void>,
): Promise<void> {
  return withWorkspaceFileMutationLock(
    filePath,
    options,
    () => writeFileUnlocked(filePath, content, options, onBeforeReplace, onStaged),
  );
}

async function writeFileUnlocked(
  filePath: string,
  content: Buffer | string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
  onStaged?: (identity: { dev: string; ino: string }) => Promise<void>,
): Promise<void> {
  assertOfficePublicationAllowed(getWorkspace(options).workspaceId, filePath);
  await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'replace');
  const fullPath = await resolveWritableWorkspacePath(filePath, options);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const stagingPath = `${fullPath}.canvas-write-${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    let mode = 0o666;
    try {
      mode = (await fs.stat(fullPath)).mode & 0o777;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }

    handle = await fs.open(stagingPath, 'wx', mode);
    await handle.writeFile(buffer);
    await handle.sync();
    if (onStaged) {
      const identity = await handle.stat({ bigint: true });
      await onStaged({ dev: String(identity.dev), ino: String(identity.ino) });
    }
    await handle.close();
    handle = null;
    await onBeforeReplace?.();
    await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'replace');
    await fs.rename(stagingPath, fullPath);

    const directoryHandle = await fs.open(path.dirname(fullPath), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

export async function replaceWorkspaceFileFromPath(
  sourcePath: string,
  filePath: string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
): Promise<void> {
  return withWorkspaceFileMutationLock(
    filePath,
    options,
    () => replaceWorkspaceFileFromPathUnlocked(sourcePath, filePath, options, onBeforeReplace),
  );
}

async function replaceWorkspaceFileFromPathUnlocked(
  sourcePath: string,
  filePath: string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
): Promise<void> {
  assertOfficePublicationAllowed(getWorkspace(options).workspaceId, filePath);
  await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'replace');
  const sourceStats = await fs.stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error('Upload source must be a file.');
  }

  const parentDir = path.posix.dirname(filePath);
  if (parentDir !== '.' && parentDir !== '/') {
    await createWorkspaceFileParentDirectory(filePath, options);
  }
  const fullPath = await resolveWritableWorkspacePath(filePath, options);
  const stagingPath = `${fullPath}.canvas-upload-${randomUUID()}.tmp`;
  try {
    try {
      await fs.link(sourcePath, stagingPath);
    } catch (error) {
      const canCopy = Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(String(error.code)),
      );
      if (!canCopy) throw error;
      await pipeline(
        createLocalReadStream(sourcePath),
        createLocalWriteStream(stagingPath, { flags: 'wx', mode: 0o644 }),
      );
    }
    await onBeforeReplace?.();
    await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'replace');
    await fs.rename(stagingPath, fullPath);
    await fs.chmod(fullPath, 0o644);
  } finally {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Creates a new workspace file without ever replacing an existing path.
 *
 * This is used for multi-file imports where a concurrent write must not turn
 * a preflight collision check into an accidental overwrite.
 */
export async function writeFileIfAbsent(
  filePath: string,
  content: Buffer | string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
  onStaged?: (identity: { dev: string; ino: string }) => Promise<void>,
  onPublished?: (publication: WorkspaceExclusiveFilePublication) => void,
): Promise<void> {
  return withWorkspaceFileMutationLock(filePath, options, async () => {
    assertOfficePublicationAllowed(getWorkspace(options).workspaceId, filePath);
    await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'create');
    const fullPath = await resolveWritableWorkspacePath(filePath, options);
    const stagingPath = `${fullPath}.canvas-create-${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(stagingPath, 'wx', 0o666);
      await handle.writeFile(content);
      await handle.sync();
      const publishedInode = await handle.stat();
      if (onStaged) {
        const identity = await handle.stat({ bigint: true });
        await onStaged({ dev: String(identity.dev), ino: String(identity.ino) });
      }
      await handle.close();
      handle = null;
      await onBeforeReplace?.();
      await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'create');
      // link() publishes the complete inode atomically and rejects EEXIST.
      // rename() would silently replace a concurrent creator's file.
      await fs.link(stagingPath, fullPath);
      if (onPublished) {
        const publication = Object.freeze({});
        exclusivePublications.set(publication, { filePath, fullPath, options: options ? structuredClone(options) : undefined,
          device: publishedInode.dev, inode: publishedInode.ino,
          sha256: createHash('sha256').update(content).digest('hex'), active: true });
        onPublished(publication);
      }
      const directoryHandle = await fs.open(path.dirname(fullPath), 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    }
  });
}

/** Compensation retains peer-created or replaced files, even with identical bytes. */
export async function rollbackWorkspaceExclusiveFilePublication(
  publication: WorkspaceExclusiveFilePublication,
  onBeforeRemove: () => Promise<void>,
): Promise<void> {
  const claim = exclusivePublications.get(publication);
  if (!claim) throw new Error('An attributable exclusive publication is required.');
  if (!claim.active) return;
  await withWorkspaceFileMutationLock(claim.filePath, claim.options, async () => {
    const filename = await resolveWritableWorkspacePath(claim.filePath, claim.options);
    if (filename !== claim.fullPath) throw new Error('Exclusive publication path changed before compensation.');
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        claim.active = false; return;
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== claim.device || before.ino !== claim.inode || before.nlink !== 1) {
        throw new Error('Exclusive publication compensation refused a different file inode.');
      }
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      if (hash.digest('hex') !== claim.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) throw new Error('Exclusive publication changed before compensation.');
      await onBeforeRemove();
      const current = await fs.lstat(filename);
      if (current.dev !== claim.device || current.ino !== claim.inode || current.nlink !== 1
        || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
        throw new Error('Exclusive publication changed before compensation removal.');
      }
      await fs.unlink(filename);
      const parent = await fs.open(path.dirname(filename), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      claim.active = false;
    } finally { await handle.close(); }
  });
}

export async function writeWorkspaceFileFromPathIfAbsent(
  sourcePath: string,
  filePath: string,
  options?: WorkspaceFileOperationOptions,
): Promise<void> {
  return withWorkspaceFileMutationLock(filePath, options, async () => {
    assertOfficePublicationAllowed(getWorkspace(options).workspaceId, filePath);
    await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'create');
    const sourceStats = await fs.stat(sourcePath);
    if (!sourceStats.isFile()) throw new Error('Upload source must be a file.');
    const parentDir = path.posix.dirname(filePath);
    if (parentDir !== '.' && parentDir !== '/') await createWorkspaceFileParentDirectory(filePath, options);
    const fullPath = await resolveWritableWorkspacePath(filePath, options);
    const stagingPath = `${fullPath}.canvas-upload-create-${randomUUID()}.tmp`;
    try {
      try {
        await fs.link(sourcePath, stagingPath);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw error;
        const canCopy = Boolean(error && typeof error === 'object' && 'code' in error
          && ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(String(error.code)));
        if (!canCopy) throw error;
        await pipeline(createLocalReadStream(sourcePath), createLocalWriteStream(stagingPath, { flags: 'wx', mode: 0o644 }));
      }
      await fs.chmod(stagingPath, 0o644);
      await assertWorkspaceExcalidrawPublicationAllowed(filePath, options, 'create');
      await fs.link(stagingPath, fullPath);
    } finally { await fs.rm(stagingPath, { force: true }).catch(() => undefined); }
  });
}

export async function writeDataFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = path.resolve(/*turbopackIgnore: true*/ getDataDir(), filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
}

export async function createDirectory(dirPath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  const fullPath = await resolveDirectoryCreationPath(dirPath, options);
  await createResolvedWorkspaceDirectory(fullPath, options);
}

/** Resolve the complete file identity before deriving its parent. Normalizing
 * the dirname separately would lose whitespace from literal Markdown paths. */
export async function createWorkspaceFileParentDirectory(filePath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  if (normalizeWorkspaceRelativePath(filePath) === '.') {
    throw new Error('A workspace file path is required to create its parent directory.');
  }
  const fullPath = await resolveDirectoryCreationPath(filePath, options);
  await createResolvedWorkspaceDirectory(path.dirname(fullPath), options);
}

async function createResolvedWorkspaceDirectory(fullPath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  await fs.mkdir(fullPath, {recursive: true});

  const realBase = await getWorkspaceRealBase(options);
  const realCreatedPath = await fs.realpath(fullPath);
  if (realCreatedPath !== realBase && !realCreatedPath.startsWith(`${realBase}${path.sep}`)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }
}

export async function createDirectoryIfAbsent(dirPath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  const parentDir = path.posix.dirname(dirPath);
  if (parentDir && parentDir !== '.') await createDirectory(parentDir, options);
  const fullPath = await resolveDirectoryCreationPath(dirPath, options);
  await fs.mkdir(fullPath);
  const realBase = await getWorkspaceRealBase(options);
  const realCreatedPath = await fs.realpath(fullPath);
  if (realCreatedPath !== realBase && !realCreatedPath.startsWith(`${realBase}${path.sep}`)) {
    await fs.rmdir(fullPath).catch(() => undefined);
    throw new Error('Invalid path: directory traversal attempt detected');
  }
}

export async function deleteFile(filePath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  return withWorkspaceFileMutationLock(filePath, options, async () => {
    await assertWorkspaceOfficePathMutationAllowed([filePath], options);
    const fullPath = await resolveExistingWorkspacePath(filePath, options);
    await fs.rm(fullPath, {recursive: true, force: true});
  });
}

export interface RenameConflictError extends Error {
  code: 'FILE_EXISTS' | 'DIRECTORY_EXISTS' | 'SOURCE_NOT_FOUND';
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
}

export async function checkRenameConflict(
  oldPath: string,
  newPath: string,
  options?: WorkspaceFileOperationOptions
): Promise<null | RenameConflictError> {
  validatePath(oldPath, options);
  validatePath(newPath, options);

  // Check if source exists
  try {
    await resolveExistingWorkspacePath(oldPath, options);
  } catch (cause) {
    if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
      throw cause;
    }
    const error = new Error(`Source path does not exist: ${oldPath}`) as RenameConflictError;
    error.code = 'SOURCE_NOT_FOUND';
    error.type = 'file';
    error.sourcePath = oldPath;
    error.destPath = newPath;
    return error;
  }

  // Check if destination already exists
  try {
    const realNewPath = await resolveExistingWorkspacePath(newPath, options);
    const destStat = await fs.stat(realNewPath);
    const realOldPath = await resolveExistingWorkspacePath(oldPath, options);
    const isSourceDirectory = (await fs.stat(realOldPath)).isDirectory();

    if (destStat.isDirectory()) {
      // Directory exists at destination - cannot overwrite
      const error = new Error(`Directory already exists at destination: ${newPath}`) as RenameConflictError;
      error.code = 'DIRECTORY_EXISTS';
      error.type = 'directory';
      error.sourcePath = oldPath;
      error.destPath = newPath;
      return error;
    } else {
      // File exists at destination
      const error = new Error(`File already exists at destination: ${newPath}`) as RenameConflictError;
      error.code = 'FILE_EXISTS';
      error.type = isSourceDirectory ? 'directory' : 'file';
      error.sourcePath = oldPath;
      error.destPath = newPath;
      return error;
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    // Destination does not exist - no conflict
    return null;
  }
}

export async function renameFile(
  oldPath: string,
  newPath: string,
  overwrite = false,
  options?: WorkspaceFileOperationOptions
): Promise<void> {
  return withWorkspaceFileMutationLock(
    newPath,
    options,
    () => renameFileUnlocked(oldPath, newPath, overwrite, options),
  );
}

export async function withRollbackableFileRename<T>(
  oldPath: string,
  newPath: string,
  overwrite: boolean,
  options: WorkspaceFileOperationOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorkspaceFileMutationLocks([oldPath, newPath], options, async () => {
    await assertWorkspaceOfficePathMutationAllowed([oldPath, newPath], options);
    let backupDirectory: string | null = null;
    let destinationBackupPath: string | null = null;
    const conflict = await checkRenameConflict(oldPath, newPath, options);
    if (conflict && !(overwrite && conflict.code === 'FILE_EXISTS' && conflict.type === 'file')) {
      throw conflict;
    }

    if (conflict) {
      backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-rename-'));
      destinationBackupPath = path.join(backupDirectory, 'destination');
      await fs.copyFile(await resolveExistingWorkspacePath(newPath, options), destinationBackupPath);
    }

    await renameFileUnlocked(oldPath, newPath, overwrite, options);
    try {
      return await operation();
    } catch (operationError) {
      try {
        await fs.rename(
          await resolveExistingWorkspacePath(newPath, options),
          validatePath(oldPath, options),
        );
        if (destinationBackupPath) {
          await fs.copyFile(destinationBackupPath, validatePath(newPath, options));
        }
      } catch (rollbackError) {
        const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Path rename failed (${operationMessage}); filesystem rollback failed: ${rollbackMessage}`, {
          cause: operationError,
        });
      }
      throw operationError;
    } finally {
      if (backupDirectory) {
        await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

async function renameFileUnlocked(
  oldPath: string,
  newPath: string,
  overwrite = false,
  options?: WorkspaceFileOperationOptions,
): Promise<void> {
  oldPath = normalizeWorkspaceRelativePath(oldPath);
  newPath = normalizeWorkspaceRelativePath(newPath);
  await assertWorkspaceOfficePathMutationAllowed([oldPath, newPath], options);
  const fullOldPath = await resolveExistingWorkspacePath(oldPath, options);
  const fullNewPath = validatePath(newPath, options);
  if (newPath.toLowerCase().endsWith('.docx') && (await fs.stat(fullOldPath)).isFile()) {
    const { readOfficeFileBytes } = await import('@/app/lib/office/document-service');
    const { validateDocxPackage } = await import('@/app/lib/office/docx-package');
    await validateDocxPackage(await readOfficeFileBytes(oldPath, options ?? {}));
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(newPath);
  if (parentDir && parentDir !== '.') {
    await createWorkspaceFileParentDirectory(newPath, options);
  }
  await resolveWritableWorkspacePath(newPath, options);

  // Check for conflicts
  const conflict = await checkRenameConflict(oldPath, newPath, options);
  if (conflict) {
    if (conflict.code === 'FILE_EXISTS' && overwrite) {
      // Delete existing file and proceed
      await fs.unlink(fullNewPath);
    } else {
      throw conflict;
    }
  }

  await fs.rename(fullOldPath, fullNewPath);
}

export async function getFileStats(filePath: string, options?: WorkspaceFileOperationOptions) {
  const fullPath = await resolveExistingWorkspacePath(filePath, options);
  const stats = await fs.stat(fullPath);

  // Calculate total size for directories
  let totalSize = stats.size;
  if (stats.isDirectory()) {
    totalSize = await calculateDirectorySize(fullPath);
  }

  return {
    size: totalSize,
    fileVersion: filesystemFileVersion(stats),
    modified: Math.floor(stats.mtimeMs / 1000),
    created: stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs / 1000) : undefined,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode?.toString(8),
  };
}

async function calculateDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await fs.readdir(dirPath, {withFileTypes: true});
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await calculateDirectorySize(entryPath);
      } else {
        const stats = await fs.stat(entryPath);
        totalSize += stats.size;
      }
    }
  } catch {
    // Ignore directories we can't read
  }
  return totalSize;
}

export async function buildFileTree(
  dirPath: string = '.',
  depth: number = 4,
  currentDepth: number = 0,
  options?: WorkspaceFileOperationOptions,
  directorySemaphore = new AsyncSemaphore(FILE_TREE_DIRECTORY_CONCURRENCY),
): Promise<FileNode[]> {
  if (currentDepth > depth) {
    return [];
  }

  const files = await directorySemaphore.run(() => listDirectory(dirPath, options));

  files.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'directory' ? -1 : 1;
  });

  if (currentDepth < depth) {
    await Promise.all(
      files.map(async (file) => {
        if (file.type === 'directory') {
          try {
            file.children = await buildFileTree(
              file.path,
              depth,
              currentDepth + 1,
              options,
              directorySemaphore,
            );
          } catch (error) {
            console.warn(`Failed to read directory ${file.path}:`, error);
            file.children = [];
          }
        }
      })
    );
  }

  return files;
}

export interface CopyResult {
  collaborationInitializedPaths?: string[];
  backups?: Array<{ path: string; backupId: string; contentSha256: string; sizeBytes: number }>;
  copied: string[];
  failed: {path: string; error: string; backupId?: string}[];
  skipped: string[];
}

function findAvailableDestName(fileName: string, fullDestDir: string, logicalExists?: (name: string) => boolean): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let candidateFull = path.join(fullDestDir, candidate);
  let idx = 1;

  while (true) {
    try {
      if (!logicalExists?.(candidate)) accessSync(candidateFull);
      candidate = ext ? `${base} (${idx})${ext}` : `${base} (${idx})`;
      candidateFull = path.join(fullDestDir, candidate);
      idx++;
    } catch {
      break;
    }
  }

  return candidate;
}

function isSameFsPath(leftPath: string, rightPath: string): boolean {
  return path.resolve(leftPath) === path.resolve(rightPath);
}

function isSameOrDescendantFsPath(candidatePath: string, parentPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function assertCopyDestinationIsSafe(fullSource: string, fullDestDir: string, fullDest: string, nativeDirectory?: boolean) {
  const isDirectory = nativeDirectory ?? (await fs.stat(fullSource)).isDirectory();
  if (!isDirectory) return;

  if (
    isSameOrDescendantFsPath(fullDestDir, fullSource) ||
    isSameOrDescendantFsPath(fullDest, fullSource)
  ) {
    throw new Error('Cannot copy a directory into itself or one of its subdirectories');
  }
}

export async function copyFile(
  sourcePath: string,
  destDir: string,
  overwrite = false,
  renameOnCollision = false,
  options?: WorkspaceFileOperationOptions
): Promise<Awaited<ReturnType<typeof copyFileBetweenWorkspaces>>> {
  return copyFileBetweenWorkspaces(sourcePath, destDir, overwrite, renameOnCollision, { source: options ?? {}, target: options ?? {} });
}

export async function withWorkspaceCopyMutationLocks<T>(
  source: WorkspaceFileOperationOptions,
  target: WorkspaceFileOperationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const workspaceIds = [...new Set([getWorkspace(source).workspaceId, getWorkspace(target).workspaceId])].sort();
  const enter = (index: number): Promise<T> => index === workspaceIds.length
    ? operation()
    : withWorkspaceMutationLock(workspaceIds[index], () => enter(index + 1));
  return enter(0);
}

async function collectOfficeCopyPaths(filePath: string, options: WorkspaceFileOperationOptions): Promise<string[]> {
  filePath = normalizeWorkspaceRelativePath(filePath);
  const absolutePath = validatePath(filePath, options);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try { stats = await fs.lstat(absolutePath); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (stats.isSymbolicLink()) {
    if (filePath.toLowerCase().endsWith('.docx')) throw new Error('Copying a Word document through a symbolic link is not supported.');
    return [];
  }
  if (!stats.isDirectory()) return filePath.toLowerCase().endsWith('.docx') ? [filePath] : [];
  const result: string[] = [];
  for (const entry of await fs.readdir(absolutePath)) {
    result.push(...await collectOfficeCopyPaths(path.posix.join(filePath, entry), options));
  }
  return result;
}

async function collectExcalidrawCopyPaths(filePath: string, options: WorkspaceFileOperationOptions): Promise<string[]> {
  filePath = normalizeWorkspaceRelativePath(filePath);
  const absolutePath = validatePath(filePath, options);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try { stats = await fs.lstat(absolutePath); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await fs.realpath(absolutePath);
    if (target.toLowerCase().endsWith('.excalidraw') || (await fs.stat(target)).isDirectory()) throw new WorkspacePathAliasError();
    return [];
  }
  if (!stats.isDirectory()) {
    if (!filePath.toLowerCase().endsWith('.excalidraw')) return [];
    await assertWorkspacePathHasNoAliases(getWorkspace(options), filePath);
    return [filePath];
  }
  const result: string[] = [];
  for (const child of await fs.readdir(absolutePath)) {
    result.push(...await collectExcalidrawCopyPaths(path.posix.join(filePath, child), options));
  }
  return result;
}

async function readExcalidrawCopyContent(filePath: string, options: WorkspaceFileOperationOptions): Promise<Buffer> {
  const { getExcalidrawDocument } = await import('@/app/lib/excalidraw-collaboration/scene-service');
  const { serializePortableExcalidrawScene } = await import('@/app/lib/excalidraw-collaboration/checkpoint');
  const { validatePortableExcalidrawScene } = await import('@/app/lib/excalidraw-collaboration/portable-import');
  const state = await getExcalidrawDocument({ workspace: getWorkspace(options), path: filePath });
  const content = await serializePortableExcalidrawScene(state);
  validatePortableExcalidrawScene(content);
  return Buffer.from(content);
}

type CopiedFileIdentity = { dev: string; ino: string };

async function publishCopiedExcalidrawContent(filePath: string, content: Buffer, options: WorkspaceFileOperationOptions,
  onFileStaged?: (identity: CopiedFileIdentity) => Promise<void>): Promise<void> {
  const workspace = getWorkspace(options);
  const actorUserId = options.mutationActorUserId ?? workspace.ownerUserId;
  if (!actorUserId) throw new Error('A user identity is required to copy Excalidraw documents.');
  const { importExcalidrawDocumentFile } = await import('@/app/lib/excalidraw-collaboration/portable-import');
  await importExcalidrawDocumentFile({ workspace, path: filePath, content, onFileStaged,
    actor: { userId: actorUserId, actorId: actorUserId, actorType: 'user' } });
}

/** Failed copies may only remove their own inode and their own portable scene files. */
async function canDiscardCopiedExcalidrawDestination(filePath: string, options: WorkspaceFileOperationOptions,
  rootIdentity: CopiedFileIdentity | null, ownedScenes: ReadonlyMap<string, CopiedFileIdentity>): Promise<boolean> {
  if (!rootIdentity) return false;
  let root: BigIntStats;
  try {
    root = await fs.lstat(validatePath(filePath, options), { bigint: true });
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
  if (root.isSymbolicLink() || String(root.dev) !== rootIdentity.dev || String(root.ino) !== rootIdentity.ino) return false;
  try {
    for (const scenePath of await collectExcalidrawCopyPaths(filePath, options)) {
      const expected = ownedScenes.get(scenePath);
      if (!expected) return false;
      const actual = await fs.lstat(validatePath(scenePath, options), { bigint: true });
      if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function assertNoManagedExcalidrawCopyDestination(filePath: string, options: WorkspaceFileOperationOptions): Promise<void> {
  const workspace = getWorkspace(options);
  if (workspace.legacy) return;
  const { openDb } = await import('@/app/lib/db');
  const database = await openDb();
  try {
    const prefix = `${filePath.replace(/[\\%_]/g, '\\$&')}/%`;
    const document = await database.get(`SELECT d.id FROM collaboration_documents d
      JOIN file_collaboration_lineages l ON l.id=d.lineage_id AND l.status='active'
      WHERE d.workspace_id=$1 AND d.provider='excalidraw' AND d.status='active'
      AND (d.path=$2 OR d.path LIKE $3 ESCAPE '\\') LIMIT 1`, [workspace.workspaceId, filePath, prefix]);
    if (document) throw new ExcalidrawPublicationRequiredError();
  } finally { await database.close(); }
}

async function publishCopiedOfficeContent(filePath: string, content: Buffer, options: WorkspaceFileOperationOptions): Promise<void> {
  const workspace = getWorkspace(options);
  const actorUserId = options.mutationActorUserId ?? workspace.ownerUserId;
  if (!actorUserId) throw new Error('A user identity is required to copy Word documents.');
  const { runWorkspaceUploadWrite } = await import('@/app/lib/files/workspace-upload-flow');
  await runWorkspaceUploadWrite({
    workspace, fileOptions: options, actorUserId, targetPath: filePath, content,
    write: async () => { throw new Error('Word copies must use the document publication service.'); },
  });
}

async function preserveOfficeCopyBaseline(filePath: string, options: WorkspaceFileOperationOptions): Promise<void> {
  const workspace = getWorkspace(options);
  const actorUserId = options.mutationActorUserId ?? workspace.ownerUserId;
  if (!actorUserId) throw new Error('A user identity is required to copy Word documents.');
  const { readOfficeDocumentSnapshot } = await import('@/app/lib/office/document-service');
  const { prepareOfficeCommit, completeOfficeCommit } = await import('@/app/lib/office/document-journal');
  const snapshot = await readOfficeDocumentSnapshot(workspace, filePath);
  if (!snapshot.collaboration.lineageId) throw new Error('The replaced Word document has no recoverable identity.');
  // Archive the existing bytes without republishing them. This also preserves
  // a damaged legacy DOCX when the user replaces it with a valid document.
  const baseline = await prepareOfficeCommit({
    workspaceId: workspace.workspaceId, lineageId: snapshot.collaboration.lineageId, path: filePath,
    actorUserId, actorSessionId: `copy-baseline:${randomUUID()}`, actorType: 'user',
    beforeHash: snapshot.stats.sha256, baseRevisionId: snapshot.revision.id,
    beforeContent: snapshot.content, content: snapshot.content, idempotencyKey: randomUUID(),
  });
  await completeOfficeCommit(baseline, snapshot.revision.id);
}

async function withOfficeCopyReplacement<T>(
  destination: string,
  exists: boolean,
  options: WorkspaceFileOperationOptions,
  operation: () => Promise<T>,
  canDiscardPartialDestination?: () => Promise<boolean>,
): Promise<T> {
  const workspace = getWorkspace(options);
  const { archiveFileCollaborationPaths, moveFileCollaborationPath, remapArchivedFileCollaborationPaths } = await import('@/app/lib/files/collaboration-policy');
  const { deleteWorkspaceFileMetadata, moveWorkspaceFileMetadata } = await import('@/app/lib/files/workspace-file-metadata');
  const discardPartialDestination = async () => {
    if (canDiscardPartialDestination && !await canDiscardPartialDestination()) return;
    await fs.rm(validatePath(destination, options), { recursive: true, force: true });
    await archiveFileCollaborationPaths({ workspace, paths: [{ path: destination }] });
    await deleteWorkspaceFileMetadata({ workspace, path: destination });
  };
  if (!exists) {
    try { return await operation(); }
    catch (error) {
      try { await discardPartialDestination(); }
      catch (rollbackError) { throw new Error('Office directory copy failed and its partial destination could not be fully cleaned up.', { cause: new AggregateError([error, rollbackError]) }); }
      throw error;
    }
  }
  const backupDirectory = '.canvas-copy-backups';
  await createDirectory(backupDirectory, options);
  await fs.chmod(validatePath(backupDirectory, options), 0o700);
  const backupPath = `${backupDirectory}/${randomUUID()}`;
  const result = await withRollbackableFileRename(destination, backupPath, false, options, async () => {
    let collaborationMoved = false;
    let metadataMoved = false;
    let copyStarted = false;
    try {
      await moveFileCollaborationPath({ workspace, oldPath: destination, newPath: backupPath });
      collaborationMoved = true;
      await moveWorkspaceFileMetadata({ workspace, oldPath: destination, newPath: backupPath });
      metadataMoved = true;
      copyStarted = true;
      return await operation();
    } catch (error) {
      try {
        if (copyStarted) await discardPartialDestination();
        if (metadataMoved) await moveWorkspaceFileMetadata({ workspace, oldPath: backupPath, newPath: destination });
        if (collaborationMoved) await moveFileCollaborationPath({ workspace, oldPath: backupPath, newPath: destination });
      } catch (rollbackError) {
        // The outer filesystem transaction restores the original directory or
        // retains its private backup when filesystem compensation also fails.
        throw new Error(`Office copy failed; metadata recovery may require the original at ${destination} or ${backupPath}.`, { cause: new AggregateError([error, rollbackError]) });
      }
      throw error;
    }
  });
  try {
    await archiveFileCollaborationPaths({ workspace, paths: [{ path: backupPath }] });
    await remapArchivedFileCollaborationPaths({ workspace, oldPath: backupPath, newPath: destination });
    await deleteWorkspaceFileMetadata({ workspace, path: backupPath });
    await fs.rm(validatePath(backupPath, options), { recursive: true, force: true });
  } catch (error) {
    // A cleanup failure must never discard the original backup or make a
    // successfully published destination disappear.
    console.warn('[Office copy] Original backup retained after cleanup failure:', backupPath, error);
  }
  return result;
}

export async function copyFileBetweenWorkspaces(
  sourcePath: string,
  destDir: string,
  overwrite = false,
  renameOnCollision = false,
  options: {
    source: WorkspaceFileOperationOptions;
    target: WorkspaceFileOperationOptions;
  },
  nativeDependencies?: WorkspaceNativeCopyDependencies,
): Promise<{copied: string; skipped: boolean; collaborationInitialized?: boolean; backup?: { path: string; backupId: string; contentSha256: string; sizeBytes: number }}> {
  const sourceScope = getWorkspace(options.source); const targetScope = getWorkspace(options.target);
  if (!sourceScope.permissions.canRead || !targetScope.permissions.canRead || !targetScope.permissions.canWrite
    || [sourceScope, targetScope].some(workspace => workspace.status !== undefined && workspace.status !== 'active')) {
    throw Object.assign(new Error('Current source and destination workspace permissions are required.'), { status: 403 });
  }
  sourcePath = normalizeWorkspaceRelativePath(sourcePath);
  destDir = normalizeWorkspaceRelativePath(destDir);
  return withWorkspaceCopyMutationLocks(options.source, options.target, async () => {
    const sourceWorkspace = getWorkspace(options.source); const targetWorkspace = getWorkspace(options.target);
    const native = nativeDependencies ?? (await import('@/app/lib/collaboration/workspace-native-copy')).workspaceNativeCopyDependencies;
    const actorUserId = options.target.mutationActorUserId ?? targetWorkspace.ownerUserId ?? undefined;
    const operationId = `copy-${createHash('sha256').update(JSON.stringify([options.target.mutationOperationId ?? randomUUID(),
      sourceWorkspace.workspaceId, sourcePath, targetWorkspace.workspaceId, destDir])).digest('hex')}`;
    const inspection = await native.inspect({ sourceWorkspace, targetWorkspace, sourcePath, targetDirectory: destDir,
      operationId, actorUserId, actorSessionId: options.target.mutationActorSessionId });
    let fullSource = validatePath(sourcePath, options.source); let sourceExists = true;
    try { fullSource = await resolveExistingWorkspacePath(sourcePath, options.source); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT' || !inspection.hasNativeSource) throw error;
      sourceExists = false;
    }
    const fullDestDir = await resolveExistingWorkspacePath(destDir, options.target);
    const fileName = path.posix.basename(sourcePath);
    let destFileName = fileName;
    const logicalExists = (name: string) => {
      const candidate = destDir === '.' ? name : `${destDir}/${name}`;
      return inspection.targetDocumentPaths.some(document => document === candidate || document.startsWith(`${candidate}/`));
    };
    if (inspection.targetDocumentPaths.includes(destDir)) throw Object.assign(new Error('A native document cannot contain a copied child.'), { status: 409 });

    let destExists = false;
    if (inspection.resumeTargetPath) {
      if (!options.target.mutationOperationId || normalizeWorkspaceRelativePath(path.posix.dirname(inspection.resumeTargetPath)) !== destDir) {
        throw Object.assign(new Error('The copy recovery destination differs from this request.'), { status: 409 });
      }
      destFileName = path.posix.basename(inspection.resumeTargetPath);
    } else if (renameOnCollision) {
      destFileName = findAvailableDestName(fileName, fullDestDir, logicalExists);
    } else {
      const fullDest = path.join(fullDestDir, destFileName);
      try {
        await fs.access(fullDest);
        destExists = true;
      } catch {
        // Destination doesn't exist - good
      }
      destExists ||= logicalExists(destFileName);

      if (destExists) {
        if (!overwrite) {
          return {copied: '', skipped: true};
        }
        if (isSameFsPath(fullSource, fullDest)) {
          throw new Error('Cannot overwrite a path with itself');
        }
      }
    }

    const fullDest = path.join(fullDestDir, destFileName);
    const destRelative = destDir === '.' ? destFileName : `${destDir}/${destFileName}`;
    await assertCopyDestinationIsSafe(fullSource, fullDestDir, fullDest, sourceExists ? undefined : inspection.sourceIsDirectory);
    return withWorkspaceFileLifecycleGuards([
      { workspaceId: getWorkspace(options.source).workspaceId, paths: [sourcePath === '.' ? '' : sourcePath] },
      { workspaceId: getWorkspace(options.target).workspaceId, paths: [destRelative] },
    ], async () => {
    // Reinspect under the actual admission barrier: pre-collision metadata granted no writer authority.
    const currentNative = await native.inspect({ sourceWorkspace, targetWorkspace, sourcePath, targetDirectory: destDir,
      operationId, actorUserId, actorSessionId: options.target.mutationActorSessionId });
    await assertNoManagedExcalidrawCopyDestination(destRelative, options.target);
    await assertWorkspaceOfficePathMutationAllowed([destRelative], options.target);
    const officeSources = sourceExists && destRelative.toLowerCase().endsWith('.docx') && (await fs.stat(fullSource)).isFile()
      ? [sourcePath]
      : await collectOfficeCopyPaths(sourcePath, options.source);
    const replacedOfficePaths = destExists ? await collectOfficeCopyPaths(destRelative, options.target) : [];
    const excalidrawSources = await collectExcalidrawCopyPaths(sourcePath, options.source);
    const replacedExcalidrawPaths = destExists ? await collectExcalidrawCopyPaths(destRelative, options.target) : [];
    if (replacedExcalidrawPaths.length) throw new ExcalidrawPublicationRequiredError();
    const includesOffice = officeSources.length > 0 || replacedOfficePaths.length > 0;
    const includesExcalidraw = excalidrawSources.length > 0;
    if (currentNative.hasNativeSource && includesExcalidraw) {
      // The native backup publisher cannot import scene authority. Refuse this
      // combination before even a scene read can initialize its durable state.
      throw Object.assign(new Error('Copying mixed native text and Excalidraw folders requires the shared scene publication workflow.'),
        { status: 409, code: 'NATIVE_COPY_MIXED_SCENE_UNSUPPORTED' });
    }
    const excalidrawContents = new Map<string, Buffer>();
    for (const source of excalidrawSources) excalidrawContents.set(source, await readExcalidrawCopyContent(source, options.source));
    let backup: { path: string; backupId: string; contentSha256: string; sizeBytes: number } | undefined;
    if (currentNative.hasNativeSource) {
      if (!actorUserId) throw Object.assign(new Error('A user identity is required to copy native documents.'), { status: 403 });
      if (overwrite && destExists || includesOffice) throw Object.assign(new Error('Native replacement and mixed Word/native copies require the structured lifecycle workflow.'),
        { status: 409, code: 'NATIVE_COPY_REPLACEMENT_UNSUPPORTED' });
      const receipt = await native.publish({ sourceWorkspace, targetWorkspace, sourcePath, targetPath: destRelative,
        operationId, actorUserId, actorSessionId: options.target.mutationActorSessionId });
      const { bindNativeCopyReceipt } = await import('@/app/lib/collaboration/native-copy-result');
      return bindNativeCopyReceipt({ copied: destRelative, skipped: false, collaborationInitialized: true }, receipt);
    }
    if (currentNative.initializedTargetPaths.some(document => document === destRelative || document.startsWith(`${destRelative}/`))) {
      throw Object.assign(new Error('A native document projection cannot be replaced by a raw copy.'),
        { status: 409, code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED' });
    }
    if (!destExists && currentNative.targetDocumentPaths.some(document => document === destRelative || document.startsWith(`${destRelative}/`))) {
      throw Object.assign(new Error('The copy destination changed after its name was selected.'), { status: 409 });
    }
    if (overwrite) await assertNoActiveRawCopyPath(getWorkspace(options.source), sourcePath, fullSource, new Set(excalidrawSources));
    if (destExists && overwrite) {
      await assertNoActiveRawCopyPath(getWorkspace(options.target), destRelative, fullDest);
      const { captureWorkspaceOperationBackup } = await import('@/app/lib/files/workspace-operation-backup');
      const captured = await captureWorkspaceOperationBackup({
        workspace: getWorkspace(options.target), path: destRelative, operationId: randomUUID(),
      });
      backup = { path: destRelative, backupId: captured.backupId,
        contentSha256: captured.contentSha256, sizeBytes: captured.sizeBytes };
    }
    try {
      if (includesOffice || includesExcalidraw) {
        if (!(options.target.mutationActorUserId ?? getWorkspace(options.target).ownerUserId)) throw new Error('A user identity is required to copy managed documents.');
        const { readOfficeFileBytes } = await import('@/app/lib/office/document-service');
        const { validateDocxPackage } = await import('@/app/lib/office/docx-package');
        // Complete validation before touching destination bytes or lineage metadata.
        for (const source of officeSources) await validateDocxPackage(await readOfficeFileBytes(source, options.source));
        for (const replaced of replacedOfficePaths) {
          await preserveOfficeCopyBaseline(replaced, options.target);
        }
        const { initializeCopiedFileCollaborationPaths } = await import('@/app/lib/files/collaboration-policy');
        const sourceIsOfficeFile = officeSources.length === 1 && officeSources[0] === sourcePath;
        const sourceIsExcalidrawFile = excalidrawSources.length === 1 && excalidrawSources[0] === sourcePath;
        let copiedRootIdentity: CopiedFileIdentity | null = null;
        const copiedSceneIdentities = new Map<string, CopiedFileIdentity>();
        const recordSceneIdentity = (destination: string) => async (identity: CopiedFileIdentity) => {
          copiedSceneIdentities.set(destination, identity);
          if (destination === destRelative) copiedRootIdentity = identity;
        };
        await withOfficeCopyReplacement(destRelative, destExists, options.target, async () => {
          await initializeCopiedFileCollaborationPaths({ workspace: getWorkspace(options.target), paths: [destRelative] });
          if (sourceIsOfficeFile) {
            await publishCopiedOfficeContent(destRelative, await readOfficeFileBytes(sourcePath, options.source), options.target);
          } else if (sourceIsExcalidrawFile) {
            await publishCopiedExcalidrawContent(destRelative, excalidrawContents.get(sourcePath)!, options.target,
              recordSceneIdentity(destRelative));
          } else {
            const excluded = new Set(await Promise.all([...officeSources, ...excalidrawSources]
              .map((source) => resolveExistingWorkspacePath(source, options.source))));
            if (includesExcalidraw) {
              await fs.mkdir(fullDest);
              const identity = await fs.lstat(fullDest, { bigint: true });
              copiedRootIdentity = { dev: String(identity.dev), ino: String(identity.ino) };
            }
            if (includesExcalidraw) {
              // The exclusively reserved root already exists; only its children enter cp's exclusive path.
              for (const child of await fs.readdir(fullSource)) {
                await fs.cp(path.join(fullSource, child), path.join(fullDest, child), { recursive: true,
                  force: false, errorOnExist: true, filter: (source) => !excluded.has(source) });
              }
            } else {
              await fs.cp(fullSource, fullDest, { recursive: true, filter: (source) => !excluded.has(source) });
            }
            for (const source of officeSources) {
              const destination = path.posix.join(destRelative, path.posix.relative(sourcePath, source));
              await publishCopiedOfficeContent(destination, await readOfficeFileBytes(source, options.source), options.target);
            }
            for (const source of excalidrawSources) {
              const destination = path.posix.join(destRelative, path.posix.relative(sourcePath, source));
              await publishCopiedExcalidrawContent(destination, excalidrawContents.get(source)!, options.target,
                recordSceneIdentity(destination));
            }
          }
        }, includesExcalidraw ? () => canDiscardCopiedExcalidrawDestination(destRelative, options.target,
          copiedRootIdentity, copiedSceneIdentities) : undefined);
      } else {
        if (destExists) await fs.rm(fullDest, { recursive: true, force: true });
        await fs.cp(fullSource, fullDest, {recursive: true});
        const { initializeCopiedFileCollaborationPaths } = await import('@/app/lib/files/collaboration-policy');
        await initializeCopiedFileCollaborationPaths({ workspace: getWorkspace(options.target), paths: [destRelative] });
      }
      return {copied: destRelative, skipped: false, collaborationInitialized: true, backup};
    } catch (error) {
      if (backup && error && typeof error === 'object') Object.assign(error, { backup });
      throw error;
    }
    });
  });
}

export async function batchCopy(
  sources: string[],
  destDir: string,
  overwrite = false,
  renameOnCollision = false,
  options?: WorkspaceFileOperationOptions
): Promise<CopyResult> {
  const results: CopyResult = {copied: [], failed: [], skipped: []};
  const copySources = compactWorkspaceSelection(sources);

  for (const sourcePath of copySources) {
    try {
      const result = await copyFile(sourcePath, destDir, overwrite, renameOnCollision, options);
      if (result.skipped) {
        results.skipped.push(sourcePath);
      } else {
        results.copied.push(result.copied);
        if (result.collaborationInitialized) (results.collaborationInitializedPaths ??= []).push(result.copied);
        if (result.backup) (results.backups ??= []).push(result.backup);
      }
    } catch (error) {
      const backup = error && typeof error === 'object' && 'backup' in error
        ? error.backup as { path: string; backupId: string; contentSha256: string; sizeBytes: number } : undefined;
      if (backup) (results.backups ??= []).push(backup);
      results.failed.push({
        path: sourcePath,
        error: error instanceof Error ? error.message : 'Unknown error',
        backupId: backup?.backupId,
      });
    }
  }

  return results;
}

export async function batchCopyBetweenWorkspaces(
  sources: string[],
  destDir: string,
  overwrite = false,
  renameOnCollision = false,
  options: {
    source: WorkspaceFileOperationOptions;
    target: WorkspaceFileOperationOptions;
  }
): Promise<CopyResult> {
  const results: CopyResult = {copied: [], failed: [], skipped: []};
  const copySources = compactWorkspaceSelection(sources);

  for (const sourcePath of copySources) {
    try {
      const result = await copyFileBetweenWorkspaces(
        sourcePath,
        destDir,
        overwrite,
        renameOnCollision,
        options
      );
      if (result.skipped) {
        results.skipped.push(sourcePath);
      } else {
        results.copied.push(result.copied);
        if (result.collaborationInitialized) (results.collaborationInitializedPaths ??= []).push(result.copied);
        if (result.backup) (results.backups ??= []).push(result.backup);
      }
    } catch (error) {
      const backup = error && typeof error === 'object' && 'backup' in error
        ? error.backup as { path: string; backupId: string; contentSha256: string; sizeBytes: number } : undefined;
      if (backup) (results.backups ??= []).push(backup);
      results.failed.push({
        path: sourcePath,
        error: error instanceof Error ? error.message : 'Unknown error',
        backupId: backup?.backupId,
      });
    }
  }

  return results;
}

export async function batchDelete(
  paths: string[],
  options?: WorkspaceFileOperationOptions
): Promise<{deleted: string[]; failed: {path: string; error: string}[]}> {
  const results = {deleted: [] as string[], failed: [] as {path: string; error: string}[]};

  await Promise.allSettled(
    paths.map(async (filePath) => {
      try {
        await deleteFile(filePath, options);
        results.deleted.push(filePath);
      } catch (error) {
        results.failed.push({
          path: filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    })
  );

  return results;
}

async function safeStat(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export async function buildGenericFileTree(
  absoluteBasePath: string,
  dirPath: string = '.',
  depth: number = 4,
  currentDepth: number = 0
): Promise<FileNode[]> {
  if (currentDepth > depth) {
    return [];
  }

  const fullPath = dirPath === '.' ? absoluteBasePath : path.join(absoluteBasePath, dirPath);

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(fullPath, {withFileTypes: true});
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    const entryPath = dirPath === '.' ? entry.name : path.posix.join(dirPath, entry.name);
    const entryFullPath = path.join(fullPath, entry.name);
    const stats = await safeStat(entryFullPath);

    nodes.push({
      name: entry.name,
      path: entryPath.replace(/\\/g, '/'),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: stats?.size,
      modified: stats ? Math.floor(stats.mtimeMs / 1000) : undefined,
      created: stats && stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs / 1000) : undefined,
      permissions: stats?.mode?.toString(8),
    });
  }

  nodes.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'directory' ? -1 : 1;
  });

  if (currentDepth < depth) {
    await Promise.all(
      nodes.map(async (file) => {
        if (file.type === 'directory') {
          try {
            file.children = await buildGenericFileTree(absoluteBasePath, file.path, depth, currentDepth + 1);
          } catch (error) {
            console.warn(`Failed to read directory ${file.path}:`, error);
            file.children = [];
          }
        }
      })
    );
  }

  return nodes;
}
