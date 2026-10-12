import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { assertCollaborationDocumentIdleReleaseProof, ensureCollaborationDocumentIdleReleased } from '../app/lib/collaboration/document-idle-release';
import { installLocalCollaborationRoomDrainer } from '../app/lib/collaboration/local-room-drain';
import { CollaborationRoomOwnerError, type CollaborationRoomOwnerFence } from '../app/lib/collaboration/room-owner';
import { collaborationRoomReleaseDigest } from '../app/lib/collaboration/room-owner-release';

function fixture() {
  const scope = { documentId: 'document-idle-release', workspaceId: 'workspace', organizationId: null,
    path: 'moved/A.md', representation: 'plain_text' as const, lifecycleGeneration: 2, schemaVersion: 1 };
  const fence: CollaborationRoomOwnerFence = { scope, epoch: 3, token: 'exact-owner-token', backendPid: 123,
    backendStart: '1234.5' };
  const doc = new Y.Doc(); doc.getText('content').insert(0, '[[B]]\n');
  const update = Y.encodeStateAsUpdate(doc); const vector = Y.encodeStateVector(doc); doc.destroy();
  const row: Record<string, unknown> = { document_id: scope.documentId, workspace_id: scope.workspaceId,
    organization_id: null, path: scope.path, representation: scope.representation, lifecycle_generation: 2,
    schema_version: 1, status: 'active', degraded: 0, room_owner_epoch: 3, room_owner_token: null,
    room_owner_backend_pid: null, room_owner_backend_start: null, document_sequence: 7,
    yjs_state: update, state_vector: vector };
  const receipt: Record<string, unknown> = { release_id: 'b9c4e09e-9b29-4886-8c8e-355931a4674a',
    document_id: scope.documentId, workspace_id: scope.workspaceId, organization_id: null, path: scope.path,
    representation: scope.representation, lifecycle_generation: 2, schema_version: 1,
    owner_epoch: 3, owner_token: fence.token, owner_backend_pid: fence.backendPid, owner_backend_start: fence.backendStart,
    document_sequence: 7, persisted_update_hash: collaborationRoomReleaseDigest('update', update),
    persisted_vector_hash: collaborationRoomReleaseDigest('vector', vector),
    live_update_hash: collaborationRoomReleaseDigest('update', update), live_vector_hash: collaborationRoomReleaseDigest('vector', vector) };
  let held: boolean | undefined = false;
  let receipts = [receipt];
  let state: Record<string, unknown> | undefined = row;
  const database: SqlConnection = {
    get: async sql => sql.includes('FROM pg_locks') ? { held } : state,
    all: async () => receipts, run: async () => {}, close: async () => {},
  };
  return { scope, fence, row, receipt, database,
    held(value: boolean | undefined) { held = value; }, receipts(value: typeof receipts) { receipts = value; },
    state(value: typeof state) { state = value; } };
}

async function main() {
  const proven = fixture();
  await assertCollaborationDocumentIdleReleaseProof(proven.database, proven.scope, proven.fence);
  // Restarted batch: exact immutable SQL release still proves vacancy without a local Doc handle.
  await assertCollaborationDocumentIdleReleaseProof(proven.database, proven.scope);
  const postgresBigints = fixture();
  postgresBigints.row.degraded = '0'; postgresBigints.row.room_owner_epoch = '3';
  await assertCollaborationDocumentIdleReleaseProof(postgresBigints.database, postgresBigints.scope, postgresBigints.fence);
  let refused = 0;
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.row.path = 'different/A.md'; },
    (f: ReturnType<typeof fixture>) => { f.row.lifecycle_generation = 3; },
    (f: ReturnType<typeof fixture>) => { f.row.room_owner_token = 'replacement-owner'; },
    (f: ReturnType<typeof fixture>) => { f.row.room_owner_backend_pid = 456; },
    (f: ReturnType<typeof fixture>) => { f.row.degraded = 1; },
    (f: ReturnType<typeof fixture>) => { f.row.degraded = null; },
    (f: ReturnType<typeof fixture>) => { f.receipts([]); },
    (f: ReturnType<typeof fixture>) => { f.receipts([f.receipt, f.receipt]); },
    (f: ReturnType<typeof fixture>) => { f.receipt.owner_token = 'other-token'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.document_sequence = 6; },
    (f: ReturnType<typeof fixture>) => { f.row.yjs_state = Uint8Array.of(1, 2); },
    (f: ReturnType<typeof fixture>) => { f.held(true); },
    (f: ReturnType<typeof fixture>) => { f.held(undefined); },
    (f: ReturnType<typeof fixture>) => { f.state(undefined); },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(assertCollaborationDocumentIdleReleaseProof(f.database, f.scope, f.fence)); refused++;
  }
  const neverClaimed = fixture(); neverClaimed.row.room_owner_epoch = 0; neverClaimed.receipts([]);
  await assertCollaborationDocumentIdleReleaseProof(neverClaimed.database, neverClaimed.scope);
  await assert.rejects(ensureCollaborationDocumentIdleReleased({ scope: proven.scope, operationId: 'batch-undo' }),
    (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_UNAVAILABLE');
  let calls = 0;
  const uninstall = installLocalCollaborationRoomDrainer({ drain: async () => {}, releaseIdle: async input => {
    assert(Object.isFrozen(input) && Object.isFrozen(input.scope));
    assert.equal(input.scope.path, proven.scope.path); assert.equal(input.operationId, 'batch-undo'); calls++;
  } });
  await ensureCollaborationDocumentIdleReleased({ scope: proven.scope, operationId: 'batch-undo' });
  uninstall(); assert.equal(calls, 1);
  console.log(`Collaboration idle release proof passed: exact receipt/current-state/advisory vacancy, restart, ${refused} refusal cases and private bridge.`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
