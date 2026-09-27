import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';

import {
  CollaborationRoomReleaseError,
  collaborationRoomReleaseDigest,
  validateCollaborationRoomReleaseReceipt,
} from '../app/lib/collaboration/room-owner-release';

function fixture() {
  const doc = new Y.Doc({ gc: false });
  doc.getText('content').insert(0, 'alpha beta');
  const update = new Uint8Array(Y.encodeStateAsUpdate(doc));
  const vector = new Uint8Array(Y.encodeStateVector(doc));
  const row: Record<string, unknown> = {
    document_id: 'proof-document',
    workspace_id: 'proof-workspace',
    organization_id: null,
    path: 'notes/proof.txt',
    representation: 'plain_text',
    lifecycle_generation: '3',
    schema_version: '1',
    status: 'active',
    room_owner_epoch: '7',
    room_owner_token: null,
    room_owner_backend_pid: null,
    room_owner_backend_start: null,
    document_sequence: '19',
    yjs_state: update,
    state_vector: vector,
  };
  const receipt: Record<string, unknown> = {
    release_id: '6d713b83-c99b-4f27-a08a-9cf0289f9db3',
    document_id: row.document_id,
    workspace_id: row.workspace_id,
    organization_id: row.organization_id,
    path: row.path,
    representation: row.representation,
    lifecycle_generation: '3',
    schema_version: '1',
    owner_epoch: '7',
    owner_token: 'released-owner-token',
    owner_backend_pid: '2718',
    owner_backend_start: '1790470800.12345',
    document_sequence: '19',
    persisted_update_hash: collaborationRoomReleaseDigest('update', update),
    persisted_vector_hash: collaborationRoomReleaseDigest('vector', vector),
    // The validator checks these immutable metadata hashes structurally, but
    // cannot and must not reconstruct the original live room buffers.
    live_update_hash: 'a'.repeat(64),
    live_vector_hash: 'b'.repeat(64),
  };
  return { doc, row, receipt };
}

function rejects(row: Record<string, unknown>, receipt: Record<string, unknown>) {
  assert.throws(() => validateCollaborationRoomReleaseReceipt(row, receipt), CollaborationRoomReleaseError);
}

test('release proof validates exact persisted bytes and normalizes PostgreSQL numeric strings', () => {
  const value = fixture();
  try {
    const receipt = validateCollaborationRoomReleaseReceipt(value.row, value.receipt);
    assert.equal(receipt.lifecycle_generation, 3);
    assert.equal(receipt.schema_version, 1);
    assert.equal(receipt.owner_epoch, 7);
    assert.equal(receipt.owner_backend_pid, 2718);
    assert.equal(receipt.document_sequence, 19);
    assert.equal(receipt.live_update_hash, 'a'.repeat(64));
    assert.equal(receipt.live_vector_hash, 'b'.repeat(64));
    assert.ok(Object.isFrozen(receipt));
  } finally { value.doc.destroy(); }
});

test('release proof compares the complete persisted update when a deletion leaves the vector unchanged', () => {
  const value = fixture();
  try {
    const beforeDelete = new Uint8Array(value.row.yjs_state as Uint8Array);
    const vectorBeforeDelete = new Uint8Array(value.row.state_vector as Uint8Array);
    value.doc.getText('content').delete(6, 4);
    const afterDelete = new Uint8Array(Y.encodeStateAsUpdate(value.doc));
    const vectorAfterDelete = new Uint8Array(Y.encodeStateVector(value.doc));
    assert.deepEqual(vectorAfterDelete, vectorBeforeDelete);
    assert.notDeepEqual(afterDelete, beforeDelete);

    value.row.yjs_state = afterDelete;
    value.row.state_vector = vectorAfterDelete;
    value.receipt.persisted_update_hash = collaborationRoomReleaseDigest('update', afterDelete);
    value.receipt.persisted_vector_hash = collaborationRoomReleaseDigest('vector', vectorAfterDelete);
    assert.doesNotThrow(() => validateCollaborationRoomReleaseReceipt(value.row, value.receipt));

    rejects(value.row, {
      ...value.receipt,
      persisted_update_hash: collaborationRoomReleaseDigest('update', beforeDelete),
    });
  } finally { value.doc.destroy(); }
});

test('release proof rejects every current scope, epoch, or sequence mismatch', () => {
  const value = fixture();
  try {
    const mismatches: Array<[string, unknown]> = [
      ['document_id', 'other-document'],
      ['workspace_id', 'other-workspace'],
      ['organization_id', 'other-organization'],
      ['path', 'notes/other.txt'],
      ['representation', 'tiptap_xml'],
      ['lifecycle_generation', '4'],
      ['schema_version', '2'],
      ['room_owner_epoch', '8'],
      ['document_sequence', '20'],
      ['status', 'archived'],
    ];
    for (const [field, replacement] of mismatches) {
      rejects({ ...value.row, [field]: replacement }, value.receipt);
    }
    rejects(value.row, { ...value.receipt, lifecycle_generation: '9007199254740992' });
    rejects(value.row, { ...value.receipt, owner_epoch: '7.5' });
  } finally { value.doc.destroy(); }
});

test('release proof requires a vacant current owner tuple and a valid historical owner tuple', () => {
  const value = fixture();
  try {
    rejects({ ...value.row, room_owner_token: 'replacement-owner' }, value.receipt);
    rejects({ ...value.row, room_owner_backend_pid: 4444 }, value.receipt);
    rejects({ ...value.row, room_owner_backend_start: '1790470900.12345' }, value.receipt);
    rejects(value.row, { ...value.receipt, owner_token: '' });
    rejects(value.row, { ...value.receipt, owner_backend_pid: '0' });
    rejects(value.row, { ...value.receipt, owner_backend_start: null });
  } finally { value.doc.destroy(); }
});

test('release proof rejects hash corruption, malformed updates, and incoherent state vectors', () => {
  const value = fixture();
  try {
    for (const field of ['persisted_update_hash', 'persisted_vector_hash', 'live_update_hash', 'live_vector_hash']) {
      rejects(value.row, { ...value.receipt, [field]: 'f'.repeat(63) });
      rejects(value.row, { ...value.receipt, [field]: 'F'.repeat(64) });
    }

    const malformed = new Uint8Array([255, 1, 2, 3]);
    rejects({ ...value.row, yjs_state: malformed }, {
      ...value.receipt,
      persisted_update_hash: collaborationRoomReleaseDigest('update', malformed),
    });

    const incoherentVector = new Uint8Array([0]);
    rejects({ ...value.row, state_vector: incoherentVector }, {
      ...value.receipt,
      persisted_vector_hash: collaborationRoomReleaseDigest('vector', incoherentVector),
    });
  } finally { value.doc.destroy(); }
});
