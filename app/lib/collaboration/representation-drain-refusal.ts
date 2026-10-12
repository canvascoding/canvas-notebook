import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { createCollaborationAdmissionService, lockCollaborationAdmissionWorkspace } from './room-admission';
import { createCollaborationAdmissionHandoffService } from './room-admission-handoff';
import { captureCollaborationAdmissionRequest, CollaborationAdmissionError, type CollaborationAdmissionRequest } from './room-admission-contract';
import { lockCollaborationAdmissionDrain, type CollaborationAdmissionDrainTicket } from './room-admission-drain';
import { assertCollaborationRoomOwnerFence, type CollaborationRoomOwnerRow } from './room-owner';
import { captureRepresentationAdmissionRequest } from './representation-admission-contract';

export async function readRepresentationDrainRequest(ticket: CollaborationAdmissionDrainTicket,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<CollaborationAdmissionRequest | null> {
  const history = createCollaborationAdmissionHandoffService({ openConnection,
    withMutationLocks: async (_workspaceIds, operation) => operation() });
  const request = await history.loadRequest(ticket.requestId);
  if (!request || captureCollaborationAdmissionRequest(request).requestDigest !== ticket.requestDigest) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  return request.action === 'representation_change' ? captureRepresentationAdmissionRequest(request).request : null;
}

/** Owner acknowledgement BEFORE any local terminal handle exists. No document bytes or owner token change. */
export async function refuseRepresentationAdmissionDrain(request: CollaborationAdmissionRequest,
  ticket: CollaborationAdmissionDrainTicket, openConnection: () => Promise<SqlConnection> = openDb): Promise<void> {
  const captured = captureRepresentationAdmissionRequest(request);
  if (ticket.requestId !== request.requestId || ticket.requestDigest !== captureCollaborationAdmissionRequest(request).requestDigest
    || ticket.fence.scope.documentId !== captured.document.documentId) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  await executeLifecycleTransaction({ openConnection, execute: async database => {
    await database.run("SET LOCAL statement_timeout = '5s'");
    await database.run("SET LOCAL lock_timeout = '4s'");
    await lockCollaborationAdmissionWorkspace(async (sql, values) => await database.all(sql, values) as Array<Record<string, unknown>>, captured.document.workspaceId);
    await lockCollaborationAdmissionDrain(async (sql, values) => await database.all(sql, values) as Array<Record<string, unknown>>, ticket, 'draining');
    const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [captured.document.documentId]) as CollaborationRoomOwnerRow | undefined;
    if (!row) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    await assertCollaborationRoomOwnerFence(database, row, ticket.fence);
    // The verified owner still holds the old lifecycle and has not started its local drain.
    // Header/target locks exclude a concurrent release or representation transaction.
    await database.run("UPDATE collaboration_admission_targets SET active = false, status = 'cancelled' WHERE request_id = $1", [request.requestId]);
    await database.run("UPDATE collaboration_admission_requests SET status = 'cancelled', revision = revision + 1, completed_at = $2 WHERE request_id = $1", [request.requestId, Date.now()]);
  }, recoverCommitted: async () => {
    const current = await createCollaborationAdmissionService({ openConnection }).read(request);
    if (current?.status !== 'cancelled') throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  } });
}
