import 'server-only';

import { promises as fs } from 'node:fs';

import JSZip, { type JSZipObject } from 'jszip';

import {
  createDirectory,
  getFileStats,
  readFile,
  resolveExistingWorkspacePath,
  writeFileIfAbsent,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { getParentDirectory, joinWorkspacePath } from '@/app/lib/files/path-utils';

const MAX_ARCHIVE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;

interface PreparedZipEntry {
  archiveEntry: JSZipObject;
  relativePath: string;
  targetPath: string;
  uncompressedSize: number;
}

export interface ZipExtractionResult {
  targetDir: string;
  files: string[];
  directories: string[];
}

export class ZipExtractionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ZipExtractionError';
  }
}

export function isZipFilePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zip');
}

function normalizeZipEntryPath(entryPath: string): string {
  const normalized = entryPath.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new ZipExtractionError('The ZIP archive contains an invalid file path.');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /^[A-Za-z]:$/.test(segment))) {
    throw new ZipExtractionError('The ZIP archive contains an invalid file path.');
  }

  return segments.join('/');
}

function getUncompressedSize(entry: JSZipObject): number {
  const size = (entry as JSZipObject & { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new ZipExtractionError('The ZIP archive could not be inspected safely.');
  }
  return size;
}

function addParentDirectories(directoryPaths: Set<string>, filePath: string): void {
  let parent = getParentDirectory(filePath);
  while (parent !== '.') {
    directoryPaths.add(parent);
    parent = getParentDirectory(parent);
  }
}

async function assertTargetDirectory(targetDir: string, options?: WorkspaceFileOperationOptions): Promise<void> {
  const targetPath = await resolveExistingWorkspacePath(targetDir, options);
  const targetStats = await fs.stat(targetPath);
  if (!targetStats.isDirectory()) {
    throw new ZipExtractionError('The extraction destination must be a directory.', 400);
  }
}

async function existingPathType(
  workspacePath: string,
  options?: WorkspaceFileOperationOptions,
): Promise<'file' | 'directory' | null> {
  try {
    const fullPath = await resolveExistingWorkspacePath(workspacePath, options);
    const stats = await fs.stat(fullPath);
    return stats.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoConflicts(
  files: PreparedZipEntry[],
  directories: Set<string>,
  options?: WorkspaceFileOperationOptions,
): Promise<void> {
  const filePaths = new Set(files.map((entry) => entry.targetPath));

  for (const directory of directories) {
    if (filePaths.has(directory)) {
      throw new ZipExtractionError(`The ZIP archive contains conflicting entries at "${directory}".`);
    }
  }

  for (const directory of directories) {
    if (await existingPathType(directory, options) === 'file') {
      throw new ZipExtractionError(`Cannot extract because "${directory}" is already a file.`, 409);
    }
  }

  for (const file of files) {
    const existingType = await existingPathType(file.targetPath, options);
    if (existingType) {
      throw new ZipExtractionError(`Cannot extract because "${file.targetPath}" already exists.`, 409);
    }
  }
}

export async function extractWorkspaceZip(
  archivePath: string,
  targetDir: string,
  options?: WorkspaceFileOperationOptions,
): Promise<ZipExtractionResult> {
  if (!isZipFilePath(archivePath)) {
    throw new ZipExtractionError('Only ZIP archives can be extracted.');
  }

  const archiveStats = await getFileStats(archivePath, options);
  if (!archiveStats.isFile) {
    throw new ZipExtractionError('The selected archive is not a file.');
  }
  if (archiveStats.size > MAX_ARCHIVE_SIZE_BYTES) {
    throw new ZipExtractionError('The ZIP archive is too large. The maximum size is 100 MB.', 413);
  }

  await assertTargetDirectory(targetDir, options);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(archivePath, options), { checkCRC32: true });
  } catch {
    throw new ZipExtractionError('The selected file is not a valid ZIP archive.');
  }

  const files: PreparedZipEntry[] = [];
  const directories = new Set<string>();
  let totalUncompressedSize = 0;

  for (const entry of Object.values(zip.files)) {
    const rawEntryName = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    const relativePath = normalizeZipEntryPath(rawEntryName.replace(/\/+$/, ''));
    const targetPath = joinWorkspacePath(targetDir, relativePath);

    if (entry.dir) {
      directories.add(targetPath);
      continue;
    }

    if (files.length >= MAX_ARCHIVE_ENTRIES) {
      throw new ZipExtractionError(`The ZIP archive contains too many files. The maximum is ${MAX_ARCHIVE_ENTRIES}.`, 413);
    }

    const uncompressedSize = getUncompressedSize(entry);
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_EXTRACTED_SIZE_BYTES) {
      throw new ZipExtractionError('The extracted files would exceed the 500 MB limit.', 413);
    }

    files.push({ archiveEntry: entry, relativePath, targetPath, uncompressedSize });
    addParentDirectories(directories, targetPath);
  }

  if (files.length === 0) {
    throw new ZipExtractionError('The ZIP archive does not contain any files.');
  }

  const duplicatePaths = new Set<string>();
  for (const file of files) {
    if (duplicatePaths.has(file.targetPath)) {
      throw new ZipExtractionError(`The ZIP archive contains duplicate entries at "${file.relativePath}".`);
    }
    duplicatePaths.add(file.targetPath);
  }

  await assertNoConflicts(files, directories, options);

  const createdDirectories = Array.from(directories)
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const directory of createdDirectories) {
    await createDirectory(directory, options);
  }

  const extractedFiles: string[] = [];
  try {
    for (const file of files) {
      const contents = await file.archiveEntry.async('nodebuffer');
      if (contents.byteLength !== file.uncompressedSize) {
        throw new ZipExtractionError(`The ZIP entry "${file.relativePath}" has an unexpected size.`);
      }
      await writeFileIfAbsent(file.targetPath, contents, options);
      extractedFiles.push(file.targetPath);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new ZipExtractionError('A file was created while the archive was being extracted. Nothing was overwritten.', 409);
    }
    throw error;
  }

  return {
    targetDir,
    files: extractedFiles,
    directories: createdDirectories,
  };
}
