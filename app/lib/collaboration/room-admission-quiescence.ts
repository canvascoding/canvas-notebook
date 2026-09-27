import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { mergeCollaborationPersistenceUpdates } from './persistence-merge';
import { findCollaborationAdmissionOutcomeSource } from './room-admission-outcome';
import { lockIdentity } from './room-owner';
import {
  captureCollaborationAdmissionTargetRow,
  decodeCollaborationAdmissionTarget,
} from './room-admission';
import { admissionDrainTicketForTarget } from './room-admission-drain';
import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  type CollaborationAdmissionRequest,
} from './room-admission-contract';
import {
  validateCollaborationRoomReleaseReceipt,
  type CollaborationRoomReleaseReceipt,
} from './room-owner-release';

type CapturedRequest = ReturnType<typeof captureCollaborationAdmissionRequest>;
type Row = Record<string, unknown>;
export type CollaborationAdmissionQuiescenceProof = Readonly<{
  kind: 'vacant' | 'normal_release' | 'owner_drain' | 'lifecycle_outcome';
  requestId: string;
  requestDigest: string;
  documentId: string;
  releaseId: string | null;
  proofText: string;
  sourceOutcomeRequestId?: string;
}>;

async function lockProofRoom(database: SqlConnection, documentId: string): Promise<void> {
  await database.run("SET LOCAL statement_timeout = '5s'");
  await database.run("SET LOCAL lock_timeout = '4s'");
  // Same advisory-lock domain as the session owner. No row/workspace lock is
  // held here, and we never wait for an owner while holding downstream locks.
  // DA03 only needs the guard through this short proof transaction; DA04 must
  // acquire a new, continuously held guard through the actual lifecycle write.
  const acquired = await database.get('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
    [lockIdentity(documentId).key]) as Row | undefined;
  if (acquired?.locked !== true) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
}

/** Header -> target -> state locks, following the already acquired room guard. */
async function inspectProof(database: SqlConnection, captured: CapturedRequest, documentId: string) {
  const expected = captured.request.expectedDocuments.find((document) => document.documentId === documentId)!;
  const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
    [captured.request.requestId]) as Row | undefined;
  if (!header || header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  const revision = Number(header.revision);
  if (!['reserved', 'draining'].includes(header.status as string)
    || !Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const targetRow = await database.get(`SELECT * FROM collaboration_admission_targets
    WHERE request_id = $1 AND document_id = $2 FOR UPDATE`, [captured.request.requestId, documentId]) as Row | undefined;
  if (!targetRow || targetRow.active !== true || typeof targetRow.snapshot_text !== 'string'
    || !['reserved', 'draining', 'released'].includes(targetRow.status as string)) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  const target = decodeCollaborationAdmissionTarget(targetRow.snapshot_text, expected);
  const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
    [documentId]) as Row | undefined;
  if (!row) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  const current = captureCollaborationAdmissionTargetRow(row, expected);
  if (current.ownerEpoch !== target.ownerEpoch) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  // An available advisory lock does not prove the old owner flushed its bytes.
  // A stale tuple is never cleared, replayed or promoted to a new generation.
  if (current.ownerToken !== null) throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
  let kind: CollaborationAdmissionQuiescenceProof['kind'];
  let receipt: CollaborationRoomReleaseReceipt | null = null;
  let sourceOutcome: Awaited<ReturnType<typeof findCollaborationAdmissionOutcomeSource>> = null;
  if (target.ownerEpoch === 0) {
    if (target.ownerToken !== null) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    kind = 'vacant';
    try {
      const update = row.yjs_state as Uint8Array;
      const decoded = mergeCollaborationPersistenceUpdates(update, update);
      if (!Buffer.from(decoded.stateVector).equals(Buffer.from(row.state_vector as Uint8Array))) {
        throw new Error('The stored vector does not match the document.');
      }
    } catch {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
  } else {
    const found = await database.get(`SELECT * FROM collaboration_room_release_receipts
      WHERE document_id = $1 AND owner_epoch = $2`, [documentId, target.ownerEpoch]) as Row | undefined;
    if (found) {
      try { receipt = validateCollaborationRoomReleaseReceipt(row, found); }
      catch { /* A lifecycle outcome may have changed this epoch's scope or representation. */ }
    }
    if (!receipt && target.ownerToken === null) {
      sourceOutcome = await findCollaborationAdmissionOutcomeSource(database, current);
    }
    if (!receipt && !sourceOutcome) {
      throw new CollaborationAdmissionError(found ? 'ADMISSION_SCOPE_CHANGED' : 'ADMISSION_RECOVERY_REQUIRED');
    }
    if (receipt && target.ownerToken !== null && (receipt.owner_token !== target.ownerToken
      || receipt.owner_backend_pid !== target.ownerBackendPid || receipt.owner_backend_start !== target.ownerBackendStart
      || current.documentSequence < target.documentSequence)) {
      throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
    }
    kind = sourceOutcome ? 'lifecycle_outcome' : targetRow.quiescence_kind === 'owner_drain' ? 'owner_drain' : 'normal_release';
    if (kind === 'owner_drain') {
      const ticket = admissionDrainTicketForTarget(captured.request.requestId, captured.requestDigest, target);
      if (targetRow.status !== 'released' || receipt?.release_id !== ticket.releaseId) {
        throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
      }
    }
  }
  // Epoch zero OR reservation made after a normal release: no owner was left
  // with permission to advance this snapshot. Sequence alone misses raw drift.
  if (target.ownerToken === null && (current.documentSequence !== target.documentSequence
    || current.persistedUpdateHash !== target.persistedUpdateHash
    || current.persistedVectorHash !== target.persistedVectorHash)) {
    throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  }
  const releaseId = receipt?.release_id ?? null;
  const proofText = JSON.stringify({
    version: 1, requestId: captured.request.requestId, requestDigest: captured.requestDigest,
    snapshotDigest: createHash('sha256').update('canvas.admission-quiescence.snapshot.v1\0')
      .update(targetRow.snapshot_text).digest('hex'),
    kind, current, receipt, ...(sourceOutcome ? { sourceOutcome } : {}),
  });
  const proof: CollaborationAdmissionQuiescenceProof = Object.freeze({
    kind, requestId: captured.request.requestId, requestDigest: captured.requestDigest, documentId, releaseId, proofText,
    ...(sourceOutcome ? { sourceOutcomeRequestId: sourceOutcome.requestId } : {}),
  });
  if (targetRow.status === 'released') {
    if (header.status !== 'draining' || targetRow.quiescence_kind !== kind || targetRow.release_id !== releaseId
      || targetRow.source_outcome_request_id !== (sourceOutcome?.requestId ?? null)
      || (targetRow.quiescence_text === null ? kind !== 'owner_drain' : targetRow.quiescence_text !== proofText)) {
      throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
    }
  } else if (targetRow.release_id !== null || targetRow.quiescence_kind !== null || targetRow.quiescence_text !== null
    || targetRow.source_outcome_request_id !== null
    || (targetRow.status === 'draining' && header.status !== 'draining')) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  return { proof, alreadyProven: targetRow.quiescence_text === proofText };
}

/** Internal handoff validation; caller already holds room guard and mutation locks. */
export { inspectProof as inspectCollaborationAdmissionQuiescence };

/**
 * Materializes a retained DA03 proof, NOT lifecycle mutation authority.
 * Active targets keep blocking claims after this transaction releases its guard.
 * DA04 must reacquire the guard and revalidate the complete proof before writing.
 * openConnection must support bounded queries and close(error) must destroy an
 * uncertain backend before recovery. Nothing installs this service by default.
 */
export function createCollaborationAdmissionQuiescenceService(options: {
  openConnection: () => Promise<SqlConnection>;
}) {
  return {
    prove(input: CollaborationAdmissionRequest, documentId: string): Promise<CollaborationAdmissionQuiescenceProof> {
      const captured = captureCollaborationAdmissionRequest(input);
      if (!captured.request.expectedDocuments.some((document) => document.documentId === documentId)) {
        throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
      }
      return executeLifecycleTransaction({
        openConnection: options.openConnection,
        execute: async (database) => {
          await lockProofRoom(database, documentId);
          const { proof, alreadyProven } = await inspectProof(database, captured, documentId);
          if (!alreadyProven) {
            await database.run(`UPDATE collaboration_admission_targets SET status = 'released',
              release_id = $3, quiescence_kind = $4, quiescence_text = $5, source_outcome_request_id = $6
              WHERE request_id = $1 AND document_id = $2`,
            [proof.requestId, documentId, proof.releaseId, proof.kind, proof.proofText, proof.sourceOutcomeRequestId ?? null]);
            await database.run(`UPDATE collaboration_admission_requests SET status = 'draining', revision = revision + 1
              WHERE request_id = $1`, [proof.requestId]);
          }
          return proof;
        },
        recoverCommitted: async (attempted) => {
          // Old uncertain session has been destroyed by executeLifecycleTransaction.
          // Recovery reads exact durable proof on a fresh guarded transaction,
          // never writes it or invents success when COMMIT did not take effect.
          const database = await options.openConnection();
          try {
            await database.run('BEGIN');
            await lockProofRoom(database, documentId);
            const recovered = await inspectProof(database, captured, documentId);
            if (!recovered.alreadyProven || recovered.proof.proofText !== attempted.proofText) {
              throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED');
            }
            return recovered.proof;
          } finally {
            // Always discard the dedicated read session, including its open TX.
            await database.close(new Error('Closing quiescence recovery transaction.'));
          }
        },
      });
    },
  };
}
