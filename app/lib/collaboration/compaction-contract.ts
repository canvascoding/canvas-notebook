import { captureCollaborationAdmissionRequest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest } from './room-admission-contract';

/** Compaction has one immutable source, not a caller-selected replacement state. */
export function captureCollaborationCompactionRequest(input: CollaborationAdmissionRequest) {
  const { request } = captureCollaborationAdmissionRequest(input);
  const document = request.expectedDocuments[0];
  const scope = request.scopes[0];
  if (request.action !== 'compact' || request.expectedDocuments.length !== 1 || document.status !== 'active'
    || request.scopes.length !== 1 || scope.kind !== 'exact' || scope.workspaceId !== document.workspaceId
    || scope.organizationId !== document.organizationId || scope.path !== document.path
    || request.actionPayloadText === undefined) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  const payload = JSON.parse(request.actionPayloadText) as Record<string, unknown>;
  if (Object.keys(payload).sort().join(',') !== 'documentId,expectedLifecycleGeneration,version'
    || payload.version !== 1 || payload.documentId !== document.documentId
    || payload.expectedLifecycleGeneration !== document.lifecycleGeneration) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return Object.freeze({ request, document });
}
