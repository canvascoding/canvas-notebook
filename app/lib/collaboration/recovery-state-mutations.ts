import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { PersistedCollaborationState } from './persistence';
import { prepareCodeMarkConflictRepair } from './code-mark-repair';
import { authoritativeCollaborationSnapshot } from './checkpoint';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { assertCurrentCollaborationProjectionIdentity } from './projection-identity';
import { lockIdentity } from './room-owner';
import { validateCollaborationRoomReleaseReceipt } from './room-owner-release';
import { assertCollaborationAdmissionOpen, captureCollaborationAdmissionTargetRow,
  lockCollaborationAdmissionWorkspace } from './room-admission';
import { findCollaborationAdmissionOutcomeSource } from './room-admission-outcome';
import { getCollaborationRoomConnectionCount } from './runtime-state';
import { decodeRecoveryState, recoveryStateFingerprint, recoveryPostgresInteger as integer } from './recovery-evidence';

type Row = Record<string, unknown>;
type OpenConnection = () => Promise<SqlConnection>;
type Metadata = Omit<PersistedCollaborationState, 'yjsState' | 'stateVector' | 'projectionFinalized'>;
type Kind = 'repair_code_marks' | 'archive_orphan';
type BackupMetadata = { state: Metadata; row: Row };
type OutcomeMetadata = { state: Metadata; ownerEpoch: number;
  projectedCanonicalHash?: string; projectedSerializedHash?: string };

export class CollaborationRecoveryMutationError extends Error {
  constructor(readonly code: 'recovery_guard_required' | 'recovery_room_busy' | 'recovery_release_unproven'
    | 'recovery_state_changed' | 'recovery_operation_conflict' | 'recovery_agent_pending' | 'recovery_invalid_state') {
    super(code); this.name = 'CollaborationRecoveryMutationError';
  }
}

function fail(code: ConstructorParameters<typeof CollaborationRecoveryMutationError>[0]): never {
  throw new CollaborationRecoveryMutationError(code);
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const terminalOperations = ['persisted_yjs', 'checkpointed_file', 'cancelled', 'expired', 'superseded', 'failed', 'rejected', 'reverted'];

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail('recovery_invalid_state');
  return value;
}

export function recoveryStateMetadata(state: PersistedCollaborationState): Metadata {
  return { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
    representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
    documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence, persistedAt: state.persistedAt,
    checkpointedAt: state.checkpointedAt, canonicalHash: state.canonicalHash, serializedHash: state.serializedHash,
    newlineStyle: state.newlineStyle, hasBom: state.hasBom, degraded: state.degraded, status: state.status,
    ...(state.projectionError ? { projectionError: { ...state.projectionError } } : {}) };
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, child]) => child !== undefined).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

function copiedState(state: PersistedCollaborationState): PersistedCollaborationState {
  return { ...recoveryStateMetadata(state), yjsState: new Uint8Array(state.yjsState), stateVector: new Uint8Array(state.stateVector) };
}

function ownerEpoch(row: Row): number {
  if (row.room_owner_token !== null || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null) fail('recovery_release_unproven');
  return integer(row.room_owner_epoch);
}

async function pendingOperations(database: SqlConnection, documentId: string, lock = false): Promise<void> {
  const rows = await database.all(`SELECT operation_id FROM collaboration_agent_operations
    WHERE document_id=$1 AND status <> ALL($2::text[]) ${lock ? 'FOR UPDATE' : ''}`, [documentId, terminalOperations]);
  if (rows.length) fail('recovery_agent_pending');
}

function outputMatches(row: Row, outcome: Row): boolean {
  try {
    const current = decodeRecoveryState(row); const after = outcome.after_metadata as OutcomeMetadata;
    if (outcome.after_update_hash !== hash(current.yjsState) || outcome.after_vector_hash !== hash(current.stateVector)
      || ownerEpoch(row) !== after.ownerEpoch) return false;
    const actual = recoveryStateMetadata(current);
    if (canonical(actual) === canonical(after.state)) return true;
    if (outcome.kind !== 'repair_code_marks') return false;
    // Checkpoint finalization changes only these four persisted fields. Every
    // identity, binary, sequence, encoding, error and durability field stays exact.
    const finalized = { ...after.state, checkpointSequence: after.state.documentSequence,
      checkpointedAt: actual.checkpointedAt, canonicalHash: after.projectedCanonicalHash, serializedHash: after.projectedSerializedHash };
    return integer(actual.checkpointedAt) >= after.state.persistedAt && canonical(actual) === canonical(finalized);
  } catch { return false; }
}

function predecessor(outcome: Row): { state: PersistedCollaborationState; row: Row } {
  const backup = outcome.before_metadata as BackupMetadata;
  if (!backup?.state || !backup.row || !(outcome.before_update instanceof Uint8Array) || !(outcome.before_vector instanceof Uint8Array)) {
    return fail('recovery_operation_conflict');
  }
  const row = { ...backup.row, yjs_state: outcome.before_update, state_vector: outcome.before_vector };
  const state = decodeRecoveryState(row);
  if (canonical(recoveryStateMetadata(state)) !== canonical(backup.state)) fail('recovery_operation_conflict');
  return { state, row };
}

async function released(database: SqlConnection, row: Row, allowRecoveryProof = true): Promise<void> {
  const epoch = ownerEpoch(row);
  if (!epoch) return;
  const receipt = await database.get('SELECT * FROM collaboration_room_release_receipts WHERE document_id=$1 AND owner_epoch=$2',
    [row.document_id, epoch]) as Row | undefined;
  if (receipt) {
    try { validateCollaborationRoomReleaseReceipt(row, receipt); return; }
    catch { /* A completed lifecycle can replace the original release scope. */ }
  }
  const state = decodeRecoveryState(row);
  const target = captureCollaborationAdmissionTargetRow(row, { documentId: state.documentId, workspaceId: state.workspaceId,
    organizationId: state.organizationId, path: state.path, representation: state.representation,
    lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion, status: state.status });
  if (await findCollaborationAdmissionOutcomeSource(database, target)) return;
  if (allowRecoveryProof) {
    // A restart after our offline lifecycle commit can retain the original
    // release proof. Require an exact durable output and its retained predecessor.
    const outcomes = await database.all(`SELECT * FROM collaboration_recovery_state_mutations
      WHERE document_id=$1 AND after_update_hash=$2 AND after_vector_hash=$3 ORDER BY created_at DESC LIMIT 20`,
    [state.documentId, hash(state.yjsState), hash(state.stateVector)]) as Row[];
    for (const outcome of outcomes) {
      if (!outputMatches(row, outcome)) continue;
      const before = predecessor(outcome);
      if (ownerEpoch(before.row) !== epoch || before.state.lifecycleGeneration + 1 !== state.lifecycleGeneration) continue;
      await released(database, before.row, false); return;
    }
  }
  fail('recovery_release_unproven');
}

export type OfflineCollaborationRecoveryGuard = Readonly<{ assertActive: () => Promise<void> }>;
type GuardState = { active: boolean; documents: Set<string>; connection: SqlConnection; backendPid: number };
const guards = new WeakMap<OfflineCollaborationRecoveryGuard, GuardState>();

async function requireGuard(guard: OfflineCollaborationRecoveryGuard, documentId: string): Promise<void> {
  const authority = guards.get(guard);
  if (!authority?.active || !authority.documents.has(documentId)) fail('recovery_guard_required');
  await guard.assertActive();
}

/** Dedicated session only; close(error) must destroy its backend, never reconnect. */
export async function withOfflineCollaborationRecoveryGuards<T>(input: {
  documentIds: readonly string[]; openGuardConnection: OpenConnection;
  operation: (guard: OfflineCollaborationRecoveryGuard) => Promise<T>;
}): Promise<T> {
  const ids = [...new Set(input.documentIds)].sort();
  if (!ids.length || ids.length > 1024 || ids.some((id) => !id || id.includes('\0'))) fail('recovery_invalid_state');
  const database = await input.openGuardConnection();
  const authority: GuardState = { active: false, documents: new Set(ids), connection: database, backendPid: 0 };
  const guard: OfflineCollaborationRecoveryGuard = Object.freeze({ assertActive: async () => {
    if (!authority.active) fail('recovery_guard_required');
    for (const id of ids) {
      const key = lockIdentity(id);
      const held = await database.get(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
        AND mode='ExclusiveLock' AND pid=pg_backend_pid() AND pid=$3 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held`, [key.high, key.low, authority.backendPid]) as Row | undefined;
      if (held?.held !== true) fail('recovery_guard_required');
      if (getCollaborationRoomConnectionCount(id) > 0) fail('recovery_room_busy');
      const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [id]) as Row | undefined;
      if (!row) fail('recovery_state_changed'); ownerEpoch(row);
      await assertCollaborationAdmissionOpen(async (sql, values) => await database.all(sql, values) as Row[], {
        documentId: id, workspaceId: text(row.workspace_id), path: text(row.path) });
      await pendingOperations(database, id);
    }
  } });
  guards.set(guard, authority);
  try {
    await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='4s'");
    await database.run('BEGIN');
    const initial: Row[] = [];
    for (const id of ids) {
      const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [id]) as Row | undefined;
      if (!row) fail('recovery_state_changed'); initial.push(row);
    }
    const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as Row[];
    for (const workspaceId of [...new Set(initial.map((row) => text(row.workspace_id)))].sort()) await lockCollaborationAdmissionWorkspace(query, workspaceId);
    for (const row of initial) await assertCollaborationAdmissionOpen(query, {
      documentId: text(row.document_id), workspaceId: text(row.workspace_id), path: text(row.path) });
    for (const id of ids) {
      const acquired = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked', [lockIdentity(id).key]) as Row | undefined;
      if (acquired?.locked !== true || getCollaborationRoomConnectionCount(id) > 0) fail('recovery_room_busy');
    }
    authority.backendPid = integer((await database.get('SELECT pg_backend_pid() AS pid') as Row).pid, 1);
    for (const id of ids) {
      const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR SHARE', [id]) as Row;
      const original = initial.find((item) => item.document_id === id)!;
      if (row.workspace_id !== original.workspace_id || row.path !== original.path) fail('recovery_state_changed');
      await released(database, row); await pendingOperations(database, id);
    }
    await database.run('COMMIT'); authority.active = true;
    const result = await input.operation(guard);
    await guard.assertActive(); return result;
  } finally {
    authority.active = false; guards.delete(guard);
    // Discard also releases every acquired session lock after any uncertain TX.
    await database.close(new Error('Closing dedicated offline recovery guard session.'));
  }
}

type MutationInput = { expected: PersistedCollaborationState; operationId: string; backupId: string;
  guard: OfflineCollaborationRecoveryGuard; openConnection: OpenConnection };

function captureInput(input: MutationInput): MutationInput {
  if (![input.operationId, input.backupId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id))) fail('recovery_invalid_state');
  return { ...input, expected: copiedState(input.expected) };
}

async function lockMutation(database: SqlConnection, input: MutationInput): Promise<Row> {
  await database.run("SET LOCAL statement_timeout='5s'"); await database.run("SET LOCAL lock_timeout='4s'");
  await requireGuard(input.guard, input.expected.documentId);
  const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as Row[];
  await lockCollaborationAdmissionWorkspace(query, input.expected.workspaceId);
  await assertCollaborationAdmissionOpen(query, input.expected);
  await pendingOperations(database, input.expected.documentId, true);
  const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [input.expected.documentId]) as Row | undefined;
  if (!row) return fail('recovery_state_changed');
  ownerEpoch(row); return row;
}

async function recordOutcome(database: SqlConnection, input: MutationInput, kind: Kind, before: Row,
  after: Row, projected?: { canonicalHash: string; serializedHash: string }): Promise<void> {
  const beforeRow = Object.fromEntries(Object.entries(before).filter(([key]) => !['yjs_state', 'state_vector'].includes(key)));
  const afterState = decodeRecoveryState(after);
  await database.run(`INSERT INTO collaboration_recovery_state_mutations
    (operation_id,backup_id,kind,document_id,before_metadata,before_update,before_vector,after_metadata,after_update_hash,after_vector_hash,created_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11)`,
  [input.operationId, input.backupId, kind, input.expected.documentId,
    JSON.stringify({ state: recoveryStateMetadata(input.expected), row: beforeRow }), Buffer.from(input.expected.yjsState), Buffer.from(input.expected.stateVector),
    JSON.stringify({ state: recoveryStateMetadata(afterState), ownerEpoch: ownerEpoch(after),
      ...(projected ? { projectedCanonicalHash: projected.canonicalHash, projectedSerializedHash: projected.serializedHash } : {}) }),
    hash(afterState.yjsState), hash(afterState.stateVector), Date.now()]);
}

async function existingOutcome(database: SqlConnection, input: MutationInput, kind: Kind, row: Row): Promise<boolean> {
  const outcome = await database.get(`SELECT * FROM collaboration_recovery_state_mutations
    WHERE operation_id=$1 OR backup_id=$2 FOR SHARE`, [input.operationId, input.backupId]) as Row | undefined;
  if (!outcome) return false;
  const before = predecessor(outcome);
  if (outcome.operation_id !== input.operationId || outcome.backup_id !== input.backupId || outcome.kind !== kind
    || outcome.document_id !== input.expected.documentId || recoveryStateFingerprint(before.state) !== recoveryStateFingerprint(input.expected)
    || !outputMatches(row, outcome)) fail('recovery_operation_conflict');
  return true;
}

async function assertOrphanRegistryIdentity(database: SqlConnection, expected: PersistedCollaborationState): Promise<void> {
  const registered = await database.get("SELECT id FROM collaboration_documents WHERE id=$1 AND status='active' FOR SHARE",
    [expected.documentId]);
  if (registered) fail('recovery_state_changed');
  const successors = await database.all(`SELECT c.id,c.organization_id,c.workspace_type,w.organization_id AS workspace_organization_id,w.type
    FROM collaboration_documents c JOIN canvas_workspaces w ON w.id=c.workspace_id AND w.status='active'
    WHERE c.workspace_id=$1 AND c.path=$2 AND c.status='active' FOR SHARE OF c,w`,
  [expected.workspaceId, expected.path]) as Row[];
  const successor = successors[0];
  if (successors.length !== 1 || successor.id === expected.documentId || successor.organization_id !== expected.organizationId
    || successor.workspace_organization_id !== expected.organizationId || successor.type !== successor.workspace_type) fail('recovery_state_changed');
}

async function recoverOutcome(input: MutationInput, kind: Kind): Promise<PersistedCollaborationState> {
  return executeLifecycleTransaction({ openConnection: input.openConnection, execute: async (database) => {
    const row = await lockMutation(database, input);
    if (!await existingOutcome(database, input, kind, row)) fail('recovery_operation_conflict');
    if (kind === 'repair_code_marks') await assertCurrentCollaborationProjectionIdentity(decodeRecoveryState(row), database);
    else await assertOrphanRegistryIdentity(database, input.expected);
    return decodeRecoveryState(row);
  }, recoverCommitted: async (proven) => proven });
}

export async function applyCodeMarkRecoveryClone(source: MutationInput): Promise<{
  state: PersistedCollaborationState; repairedHash: string; lostFormatting: { mark: string; utf16Units: number }[];
  disposition: 'applied' | 'already_applied';
}> {
  const input = captureInput(source); const repair = prepareCodeMarkConflictRepair(input.expected);
  if (input.expected.status !== 'active' || !input.expected.degraded) fail('recovery_invalid_state');
  const sequence = integer(input.expected.documentSequence + 1, 1); integer(input.expected.lifecycleGeneration + 1, 1);
  const snapshot = authoritativeCollaborationSnapshot({ ...input.expected, yjsState: repair.repairedYjsState, stateVector: repair.stateVector });
  let disposition: 'applied' | 'already_applied' = 'applied';
  const state = await executeLifecycleTransaction({ openConnection: input.openConnection,
    execute: async (database) => {
      const before = await lockMutation(database, input);
      if (await existingOutcome(database, input, 'repair_code_marks', before)) {
        await assertCurrentCollaborationProjectionIdentity(decodeRecoveryState(before), database);
        disposition = 'already_applied'; return decodeRecoveryState(before);
      }
      if (recoveryStateFingerprint(decodeRecoveryState(before)) !== recoveryStateFingerprint(input.expected)) fail('recovery_state_changed');
      await assertCurrentCollaborationProjectionIdentity(input.expected, database); await released(database, before);
      const after = await database.get(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,
        lifecycle_generation=lifecycle_generation+1,document_sequence=$3,persisted_at=$4,degraded=0,
        projection_error_code=NULL,projection_error_phase=NULL,projection_error_cause=NULL,projection_error_sequence=NULL,
        projection_error_generation=NULL,projection_error_permanent=0
        WHERE document_id=$5 AND workspace_id=$6 AND path=$7 AND lifecycle_generation=$8 AND document_sequence=$9
          AND status='active' AND yjs_state=$10 AND state_vector=$11 RETURNING *`,
      [Buffer.from(repair.repairedYjsState), Buffer.from(repair.stateVector), sequence, Date.now(), input.expected.documentId,
        input.expected.workspaceId, input.expected.path, input.expected.lifecycleGeneration, input.expected.documentSequence,
        Buffer.from(input.expected.yjsState), Buffer.from(input.expected.stateVector)]) as Row | undefined;
      if (!after) fail('recovery_state_changed');
      await recordOutcome(database, input, 'repair_code_marks', before, after,
        { canonicalHash: hash(snapshot.canonicalContent), serializedHash: repair.serializedHash });
      await requireGuard(input.guard, input.expected.documentId); return decodeRecoveryState(after);
    }, recoverCommitted: () => recoverOutcome(input, 'repair_code_marks') });
  return { state, repairedHash: repair.repairedHash, lostFormatting: repair.lostFormatting, disposition };
}

export async function archiveCollaborationRecoveryOrphan(source: MutationInput): Promise<{
  state: PersistedCollaborationState; disposition: 'archived' | 'already_archived';
}> {
  const input = captureInput(source);
  if (input.expected.status !== 'active') fail('recovery_invalid_state'); integer(input.expected.lifecycleGeneration + 1, 1);
  let disposition: 'archived' | 'already_archived' = 'archived';
  const state = await executeLifecycleTransaction({ openConnection: input.openConnection,
    execute: async (database) => {
      const before = await lockMutation(database, input);
      await assertOrphanRegistryIdentity(database, input.expected);
      if (await existingOutcome(database, input, 'archive_orphan', before)) {
        disposition = 'already_archived'; return decodeRecoveryState(before);
      }
      if (recoveryStateFingerprint(decodeRecoveryState(before)) !== recoveryStateFingerprint(input.expected)) fail('recovery_state_changed');
      await released(database, before);
      const after = await database.get(`UPDATE collaboration_yjs_states SET status='archived',lifecycle_generation=lifecycle_generation+1
        WHERE document_id=$1 AND workspace_id=$2 AND path=$3 AND lifecycle_generation=$4 AND document_sequence=$5
          AND status='active' AND yjs_state=$6 AND state_vector=$7 RETURNING *`, [input.expected.documentId,
      input.expected.workspaceId, input.expected.path, input.expected.lifecycleGeneration, input.expected.documentSequence,
      Buffer.from(input.expected.yjsState), Buffer.from(input.expected.stateVector)]) as Row | undefined;
      if (!after) fail('recovery_state_changed');
      await recordOutcome(database, input, 'archive_orphan', before, after);
      await requireGuard(input.guard, input.expected.documentId); return decodeRecoveryState(after);
    }, recoverCommitted: () => recoverOutcome(input, 'archive_orphan') });
  return { state, disposition };
}
