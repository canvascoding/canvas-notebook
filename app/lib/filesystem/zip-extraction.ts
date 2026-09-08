import 'server-only';

import { promises as fs } from 'node:fs';

import JSZip, { type JSZipObject } from 'jszip';

import {
  createDirectory,
  getFileStats,
  readFile,
  resolveExistingWorkspacePath,
  writeFileIfAbsent,
  withWorkspaceFileMutationLocks,
  validatePath,
  assertWorkspaceOfficePathMutationAllowed,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { getParentDirectory, joinWorkspacePath } from '@/app/lib/files/path-utils';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';

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
  collaborationInitializedPaths?: string[];
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
  archivePath = normalizeWorkspaceRelativePath(archivePath);
  targetDir = normalizeWorkspaceRelativePath(targetDir);
  return withWorkspaceFileMutationLocks([archivePath, targetDir], options, async () => {
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
      const targetPath = normalizeWorkspaceRelativePath(joinWorkspacePath(targetDir, relativePath));

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

    const officeFiles = files.filter((file) => file.targetPath.toLowerCase().endsWith('.docx'));
    if (officeFiles.length) {
      if (!options?.workspace || !(options.mutationActorUserId ?? options.workspace.ownerUserId)) {
        throw new ZipExtractionError('A workspace and user identity are required to extract Word documents.');
      }
      await assertWorkspaceOfficePathMutationAllowed(officeFiles.map((file) => file.targetPath), options);
      const { DOCX_PACKAGE_LIMITS, validateDocxPackage } = await import('@/app/lib/office/docx-package');
      for (const file of officeFiles) {
        if (file.uncompressedSize > DOCX_PACKAGE_LIMITS.compressedBytes) throw new ZipExtractionError('A Word document in the archive exceeds the 32 MiB limit.', 413);
        await validateDocxPackage(await file.archiveEntry.async('nodebuffer'));
      }
    }

    const createdDirectories = Array.from(directories)
      .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
    const newDirectories: string[] = [];
    const extractedFiles: string[] = [];
    const attemptedFiles: string[] = [];
    try {
      for (const directory of createdDirectories) {
        if (!(await existingPathType(directory, options))) newDirectories.push(directory);
        await createDirectory(directory, options);
      }
      for (const file of files) {
        const contents = await file.archiveEntry.async('nodebuffer');
        if (contents.byteLength !== file.uncompressedSize) {
          throw new ZipExtractionError(`The ZIP entry "${file.relativePath}" has an unexpected size.`);
        }
        // A publisher can throw after link/rename succeeded (directory fsync,
        // revision or journal finalization). Include this attempted path too.
        attemptedFiles.push(file.targetPath);
        if (file.targetPath.toLowerCase().endsWith('.docx')) {
          const { writeWorkspaceFileContent } = await import('@/app/lib/files/write-service');
          await writeWorkspaceFileContent({
            workspace: options!.workspace!, fileOptions: options!, actorUserId: (options!.mutationActorUserId ?? options!.workspace!.ownerUserId)!,
            path: file.targetPath, content: contents, createOnly: true,
          });
        } else {
          await writeFileIfAbsent(file.targetPath, contents, options);
        }
        extractedFiles.push(file.targetPath);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      const collision = !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
      // Atomic create rejected a new external entry: it never belonged to us.
      const rollbackPaths = collision ? attemptedFiles.slice(0, -1) : attemptedFiles;
      for (const file of [...rollbackPaths].reverse()) {
        try { await fs.rm(validatePath(file, options), { force: true }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (officeFiles.length && options?.workspace) {
        try {
          const { archiveFileCollaborationPaths } = await import('@/app/lib/files/collaboration-policy');
          await archiveFileCollaborationPaths({ workspace: options.workspace, paths: rollbackPaths.map((file) => ({ path: file })) });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      for (const directory of newDirectories.reverse()) {
        try { await fs.rmdir(validatePath(directory, options)); }
        catch (rollbackError) {
          if (!rollbackError || typeof rollbackError !== 'object' || !('code' in rollbackError) || !['ENOENT', 'ENOTEMPTY'].includes(String(rollbackError.code))) rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) throw new ZipExtractionError(`Archive extraction failed and some newly created paths could not be removed: ${rollbackErrors.map(String).join('; ')}`, 500);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new ZipExtractionError('A file was created while the archive was being extracted. Nothing was overwritten.', 409);
      }
      throw error;
    }

    return {
      targetDir,
      files: extractedFiles,
      directories: createdDirectories,
      collaborationInitializedPaths: officeFiles.map((file) => file.targetPath),
    };
  });
}
