import { workspaceHeaders } from '@/app/lib/files/client';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import type { CollaborationDocumentLocation } from './document-location';
import { fetchLiveDocument, invalidateOpenedLiveDocument, LiveDocumentNetworkError, openedDocumentAuthScope, validateOpenedLiveDocumentLocation } from './opened-document-registry';
import { CollaborationDocumentLocationRequestError } from './document-location-retry';

/** Read committed location by identity. Callers must still fence their view/tab lifetime. */
export async function requestCollaborationDocumentLocation(
  workspaceId: string, documentId: string, signal: AbortSignal,
): Promise<CollaborationDocumentLocation | null> {
  const query = new URLSearchParams({ workspaceId, documentId });
  const auth = openedDocumentAuthScope();
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  void cancellation.catch(() => undefined);
  const onAbort = () => rejectCancellation(signal.reason ?? new Error('Location lookup was aborted.'));
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await Promise.race([fetchLiveDocument(`/api/files/collaboration/location?${query}`, {
      credentials: 'include', cache: 'no-store', headers: workspaceHeaders(workspaceId), signal,
    }), cancellation]);
    signal.throwIfAborted();
    if (openedDocumentAuthScope() !== auth) throw new Error('The signed-in session changed.');
    if (response.status === 404) { invalidateOpenedLiveDocument(workspaceId, { documentId }, auth); return null; }
    if (!response.ok) {
      const failure = await Promise.race([response.json(), cancellation]) as { success?: unknown; code?: unknown; retryable?: unknown } | null;
      signal.throwIfAborted();
      if (openedDocumentAuthScope() !== auth) throw new Error('The signed-in session changed.');
      const retryable = response.status === 503 && failure?.success === false && failure.retryable === true
        && (failure.code === 'FILE_MUTATION_LOCK_TIMEOUT' || failure.code === 'FILE_MUTATION_LOCK_BUSY');
      throw new CollaborationDocumentLocationRequestError('Location lookup failed.', {
        status: response.status, code: typeof failure?.code === 'string' ? failure.code : 'LOCATION_FAILED', retryable,
      });
    }
    const location: Partial<CollaborationDocumentLocation> & { success?: boolean } = await Promise.race([response.json(), cancellation]);
    signal.throwIfAborted();
    if (openedDocumentAuthScope() !== auth) throw new Error('The signed-in session changed.');
    const pendingFirstSession = location.lifecycleGeneration === null && location.representation === null;
    const initialized = Number.isSafeInteger(location.lifecycleGeneration) && (location.lifecycleGeneration ?? 0) >= 1
      && ['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(location.representation ?? '');
    if (location.success !== true || location.workspaceId !== workspaceId || location.documentId !== documentId
      || typeof location.path !== 'string' || normalizeWorkspacePathParam(location.path) !== location.path
      || (!pendingFirstSession && !initialized)) {
      throw new Error('Invalid document location.');
    }
    validateOpenedLiveDocumentLocation(workspaceId, documentId, { path: location.path,
      lifecycleGeneration: location.lifecycleGeneration ?? null, representation: location.representation ?? null }, auth);
    return { workspaceId, documentId, path: location.path,
      lifecycleGeneration: location.lifecycleGeneration ?? null, representation: location.representation ?? null };
  } catch (error) {
    if (error instanceof LiveDocumentNetworkError && !signal.aborted && openedDocumentAuthScope() === auth) {
      throw new CollaborationDocumentLocationRequestError(error.message, { code: 'LOCATION_NETWORK_ERROR', retryable: true });
    }
    if (!signal.aborted && openedDocumentAuthScope() === auth
      && !(error instanceof CollaborationDocumentLocationRequestError && error.retryable)) {
      invalidateOpenedLiveDocument(workspaceId, { documentId }, auth);
    }
    throw error;
  } finally { cleanup(); }
}
