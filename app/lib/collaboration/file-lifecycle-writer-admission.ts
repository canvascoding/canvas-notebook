import 'server-only';

import { hasVerifiedWorkspaceFileLifecycleCollaborationWrite } from './file-lifecycle-admission-context';
import { lockCollaborationAdmissionWorkspace, tryLockCollaborationAdmissionWorkspace } from './room-admission';
import type { CollaborationRoomOwnerScope } from './room-owner';

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
