import path from 'path';
import { promises as fs } from 'fs';

import { resolveAgentStorageDir, resolveSettingsStorageDir } from '@/app/lib/runtime-data-paths';

export const SETTINGS_STORAGE_DIR = resolveSettingsStorageDir();
export const LEGACY_SETTINGS_STORAGE_DIR = resolveAgentStorageDir();

type ReadTextResult = {
  filePath: string;
  content: string | null;
};

type ReadBufferResult = {
  filePath: string;
  buffer: Buffer | null;
};

type WriteOptions = {
  mode?: number;
  directoryMode?: number;
};

function assertSafeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    normalized === '.' ||
    path.isAbsolute(relativePath) ||
    normalized.startsWith('..') ||
    normalized.split(path.sep).includes('..')
  ) {
    throw new Error('Invalid settings storage path.');
  }
  return normalized;
}

export function resolveSettingsStoragePath(relativePath: string): string {
  return path.join(SETTINGS_STORAGE_DIR, assertSafeRelativePath(relativePath));
}

export function resolveLegacySettingsStoragePath(relativePath: string): string {
  return path.join(LEGACY_SETTINGS_STORAGE_DIR, assertSafeRelativePath(relativePath));
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDirectory(filePath: string, directoryMode = 0o700): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: directoryMode });
  await fs.chmod(dirPath, directoryMode).catch(() => undefined);
}

async function copyLegacyFileIfPrimaryMissing(relativePath: string, mode = 0o600): Promise<void> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  if (await exists(primaryPath)) return;

  const legacyPath = resolveLegacySettingsStoragePath(relativePath);
  if (!(await exists(legacyPath))) return;

  await ensureParentDirectory(primaryPath);
  await fs.copyFile(legacyPath, primaryPath);
  await fs.chmod(primaryPath, mode).catch(() => undefined);
}

async function copyLegacyDirectoryIfPrimaryMissing(relativePath: string, mode = 0o700): Promise<void> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  if (await exists(primaryPath)) return;

  const legacyPath = resolveLegacySettingsStoragePath(relativePath);
  if (!(await exists(legacyPath))) return;

  await fs.mkdir(path.dirname(primaryPath), { recursive: true });
  await fs.cp(legacyPath, primaryPath, { recursive: true, preserveTimestamps: true });
  await fs.chmod(primaryPath, mode).catch(() => undefined);
}

export async function migrateLegacySettingsFileIfMissing(relativePath: string, mode = 0o600): Promise<void> {
  await copyLegacyFileIfPrimaryMissing(relativePath, mode);
}

export async function migrateLegacySettingsDirectoryIfMissing(relativePath: string, mode = 0o700): Promise<void> {
  await copyLegacyDirectoryIfPrimaryMissing(relativePath, mode);
}

export async function ensureSettingsStorageDirectory(): Promise<string> {
  try {
    await fs.mkdir(SETTINGS_STORAGE_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(SETTINGS_STORAGE_DIR, 0o700).catch(() => undefined);
    return SETTINGS_STORAGE_DIR;
  } catch {
    await fs.mkdir(LEGACY_SETTINGS_STORAGE_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(LEGACY_SETTINGS_STORAGE_DIR, 0o700).catch(() => undefined);
    return LEGACY_SETTINGS_STORAGE_DIR;
  }
}

export async function readSettingsTextFileIfExists(relativePath: string): Promise<ReadTextResult> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  const legacyPath = resolveLegacySettingsStoragePath(relativePath);

  try {
    await copyLegacyFileIfPrimaryMissing(relativePath);
    return {
      filePath: primaryPath,
      content: await fs.readFile(primaryPath, 'utf8'),
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      const legacyContent = await fs.readFile(legacyPath, 'utf8').catch(() => null);
      if (legacyContent !== null) {
        return { filePath: legacyPath, content: legacyContent };
      }
      throw error;
    }
  }

  const legacyContent = await fs.readFile(legacyPath, 'utf8').catch(() => null);
  if (legacyContent !== null) {
    return { filePath: legacyPath, content: legacyContent };
  }

  return { filePath: primaryPath, content: null };
}

export async function readSettingsBufferFileIfExists(relativePath: string): Promise<ReadBufferResult> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  const legacyPath = resolveLegacySettingsStoragePath(relativePath);

  try {
    await copyLegacyFileIfPrimaryMissing(relativePath);
    return {
      filePath: primaryPath,
      buffer: await fs.readFile(primaryPath),
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      const legacyBuffer = await fs.readFile(legacyPath).catch(() => null);
      if (legacyBuffer) {
        return { filePath: legacyPath, buffer: legacyBuffer };
      }
      throw error;
    }
  }

  const legacyBuffer = await fs.readFile(legacyPath).catch(() => null);
  if (legacyBuffer) {
    return { filePath: legacyPath, buffer: legacyBuffer };
  }

  return { filePath: primaryPath, buffer: null };
}

async function writeAtomic(filePath: string, content: string | Buffer, options: WriteOptions = {}): Promise<void> {
  await ensureParentDirectory(filePath, options.directoryMode);
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, content, { mode: options.mode ?? 0o600 });
  await fs.chmod(tempPath, options.mode ?? 0o600).catch(() => undefined);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, options.mode ?? 0o600).catch(() => undefined);
}

export async function writeSettingsTextFileAtomic(
  relativePath: string,
  content: string,
  options: WriteOptions = {},
): Promise<string> {
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  const primaryPath = resolveSettingsStoragePath(relativePath);
  try {
    await copyLegacyFileIfPrimaryMissing(relativePath, options.mode);
    await writeAtomic(primaryPath, body, options);
    return primaryPath;
  } catch (primaryError) {
    const legacyPath = resolveLegacySettingsStoragePath(relativePath);
    try {
      await writeAtomic(legacyPath, body, options);
      return legacyPath;
    } catch {
      throw primaryError;
    }
  }
}

export async function writeSettingsBufferFileAtomic(
  relativePath: string,
  buffer: Buffer,
  options: WriteOptions = {},
): Promise<string> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  try {
    await copyLegacyFileIfPrimaryMissing(relativePath, options.mode);
    await writeAtomic(primaryPath, buffer, options);
    return primaryPath;
  } catch (primaryError) {
    const legacyPath = resolveLegacySettingsStoragePath(relativePath);
    try {
      await writeAtomic(legacyPath, buffer, options);
      return legacyPath;
    } catch {
      throw primaryError;
    }
  }
}

export async function writeSettingsJsonFileAtomic(
  relativePath: string,
  payload: unknown,
  options: WriteOptions = {},
): Promise<string> {
  return writeSettingsTextFileAtomic(relativePath, JSON.stringify(payload, null, 2), options);
}

export async function removeSettingsPath(relativePath: string, options: { recursive?: boolean } = {}): Promise<void> {
  const primaryPath = resolveSettingsStoragePath(relativePath);
  const legacyPath = resolveLegacySettingsStoragePath(relativePath);
  await fs.rm(primaryPath, { recursive: options.recursive ?? false, force: true }).catch(() => undefined);
  await fs.rm(legacyPath, { recursive: options.recursive ?? false, force: true }).catch(() => undefined);
}
