import { createReadStream as createLocalReadStream, promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  permissions?: string;
  children?: FileNode[];
}

const DATA = process.env.DATA || path.join(process.cwd(), 'data');
const WORKSPACE_BASE_DIR = path.join(DATA, 'workspace');
const CANVAS_AGENT_DIR = path.join(DATA, 'canvas-agent');
const IGNORED_WORKSPACE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache']);
const HIDDEN_WORKSPACE_METADATA_FILES = new Set(['.gitkeep', '.keep']);

export function validatePath(userPath: string): string {
  const normalizedBase = path.normalize(WORKSPACE_BASE_DIR);
  const normalizedPath = path.normalize(path.join(normalizedBase, userPath));

  if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }

  return normalizedPath;
}

function isAppOutputMetadataFile(filePath: string, fileName: string): boolean {
  if (!fileName.endsWith('.json')) return false;
  // Hide JSON metadata files in app output directories
  const APP_OUTPUT_DIRS = [
    'image-generation/generations',
    'veo-studio/video-generation',
    'nano-banana-ad-localizer/localizations',
  ];
  return APP_OUTPUT_DIRS.some((dir) => filePath.includes(dir));
}

export async function listDirectory(dirPath: string = '.'): Promise<FileNode[]> {
  const fullPath = validatePath(dirPath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });

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
  const fullPath = validatePath(filePath);
  return fs.readFile(fullPath);
}

export function validateCanvasAgentPath(userPath: string): string {
  const normalizedBase = path.normalize(CANVAS_AGENT_DIR);
  // Accept both absolute paths (/data/canvas-agent/...) and bare relative names (agents.md)
  const resolved = path.isAbsolute(userPath)
    ? path.normalize(userPath)
    : path.normalize(path.join(normalizedBase, userPath));

  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error('Invalid path: not within canvas-agent directory');
  }

  return resolved;
}

export async function readCanvasAgentFile(filePath: string): Promise<Buffer> {
  const fullPath = validateCanvasAgentPath(filePath);
  return fs.readFile(fullPath);
}

export async function createReadStream(
  filePath: string,
  options?: { start?: number; end?: number; highWaterMark?: number }
): Promise<{ stream: Readable; close: () => Promise<void> }> {
  const fullPath = validatePath(filePath);
  return {
    stream: createLocalReadStream(fullPath, options) as unknown as Readable,
    close: async () => {},
  };
}

export async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = validatePath(filePath);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await fs.writeFile(fullPath, buffer);
}

export async function createDirectory(dirPath: string): Promise<void> {
  const fullPath = validatePath(dirPath);
  await fs.mkdir(fullPath, { recursive: true });
}

export async function deleteFile(filePath: string): Promise<void> {
  const fullPath = validatePath(filePath);
  await fs.rm(fullPath, { recursive: true, force: true });
}

export interface RenameConflictError extends Error {
  code: 'FILE_EXISTS' | 'DIRECTORY_EXISTS' | 'SOURCE_NOT_FOUND';
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
}

export async function checkRenameConflict(oldPath: string, newPath: string): Promise<null | RenameConflictError> {
  const fullOldPath = validatePath(oldPath);
  const fullNewPath = validatePath(newPath);
  
  // Check if source exists
  try {
    await fs.access(fullOldPath);
  } catch {
    const error = new Error(`Source path does not exist: ${oldPath}`) as RenameConflictError;
    error.code = 'SOURCE_NOT_FOUND';
    error.type = 'file';
    error.sourcePath = oldPath;
    error.destPath = newPath;
    return error;
  }
  
  // Check if destination already exists
  try {
    const destStat = await fs.stat(fullNewPath);
    const isSourceDirectory = (await fs.stat(fullOldPath)).isDirectory();
    
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
  } catch {
    // Destination does not exist - no conflict
    return null;
  }
}

export async function renameFile(oldPath: string, newPath: string, overwrite = false): Promise<void> {
  const fullOldPath = validatePath(oldPath);
  const fullNewPath = validatePath(newPath);
  
  // Ensure parent directory exists
  const parentDir = path.dirname(newPath);
  if (parentDir && parentDir !== '.') {
    await createDirectory(parentDir);
  }
  
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
  const fullPath = validatePath(filePath);
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
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
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
  if (currentDepth >= depth) {
    return [];
  }

  const files = await listDirectory(dirPath);

  files.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'directory' ? -1 : 1;
  });

  if (currentDepth < depth - 1) {
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
  failed: { path: string; error: string }[];
  skipped: string[];
}

export async function copyFile(
  sourcePath: string,
  destDir: string,
  overwrite = false
): Promise<{ copied: string; skipped: boolean }> {
  const fullSource = validatePath(sourcePath);
  const fullDestDir = validatePath(destDir);
  const fileName = path.basename(fullSource);
  const fullDest = path.join(fullDestDir, fileName);
  const destRelative = destDir === '.' ? fileName : `${destDir}/${fileName}`;

  try {
    await fs.access(fullDest);
    if (!overwrite) {
      return { copied: '', skipped: true };
    }
    await fs.rm(fullDest, { recursive: true, force: true });
  } catch {
    // Destination doesn't exist - good
  }

  await fs.cp(fullSource, fullDest, { recursive: true });
  return { copied: destRelative, skipped: false };
}

export async function batchCopy(
  sources: string[],
  destDir: string,
  overwrite = false
): Promise<CopyResult> {
  const results: CopyResult = { copied: [], failed: [], skipped: [] };

  await Promise.allSettled(
    sources.map(async (sourcePath) => {
      try {
        const result = await copyFile(sourcePath, destDir, overwrite);
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

export async function batchDelete(paths: string[]): Promise<{ deleted: string[]; failed: { path: string; error: string }[] }> {
  const results = { deleted: [] as string[], failed: [] as { path: string; error: string }[] };

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
