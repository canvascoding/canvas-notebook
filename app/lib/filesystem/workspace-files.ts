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

const WORKSPACE_BASE_DIR = path.resolve(
  process.env.WORKSPACE_DIR || path.join(process.cwd(), 'data', 'workspace')
);

export function validatePath(userPath: string): string {
  const normalizedBase = path.normalize(WORKSPACE_BASE_DIR);
  const normalizedPath = path.normalize(path.join(normalizedBase, userPath));

  if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }

  return normalizedPath;
}

export async function listDirectory(dirPath: string = '.'): Promise<FileNode[]> {
  const fullPath = validatePath(dirPath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const ignoredDirs = ['node_modules', '.next', '.git', 'dist', 'build', '.cache'];

  return Promise.all(
    entries
      .filter((entry) => !ignoredDirs.includes(entry.name))
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

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  const fullOldPath = validatePath(oldPath);
  const fullNewPath = validatePath(newPath);
  await createDirectory(path.dirname(newPath));
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
