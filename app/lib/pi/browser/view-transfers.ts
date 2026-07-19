import 'server-only';

import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import {
  ensureWorkspaceRoot,
  resolveDirectoryCreationPath,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
} from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  resolveAgentSessionWorkspaceForUser,
  type WorkspacePermissionRequirement,
} from '../session-workspace-context';
import type { BrowserRuntimeContext } from './runtime';

export const MAX_BROWSER_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_BROWSER_DOWNLOAD_FILE_BYTES = 250 * 1024 * 1024;
export const BROWSER_DOWNLOAD_WORKSPACE_DIRECTORY = 'Browser Downloads';

async function resolveTransferWorkspace(
  context: BrowserRuntimeContext,
  permissions: WorkspacePermissionRequirement[],
): Promise<WorkspaceContext> {
  const userId = context.userId;
  const agentId = context.agentId;
  const sessionId = context.sessionId;
  const workspaceId = context.workspaceId;
  const workspaceType = context.workspaceType;
  if (!userId || !agentId || !sessionId || !workspaceId || !workspaceType) {
    throw new Error('Browser workspace scope changed.');
  }
  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId,
    workspaceId,
    permissions,
  });
  if (
    workspace.workspaceId !== workspaceId
    || workspace.workspaceType !== workspaceType
    || (workspace.organizationId ?? null) !== (context.organizationId ?? null)
  ) {
    throw new Error('Browser workspace scope changed.');
  }
  return workspace;
}

export function sanitizeBrowserDownloadFileName(value: string): string {
  const baseName = path.basename(value.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 180);
  return baseName && baseName !== '.' && baseName !== '..' ? baseName : 'download.bin';
}

export function normalizeBrowserUploadPaths(paths: unknown, multiple: boolean): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > (multiple ? 10 : 1)) {
    throw new Error('A valid workspace file selection is required.');
  }
  const normalized = paths.map((value) => typeof value === 'string' ? value.trim() : '');
  if (normalized.some((value) => {
    const slashPath = value.replace(/\\/g, '/');
    return !value
      || value.length > 1024
      || value.includes('\0')
      || path.posix.isAbsolute(slashPath)
      || /^[A-Za-z]:\//u.test(slashPath)
      || slashPath.split('/').includes('..');
  })) {
    throw new Error('A valid workspace file selection is required.');
  }
  return normalized;
}

export async function resolveBrowserUploadFiles(
  context: BrowserRuntimeContext,
  paths: unknown,
  multiple: boolean,
): Promise<{ absolutePaths: string[]; totalBytes: number }> {
  const workspace = await resolveTransferWorkspace(context, ['canRead', 'canRunAgent']);
  const relativePaths = normalizeBrowserUploadPaths(paths, multiple);
  const resolved = await Promise.all(relativePaths.map(async (relativePath) => {
    const absolutePath = await resolveExistingWorkspacePath(workspace, relativePath);
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) throw new Error('Browser uploads require regular workspace files.');
    if (stats.size > MAX_BROWSER_UPLOAD_FILE_BYTES) throw new Error('Browser upload file is too large.');
    return { absolutePath, size: stats.size };
  }));
  return {
    absolutePaths: resolved.map((entry) => entry.absolutePath),
    totalBytes: resolved.reduce((total, entry) => total + entry.size, 0),
  };
}

function assertBrowserDownloadGuid(guid: string): string {
  if (!/^[a-f0-9-]{20,80}$/iu.test(guid)) throw new Error('Invalid browser download scope.');
  return guid;
}

export function resolveBrowserDownloadStagingDirectory(): string {
  const root = requirePathInside(resolveWorkspaceDataRoot(), 'browser-view-downloads');
  return requirePathInside(root, 'staging');
}

export async function prepareBrowserDownloadStagingDirectory(): Promise<string> {
  const directory = resolveBrowserDownloadStagingDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export async function cleanupBrowserDownloadStagingFile(directory: string, guid: string): Promise<void> {
  const validatedGuid = assertBrowserDownloadGuid(guid);
  await Promise.all([
    requirePathInside(directory, validatedGuid),
    requirePathInside(directory, `${validatedGuid}.crdownload`),
  ].map(async (filePath) => {
    await fs.unlink(filePath).catch((error: unknown) => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }));
}

async function uniqueWorkspaceDownloadPath(workspace: WorkspaceContext, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? fileName : `${stem} (${index})${extension}`;
    const relativePath = path.posix.join(BROWSER_DOWNLOAD_WORKSPACE_DIRECTORY, candidateName);
    const absolutePath = await resolveWritableWorkspacePath(workspace, relativePath);
    try {
      await fs.access(absolutePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return relativePath;
      throw error;
    }
  }
  throw new Error('Browser download destination is unavailable.');
}

export async function resolveCompletedBrowserDownloadSource(
  stagingDirectory: string,
  guid: string,
  reportedFilePath?: string,
): Promise<string> {
  const expectedPath = requirePathInside(stagingDirectory, assertBrowserDownloadGuid(guid));
  if (reportedFilePath && path.resolve(reportedFilePath) !== path.resolve(expectedPath)) {
    throw new Error('Browser download path is outside the controlled area.');
  }
  const stagingRealPath = await fs.realpath(stagingDirectory);
  const sourceRealPath = await fs.realpath(expectedPath);
  const validatedSource = requirePathInside(stagingRealPath, path.relative(stagingRealPath, sourceRealPath));
  if (validatedSource !== sourceRealPath) throw new Error('Browser download path is outside the controlled area.');
  const stats = await fs.stat(sourceRealPath);
  if (!stats.isFile()) throw new Error('Browser download is not a regular file.');
  return sourceRealPath;
}

export async function moveBrowserDownloadIntoWorkspace(input: {
  context: BrowserRuntimeContext;
  sourcePath: string;
  stagingDirectory: string;
  suggestedFileName: string;
}): Promise<{ fileName: string; workspacePath: string; size: number }> {
  const workspace = await resolveTransferWorkspace(input.context, ['canRead', 'canRunAgent', 'canWrite']);
  const tempRealPath = await fs.realpath(input.stagingDirectory);
  const sourceRealPath = await fs.realpath(input.sourcePath);
  const validatedSource = requirePathInside(tempRealPath, path.relative(tempRealPath, sourceRealPath));
  if (validatedSource !== sourceRealPath) throw new Error('Browser download path is outside the controlled area.');
  const stats = await fs.stat(sourceRealPath);
  if (!stats.isFile()) throw new Error('Browser download is not a regular file.');
  if (stats.size > MAX_BROWSER_DOWNLOAD_FILE_BYTES) throw new Error('Browser download file is too large.');

  const fileName = sanitizeBrowserDownloadFileName(input.suggestedFileName);
  const directoryPath = await resolveDirectoryCreationPath(workspace, BROWSER_DOWNLOAD_WORKSPACE_DIRECTORY);
  await fs.mkdir(directoryPath, { recursive: true });
  await ensureWorkspaceRoot(workspace);
  const workspacePath = await uniqueWorkspaceDownloadPath(workspace, fileName);
  const destinationPath = await resolveWritableWorkspacePath(workspace, workspacePath);
  try {
    await fs.rename(sourceRealPath, destinationPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) throw error;
    await fs.copyFile(sourceRealPath, destinationPath, fsConstants.COPYFILE_EXCL);
    await fs.unlink(sourceRealPath);
  }
  invalidateFileReferenceCache({ workspace });
  return { fileName: path.posix.basename(workspacePath), workspacePath, size: stats.size };
}
