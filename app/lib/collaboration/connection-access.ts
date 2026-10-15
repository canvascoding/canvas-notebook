import 'server-only';

import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { session, user } from '@/app/lib/db/schema';
import { withFileCollaborationReadSnapshot } from '@/app/lib/files/collaboration-repository';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { readPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { loadCollaborationState, loadCollaborationStateOnConnection } from './persistence';
import type { CollaborationTicketClaims } from './types';
import { fileGuestService } from '@/app/lib/file-guests/service';
import { readFileGuestNativeTargetOnConnection, FileGuestTargetError } from '@/app/lib/file-guests/target';

export class CollaborationAccessError extends Error {
  readonly code = 'COLLABORATION_ACCESS_REVOKED';
}

/** Actual Guest authority only; no caller-provided workspace/access facade.
 * The service pins native identity and the current session on its own reader B.
 * Ticket expiry controls joining upstream; session expiry controls live access. */
async function actualGuestTicketAccess(claims: CollaborationTicketClaims) {
  if (!claims.guestInvitationId) throw new CollaborationAccessError('File guest access was revoked.');
  const access = await fileGuestService.access(claims.guestInvitationId, { sessionId: claims.sessionId });
  const { invitation, guestSession, state, workspace, user } = access;
  if (invitation.id !== claims.guestInvitationId || guestSession.invitationId !== invitation.id
    || guestSession.id !== claims.sessionId || claims.userId !== user.id || user.id !== `guest:${invitation.id}`
    || claims.provider !== 'yjs' || claims.permission !== invitation.permission
    || claims.guestPolicyRevision !== invitation.policyRevision
    || claims.documentId !== invitation.documentId || claims.documentId !== state.documentId
    || claims.path !== invitation.path || claims.path !== state.path
    || claims.workspaceId !== workspace.workspaceId || claims.workspaceId !== invitation.workspaceId || claims.workspaceId !== state.workspaceId
    || claims.organizationId !== (workspace.organizationId ?? null) || claims.organizationId !== state.organizationId
    || claims.lifecycleGeneration !== invitation.lifecycleGeneration || claims.lifecycleGeneration !== state.lifecycleGeneration
    || claims.representation !== state.representation || claims.schemaVersion !== state.schemaVersion) {
    throw new CollaborationAccessError('File guest access was revoked.');
  }
  return { user, workspace, state };
}

/** Ticket expiry limits joining; the underlying session governs ongoing access. */
export async function resolveCollaborationSessionAccess(claims: CollaborationTicketClaims) {
  if (claims.guestInvitationId) {
    const access = await actualGuestTicketAccess(claims);
    return { user: access.user, workspace: access.workspace };
  }
  const [authenticatedUser] = await db.select({ id: user.id, name: user.name, email: user.email, role: user.role })
    .from(session).innerJoin(user, eq(user.id, session.userId))
    .where(and(
      eq(session.id, claims.sessionId), eq(session.userId, claims.userId), gt(session.expiresAt, new Date()),
      or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, new Date())),
    )).limit(1);
  if (!authenticatedUser) throw new CollaborationAccessError('Collaboration session is no longer authenticated.');
  const workspace = await readPostgresWorkspaceForActor(resolveWorkspaceActor(authenticatedUser), claims.workspaceId);
  if (!workspace?.permissions.canRead) throw new CollaborationAccessError('Workspace access was revoked.');
  if (claims.permission === 'write' && !workspace.permissions.canWrite) {
    throw new CollaborationAccessError('Workspace write access was revoked.');
  }
  return { user: authenticatedUser, workspace };
}

export async function assertCollaborationDocumentAccess(claims: CollaborationTicketClaims, workspace: WorkspaceContext) {
  if (claims.guestInvitationId) return (await actualGuestTicketAccess(claims)).state;
  // Drawing/provider contracts retain their existing identity check. The
  // exact native text reader deliberately accepts only the three text formats.
  if (claims.provider !== 'yjs' || claims.representation === 'excalidraw_scene') {
    const metadata = await readFileCollaborationState({workspace,path:claims.path});
    const state = await loadCollaborationState(claims.documentId);
    if (!metadata.document || metadata.document.id !== claims.documentId || !state
      || state.workspaceId !== claims.workspaceId || state.path !== claims.path
      || state.representation !== claims.representation || state.lifecycleGeneration !== claims.lifecycleGeneration
      || state.schemaVersion !== claims.schemaVersion) throw new CollaborationAccessError('Collaboration document generation is stale.');
    return state;
  }
  // Fresh identity reads must not queue live messages behind Markdown output.
  // The authenticated member/native transport is resolved by the caller.
  // Compare its exact native identity on one read snapshot. A file projection
  // and a trimmed neighboring name never establish collaborative identity.
  try {
    return await withFileCollaborationReadSnapshot(async database => {
      if (workspace.workspaceId !== claims.workspaceId || (workspace.organizationId ?? null) !== claims.organizationId
        || !workspace.permissions.canRead || claims.provider !== 'yjs') throw new CollaborationAccessError('Collaboration document generation is stale.');
      const target = await readFileGuestNativeTargetOnConnection(database,workspace,{workspaceId:claims.workspaceId,
        path:claims.path,documentId:claims.documentId,lifecycleGeneration:claims.lifecycleGeneration});
      const state = await loadCollaborationStateOnConnection(database,claims.documentId);
      if (!state || state.workspaceId !== claims.workspaceId || state.organizationId !== claims.organizationId || state.path !== claims.path
        || state.representation !== claims.representation || state.lifecycleGeneration !== claims.lifecycleGeneration
        || state.schemaVersion !== claims.schemaVersion || target.representation !== claims.representation || target.schemaVersion !== claims.schemaVersion) {
        throw new CollaborationAccessError('Collaboration document generation is stale.');
      }
      return state;
    });
  } catch (error) {
    if (error instanceof FileGuestTargetError) throw new CollaborationAccessError('Collaboration document generation is stale.');
    throw error;
  }
}

export async function revalidateCollaborationAccess(claims: CollaborationTicketClaims) {
  if (claims.guestInvitationId) return actualGuestTicketAccess(claims);
  const access = await resolveCollaborationSessionAccess(claims);
  const state = await assertCollaborationDocumentAccess(claims, access.workspace);
  return { ...access, state };
}
