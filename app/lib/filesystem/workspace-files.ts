import {
  createReadStream as createLocalReadStream,
  createWriteStream as createLocalWriteStream,
  promises as fs,
  accessSync,
} from 'fs';
import { randomUUID } from 'crypto';
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
} from '@/app/lib/workspaces/path-guard';
import { compactWorkspaceSelection } from '@/app/lib/files/operation-flows';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { AsyncSemaphore } from '@/app/lib/utils/async-semaphore';

export type { FileNode } from '@/app/lib/files/types';

export interface WorkspaceFileOperationOptions {
  workspace?: WorkspaceContext;
  includeMetadata?: boolean;
  includeSymlinks?: boolean;
}

function getDataDir(): string {
  return resolveWorkspaceDataRoot();
}

function getWorkspace(options?: WorkspaceFileOperationOptions): WorkspaceContext {
  return options?.workspace ?? createLegacyPersonalWorkspaceContext();
}

const IGNORED_WORKSPACE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.canvas-brand']);
const HIDDEN_WORKSPACE_METADATA_FILES = new Set(['.gitkeep', '.keep']);
const FILE_METADATA_CONCURRENCY = 32;
const FILE_TREE_DIRECTORY_CONCURRENCY = 16;
const workspaceFileMutationLocks = new Map<string, Promise<void>>();

async function withExactWorkspaceFileMutationLock<T>(
  filePath: string,
  options: WorkspaceFileOperationOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${getWorkspace(options).workspaceId}\0${filePath}`;
  const previous = workspaceFileMutationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const queued = previous.then(() => current);
  workspaceFileMutationLocks.set(key, queued);

  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (workspaceFileMutationLocks.get(key) === queued) workspaceFileMutationLocks.delete(key);
  }
}

function workspaceMutationLockPathHierarchy(filePath: string): string[] {
  const normalizedPath = path.posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (normalizedPath === '.' || normalizedPath === '') return ['.'];

  const paths = [normalizedPath];
  let parentPath = path.posix.dirname(normalizedPath);
  while (parentPath !== '.' && parentPath !== '/') {
    paths.push(parentPath);
    const nextParentPath = path.posix.dirname(parentPath);
    if (nextParentPath === parentPath) break;
    parentPath = nextParentPath;
  }
  paths.push('.');
  return paths;
}

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
  const uniquePaths = [...new Set(filePaths.flatMap(workspaceMutationLockPathHierarchy))]
    .sort((left, right) => left.localeCompare(right));
  const runWithLocks = async (index: number): Promise<T> => {
    if (index >= uniquePaths.length) return operation();
    return withExactWorkspaceFileMutationLock(uniquePaths[index], options, () => runWithLocks(index + 1));
  };
  return runWithLocks(0);
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

  const visibleEntries = entries.filter((entry) => {
    if (options?.includeSymlinks === false && entry.isSymbolicLink()) {
      return false;
    }
    if (entry.isDirectory()) {
      return !IGNORED_WORKSPACE_DIRS.has(entry.name);
    }
    return !HIDDEN_WORKSPACE_METADATA_FILES.has(entry.name);
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
    const stats = await safeStat(entryPath);
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
): Promise<void> {
  return withWorkspaceFileMutationLock(
    filePath,
    options,
    () => writeFileUnlocked(filePath, content, options, onBeforeReplace),
  );
}

async function writeFileUnlocked(
  filePath: string,
  content: Buffer | string,
  options?: WorkspaceFileOperationOptions,
  onBeforeReplace?: () => Promise<void>,
): Promise<void> {
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
    await handle.close();
    handle = null;
    await onBeforeReplace?.();
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
  const sourceStats = await fs.stat(sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error('Upload source must be a file.');
  }

  const parentDir = path.posix.dirname(filePath);
  if (parentDir !== '.' && parentDir !== '/') {
    await createDirectory(parentDir, options);
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
  options?: WorkspaceFileOperationOptions
): Promise<void> {
  const fullPath = await resolveWritableWorkspacePath(filePath, options);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer, { flag: 'wx' });
}

export async function writeWorkspaceFileFromPathIfAbsent(
  sourcePath: string,
  filePath: string,
  options?: WorkspaceFileOperationOptions,
): Promise<void> {
  const sourceStats = await fs.stat(sourcePath);
  if (!sourceStats.isFile()) throw new Error('Upload source must be a file.');
  const parentDir = path.posix.dirname(filePath);
  if (parentDir !== '.' && parentDir !== '/') await createDirectory(parentDir, options);
  const fullPath = await resolveWritableWorkspacePath(filePath, options);
  let created = false;
  try {
    try {
      await fs.link(sourcePath, fullPath);
      created = true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw error;
      const canCopy = Boolean(error && typeof error === 'object' && 'code' in error
        && ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(String(error.code)));
      if (!canCopy) throw error;
      await pipeline(createLocalReadStream(sourcePath), createLocalWriteStream(fullPath, { flags: 'wx', mode: 0o644 }));
      created = true;
    }
    await fs.chmod(fullPath, 0o644);
  } catch (error) {
    if (created) await fs.rm(fullPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeDataFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = path.resolve(/*turbopackIgnore: true*/ getDataDir(), filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
}

export async function createDirectory(dirPath: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  const fullPath = await resolveDirectoryCreationPath(dirPath, options);
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
  const fullPath = await resolveExistingWorkspacePath(filePath, options);
  await fs.rm(fullPath, {recursive: true, force: true});
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
  const fullOldPath = await resolveExistingWorkspacePath(oldPath, options);
  const fullNewPath = validatePath(newPath, options);

  // Ensure parent directory exists
  const parentDir = path.dirname(newPath);
  if (parentDir && parentDir !== '.') {
    await createDirectory(parentDir, options);
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
  copied: string[];
  failed: {path: string; error: string}[];
  skipped: string[];
}

function findAvailableDestName(fileName: string, fullDestDir: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let candidateFull = path.join(fullDestDir, candidate);
  let idx = 1;

  while (true) {
    try {
      accessSync(candidateFull);
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

async function assertCopyDestinationIsSafe(fullSource: string, fullDestDir: string, fullDest: string) {
  const sourceStats = await fs.stat(fullSource);
  if (!sourceStats.isDirectory()) return;

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
): Promise<{copied: string; skipped: boolean}> {
  const fullSource = await resolveExistingWorkspacePath(sourcePath, options);
  const fullDestDir = await resolveExistingWorkspacePath(destDir, options);
  const fileName = path.basename(fullSource);
  let destFileName = fileName;

  if (renameOnCollision) {
    const fullDest = path.join(fullDestDir, destFileName);
    try {
      await fs.access(fullDest);
      destFileName = findAvailableDestName(fileName, fullDestDir);
    } catch {
      // Destination doesn't exist - use original name
    }
  } else {
    const fullDest = path.join(fullDestDir, destFileName);
    let destExists = false;
    try {
      await fs.access(fullDest);
      destExists = true;
    } catch {
      // Destination doesn't exist - good
    }

    if (destExists) {
      if (!overwrite) {
        return {copied: '', skipped: true};
      }
      if (isSameFsPath(fullSource, fullDest)) {
        throw new Error('Cannot overwrite a path with itself');
      }
      await fs.rm(fullDest, {recursive: true, force: true});
    }
  }

  const fullDest = path.join(fullDestDir, destFileName);
  const destRelative = destDir === '.' ? destFileName : `${destDir}/${destFileName}`;
  await assertCopyDestinationIsSafe(fullSource, fullDestDir, fullDest);
  await fs.cp(fullSource, fullDest, {recursive: true});
  return {copied: destRelative, skipped: false};
}

export async function copyFileBetweenWorkspaces(
  sourcePath: string,
  destDir: string,
  overwrite = false,
  renameOnCollision = false,
  options: {
    source: WorkspaceFileOperationOptions;
    target: WorkspaceFileOperationOptions;
  }
): Promise<{copied: string; skipped: boolean}> {
  const fullSource = await resolveExistingWorkspacePath(sourcePath, options.source);
  const fullDestDir = await resolveExistingWorkspacePath(destDir, options.target);
  const fileName = path.basename(fullSource);
  let destFileName = fileName;

  if (renameOnCollision) {
    const fullDest = path.join(fullDestDir, destFileName);
    try {
      await fs.access(fullDest);
      destFileName = findAvailableDestName(fileName, fullDestDir);
    } catch {
      // Destination doesn't exist - use original name
    }
  } else {
    const fullDest = path.join(fullDestDir, destFileName);
    let destExists = false;
    try {
      await fs.access(fullDest);
      destExists = true;
    } catch {
      // Destination doesn't exist - good
    }

    if (destExists) {
      if (!overwrite) {
        return {copied: '', skipped: true};
      }
      if (isSameFsPath(fullSource, fullDest)) {
        throw new Error('Cannot overwrite a path with itself');
      }
      await fs.rm(fullDest, {recursive: true, force: true});
    }
  }

  const fullDest = path.join(fullDestDir, destFileName);
  const destRelative = destDir === '.' ? destFileName : `${destDir}/${destFileName}`;
  await assertCopyDestinationIsSafe(fullSource, fullDestDir, fullDest);
  await fs.cp(fullSource, fullDest, {recursive: true});
  return {copied: destRelative, skipped: false};
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
      }
    } catch (error) {
      results.failed.push({
        path: sourcePath,
        error: error instanceof Error ? error.message : 'Unknown error',
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
      }
    } catch (error) {
      results.failed.push({
        path: sourcePath,
        error: error instanceof Error ? error.message : 'Unknown error',
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
