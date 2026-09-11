import 'server-only';

import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { session, user } from '@/app/lib/db/schema';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { readPostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { loadCollaborationState } from './persistence';
import type { CollaborationTicketClaims } from './types';
import { fileGuestService } from '@/app/lib/file-guests/service';

export class CollaborationAccessError extends Error {
  readonly code = 'COLLABORATION_ACCESS_REVOKED';
}

/** Ticket expiry limits joining; the underlying session governs ongoing access. */
export async function resolveCollaborationSessionAccess(claims: CollaborationTicketClaims) {
  if (claims.guestInvitationId) {
    const access = await fileGuestService.access(claims.guestInvitationId, { sessionId: claims.sessionId });
    if (claims.userId !== access.user.id || claims.workspaceId !== access.workspace.workspaceId
      || claims.documentId !== access.invitation.documentId || claims.path !== access.invitation.path
      || claims.organizationId !== access.state.organizationId || claims.guestPolicyRevision !== access.invitation.policyRevision
      || (claims.permission === 'write' && access.invitation.permission !== 'write')) {
      throw new CollaborationAccessError('File guest access was revoked.');
    }
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
  // Fresh identity reads must not queue live messages behind Markdown output.
  const metadata = await readFileCollaborationState({ workspace, path: claims.path });
  const state = await loadCollaborationState(claims.documentId);
  if (!metadata.document || metadata.document.id !== claims.documentId || !state
    || state.workspaceId !== claims.workspaceId || state.path !== claims.path
    || state.representation !== claims.representation || state.lifecycleGeneration !== claims.lifecycleGeneration
    || state.schemaVersion !== claims.schemaVersion) {
    throw new CollaborationAccessError('Collaboration document generation is stale.');
  }
  return state;
}

export async function revalidateCollaborationAccess(claims: CollaborationTicketClaims) {
  const access = await resolveCollaborationSessionAccess(claims);
  const state = await assertCollaborationDocumentAccess(claims, access.workspace);
  return { ...access, state };
}
