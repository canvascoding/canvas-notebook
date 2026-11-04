import 'server-only';

import { openDb } from '../db';
import { NATIVE_PEER_ADMISSION_BUSY_REASON } from './failure';
import { tryLockFileLifecycleCollaborationRoomAdmission } from './file-lifecycle-writer-admission';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { assertCollaborationAdmissionOpen } from './room-admission';
import { CollaborationAdmissionError } from './room-admission-contract';
import type { CollaborationTicketClaims } from './types';

/** Final native Socket gate, under the caller's workspace fence. A successful
 * gate is neither authentication nor a mutation grant. Only a real conflict
 * with confirmed ROLLBACK and close may request a fresh client admission. */
export async function assertNativePeerRoomAdmissionOpen(input: Pick<CollaborationTicketClaims,
  'documentId' | 'workspaceId' | 'organizationId' | 'path' | 'representation' | 'lifecycleGeneration' | 'schemaVersion'>): Promise<void> {
  if (input.representation === 'excalidraw_scene') throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  const scope = Object.freeze({ ...input, representation: input.representation });
  let settledConflict: unknown;
  try {
    await executeLifecycleTransaction({
      openConnection: openDb,
      execute: async database => {
        await database.run("SET LOCAL statement_timeout = '5s'");
        await database.run("SET LOCAL lock_timeout = '4s'");
        const query = async (sql: string, values?: unknown[]) =>
          await database.all(sql, values) as Array<Record<string, unknown>>;
        await tryLockFileLifecycleCollaborationRoomAdmission(query, scope);
        await assertCollaborationAdmissionOpen(query, scope);
      },
      afterRollbackClosed: error => {
        if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') settledConflict = error;
      },
      // A rejected or lost COMMIT acknowledgement never requests a replay.
      recoverCommitted: async (_value, error) => { throw error; },
    });
  } catch (error) {
    if (settledConflict !== undefined && settledConflict === error) {
      throw Object.assign(new Error('Native collaboration admission is busy.'), { reason: NATIVE_PEER_ADMISSION_BUSY_REASON });
    }
    throw error;
  }
}
