import { readApiError } from './client';
import type { UploadDirectoryResult } from './upload-result';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export async function uploadWorkspaceDirectories(paths: string[], targetDir: string, workspaceId: string | null): Promise<UploadDirectoryResult> {
  const response = await fetch('/api/files/uploads/directories', { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(workspaceId ? { [WORKSPACE_ID_HEADER]: workspaceId } : {}) },
    body: JSON.stringify({ directories: paths, targetDir }) });
  if (!response.ok) throw await readApiError(response, 'Could not upload folders.');
  return response.json();
}
