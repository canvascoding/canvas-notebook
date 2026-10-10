import { captureCollaborationAdmissionRequest, collaborationAdmissionActionDigest, CollaborationAdmissionError,
  type CollaborationAdmissionRequest } from './room-admission-contract';
import { parseRichMigrationRequest, type RichMigrationRequest } from './representation-migration-contract';
import type { PersistedCollaborationState } from './persistence';

export function createRepresentationAdmissionRequest(state: PersistedCollaborationState, actorId: string, migration: RichMigrationRequest): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify({ version: 1, representation: 'tiptap_blocks', migration });
  return captureCollaborationAdmissionRequest({ requestId: migration.requestId, actorId, action: 'representation_change',
    actionDigest: collaborationAdmissionActionDigest('representation_change', actionPayloadText), actionPayloadText,
    scopes: [{ workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path, kind: 'exact' }],
    expectedDocuments: [{ documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
      path: state.path, representation: state.representation, lifecycleGeneration: state.lifecycleGeneration,
      schemaVersion: state.schemaVersion, status: state.status }],
  }).request;
}

export function captureRepresentationAdmissionRequest(input: CollaborationAdmissionRequest) {
  const { request } = captureCollaborationAdmissionRequest(input);
  const document = request.expectedDocuments[0], scope = request.scopes[0];
  if (request.action !== 'representation_change' || request.expectedDocuments.length !== 1 || document.status !== 'active'
    || !['plain_text', 'tiptap_xml'].includes(document.representation) || request.scopes.length !== 1
    || scope.kind !== 'exact' || scope.workspaceId !== document.workspaceId || scope.organizationId !== document.organizationId
    || scope.path !== document.path || request.actionPayloadText === undefined) throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  const payload = JSON.parse(request.actionPayloadText) as Record<string, unknown>;
  const migration = parseRichMigrationRequest(payload.migration);
  if (Object.keys(payload).sort().join(',') !== 'migration,representation,version' || payload.version !== 1
    || payload.representation !== 'tiptap_blocks' || !migration || migration.requestId !== request.requestId
    || migration.expectedDocumentId !== document.documentId || migration.expectedLifecycleGeneration !== document.lifecycleGeneration) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return Object.freeze({ request, document, migration });
}
