import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  readSettingsBufferFileIfExists,
  readSettingsTextFileIfExists,
  removeSettingsPath,
  resolveSettingsStoragePath,
  writeSettingsBufferFileAtomic,
  writeSettingsTextFileAtomic,
} from '@/app/lib/settings-storage';
import { resolveScopedMcpPath, type McpScope } from '@/app/lib/mcp/scope';

type WriteOptions = {
  mode?: number;
  directoryMode?: number;
};

function normalizeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Invalid MCP storage path.');
  }
  return normalized;
}

async function writeAtomic(filePath: string, content: string | Buffer, options: WriteOptions = {}): Promise<void> {
  const directoryMode = options.directoryMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: directoryMode });
  await fs.chmod(path.dirname(filePath), directoryMode).catch(() => undefined);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporaryPath, content, { mode });
  await fs.chmod(temporaryPath, mode).catch(() => undefined);
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, mode).catch(() => undefined);
}

export function resolveMcpStoragePath(relativePath: string, scope?: McpScope | null): string {
  const normalized = normalizeRelativePath(relativePath);
  return resolveScopedMcpPath(scope, normalized) || resolveSettingsStoragePath(normalized);
}

export async function readMcpTextFileIfExists(relativePath: string, scope?: McpScope | null): Promise<{ filePath: string; content: string | null }> {
  const scopedPath = resolveScopedMcpPath(scope, normalizeRelativePath(relativePath));
  if (!scopedPath) return readSettingsTextFileIfExists(relativePath);
  try {
    return { filePath: scopedPath, content: await fs.readFile(scopedPath, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { filePath: scopedPath, content: null };
    throw error;
  }
}

export async function readMcpBufferFileIfExists(relativePath: string, scope?: McpScope | null): Promise<{ filePath: string; buffer: Buffer | null }> {
  const scopedPath = resolveScopedMcpPath(scope, normalizeRelativePath(relativePath));
  if (!scopedPath) return readSettingsBufferFileIfExists(relativePath);
  try {
    return { filePath: scopedPath, buffer: await fs.readFile(scopedPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { filePath: scopedPath, buffer: null };
    throw error;
  }
}

export async function writeMcpTextFileAtomic(relativePath: string, content: string, scope?: McpScope | null, options: WriteOptions = {}): Promise<string> {
  const scopedPath = resolveScopedMcpPath(scope, normalizeRelativePath(relativePath));
  if (!scopedPath) return writeSettingsTextFileAtomic(relativePath, content, options);
  await writeAtomic(scopedPath, content.endsWith('\n') || content.length === 0 ? content : `${content}\n`, options);
  return scopedPath;
}

export async function writeMcpBufferFileAtomic(relativePath: string, buffer: Buffer, scope?: McpScope | null, options: WriteOptions = {}): Promise<string> {
  const scopedPath = resolveScopedMcpPath(scope, normalizeRelativePath(relativePath));
  if (!scopedPath) return writeSettingsBufferFileAtomic(relativePath, buffer, options);
  await writeAtomic(scopedPath, buffer, options);
  return scopedPath;
}

export async function removeMcpStoragePath(relativePath: string, scope?: McpScope | null, options: { recursive?: boolean } = {}): Promise<void> {
  const scopedPath = resolveScopedMcpPath(scope, normalizeRelativePath(relativePath));
  if (!scopedPath) return removeSettingsPath(relativePath, options);
  await fs.rm(scopedPath, { recursive: options.recursive ?? false, force: true });
}
