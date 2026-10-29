import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import type { RichMigrationTransaction } from './rich-migration-domain';
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
  type CollaborationAdmissionDocument,
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

async function lockProofRoom(database: SqlConnection, documentId: string, authenticatedWrite = false): Promise<void> {
  await database.run("SET LOCAL statement_timeout = '5s'");
  await database.run(authenticatedWrite ? "SET LOCAL lock_timeout = '50ms'" : "SET LOCAL lock_timeout = '4s'");
  // Same advisory-lock domain as the session owner. No row/workspace lock is
  // held here, and we never wait for an owner while holding downstream locks.
  // DA03 only needs the guard through this short proof transaction; DA04 must
  // acquire a new, continuously held guard through the actual lifecycle write.
  const acquired = await database.get('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
    [lockIdentity(documentId).key]) as Row | undefined;
  if (acquired?.locked !== true) throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
}

function assertProofHeader(header: Row | undefined, captured: CapturedRequest): asserts header is Row {
  if (!header || header.request_digest !== captured.requestDigest || header.intent_text !== captured.intentText) {
    throw new CollaborationAdmissionError('ADMISSION_REQUEST_CHANGED');
  }
  const revision = Number(header.revision);
  if (!['reserved', 'draining'].includes(header.status as string)
    || !Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
}

function captureProofTarget(targetRow: Row | undefined, expected: CollaborationAdmissionDocument) {
  if (!targetRow || targetRow.active !== true || typeof targetRow.snapshot_text !== 'string'
    || !['reserved', 'draining', 'released'].includes(targetRow.status as string)) {
    throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  }
  return { row: targetRow as Row & { snapshot_text: string },
    target: decodeCollaborationAdmissionTarget(targetRow.snapshot_text, expected) };
}

/** Same validator for individually locked and set-locked actual SQL rows.
 * These private observations grant no mutation or authorization capability. */
async function inspectProofRows(database: SqlConnection, captured: CapturedRequest, observation: {
  expected: CollaborationAdmissionDocument; header: Row; row: Row;
  target: ReturnType<typeof captureProofTarget>;
}) {
  const { expected, header, row } = observation, { row: targetRow, target } = observation.target;
  const documentId = expected.documentId;
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

/** Header -> target -> state locks, following the already acquired room guard. */
async function inspectProof(database: SqlConnection, captured: CapturedRequest, documentId: string) {
  const expected = captured.request.expectedDocuments.find(document => document.documentId === documentId)!;
  const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
    [captured.request.requestId]) as Row | undefined;
  assertProofHeader(header, captured);
  const targetRow = await database.get(`SELECT * FROM collaboration_admission_targets
    WHERE request_id = $1 AND document_id = $2 FOR UPDATE`, [captured.request.requestId, documentId]) as Row | undefined;
  const target = captureProofTarget(targetRow, expected);
  const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
    [documentId]) as Row | undefined;
  if (!row) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  return inspectProofRows(database, captured, { expected, header, row, target });
}

/** Internal handoff validation; caller already holds room guard and mutation locks. */
export { inspectProof as inspectCollaborationAdmissionQuiescence };

/** Fresh set observation on the caller's actual transaction. The caller holds
 * every selected room guard and the mutation/workspace locks continuously.
 * No state, proof or permission is reused across invocations or SQL phases. */
export async function inspectCollaborationAdmissionQuiescenceSet(database: SqlConnection, captured: CapturedRequest,
  documentIds: readonly string[]): Promise<readonly Awaited<ReturnType<typeof inspectProofRows>>[]> {
  const requestedIds = Object.freeze([...documentIds]), selectedIds = new Set(requestedIds);
  const expected = captured.request.expectedDocuments.filter(document => selectedIds.has(document.documentId));
  if (expected.length !== requestedIds.length || selectedIds.size !== requestedIds.length
    || expected.some((document, index) => document.documentId !== requestedIds[index])) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  if (!expected.length) return Object.freeze([]);
  const header = await database.get('SELECT * FROM collaboration_admission_requests WHERE request_id = $1 FOR UPDATE',
    [captured.request.requestId]) as Row | undefined;
  assertProofHeader(header, captured);
  const targetRows = await database.all(`SELECT * FROM collaboration_admission_targets
    WHERE request_id = $1 AND document_id = ANY($2::text[]) ORDER BY document_id COLLATE "C" FOR UPDATE`,
  [captured.request.requestId, requestedIds]) as Row[];
  const targetById = new Map(targetRows.map(row => [row.document_id, row]));
  if (targetRows.length !== expected.length || targetById.size !== expected.length
    || requestedIds.some(id => !targetById.has(id))) throw new CollaborationAdmissionError('ADMISSION_STATE_CHANGED');
  const targets = expected.map(document => captureProofTarget(targetById.get(document.documentId), document));
  const rows = await database.all(`SELECT * FROM collaboration_yjs_states
    WHERE document_id = ANY($1::text[]) ORDER BY document_id COLLATE "C" FOR UPDATE`, [requestedIds]) as Row[];
  const stateById = new Map(rows.map(row => [row.document_id, row]));
  if (rows.length !== expected.length || stateById.size !== expected.length
    || requestedIds.some(id => !stateById.has(id))) throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED');
  const result = [];
  for (const [index, document] of expected.entries()) {
    result.push(await inspectProofRows(database, captured, { expected: document, header,
      target: targets[index], row: stateById.get(document.documentId)! }));
  }
  return Object.freeze(result);
}

/** Borrowed DA03 mechanics only; the caller owns current authorization, the
 * actual connection/transaction and the commit/recovery boundary. The optional
 * wait policy changes only the bounded lock timeout, never authority. */
export async function proveCollaborationAdmissionQuiescenceOnConnection(database: SqlConnection,
  input: CollaborationAdmissionRequest, documentId: string,
  wait: Readonly<{ lockTimeout: '50ms' | '4s' }> = { lockTimeout: '4s' },
): Promise<CollaborationAdmissionQuiescenceProof> {
  const captured = captureCollaborationAdmissionRequest(input);
  const timeout = wait && Object.getOwnPropertyDescriptor(wait, 'lockTimeout');
  if (!captured.request.expectedDocuments.some((document) => document.documentId === documentId)
    || !wait || Object.getPrototypeOf(wait) !== Object.prototype || Reflect.ownKeys(wait).length !== 1
    || !timeout?.enumerable || !Object.hasOwn(timeout, 'value') || !['50ms', '4s'].includes(timeout.value)) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  await lockProofRoom(database, documentId, timeout.value === '50ms');
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
}

/**
 * Materializes a retained DA03 proof, NOT lifecycle mutation authority.
 * Active targets keep blocking claims after this transaction releases its guard.
 * DA04 must reacquire the guard and revalidate the complete proof before writing.
 * openConnection must support bounded queries and close(error) must destroy an
 * uncertain backend before recovery. Nothing installs this service by default.
 */
export function createCollaborationAdmissionQuiescenceService(options: {
  openConnection: () => Promise<SqlConnection>;
  withMutationTransaction?: RichMigrationTransaction;
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
          const execute = () => proveCollaborationAdmissionQuiescenceOnConnection(database, captured.request,
            documentId, { lockTimeout: options.withMutationTransaction ? '50ms' : '4s' });
          return options.withMutationTransaction ? options.withMutationTransaction(database, execute) : execute();
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
