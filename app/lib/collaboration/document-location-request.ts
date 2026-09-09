import { workspaceHeaders } from '@/app/lib/files/client';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import type { CollaborationDocumentLocation } from './document-location';

/** Read committed location by identity. Callers must still fence their view/tab lifetime. */
export async function requestCollaborationDocumentLocation(
  workspaceId: string, documentId: string, signal: AbortSignal,
): Promise<CollaborationDocumentLocation | null> {
  const query = new URLSearchParams({ workspaceId, documentId });
  const response = await fetch(`/api/files/collaboration/location?${query}`, {
    credentials: 'include', cache: 'no-store', headers: workspaceHeaders(workspaceId), signal,
  });
  signal.throwIfAborted();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Location lookup failed.');
  const location: Partial<CollaborationDocumentLocation> & { success?: boolean } = await response.json();
  signal.throwIfAborted();
  const pendingFirstSession = location.lifecycleGeneration === null && location.representation === null;
  const initialized = Number.isSafeInteger(location.lifecycleGeneration) && (location.lifecycleGeneration ?? 0) >= 1
    && ['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(location.representation ?? '');
  if (location.success !== true || location.workspaceId !== workspaceId || location.documentId !== documentId
    || typeof location.path !== 'string' || normalizeWorkspacePathParam(location.path) !== location.path
    || (!pendingFirstSession && !initialized)) {
    throw new Error('Invalid document location.');
  }
  return { workspaceId, documentId, path: location.path,
    lifecycleGeneration: location.lifecycleGeneration ?? null, representation: location.representation ?? null };
}
