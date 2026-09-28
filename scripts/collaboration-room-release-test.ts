import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'pg';
import * as Y from 'yjs';

import {
  CollaborationRoomReleaseError,
  recordCollaborationRoomRelease,
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseReceipt,
} from '../app/lib/collaboration/room-owner-release';
import { lockIdentity } from '../app/lib/collaboration/room-owner';
import type {
  CollaborationRoomOwnerFence,
  CollaborationRoomOwnerRow,
  CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';

const RELEASE_FIELDS = [
  'release_id', 'document_id', 'workspace_id', 'organization_id', 'path', 'representation',
  'lifecycle_generation', 'schema_version', 'owner_epoch', 'owner_token', 'owner_backend_pid',
  'owner_backend_start', 'document_sequence', 'persisted_update_hash', 'persisted_vector_hash',
  'live_update_hash', 'live_vector_hash',
] as const;

function fixture(documentId = 'release-doc') {
  const scope: CollaborationRoomOwnerScope = Object.freeze({
    documentId,
    workspaceId: 'workspace-a',
    organizationId: null,
    path: `${documentId}.txt`,
    representation: 'plain_text',
    lifecycleGeneration: 3,
    schemaVersion: 1,
  });
  const fence: CollaborationRoomOwnerFence = Object.freeze({
    scope,
    epoch: 8,
    token: 'room-owner-token',
    backendPid: 2345,
    backendStart: '1727370000.12345',
  });
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'alpha beta');
  const yjsState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  const snapshot = {
    releaseId: '2d607a15-c32c-41aa-b19f-425cde6ae803',
    yjsState: new Uint8Array(yjsState),
    stateVector: new Uint8Array(stateVector),
  };
  const row: CollaborationRoomOwnerRow & { document_sequence: number; yjs_state: Uint8Array; state_vector: Uint8Array } = {
    document_id: scope.documentId,
    workspace_id: scope.workspaceId,
    organization_id: scope.organizationId,
    path: scope.path,
    representation: scope.representation,
    lifecycle_generation: scope.lifecycleGeneration,
    schema_version: scope.schemaVersion,
    status: 'active',
    room_owner_epoch: fence.epoch,
    room_owner_token: fence.token,
    room_owner_backend_pid: fence.backendPid,
    room_owner_backend_start: fence.backendStart,
    document_sequence: 21,
    yjs_state: new Uint8Array(yjsState),
    state_vector: new Uint8Array(stateVector),
  };
  const inserted: Record<string, unknown>[] = [];
  const recordEvents: string[] = [];
  const query = async (sql: string, _values?: unknown[]) => {
    recordEvents.push(sql.includes('SELECT EXISTS') ? 'holder' : 'insert');
    if (sql.includes('SELECT EXISTS')) return [{ held: true }];
    const values = _values ?? [];
    inserted.push(Object.fromEntries(RELEASE_FIELDS.map((field, index) => [field, values[index]])));
    return [];
  };
  return { doc, scope, fence, row, snapshot, inserted, recordEvents, query };
}

async function record(f: ReturnType<typeof fixture>) {
  await recordCollaborationRoomRelease({ query: f.query, row: f.row, fence: f.fence, snapshot: f.snapshot });
  return f.inserted[0] as unknown as CollaborationRoomReleaseReceipt;
}

function persistedRow(f: ReturnType<typeof fixture>, overrides: Partial<typeof f.row> = {}) {
  return {
    ...f.row,
    room_owner_token: null,
    room_owner_backend_pid: null,
    room_owner_backend_start: null,
    ...overrides,
  };
}

function recoveryClient(input: {
  stateRow: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  locked?: boolean;
}) {
  const events: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let endCalls = 0;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_try_advisory_lock')) {
        events.push('try-advisory');
        return { rows: [{ locked: input.locked ?? true }] };
      }
      if (sql === 'BEGIN') { events.push('begin'); return { rows: [] }; }
      if (sql.includes('FROM collaboration_yjs_states')) {
        events.push('state-row');
        return { rows: [input.stateRow] };
      }
      if (sql.includes('FROM collaboration_room_release_receipts')) {
        events.push('receipt');
        return { rows: input.receipt ? [input.receipt] : [] };
      }
      throw new Error(`Unexpected recovery query: ${sql}`);
    },
    end: async () => { endCalls += 1; events.push('end'); },
  };
  return {
    client: client as unknown as Pick<Client, 'query' | 'end'>,
    events,
    calls,
    get endCalls() { return endCalls; },
  };
}

test('release receipt binds the durably stored Yjs update including a causal deletion', async () => {
  const f = fixture('release-deletion');
  const beforeDelete = Y.encodeStateAsUpdate(f.doc);
  const vectorBeforeDelete = Y.encodeStateVector(f.doc);
  f.doc.getText('content').delete(6, 4);
  f.snapshot.yjsState = new Uint8Array(Y.encodeStateAsUpdate(f.doc));
  f.snapshot.stateVector = new Uint8Array(Y.encodeStateVector(f.doc));
  f.row.yjs_state = new Uint8Array(f.snapshot.yjsState);
  f.row.state_vector = new Uint8Array(f.snapshot.stateVector);
  try {
    assert.deepEqual(f.snapshot.stateVector, vectorBeforeDelete,
      'a Yjs deletion changes the update but does not advance the state vector');
    assert.notDeepEqual(f.snapshot.yjsState, beforeDelete, 'the deletion set is present in the release update');

    const receipt = await record(f);

    assert.equal(receipt.persisted_update_hash, receipt.live_update_hash,
      'the receipt commits the same deletion-bearing bytes that are durable');
    assert.equal(receipt.persisted_vector_hash, receipt.live_vector_hash);
    assert.deepEqual(f.recordEvents, ['holder', 'insert']);
    assert.equal(f.inserted.length, 1);
    assert.equal(f.inserted[0]?.release_id, f.snapshot.releaseId);
    assert.equal(f.inserted[0]?.document_sequence, f.row.document_sequence);
  } finally { f.doc.destroy(); }
});

test('release receipt rejects an unsaved deletion even when live and stored vectors match', async () => {
  const f = fixture('release-unsaved-deletion');
  const durableState = new Uint8Array(f.row.yjs_state);
  const durableVector = new Uint8Array(f.row.state_vector);
  f.doc.getText('content').delete(6, 4);
  f.snapshot.yjsState = new Uint8Array(Y.encodeStateAsUpdate(f.doc));
  f.snapshot.stateVector = new Uint8Array(Y.encodeStateVector(f.doc));
  try {
    assert.deepEqual(f.snapshot.stateVector, durableVector,
      'the unsaved deletion deliberately leaves the state vector unchanged');
    assert.notDeepEqual(f.snapshot.yjsState, durableState);

    await assert.rejects(recordCollaborationRoomRelease({
      query: f.query, row: f.row, fence: f.fence, snapshot: f.snapshot,
    }), CollaborationRoomReleaseError);

    assert.deepEqual(f.recordEvents, ['holder']);
    assert.equal(f.inserted.length, 0, 'no receipt is written for deletion bytes absent from the stored update');
  } finally { f.doc.destroy(); }
});

test('release receipt rejects incoherent stored or live state vectors', async () => {
  const f = fixture('release-vector-mismatch');
  const validStoredVector = new Uint8Array(f.row.state_vector);
  const invalidVector = new Y.Doc();
  invalidVector.getText('content').insert(0, 'unrelated');
  try {
    f.row.state_vector = Y.encodeStateVector(invalidVector);
    await assert.rejects(recordCollaborationRoomRelease({
      query: f.query, row: f.row, fence: f.fence, snapshot: f.snapshot,
    }), CollaborationRoomReleaseError);
    assert.equal(f.inserted.length, 0);

    f.row.state_vector = validStoredVector;
    f.snapshot.stateVector = new Uint8Array(Y.encodeStateVector(invalidVector));
    await assert.rejects(recordCollaborationRoomRelease({
      query: f.query, row: f.row, fence: f.fence, snapshot: f.snapshot,
    }), CollaborationRoomReleaseError);
    assert.equal(f.inserted.length, 0);
  } finally { invalidVector.destroy(); f.doc.destroy(); }
});

test('release recovery locks the advisory identity before BEGIN and row lookup, then ends once', async () => {
  const f = fixture('release-recovery-success');
  try {
    const receipt = await record(f);
    const pg = recoveryClient({ stateRow: persistedRow(f), receipt });

    const recovered = await recoverCollaborationRoomRelease({
      createClient: async () => pg.client,
      fence: f.fence,
      snapshot: f.snapshot,
    });

    assert.deepEqual(recovered, receipt);
    assert.deepEqual(pg.events, ['try-advisory', 'begin', 'state-row', 'receipt', 'end']);
    assert.equal(pg.calls[0]?.sql.includes('pg_try_advisory_lock'), true);
    assert.equal(pg.calls[0]?.values[0], lockIdentity(f.scope.documentId).key);
    assert.equal(pg.calls[1]?.sql, 'BEGIN');
    assert.match(pg.calls[2]?.sql ?? '', /FOR UPDATE/u);
    assert.equal(pg.endCalls, 1);
  } finally { f.doc.destroy(); }
});

test('release recovery rejects stale receipt, changed scope, and a newer owner epoch; always ending once', async () => {
  const f = fixture('release-recovery-rejections');
  try {
    const receipt = await record(f);
    const cases: Array<{ name: string; stateRow: Record<string, unknown>; fence?: CollaborationRoomOwnerFence }> = [
      { name: 'stale receipt', stateRow: persistedRow(f) },
      { name: 'changed scope', stateRow: persistedRow(f), fence: { ...f.fence,
        scope: { ...f.scope, path: 'renamed.txt' } } },
      { name: 'new owner epoch', stateRow: persistedRow(f, { room_owner_epoch: f.fence.epoch + 1 }) },
    ];

    for (const item of cases) {
      const pg = recoveryClient({ stateRow: item.stateRow, receipt: item.name === 'stale receipt' ? undefined : receipt });
      await assert.rejects(recoverCollaborationRoomRelease({
        createClient: async () => pg.client,
        fence: item.fence ?? f.fence,
        snapshot: f.snapshot,
      }), CollaborationRoomReleaseError, item.name);
      assert.equal(pg.endCalls, 1, `${item.name}: dedicated client ends exactly once`);
      assert.equal(pg.events.at(-1), 'end');
    }
  } finally { f.doc.destroy(); }
});

test('failed advisory acquisition rejects without BEGIN or state read and still ends once', async () => {
  const f = fixture('release-recovery-advisory-busy');
  try {
    const pg = recoveryClient({ stateRow: persistedRow(f), locked: false });
    await assert.rejects(recoverCollaborationRoomRelease({
      createClient: async () => pg.client,
      fence: f.fence,
      snapshot: f.snapshot,
    }), CollaborationRoomReleaseError);
    assert.deepEqual(pg.events, ['try-advisory', 'end']);
    assert.equal(pg.endCalls, 1);
  } finally { f.doc.destroy(); }
});
