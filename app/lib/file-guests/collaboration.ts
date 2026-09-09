import 'server-only';

import { issueCollaborationTicket, verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { COLLABORATION_SCHEMA_VERSION, RICH_MARKDOWN_SCHEMA_VERSION, type CollaborationSessionResponse } from '@/app/lib/collaboration/types';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { materializeCollaborationCheckpoint } from '@/app/lib/collaboration/checkpoint';
import { fileGuestService, FileGuestError } from './service';

export async function fileGuestCollaborationSession(id: string, token: string): Promise<CollaborationSessionResponse> {
  const { user, guestSession, state, invitation } = await fileGuestService.access(id, { token });
  const issued = issueCollaborationTicket({ userId: user.id, sessionId: guestSession.id,
    guestInvitationId: id, guestPolicyRevision: invitation.policyRevision,
    workspaceId: state.workspaceId, organizationId: state.organizationId, documentId: state.documentId,
    path: state.path, representation: state.representation, provider: 'yjs',
    permission: invitation.permission === 'write' ? 'write' : 'read', lifecycleGeneration: state.lifecycleGeneration,
  });
  return { success: true, documentId: state.documentId, documentName: state.documentId, provider: 'yjs',
    representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: COLLABORATION_SCHEMA_VERSION,
    richTextSchemaVersion: RICH_MARKDOWN_SCHEMA_VERSION, permission: issued.claims.permission,
    documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
    stateVector: Buffer.from(state.stateVector).toString('base64'), token: issued.token,
    expiresAt: new Date(issued.claims.expiresAt).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: user.id, name: user.name, ...collaborationUserColors(user.id) },
    guestAccess: { invitationId: id, workspaceId: state.workspaceId },
  };
}

export async function fileGuestCheckpoint(id: string, token: string, ticket: string, stateVector: string) {
  const found = await fileGuestService.access(id, { token });
  const claims = verifyCollaborationTicket(ticket);
  if (claims.guestInvitationId !== id || claims.guestPolicyRevision !== found.invitation.policyRevision
    || claims.sessionId !== found.guestSession.id || claims.userId !== found.user.id || claims.permission !== 'write'
    || found.invitation.permission !== 'write' || claims.documentId !== found.state.documentId
    || claims.workspaceId !== found.workspace.workspaceId || claims.path !== found.state.path
    || claims.lifecycleGeneration !== found.state.lifecycleGeneration || claims.representation !== found.state.representation) {
    throw new FileGuestError('Das Bearbeitungsrecht wurde geändert. Bitte neu laden.');
  }
  if (!stateVector || stateVector.length > 64 * 1024 || Buffer.from(found.state.stateVector).toString('base64') !== stateVector) throw new FileGuestError('Änderungen werden noch synchronisiert. Bitte erneut versuchen.', 409);
  const result = await materializeCollaborationCheckpoint({ state: found.state, workspace: found.workspace,
    actorUserId: found.user.id, actorType: 'user', sourceSessionId: found.guestSession.id });
  return { success: true, documentId: result.state.documentId, lifecycleGeneration: result.state.lifecycleGeneration,
    documentSequence: result.state.documentSequence, checkpointSequence: result.state.checkpointSequence,
    sequence: result.state.documentSequence, revisionId: result.revisionId, stateVector: Buffer.from(result.state.stateVector).toString('base64') };
}
