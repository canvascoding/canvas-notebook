import { promises as fs } from 'node:fs';
import { validatePath } from './workspace-files';
import { publishWorkspaceFileMutation } from './file-watcher';
import { filesystemFileVersion } from './file-version';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceUploadCommit } from '@/app/lib/files/upload-result';

export async function publishWorkspaceUpload(workspace: WorkspaceContext, filePath: string): Promise<WorkspaceUploadCommit> {
  const stats = await fs.stat(validatePath(filePath, { workspace })).catch(() => null);
  publishWorkspaceFileMutation({ workspace, relativePath: filePath, type: stats?.isDirectory() ? 'addDir' : 'add',
    fileVersion: stats ? filesystemFileVersion(stats) : undefined });
  return { targetPath: filePath, fileVersion: stats ? filesystemFileVersion(stats) : undefined,
    node: stats ? { path: filePath, name: filePath.split('/').pop()!, type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size, modified: Math.floor(stats.mtimeMs / 1000), created: stats.birthtimeMs > 0 ? Math.floor(stats.birthtimeMs / 1000) : undefined,
      permissions: stats.mode.toString(8) } : undefined };
}
