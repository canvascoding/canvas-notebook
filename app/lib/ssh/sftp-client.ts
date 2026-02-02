import SFTPClient from 'ssh2-sftp-client';
import { createReadStream as createLocalReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { readFileSync } from 'fs';
import path from 'path';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  permissions?: string;
  children?: FileNode[];
}

function loadEnvFallback() {
  if (process.env.SSH_HOST && process.env.SSH_USER && process.env.SSH_PORT) {
    return;
  }

  const envPath = path.resolve(process.cwd(), '.env.local');
  let content = '';

  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

loadEnvFallback();

const BASE_PATH = process.env.SSH_BASE_PATH || '/home/canvas-notebook/workspace';
const IS_TEST_MODE = process.env.SSH_TEST_MODE === '1';
const USE_LOCAL_FS = process.env.SSH_USE_LOCAL_FS === 'true';
const SHOULD_USE_LOCAL_FS = IS_TEST_MODE || USE_LOCAL_FS;

const SSH_CONFIG = {
  host: process.env.SSH_HOST || 'ssh.canvas.holdings',
  port: parseInt(process.env.SSH_PORT || '22'),
  username: process.env.SSH_USER || 'canvas-notebook',
};

function getSSHCredentials() {
  if (!process.env.SSH_KEY_PATH) {
    throw new Error('SSH_KEY_PATH environment variable is required');
  }

  try {
    const privateKey = readFileSync(process.env.SSH_KEY_PATH);
    return { privateKey };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to read SSH private key at ${process.env.SSH_KEY_PATH}: ${errorMessage}`);
  }
}

async function withSftp<T>(fn: (sftp: SFTPClient) => Promise<T>) {
  const sftp = new SFTPClient();

  try {
    const config = {
      ...SSH_CONFIG,
      ...getSSHCredentials(),
      readyTimeout: 30000,
    } as unknown as Parameters<SFTPClient['connect']>[0];
    await sftp.connect(config);
    return await fn(sftp);
  } finally {
    await sftp.end();
  }
}

// Validate and normalize path to prevent directory traversal
export function validatePath(userPath: string): string {
  const normalizedBase = path.normalize(BASE_PATH);
  const normalizedPath = path.normalize(path.join(normalizedBase, userPath));

  if (!normalizedPath.startsWith(normalizedBase)) {
    throw new Error('Invalid path: directory traversal attempt detected');
  }

  return normalizedPath;
}

export async function listDirectory(dirPath: string = '.'): Promise<FileNode[]> {
  const fullPath = validatePath(dirPath);

  if (SHOULD_USE_LOCAL_FS) {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const ignoredDirs = ['node_modules', '.next', '.git', 'dist', 'build', '.cache'];

    const files = await Promise.all(
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

    return files;
  }

  return withSftp(async (sftp) => {
    const list = await sftp.list(fullPath);

    // Filter out node_modules, .next, .git and other build folders
    const ignoredDirs = ['node_modules', '.next', '.git', 'dist', 'build', '.cache'];

    return list
      .filter((file) => !ignoredDirs.includes(file.name))
      .map((file) => ({
        name: file.name,
        path: path.join(dirPath, file.name),
        type: file.type === 'd' ? 'directory' : 'file',
        size: file.size,
        modified: file.modifyTime,
        permissions: file.rights?.octal,
      }));
  });
}

export async function readFile(filePath: string): Promise<Buffer> {
  const fullPath = validatePath(filePath);

  if (SHOULD_USE_LOCAL_FS) {
    return fs.readFile(fullPath);
  }

  return withSftp(async (sftp) => {
    const content = await sftp.get(fullPath);
    return content as Buffer;
  });
}

export async function createReadStream(
  filePath: string,
  options?: { start?: number; end?: number; highWaterMark?: number }
): Promise<{ stream: Readable; close: () => Promise<void> }> {
  const fullPath = validatePath(filePath);

  if (SHOULD_USE_LOCAL_FS) {
    return {
      stream: createLocalReadStream(fullPath, options) as unknown as Readable,
      close: async () => {},
    };
  }

  const sftp = new SFTPClient();
  const config = {
    ...SSH_CONFIG,
    ...getSSHCredentials(),
    readyTimeout: 30000,
  } as unknown as Parameters<SFTPClient['connect']>[0];

  await sftp.connect(config);
  const stream = (sftp as unknown as {
    createReadStream: (
      remotePath: string,
      streamOptions?: { start?: number; end?: number; highWaterMark?: number }
    ) => Readable;
  }).createReadStream(fullPath, options);
  const close = async () => {
    try {
      await sftp.end();
    } catch {
      // ignore
    }
  };

  const closeOnce = () => {
    void close();
  };

  stream.once('close', closeOnce);
  stream.once('end', closeOnce);
  stream.once('error', closeOnce);

  return { stream, close };
}

export async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  const fullPath = validatePath(filePath);

  if (SHOULD_USE_LOCAL_FS) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await fs.writeFile(fullPath, buffer);
    return;
  }

  return withSftp(async (sftp) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await sftp.put(buffer, fullPath);
  });
}

export async function createDirectory(dirPath: string): Promise<void> {
  const fullPath = validatePath(dirPath);

  if (SHOULD_USE_LOCAL_FS) {
    await fs.mkdir(fullPath, { recursive: true });
    return;
  }

  return withSftp(async (sftp) => {
    // SFTP mkdir with recursive: true might not be supported by all servers or libraries efficiently.
    // ssh2-sftp-client supports recursive: true.
    await sftp.mkdir(fullPath, true); 
  });
}

export async function deleteFile(filePath: string): Promise<void> {
  const fullPath = validatePath(filePath);

  if (SHOULD_USE_LOCAL_FS) {
    await fs.rm(fullPath, { recursive: true, force: true });
    return;
  }

  return withSftp(async (sftp) => {
    const stat = await sftp.stat(fullPath);

    if (stat.isDirectory) {
      await sftp.rmdir(fullPath, true); // recursive: true
    } else {
      await sftp.delete(fullPath);
    }
  });
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  const fullOldPath = validatePath(oldPath);
  const fullNewPath = validatePath(newPath);

  if (SHOULD_USE_LOCAL_FS) {
    await fs.rename(fullOldPath, fullNewPath);
    return;
  }

  return withSftp(async (sftp) => {
    await sftp.rename(fullOldPath, fullNewPath);
  });
}

export async function getFileStats(filePath: string) {
  const fullPath = validatePath(filePath);

  if (SHOULD_USE_LOCAL_FS) {
    const stats = await fs.stat(fullPath);
    return {
      size: stats.size,
      modified: Math.floor(stats.mtimeMs / 1000),
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      permissions: stats.mode?.toString(8),
    };
  }

  return withSftp(async (sftp) => {
    const stats = await sftp.stat(fullPath);

    return {
      size: stats.size,
      modified: stats.mtime,
      isDirectory: stats.isDirectory,
      isFile: stats.isFile,
      permissions: stats.mode?.toString(8),
    };
  });
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

  // Sort: directories first, then by name
  files.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'directory' ? -1 : 1;
  });

  // Recursively load children for directories
  if (currentDepth < depth - 1) {
    if (SHOULD_USE_LOCAL_FS) {
      // Parallel execution for local FS
      await Promise.all(
        files.map(async (file) => {
          if (file.type === 'directory') {
            try {
              const children = await buildFileTree(file.path, depth, currentDepth + 1);
              file.children = children;
            } catch (error) {
              console.warn(`Failed to read directory ${file.path}:`, error);
              file.children = [];
            }
          }
        })
      );
    } else {
      // Sequential for SFTP to avoid connection limits
      const withChildren: FileNode[] = [];
      for (const file of files) {
        if (file.type === 'directory') {
          try {
            const children = await buildFileTree(file.path, depth, currentDepth + 1);
            withChildren.push({ ...file, children });
          } catch (error) {
            console.warn(`Failed to read directory ${file.path}:`, error);
            withChildren.push(file);
          }
        } else {
          withChildren.push(file);
        }
      }
      return withChildren; // Return logic was different in original, but for local FS we modify in place.
      // Wait, original returned a new array. Let's align.
    }
    // Align return for both cases
    return files;
  }

  return files;
}
