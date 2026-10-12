import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { CollaborationRoomOwnerError, lockIdentity, type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope } from './room-owner';
import { validateCollaborationRoomReleaseReceipt } from './room-owner-release';

export { ensureCollaborationDocumentIdleReleased } from './local-room-drain';

/** Read-only proof inside the caller's transaction and workspace lifecycle fence. */
export async function assertCollaborationDocumentIdleReleaseProof(database: SqlConnection,
  scope: CollaborationRoomOwnerScope, fence?: CollaborationRoomOwnerFence): Promise<void> {
  const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
    [scope.documentId]) as Record<string, unknown> | undefined;
  if (!row || row.status !== 'active' || row.document_id !== scope.documentId
    || row.workspace_id !== scope.workspaceId || row.organization_id !== scope.organizationId
    || row.path !== scope.path || row.representation !== scope.representation
    || Number(row.lifecycle_generation) !== scope.lifecycleGeneration || Number(row.schema_version) !== scope.schemaVersion) {
    throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
  }
  if (row.degraded !== 0 && row.degraded !== '0' && row.degraded !== false || row.room_owner_token !== null
    || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null) {
    throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
  }
  // Never infer a successful release merely from cleared owner columns.
  const epoch = Number(row.room_owner_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || fence && epoch !== fence.epoch) {
    throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
  }
  if (epoch > 0) {
    const receipts = await database.all(`SELECT * FROM collaboration_room_release_receipts
      WHERE document_id = $1 AND owner_epoch = $2`, [scope.documentId, epoch]) as Record<string, unknown>[];
    if (receipts.length !== 1) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
    const receipt = validateCollaborationRoomReleaseReceipt(row, receipts[0]);
    if (fence && (receipt.owner_token !== fence.token || receipt.owner_backend_pid !== fence.backendPid
      || receipt.owner_backend_start !== fence.backendStart)) {
      throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
    }
  } else if (fence) throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
  const key = lockIdentity(scope.documentId);
  const holder = await database.get(`SELECT EXISTS (SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1) AS held`,
  [key.high, key.low]) as { held?: boolean } | undefined;
  if (holder?.held !== false) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
}
