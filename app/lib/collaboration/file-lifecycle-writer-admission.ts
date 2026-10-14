import 'server-only';

import { hasVerifiedWorkspaceFileLifecycleCollaborationWrite } from './file-lifecycle-admission-context';
import { lockCollaborationAdmissionWorkspace, tryLockCollaborationAdmissionWorkspace } from './room-admission';
import type { CollaborationRoomOwnerScope } from './room-owner';
import { CollaborationAdmissionError, collaborationAdmissionLockKey } from './room-admission-contract';

type Query = (sql: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Reservation and unrelated writer callers keep their ordinary strict lock. */
export async function tryLockFileLifecycleCollaborationWriterAdmission(query: Query,
  scope: CollaborationRoomOwnerScope): Promise<void> {
  if (!await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(scope)) {
    await tryLockCollaborationAdmissionWorkspace(query, scope.workspaceId);
  }
}

/** Initialization may inherit only the exact virgin document's scoped grant. */
export async function lockFileLifecycleCollaborationWriterAdmission(query: Query,
  scope: CollaborationRoomOwnerScope): Promise<void> {
  if (!await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(scope)) {
    await lockCollaborationAdmissionWorkspace(query, scope.workspaceId);
  }
}

/**
 * Joining a room or claiming its owner header may coexist with native readers.
 * Lifecycle writers remain exclusive; the caller still checks reservations and
 * must acquire the separate NONBLOCKING document-owner lock before any claim.
 */
export async function tryLockFileLifecycleCollaborationRoomAdmission(query: Query,
  scope: CollaborationRoomOwnerScope): Promise<void> {
  if (!await hasVerifiedWorkspaceFileLifecycleCollaborationWrite(scope)) {
    const rows = await query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
      [collaborationAdmissionLockKey(scope.workspaceId)]);
    if (rows[0]?.locked !== true) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
  }
}
