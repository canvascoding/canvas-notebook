import { createDirectory } from './workspace-files';
import { publishWorkspaceUpload } from './upload-events';
import { sanitizeWorkspaceUploadPath } from '@/app/lib/files/upload-paths';
import { joinWorkspacePath } from '@/app/lib/files/path-utils';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import { WorkspaceUploadServiceError } from '@/app/lib/files/workspace-upload-service';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { UploadDirectoryResult } from '@/app/lib/files/upload-result';

export async function createWorkspaceUploadDirectories(workspace: WorkspaceContext, targetDir: string, directories: string[]): Promise<UploadDirectoryResult> {
  if (!workspace.permissions.canWrite) throw new WorkspaceUploadServiceError('UPLOAD_FORBIDDEN', 403, 'This workspace is read-only.');
  if (directories.length > 1000) throw new WorkspaceUploadServiceError('UPLOAD_TOO_MANY_DIRECTORIES', 400, 'Select at most 1000 folders per upload.');
  const target = resolveWorkspacePath(workspace, targetDir || '.').relativePath;
  const entries = [...new Set(directories)].map((sourcePath) => {
    const relativePath = sanitizeWorkspaceUploadPath(sourcePath);
    if (!relativePath) throw new WorkspaceUploadServiceError('UPLOAD_DIRECTORY_PATH_INVALID', 400, 'The selected folder has an invalid path.');
    const targetPath = resolveWorkspacePath(workspace, joinWorkspacePath(target, relativePath)).relativePath;
    return { sourcePath, targetPath };
  });
  const result: UploadDirectoryResult = { completed: [], failed: [] };
  for (const entry of entries) {
    try {
      await createDirectory(entry.targetPath, { workspace });
      result.completed.push({ sourcePath: entry.sourcePath, committed: await publishWorkspaceUpload(workspace, entry.targetPath) });
    } catch (error) { result.failed.push({ sourcePath: entry.sourcePath, error: error instanceof Error ? error.message : 'Could not create folder.' }); }
  }
  return result;
}
