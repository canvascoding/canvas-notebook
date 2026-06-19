import {createReadStream as createLocalReadStream, promises as fs, accessSync} from 'fs';
import path from 'path';
import {Readable} from 'stream';
import type { FileNode } from '@/app/lib/files/types';
import { createLegacyPersonalWorkspaceContext, resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import {
  ensureWorkspaceRoot,
  resolveDirectoryCreationPath as resolveDirectoryCreationPathForContext,
  resolveExistingWorkspacePath as resolveExistingWorkspacePathForContext,
  resolveWritableWorkspacePath as resolveWritableWorkspacePathForContext,
  resolveWorkspacePath,
} from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type { FileNode } from '@/app/lib/files/types';

export interface WorkspaceFileOperationOptions {
  workspace?: WorkspaceContext;
}

function getDataDir(): string {
  return resolveWorkspaceDataRoot();
}

function getWorkspace(options?: WorkspaceFileOperationOptions): WorkspaceContext {
  return options?.workspace ?? createLegacyPersonalWorkspaceContext();
}

const IGNORED_WORKSPACE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache']);
const HIDDEN_WORKSPACE_METADATA_FILES = new Set(['.gitkeep', '.keep']);

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

function isAppOutputMetadataFile(_filePath: string, fileName: string): boolean {
  if (!fileName.endsWith('.json')) return false;
  return false;
}

export async function listDirectory(
  dirPath: string = '.',
  options?: WorkspaceFileOperationOptions
): Promise<FileNode[]> {
  const fullPath = await resolveExistingWorkspacePath(dirPath, options);
  const entries = await fs.readdir(fullPath, {withFileTypes: true});

  return Promise.all(
    entries
      .filter((entry) => {
        if (entry.isDirectory()) {
          return !IGNORED_WORKSPACE_DIRS.has(entry.name);
        }

        if (HIDDEN_WORKSPACE_METADATA_FILES.has(entry.name)) {
          return false;
        }

        // Hide app output metadata JSON files
        const entryPath = path.join(dirPath, entry.name);
        if (isAppOutputMetadataFile(entryPath, entry.name)) {
          return false;
        }

        return true;
      })
      .map(async (entry) => {
        const entryPath = path.join(fullPath, entry.name);
        const stats = await fs.stat(entryPath);

        return {
          name: entry.name,
          path: path.join(dirPath, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: Math.floor(stats.mtimeMs / 1000),
          permissions: stats.mode?.toString(8),
        } satisfies FileNode;
      })
  );
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
  options?: WorkspaceFileOperationOptions
): Promise<void> {
  const fullPath = await resolveWritableWorkspacePath(filePath, options);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
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
  options?: WorkspaceFileOperationOptions
): Promise<FileNode[]> {
  if (currentDepth > depth) {
    return [];
  }

  const files = await listDirectory(dirPath, options);

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
            file.children = await buildFileTree(file.path, depth, currentDepth + 1, options);
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
    try {
      await fs.access(fullDest);
      if (!overwrite) {
        return {copied: '', skipped: true};
      }
      await fs.rm(fullDest, {recursive: true, force: true});
    } catch {
      // Destination doesn't exist - good
    }
  }

  const fullDest = path.join(fullDestDir, destFileName);
  const destRelative = destDir === '.' ? destFileName : `${destDir}/${destFileName}`;
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

  await Promise.allSettled(
    sources.map(async (sourcePath) => {
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
    })
  );

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
