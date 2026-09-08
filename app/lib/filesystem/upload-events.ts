import { promises as fs } from 'node:fs';
import { validatePath } from './workspace-files';
import { publishWorkspaceFileMutation } from './file-watcher';
import { filesystemFileVersion } from './file-version';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export async function publishWorkspaceUpload(workspace: WorkspaceContext, filePath: string) {
  const stats = await fs.stat(validatePath(filePath, { workspace })).catch(() => null);
  publishWorkspaceFileMutation({ workspace, relativePath: filePath, type: stats?.isDirectory() ? 'addDir' : 'add',
    fileVersion: stats ? filesystemFileVersion(stats) : undefined });
}
