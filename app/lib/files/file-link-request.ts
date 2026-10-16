import { workspaceHeaders } from './client';
import { normalizeWorkspacePathParam } from './path-utils';
import { fetchLiveDocument } from '@/app/lib/collaboration/opened-document-registry';
import type { WorkspaceFileLinkTarget } from './file-link-target';

export async function requestWorkspaceFileLinkTarget(workspaceId: string,
  identity: { documentId?: string; lineageId?: string }, signal: AbortSignal): Promise<WorkspaceFileLinkTarget | null> {
  const query = new URLSearchParams({ workspaceId });
  if (identity.documentId) query.set('documentId', identity.documentId);
  if (identity.lineageId) query.set('lineageId', identity.lineageId);
  const response = await fetchLiveDocument(`/api/files/location?${query}`, {
    credentials: 'include', cache: 'no-store', headers: workspaceHeaders(workspaceId), signal,
  });
  signal.throwIfAborted();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('The linked file could not be resolved.');
  const target = await response.json() as WorkspaceFileLinkTarget & { success?: boolean };
  if (!target.success || target.workspaceId !== workspaceId || normalizeWorkspacePathParam(target.path) !== target.path
    || (identity.documentId && target.documentId !== identity.documentId)
    || (identity.lineageId && target.lineageId !== identity.lineageId)) throw new Error('Invalid linked file location.');
  return target;
}
