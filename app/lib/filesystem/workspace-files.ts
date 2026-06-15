import {createReadStream as createLocalReadStream, promises as fs, accessSync} from 'fs';
import path from 'path';
import {Readable} from 'stream';
import type { FileNode } from '@/app/lib/files/types';

export type { FileNode } from '@/app/lib/files/types';

function getRuntimeCwd(): string {
  return Reflect.apply(process.cwd, process, []) as string;
}

function getDataDir(): string {
  const configuredDataDir = process.env.DATA?.trim();
  if (!configuredDataDir || configuredDataDir === './data' || configuredDataDir === 'data') {
    return path.join(getRuntimeCwd(), 'data');
  }

  if (path.isAbsolute(configuredDataDir)) {
    return configuredDataDir;
  }

  return path.join(getRuntimeCwd(), 'data');
}

function getWorkspaceBaseDir(): string {
  return path.join(getDataDir(), 'workspace');
}

const IGNORED_WORKSPACE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache']);
const HIDDEN_WORKSPACE_METADATA_FILES = new Set(['.gitkeep', '.keep']);

export function validatePath(userPath: string): string {
  const normalizedBase = path.resolve(getWorkspaceBaseDir());
  const normalizedPath = path.resolve(normalizedBase, userPath);

  if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }

  return normalizedPath;
}

function assertWithinBase(candidatePath: string, basePath: string) {
  if (candidatePath !== basePath && !candidatePath.startsWith(`${basePath}${path.sep}`)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }
}

async function getWorkspaceRealBase(): Promise<string> {
  const basePath = validatePath('.');
  await fs.mkdir(basePath, {recursive: true});
  return fs.realpath(basePath);
}

export async function resolveExistingWorkspacePath(userPath: string): Promise<string> {
  const candidatePath = validatePath(userPath);
  const realBase = await getWorkspaceRealBase();
  const realPath = await fs.realpath(candidatePath);
  assertWithinBase(realPath, realBase);
  return realPath;
}

async function resolveWritableWorkspacePath(userPath: string): Promise<string> {
  const candidatePath = validatePath(userPath);
  const realBase = await getWorkspaceRealBase();
  const parentPath = path.dirname(candidatePath);
  const realParent = await fs.realpath(parentPath);
  assertWithinBase(realParent, realBase);

  try {
    const realExistingPath = await fs.realpath(candidatePath);
    assertWithinBase(realExistingPath, realBase);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  return candidatePath;
}

async function resolveDirectoryCreationPath(userPath: string): Promise<string> {
  const candidatePath = validatePath(userPath);
  const realBase = await getWorkspaceRealBase();
  let current = path.dirname(candidatePath);

  while (current !== path.dirname(current)) {
    try {
      const realCurrent = await fs.realpath(current);
      assertWithinBase(realCurrent, realBase);
      return candidatePath;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        const next = path.dirname(current);
        if (next === current) break;
        current = next;
        continue;
      }
      throw error;
    }
  }

  throw new Error('Invalid path: parent directory is outside workspace');
}

function isAppOutputMetadataFile(_filePath: string, fileName: string): boolean {
  if (!fileName.endsWith('.json')) return false;
  return false;
}

export async function listDirectory(dirPath: string = '.'): Promise<FileNode[]> {
  const fullPath = await resolveExistingWorkspacePath(dirPath);
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

export async function readFile(filePath: string): Promise<Buffer> {
  const fullPath = await resolveExistingWorkspacePath(filePath);
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
  options?: {start?: number; end?: number; highWaterMark?: number}
): Promise<{stream: Readable; close: () => Promise<void>}> {
  const fullPath = await resolveExistingWorkspacePath(filePath);
  return {
    stream: createLocalReadStream(fullPath, options) as unknown as Readable,
    close: async () => {},
  };
}

export async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = await resolveWritableWorkspacePath(filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
}

export async function writeDataFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = path.resolve(/*turbopackIgnore: true*/ getDataDir(), filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
}

export async function createDirectory(dirPath: string): Promise<void> {
  const fullPath = await resolveDirectoryCreationPath(dirPath);
  await fs.mkdir(fullPath, {recursive: true});

  const realBase = await getWorkspaceRealBase();
  const realCreatedPath = await fs.realpath(fullPath);
  assertWithinBase(realCreatedPath, realBase);
}

export async function deleteFile(filePath: string): Promise<void> {
  const fullPath = await resolveExistingWorkspacePath(filePath);
  await fs.rm(fullPath, {recursive: true, force: true});
}

export interface RenameConflictError extends Error {
  code: 'FILE_EXISTS' | 'DIRECTORY_EXISTS' | 'SOURCE_NOT_FOUND';
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
}

export async function checkRenameConflict(oldPath: string, newPath: string): Promise<null | RenameConflictError> {
  validatePath(oldPath);
  validatePath(newPath);

  // Check if source exists
  try {
    await resolveExistingWorkspacePath(oldPath);
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
    const realNewPath = await resolveExistingWorkspacePath(newPath);
    const destStat = await fs.stat(realNewPath);
    const realOldPath = await resolveExistingWorkspacePath(oldPath);
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

export async function renameFile(oldPath: string, newPath: string, overwrite = false): Promise<void> {
  const fullOldPath = await resolveExistingWorkspacePath(oldPath);
  const fullNewPath = validatePath(newPath);

  // Ensure parent directory exists
  const parentDir = path.dirname(newPath);
  if (parentDir && parentDir !== '.') {
    await createDirectory(parentDir);
  }
  await resolveWritableWorkspacePath(newPath);

  // Check for conflicts
  const conflict = await checkRenameConflict(oldPath, newPath);
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

export async function getFileStats(filePath: string) {
  const fullPath = await resolveExistingWorkspacePath(filePath);
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
  currentDepth: number = 0
): Promise<FileNode[]> {
  if (currentDepth > depth) {
    return [];
  }

  const files = await listDirectory(dirPath);

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
            file.children = await buildFileTree(file.path, depth, currentDepth + 1);
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
  renameOnCollision = false
): Promise<{copied: string; skipped: boolean}> {
  const fullSource = await resolveExistingWorkspacePath(sourcePath);
  const fullDestDir = await resolveExistingWorkspacePath(destDir);
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
  renameOnCollision = false
): Promise<CopyResult> {
  const results: CopyResult = {copied: [], failed: [], skipped: []};

  await Promise.allSettled(
    sources.map(async (sourcePath) => {
      try {
        const result = await copyFile(sourcePath, destDir, overwrite, renameOnCollision);
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
  paths: string[]
): Promise<{deleted: string[]; failed: {path: string; error: string}[]}> {
  const results = {deleted: [] as string[], failed: [] as {path: string; error: string}[]};

  await Promise.allSettled(
    paths.map(async (filePath) => {
      try {
        await deleteFile(filePath);
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
