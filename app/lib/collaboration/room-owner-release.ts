import 'server-only';

import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { mergeCollaborationPersistenceUpdates } from './persistence-merge';
import {
  captureCollaborationAdmissionDrainTicket,
  lockCollaborationAdmissionDrain,
  matchesCollaborationAdmissionDrainFence,
  readCollaborationAdmissionTerminalDrain,
  type CollaborationAdmissionDrainTicket,
} from './room-admission-drain';
import {
  assertCollaborationRoomOwnerFence,
  lockIdentity,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerRow,
} from './room-owner';

export type CollaborationRoomReleaseSnapshot = Readonly<{
  releaseId: string;
  yjsState: Uint8Array;
  stateVector: Uint8Array;
  admission?: CollaborationAdmissionDrainTicket;
}>;

export type CollaborationRoomReleaseReceipt = Readonly<{
  release_id: string;
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: string;
  lifecycle_generation: number;
  schema_version: number;
  owner_epoch: number;
  owner_token: string;
  owner_backend_pid: number;
  owner_backend_start: string;
  document_sequence: number;
  persisted_update_hash: string;
  persisted_vector_hash: string;
  live_update_hash: string;
  live_vector_hash: string;
}>;

type ReleaseStateRow = CollaborationRoomOwnerRow & {
  document_sequence: number | string;
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
};
type Query = (sql: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export class CollaborationRoomReleaseError extends Error {
  readonly code = 'ROOM_RELEASE_UNPROVEN';
  constructor(options?: ErrorOptions) {
    super('The collaboration room has no verified durable release.', options);
    this.name = 'CollaborationRoomReleaseError';
  }
}

export function captureCollaborationRoomReleaseSnapshot(input: CollaborationRoomReleaseSnapshot): CollaborationRoomReleaseSnapshot {
  const maxBytes = 64 * 1024 * 1024;
  if (!(input.yjsState instanceof Uint8Array) || !(input.stateVector instanceof Uint8Array)
    || input.yjsState.byteLength === 0 || input.yjsState.byteLength > maxBytes
    || input.stateVector.byteLength === 0 || input.stateVector.byteLength > maxBytes) {
    throw new CollaborationRoomReleaseError();
  }
  const admission = input.admission && captureCollaborationAdmissionDrainTicket(input.admission);
  if (admission && admission.releaseId !== input.releaseId) throw new CollaborationRoomReleaseError();
  return Object.freeze({ releaseId: input.releaseId, ...(admission ? { admission } : {}),
    yjsState: new Uint8Array(input.yjsState), stateVector: new Uint8Array(input.stateVector) });
}

function digest(kind: 'update' | 'vector', value: Uint8Array): string {
  return createHash('sha256').update(`canvas.room-release.v1\0${kind}\0`).update(value).digest('hex');
}

export { digest as collaborationRoomReleaseDigest };

function receiptInteger(value: unknown, minimum: number): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/u.test(value))) {
    throw new CollaborationRoomReleaseError();
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new CollaborationRoomReleaseError();
  return number;
}

function receiptString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new CollaborationRoomReleaseError();
  return value;
}

function receiptHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new CollaborationRoomReleaseError();
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function normalizeReceipt(receipt: Record<string, unknown>): CollaborationRoomReleaseReceipt {
  return Object.freeze({
    release_id: receiptString(receipt.release_id),
    document_id: receiptString(receipt.document_id),
    workspace_id: receiptString(receipt.workspace_id),
    organization_id: receipt.organization_id === null ? null : receiptString(receipt.organization_id),
    path: receiptString(receipt.path),
    representation: receiptString(receipt.representation),
    lifecycle_generation: receiptInteger(receipt.lifecycle_generation, 1),
    schema_version: receiptInteger(receipt.schema_version, 1),
    owner_epoch: receiptInteger(receipt.owner_epoch, 1),
    owner_token: receiptString(receipt.owner_token),
    owner_backend_pid: receiptInteger(receipt.owner_backend_pid, 1),
    owner_backend_start: receiptString(receipt.owner_backend_start),
    document_sequence: receiptInteger(receipt.document_sequence, 0),
    persisted_update_hash: receiptHash(receipt.persisted_update_hash),
    persisted_vector_hash: receiptHash(receipt.persisted_vector_hash),
    live_update_hash: receiptHash(receipt.live_update_hash),
    live_vector_hash: receiptHash(receipt.live_vector_hash),
  });
}

/**
 * Validates that an immutable release receipt still describes the exact
 * token-free persisted room state. Live hashes are authenticated receipt
 * metadata only: the original live buffers are deliberately not reconstructed.
 */
export function validateCollaborationRoomReleaseReceipt(
  row: Record<string, unknown>,
  receipt: Record<string, unknown>,
): CollaborationRoomReleaseReceipt {
  const normalized = normalizeReceipt(receipt);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(normalized.release_id)
    || row.status !== 'active'
    || row.document_id !== normalized.document_id
    || row.workspace_id !== normalized.workspace_id
    || row.organization_id !== normalized.organization_id
    || row.path !== normalized.path
    || row.representation !== normalized.representation
    || receiptInteger(row.lifecycle_generation, 1) !== normalized.lifecycle_generation
    || receiptInteger(row.schema_version, 1) !== normalized.schema_version
    || receiptInteger(row.room_owner_epoch, 1) !== normalized.owner_epoch
    || receiptInteger(row.document_sequence, 0) !== normalized.document_sequence
    || row.room_owner_token !== null
    || row.room_owner_backend_pid !== null
    || row.room_owner_backend_start !== null
    || !(row.yjs_state instanceof Uint8Array)
    || !(row.state_vector instanceof Uint8Array)
    || digest('update', row.yjs_state) !== normalized.persisted_update_hash
    || digest('vector', row.state_vector) !== normalized.persisted_vector_hash) {
    throw new CollaborationRoomReleaseError();
  }
  try {
    const persisted = mergeCollaborationPersistenceUpdates(row.yjs_state, row.yjs_state);
    if (!sameBytes(persisted.stateVector, row.state_vector)) throw new CollaborationRoomReleaseError();
  } catch (cause) {
    if (cause instanceof CollaborationRoomReleaseError) throw cause;
    throw new CollaborationRoomReleaseError({ cause });
  }
  return normalized;
}

function terminalReceiptFor(input: {
  fence: CollaborationRoomOwnerFence;
  snapshot: CollaborationRoomReleaseSnapshot;
  quiescenceText: string;
  storedReceipt: Record<string, unknown>;
}): CollaborationRoomReleaseReceipt {
  let proof: Record<string, unknown>;
  try { proof = JSON.parse(input.quiescenceText) as Record<string, unknown>; }
  catch (cause) { throw new CollaborationRoomReleaseError({ cause }); }
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || !proof.current || typeof proof.current !== 'object' || Array.isArray(proof.current)
    || !proof.receipt || typeof proof.receipt !== 'object' || Array.isArray(proof.receipt)) {
    throw new CollaborationRoomReleaseError();
  }
  const receipt = normalizeReceipt(proof.receipt as Record<string, unknown>);
  const stored = normalizeReceipt(input.storedReceipt);
  const scope = input.fence.scope;
  if (JSON.stringify(receipt) !== JSON.stringify(stored)
    || receipt.release_id !== input.snapshot.releaseId
    || receipt.document_id !== scope.documentId || receipt.workspace_id !== scope.workspaceId
    || receipt.organization_id !== scope.organizationId || receipt.path !== scope.path
    || receipt.representation !== scope.representation
    || receipt.lifecycle_generation !== scope.lifecycleGeneration || receipt.schema_version !== scope.schemaVersion
    || receipt.owner_epoch !== input.fence.epoch || receipt.owner_token !== input.fence.token
    || receipt.owner_backend_pid !== input.fence.backendPid
    || receipt.owner_backend_start !== input.fence.backendStart
    || receipt.live_update_hash !== digest('update', input.snapshot.yjsState)
    || receipt.live_vector_hash !== digest('vector', input.snapshot.stateVector)) {
    throw new CollaborationRoomReleaseError();
  }
  const expectedCurrent = {
    document: { documentId: scope.documentId, workspaceId: scope.workspaceId,
      organizationId: scope.organizationId, path: scope.path, representation: scope.representation,
      lifecycleGeneration: scope.lifecycleGeneration, schemaVersion: scope.schemaVersion, status: 'active' },
    ownerEpoch: input.fence.epoch, ownerToken: null, ownerBackendPid: null, ownerBackendStart: null,
    documentSequence: receipt.document_sequence, persistedUpdateHash: receipt.persisted_update_hash,
    persistedVectorHash: receipt.persisted_vector_hash,
  };
  if (JSON.stringify(proof.current) !== JSON.stringify(expectedCurrent)) throw new CollaborationRoomReleaseError();
  try {
    const live = mergeCollaborationPersistenceUpdates(input.snapshot.yjsState, input.snapshot.yjsState);
    if (!sameBytes(live.stateVector, input.snapshot.stateVector)) throw new CollaborationRoomReleaseError();
  } catch (cause) {
    if (cause instanceof CollaborationRoomReleaseError) throw cause;
    throw new CollaborationRoomReleaseError({ cause });
  }
  return receipt;
}

function receiptFor(row: ReleaseStateRow, fence: CollaborationRoomOwnerFence,
  snapshot: CollaborationRoomReleaseSnapshot): CollaborationRoomReleaseReceipt {
  const scope = fence.scope;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(snapshot.releaseId)
    || row.status !== 'active' || row.document_id !== scope.documentId
    || row.workspace_id !== scope.workspaceId || row.organization_id !== scope.organizationId
    || row.path !== scope.path || row.representation !== scope.representation
    || Number(row.lifecycle_generation) !== scope.lifecycleGeneration || Number(row.schema_version) !== scope.schemaVersion
    || Number(row.room_owner_epoch) !== fence.epoch
    || !Number.isSafeInteger(Number(row.document_sequence)) || Number(row.document_sequence) < 0) {
    throw new CollaborationRoomReleaseError();
  }
  try {
    const live = mergeCollaborationPersistenceUpdates(snapshot.yjsState, snapshot.yjsState);
    const persisted = mergeCollaborationPersistenceUpdates(row.yjs_state, snapshot.yjsState);
    if (persisted.disposition !== 'unchanged'
      || !Buffer.from(live.stateVector).equals(Buffer.from(snapshot.stateVector))
      || !Buffer.from(persisted.stateVector).equals(Buffer.from(row.state_vector))) {
      throw new CollaborationRoomReleaseError();
    }
  } catch (cause) { throw new CollaborationRoomReleaseError({ cause }); }
  return Object.freeze({
    release_id: snapshot.releaseId, document_id: scope.documentId, workspace_id: scope.workspaceId,
    organization_id: scope.organizationId, path: scope.path, representation: scope.representation,
    lifecycle_generation: scope.lifecycleGeneration, schema_version: scope.schemaVersion,
    owner_epoch: fence.epoch, owner_token: fence.token, owner_backend_pid: fence.backendPid,
    owner_backend_start: fence.backendStart, document_sequence: Number(row.document_sequence),
    persisted_update_hash: digest('update', row.yjs_state), persisted_vector_hash: digest('vector', row.state_vector),
    live_update_hash: digest('update', snapshot.yjsState), live_vector_hash: digest('vector', snapshot.stateVector),
  });
}

/** Caller owns the state row lock and transaction through exact-token clear. */
export async function recordCollaborationRoomRelease(input: {
  query: Query;
  row: CollaborationRoomOwnerRow | undefined;
  fence: CollaborationRoomOwnerFence;
  snapshot: CollaborationRoomReleaseSnapshot;
}): Promise<void> {
  if (!input.row) throw new CollaborationRoomReleaseError();
  const snapshot = captureCollaborationRoomReleaseSnapshot(input.snapshot);
  await assertCollaborationRoomOwnerFence({ get: async (sql, values) => (await input.query(sql, values))[0] }, input.row, input.fence);
  const receipt = receiptFor(input.row as ReleaseStateRow, input.fence, snapshot);
  const fields = Object.keys(receipt);
  await input.query(`INSERT INTO collaboration_room_release_receipts (${fields.join(', ')}, created_at)
    VALUES (${fields.map((_, index) => `$${index + 1}`).join(', ')}, $${fields.length + 1})`,
  [...Object.values(receipt), Date.now()]);
}

/**
 * Read-only recovery, never an authorization for a later lifecycle write.
 * The old owner session MUST have ended first. The caller retains the frozen
 * snapshot. Active-request recovery rejects absence, drift, or a competing
 * claim; an immutable committed outcome may prove cleanup of only that exact
 * old local instance after the lifecycle and a replacement owner advanced.
 */
export async function recoverCollaborationRoomRelease(input: {
  createClient: () => Promise<Pick<Client, 'query' | 'end'>>;
  fence: CollaborationRoomOwnerFence;
  snapshot: CollaborationRoomReleaseSnapshot;
}): Promise<CollaborationRoomReleaseReceipt> {
  const fence = Object.freeze({ ...input.fence, scope: Object.freeze({ ...input.fence.scope }) });
  const snapshot = captureCollaborationRoomReleaseSnapshot(input.snapshot);
  if (snapshot.admission && !matchesCollaborationAdmissionDrainFence(snapshot.admission, fence)) {
    throw new CollaborationRoomReleaseError();
  }
  const client = await input.createClient();
  const query = async (sql: string, values?: unknown[]) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([client.query(sql, values), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CollaborationRoomReleaseError()), 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    if (snapshot.admission) {
      // A committed lifecycle may already have advanced the state and handed
      // this advisory lock to a replacement owner. Detect its immutable
      // outcome before trying the current room guard.
      const header = await query('SELECT status FROM collaboration_admission_requests WHERE request_id = $1',
        [snapshot.admission.requestId]);
      if (header.rows[0]?.status === 'committed') {
        await query('BEGIN');
        const database = {
          get: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows[0],
          all: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows,
          run: async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            return { changes: result.rowCount ?? 0 };
          },
          close: async () => {},
        };
        try {
          const terminal = await readCollaborationAdmissionTerminalDrain(database, snapshot.admission);
          const found = (await query('SELECT * FROM collaboration_room_release_receipts WHERE release_id = $1',
            [snapshot.releaseId])).rows[0] as Record<string, unknown> | undefined;
          if (!found) throw new CollaborationRoomReleaseError();
          return terminalReceiptFor({ fence, snapshot, quiescenceText: terminal.quiescenceText, storedReceipt: found });
        } catch (cause) {
          if (cause instanceof CollaborationRoomReleaseError) throw cause;
          throw new CollaborationRoomReleaseError({ cause });
        }
      }
    }
    // Never wait for an active replacement owner. No workspace or state lock
    // is held while obtaining the document's existing advisory lock domain.
    const lock = lockIdentity(fence.scope.documentId);
    const acquired = await query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [lock.key]);
    if (acquired.rows[0]?.locked !== true) throw new CollaborationRoomReleaseError();
    await query('BEGIN');
    if (snapshot.admission) {
      await lockCollaborationAdmissionDrain(async (sql, values) => (await query(sql, values)).rows, snapshot.admission, 'released');
    }
    const row = (await query('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
      [fence.scope.documentId])).rows[0] as ReleaseStateRow | undefined;
    if (!row || row.room_owner_token !== null || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null) {
      throw new CollaborationRoomReleaseError();
    }
    const expected = receiptFor(row, fence, snapshot);
    const found = (await query('SELECT * FROM collaboration_room_release_receipts WHERE release_id = $1',
      [snapshot.releaseId])).rows[0] as Record<string, unknown> | undefined;
    const numeric = new Set(['lifecycle_generation', 'schema_version', 'owner_epoch', 'owner_backend_pid', 'document_sequence']);
    if (!found || Object.entries(expected).some(([key, value]) => (numeric.has(key) ? Number(found[key]) : found[key]) !== value)) {
      throw new CollaborationRoomReleaseError();
    }
    // This transaction only reads. End/rollback releases its row and advisory
    // locks; there is no second COMMIT acknowledgement to infer or replay.
    return expected;
  } finally {
    // Dedicated connection, never returned to a pool with an unresolved TX.
    await client.end();
  }
}
