/** Test-only SQL observation. It never grants admission or performs a room release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { ownedYjsStateFromSqlRow, type OwnedYjsStorageRow } from './owned-yjs-authority-storage-row';

export type OwnedRestartRoomInput = {
  documentId: string; path: string; generation: number;
  expectedWorkspaceId?: string; expectedOwnerEpoch?: number; expectedScopeProof?: string;
};
export type OwnedRestartRoomEvidence = {
  scopeProof: string; ownerEpoch: number; ownerTupleCleared: boolean; ownerTupleComplete: boolean; advisoryLockHeld: boolean;
  releaseReceiptValid: boolean; admissionPending: boolean; released: boolean;
  version: { sequence: number; stateProof: string; yjsSha256: string; vectorSha256: string };
};
type Row = OwnedYjsStorageRow & {
  room_owner_epoch: number | string; room_owner_token: string | null;
  room_owner_backend_pid: number | null; room_owner_backend_start: string | null;
  registry_workspace_id: string; registry_organization_id: string | null; registry_path: string;
  registry_status: string; registry_state_version: number | string; registry_lineage_id: string | null;
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function integer(value: unknown, minimum: number): number {
  assert(typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value));
  const number = Number(value); assert(Number.isSafeInteger(number) && number >= minimum);
  return number;
}

/** Caller must prove ownership of its target before connecting and retain a READ ONLY transaction. */
export async function readOwnedRestartRoomOnConnection(database: Pick<Client, 'query'>,
  input: OwnedRestartRoomInput): Promise<OwnedRestartRoomEvidence> {
  assert(input.documentId && input.documentId.length <= 256);
  assert.match(input.path, /^(?:owned-yjs-restart-[a-f0-9-]+\/)?owned-yjs-restart-[a-f0-9-]+\.md$/u);
  integer(input.generation, 1);
  if (input.expectedWorkspaceId !== undefined) assert(input.expectedWorkspaceId && input.expectedWorkspaceId.length <= 256);
  if (input.expectedOwnerEpoch !== undefined) integer(input.expectedOwnerEpoch, 1);
  if (input.expectedScopeProof !== undefined) assert.match(input.expectedScopeProof, /^[a-f0-9]{64}$/u);
  assert.equal((await database.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  const rows = (await database.query(`SELECT s.*,d.workspace_id AS registry_workspace_id,
    d.organization_id AS registry_organization_id,d.path AS registry_path,d.status AS registry_status,
    d.state_version AS registry_state_version,d.lineage_id AS registry_lineage_id
    FROM collaboration_documents d JOIN collaboration_yjs_states s ON s.document_id=d.id
    WHERE d.id=$1 AND d.path=$2 AND d.provider='yjs' AND d.status='active'
      AND s.lifecycle_generation=$3`, [input.documentId, input.path, input.generation])).rows as Row[];
  assert.equal(rows.length, 1, 'The exact owned native registry/state is unavailable.');
  const row = rows[0];
  assert.equal(row.document_id, input.documentId); assert.equal(row.path, input.path);
  assert.equal(row.registry_path, row.path); assert.equal(row.registry_workspace_id, row.workspace_id);
  assert.equal(row.registry_organization_id, row.organization_id); assert.equal(row.registry_status, 'active');
  assert.equal(row.status, 'active'); assert.equal(row.representation, 'tiptap_blocks');
  assert.equal(integer(row.schema_version, 1), 1); assert.equal(integer(row.lifecycle_generation, 1), input.generation);
  assert(integer(row.registry_state_version, 0) <= integer(row.document_sequence, 0));
  assert(row.workspace_id && (row.organization_id === null || typeof row.organization_id === 'string' && row.organization_id));
  if (input.expectedWorkspaceId !== undefined) assert.equal(row.workspace_id, input.expectedWorkspaceId);
  assert.equal((await database.query(`SELECT count(*)::int AS count FROM collaboration_documents
    WHERE workspace_id=$1 AND path=$2 AND provider='yjs' AND status='active'`, [row.workspace_id, input.path])).rows[0].count, 1);
  assert(row.registry_lineage_id);
  assert.equal((await database.query(`SELECT id FROM file_collaboration_lineages WHERE id=$1 AND workspace_id=$2
    AND path=$3 AND organization_id IS NOT DISTINCT FROM $4 AND status='active'`,
  [row.registry_lineage_id, row.workspace_id, input.path, row.organization_id])).rows.length, 1);
  const scopeProof = createHash('sha256').update(JSON.stringify(['owned-restart-native-scope-v1',
    row.document_id, row.workspace_id, row.organization_id, row.path, input.generation,
    row.representation, integer(row.schema_version, 1), row.registry_lineage_id])).digest('hex');
  if (input.expectedScopeProof !== undefined) assert.equal(scopeProof, input.expectedScopeProof, 'The exact observed native scope changed.');
  assert(Buffer.isBuffer(row.yjs_state) && Buffer.isBuffer(row.state_vector));
  assert(row.yjs_state.length <= 4 * 1024 * 1024 && row.state_vector.length <= 256 * 1024);
  // The CLI reaches these imports only after its genuine owned target guard.
  const { authoritativeNativeCollaborationSnapshot } = await import('../../app/lib/collaboration/document-snapshot');
  const { lockIdentity } = await import('../../app/lib/collaboration/room-owner');
  const { validateCollaborationRoomReleaseReceipt } = await import('../../app/lib/collaboration/room-owner-release');
  const native = authoritativeNativeCollaborationSnapshot(ownedYjsStateFromSqlRow(row));
  const ownerEpoch = integer(row.room_owner_epoch, 1);
  if (input.expectedOwnerEpoch !== undefined) assert.equal(ownerEpoch, input.expectedOwnerEpoch, 'The exact observed room owner changed.');
  const ownerTupleCleared = row.room_owner_token === null && row.room_owner_backend_pid === null && row.room_owner_backend_start === null;
  const ownerTupleComplete = typeof row.room_owner_token === 'string' && row.room_owner_token.length > 0
    && Number.isSafeInteger(row.room_owner_backend_pid) && Number(row.room_owner_backend_pid) > 0
    && typeof row.room_owner_backend_start === 'string' && row.room_owner_backend_start.length > 0;
  const lock = lockIdentity(input.documentId);
  const held = (await database.query(`SELECT EXISTS (SELECT 1 FROM pg_locks
    WHERE locktype='advisory' AND granted AND mode='ExclusiveLock'
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held`, [lock.high, lock.low])).rows[0].held;
  assert.equal(typeof held, 'boolean');
  const receipts = (await database.query(`SELECT * FROM collaboration_room_release_receipts
    WHERE document_id=$1 AND owner_epoch=$2`, [input.documentId, ownerEpoch])).rows;
  assert(receipts.length <= 1, 'The exact room release receipt is ambiguous.');
  let releaseReceiptValid = false;
  if (ownerTupleCleared && receipts.length === 1) {
    validateCollaborationRoomReleaseReceipt(row, receipts[0]); releaseReceiptValid = true;
  }
  const pending = (await database.query(`SELECT EXISTS (SELECT 1 FROM collaboration_admission_scopes s
    JOIN collaboration_admission_requests r ON r.request_id=s.request_id
    WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled')
      AND (s.path=$2 OR $2='' OR left(s.path,length($2)+1)=$2||'/'
        OR (s.kind='subtree' AND (s.path='' OR left($2,length(s.path)+1)=s.path||'/')))) AS pending`,
  [row.workspace_id, input.path])).rows[0].pending;
  assert.equal(typeof pending, 'boolean');
  return { scopeProof, ownerEpoch, ownerTupleCleared, ownerTupleComplete, advisoryLockHeld: held, releaseReceiptValid, admissionPending: pending,
    released: ownerTupleCleared && !held && releaseReceiptValid && !pending,
    version: { sequence: native.version.documentSequence, stateProof: native.version.stateProof,
      yjsSha256: sha256(row.yjs_state), vectorSha256: sha256(row.state_vector) } };
}
