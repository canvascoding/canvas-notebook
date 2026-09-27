import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Client } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import {
  captureCollaborationAdmissionRequest,
  CollaborationAdmissionError,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import {
  admissionDrainTicketForTarget,
  lockCollaborationAdmissionDrain,
  readCollaborationAdmissionTerminalDrain,
} from '../app/lib/collaboration/room-admission-drain';
import { collaborationAdmissionOutcomeDigest } from '../app/lib/collaboration/room-admission-outcome';
import {
  createCollaborationAdmissionService,
  type CollaborationAdmissionTarget,
} from '../app/lib/collaboration/room-admission';
import {
  collaborationRoomReleaseDigest,
  CollaborationRoomReleaseError,
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseReceipt,
  type CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';

type Row = Record<string, unknown>;

function fixture() {
  const document = Object.freeze({ documentId: 'terminal-finish-doc', workspaceId: 'workspace-a', organizationId: null,
    path: 'terminal-finish.txt', representation: 'plain_text' as const, lifecycleGeneration: 4, schemaVersion: 1,
    status: 'active' as const });
  const request: CollaborationAdmissionRequest = Object.freeze({
    requestId: '123e4567-e89b-42d3-a456-426614174000', actorId: 'actor-a', action: 'archive',
    actionDigest: 'a'.repeat(64), scopes: Object.freeze([{ workspaceId: document.workspaceId,
      organizationId: document.organizationId, path: document.path, kind: 'exact' as const }]),
    expectedDocuments: Object.freeze([document]),
  });
  const captured = captureCollaborationAdmissionRequest(request);
  const ydoc = new Y.Doc({ gc: false });
  ydoc.getText('content').insert(0, 'durable terminal bytes');
  const yjsState = new Uint8Array(Y.encodeStateAsUpdate(ydoc));
  const stateVector = new Uint8Array(Y.encodeStateVector(ydoc));
  const target: CollaborationAdmissionTarget = Object.freeze({ document, ownerEpoch: 9,
    ownerToken: 'old-owner-token', ownerBackendPid: 4321, ownerBackendStart: '1727370000.12345',
    documentSequence: 31, persistedUpdateHash: collaborationRoomReleaseDigest('update', yjsState),
    persistedVectorHash: collaborationRoomReleaseDigest('vector', stateVector) });
  const ticket = admissionDrainTicketForTarget(captured.request.requestId, captured.requestDigest, target);
  const receipt: CollaborationRoomReleaseReceipt = Object.freeze({
    release_id: ticket.releaseId, document_id: document.documentId, workspace_id: document.workspaceId,
    organization_id: document.organizationId, path: document.path, representation: document.representation,
    lifecycle_generation: document.lifecycleGeneration, schema_version: document.schemaVersion,
    owner_epoch: target.ownerEpoch, owner_token: target.ownerToken!, owner_backend_pid: target.ownerBackendPid!,
    owner_backend_start: target.ownerBackendStart!, document_sequence: target.documentSequence,
    persisted_update_hash: target.persistedUpdateHash!, persisted_vector_hash: target.persistedVectorHash!,
    live_update_hash: collaborationRoomReleaseDigest('update', yjsState),
    live_vector_hash: collaborationRoomReleaseDigest('vector', stateVector),
  });
  const current = Object.freeze({ document, ownerEpoch: target.ownerEpoch, ownerToken: null,
    ownerBackendPid: null, ownerBackendStart: null, documentSequence: target.documentSequence,
    persistedUpdateHash: receipt.persisted_update_hash, persistedVectorHash: receipt.persisted_vector_hash });
  const originalSnapshotText = JSON.stringify(target);
  const quiescenceText = JSON.stringify({ version: 1, requestId: captured.request.requestId,
    requestDigest: captured.requestDigest,
    snapshotDigest: collaborationRoomReleaseDigestForTest(originalSnapshotText), kind: 'owner_drain', current, receipt });
  const outcomeSnapshot = Object.freeze({ document, ownerEpoch: target.ownerEpoch, ownerToken: null,
    ownerBackendPid: null, ownerBackendStart: null, documentSequence: target.documentSequence,
    persistedUpdateHash: receipt.persisted_update_hash, persistedVectorHash: receipt.persisted_vector_hash });
  const outcomeSnapshotText = JSON.stringify(outcomeSnapshot);
  const outcome = Object.freeze({ version: 1 as const, requestId: captured.request.requestId,
    requestDigest: captured.requestDigest, result: Object.freeze({ status: 'archived' }),
    targets: Object.freeze([{ documentId: document.documentId,
      proofDigest: collaborationAdmissionOutcomeDigest('input', quiescenceText),
      snapshotText: outcomeSnapshotText,
      snapshotDigest: collaborationAdmissionOutcomeDigest('snapshot', outcomeSnapshotText) }]) });
  const header: Row = { request_id: captured.request.requestId, request_digest: captured.requestDigest,
    intent_text: captured.intentText, status: 'committed', revision: 3, outcome_text: JSON.stringify(outcome) };
  const targetRow: Row = { request_id: captured.request.requestId, document_id: document.documentId,
    snapshot_text: originalSnapshotText, status: 'completed', active: false, release_id: ticket.releaseId,
    quiescence_kind: 'owner_drain', quiescence_text: quiescenceText,
    outcome_snapshot_text: outcomeSnapshotText,
    outcome_snapshot_digest: collaborationAdmissionOutcomeDigest('snapshot', outcomeSnapshotText) };
  const snapshot: CollaborationRoomReleaseSnapshot = Object.freeze({ releaseId: ticket.releaseId, admission: ticket,
    yjsState: new Uint8Array(yjsState), stateVector: new Uint8Array(stateVector) });
  return { ydoc, captured, target, ticket, receipt, header, targetRow, snapshot };
}

function collaborationRoomReleaseDigestForTest(text: string): string {
  return createHash('sha256').update('canvas.admission-quiescence.snapshot.v1\0').update(text).digest('hex');
}

function connection(f: ReturnType<typeof fixture>, overrides: { target?: Row; header?: Row } = {}) {
  const calls: string[] = [];
  const header = overrides.header ?? f.header;
  const target = overrides.target ?? f.targetRow;
  const database: SqlConnection = {
    get: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM collaboration_admission_requests')) return header;
      if (sql.includes('FROM collaboration_admission_targets')) return target;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    all: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM collaboration_admission_targets') && sql.includes('ORDER BY document_id')) return [target];
      if (sql.includes('JOIN collaboration_admission_targets')) return [{ ...target,
        request_id: header.request_id, request_digest: header.request_digest, request_status: header.status }];
      throw new Error(`Unexpected all query: ${sql}`);
    },
    run: async (sql) => { calls.push(sql); return { changes: 0 }; },
    close: async () => { calls.push('CLOSE'); },
  };
  return { database, calls };
}

function client(f: ReturnType<typeof fixture>, overrides: { receipt?: Row; target?: Row } = {}) {
  const db = connection(f, { target: overrides.target });
  const calls: string[] = [];
  const pg = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql === 'BEGIN') return { rows: [], rowCount: null };
      if (sql.includes('FROM collaboration_room_release_receipts')) {
        return { rows: [overrides.receipt ?? f.receipt], rowCount: 1 };
      }
      if (sql.includes('FROM collaboration_yjs_states') || sql.includes('pg_try_advisory_lock')) {
        throw new Error('Terminal local finish must not inspect current state or acquire the current room guard.');
      }
      if (sql.includes('FROM collaboration_admission_requests')) return { rows: [f.header], rowCount: 1 };
      if (sql.includes('FROM collaboration_admission_targets') && sql.includes('ORDER BY document_id')) {
        return { rows: [overrides.target ?? f.targetRow], rowCount: 1 };
      }
      if (sql.includes('FROM collaboration_admission_targets')) {
        return { rows: [overrides.target ?? f.targetRow], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${sql} ${JSON.stringify(values)}`);
    },
    end: async () => { calls.push('END'); },
  };
  return { pg: pg as unknown as Pick<Client, 'query' | 'end'>, calls, db };
}

test('committed owner drain remains readable and pollable as an exact released ticket', async () => {
  const f = fixture();
  try {
    const direct = connection(f);
    assert.deepEqual(await readCollaborationAdmissionTerminalDrain(direct.database, f.ticket), {
      ticket: f.ticket, status: 'released', quiescenceText: f.targetRow.quiescence_text,
    });

    const opened: ReturnType<typeof connection>[] = [];
    const service = createCollaborationAdmissionService({ openConnection: async () => {
      const item = connection(f);
      opened.push(item);
      return item.database;
    } });
    assert.deepEqual(await service.readDrain(f.ticket), { ticket: f.ticket, status: 'released' });
    assert.deepEqual(await service.pendingDrains([f.ticket.fence]), [f.ticket]);
    assert.ok(opened.length >= 2);

    await assert.rejects(lockCollaborationAdmissionDrain(async (sql) => {
      if (sql.includes('collaboration_admission_requests')) return [f.header];
      throw new Error('A terminal header must fail before reading its target.');
    }, f.ticket, 'draining'), (error: unknown) => error instanceof CollaborationAdmissionError
      && error.code === 'ADMISSION_STATE_CHANGED');
  } finally { f.ydoc.destroy(); }
});

test('receipt-only terminal recovery verifies old bytes and never reads advanced current state or room guard', async () => {
  const f = fixture();
  try {
    const recovery = client(f);
    assert.deepEqual(await recoverCollaborationRoomRelease({ createClient: async () => recovery.pg,
      fence: f.ticket.fence, snapshot: f.snapshot }), f.receipt);
    assert.equal(recovery.calls.some((sql) => sql.includes('pg_try_advisory_lock')), false);
    assert.equal(recovery.calls.some((sql) => sql.includes('collaboration_yjs_states')), false);
    assert.equal(recovery.calls.at(-1), 'END');
  } finally { f.ydoc.destroy(); }
});

test('terminal recovery rejects proof, stored receipt, and deletion-only live-byte drift', async () => {
  const f = fixture();
  try {
    const tamperedTarget = { ...f.targetRow, quiescence_text: `${f.targetRow.quiescence_text as string} ` };
    await assert.rejects(readCollaborationAdmissionTerminalDrain(connection(f, { target: tamperedTarget }).database, f.ticket),
      (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_RECOVERY_REQUIRED');

    const wrongReceipt = { ...f.receipt, live_update_hash: 'f'.repeat(64) };
    const badReceipt = client(f, { receipt: wrongReceipt });
    await assert.rejects(recoverCollaborationRoomRelease({ createClient: async () => badReceipt.pg,
      fence: f.ticket.fence, snapshot: f.snapshot }), CollaborationRoomReleaseError);

    const changed = new Y.Doc({ gc: false });
    Y.applyUpdate(changed, f.snapshot.yjsState);
    const beforeVector = new Uint8Array(Y.encodeStateVector(changed));
    changed.getText('content').delete(0, 1);
    const deletionSnapshot = { ...f.snapshot, yjsState: new Uint8Array(Y.encodeStateAsUpdate(changed)),
      stateVector: new Uint8Array(Y.encodeStateVector(changed)) };
    assert.deepEqual(deletionSnapshot.stateVector, beforeVector,
      'the deletion changes full update bytes without advancing the state vector');
    const drift = client(f);
    await assert.rejects(recoverCollaborationRoomRelease({ createClient: async () => drift.pg,
      fence: f.ticket.fence, snapshot: deletionSnapshot }), CollaborationRoomReleaseError);
    changed.destroy();
  } finally { f.ydoc.destroy(); }
});
