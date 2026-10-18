import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { readHistoricalNativeWorkspaceCopyReceiptOnConnection, type NativeCopyReceiptStorageIdentity } from '../collaboration/native-copy-historical-receipt';
import { assertNativeCopySessionOnConnection } from './workspace-operation-native-copy-owner';
import type { NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { NativeLinkMutationReceipt } from '../markdown/native-link-mutation-persistence';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { serializeWorkspaceOperationRequest, readWorkspaceOperationJournalOnConnection,
  type WorkspaceOperationWithSteps } from './workspace-operation-journal';
import type { WorkspaceOperationOwnedCopyStage } from './workspace-operation-managed-copy-stage';
import { assertNativeCopyPhaseReceipt, copyPhaseChanged, NativeCopyPhaseError, nativeCopyPhaseExpectedLinks,
  nativeCopyPhaseSha, nativeCopyPhaseStepCount } from './workspace-operation-native-copy-phase-contract';
import { NATIVE_COPY_COMPLETION_STEP_KEY, nativeCopyPhaseReceiptProof, nativeCopyPhaseCompletionFence } from './workspace-operation-native-copy-phase-contract';
import type { WorkspaceOperationRecord } from './workspace-operation-journal';
import { decodeNativeCopyMetadataCompletionWitness, nativeCopyMetadataCompositeDigest } from './workspace-operation-native-copy-metadata';
import { readHistoricalExcalidrawCopyOnConnection } from '../excalidraw-collaboration/copy-domain';
import type { ExcalidrawCopyBirthReceipt, ExcalidrawCopyReceiptStorageIdentity } from '../excalidraw-collaboration/copy-contract';

type Row = Record<string, unknown>;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const bounded = (value: unknown, maximum: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function object(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return !property?.enumerable || !Object.hasOwn(property, 'value');
    })) copyPhaseChanged();
  return value as Row;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const stateProof = (value: unknown): value is string => typeof value === 'string' && /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(value);
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) copyPhaseChanged();
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) copyPhaseChanged(); return property.value;
  });
}
function receiptBody(input: unknown, stage: WorkspaceOperationOwnedCopyStage, status: NativeCopyReceipt['publicationStatus']): NativeCopyReceipt {
  const body = object(input, ['version', 'operationId', 'workspaceId', 'requestFingerprint', 'documents']);
  const documents = array(body.documents, 10_000).map(value => {
    const document = object(value, ['version', 'source', 'clone', 'blockIdMapping']);
    const source = object(document.source, ['documentId', 'lifecycleGeneration', 'stateProof', 'documentSequence']);
    const clone = object(document.clone, ['documentId', 'lineageId', 'path', 'lifecycleGeneration', 'stateProof', 'initialSequence']);
    if (document.version !== 1 || !id(source.documentId) || !id(clone.documentId) || !id(clone.lineageId)
      || !stateProof(source.stateProof) || !stateProof(clone.stateProof)
      || !bounded(source.lifecycleGeneration, Number.MAX_SAFE_INTEGER - 1) || source.lifecycleGeneration === 0
      || !bounded(source.documentSequence, Number.MAX_SAFE_INTEGER - 1) || clone.lifecycleGeneration !== 1 || clone.initialSequence !== 0) copyPhaseChanged();
    const mapping = document.blockIdMapping;
    if (!mapping || typeof mapping !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) copyPhaseChanged();
    for (const key of Reflect.ownKeys(mapping)) {
      const property = Object.getOwnPropertyDescriptor(mapping, key);
      if (typeof key !== 'string' || !key || !property?.enumerable || !Object.hasOwn(property, 'value')
        || typeof property.value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(property.value)) copyPhaseChanged();
    }
    return document;
  });
  const receipt = { ...body, documents, publicationStatus: status } as unknown as NativeCopyReceipt;
  assertNativeCopyPhaseReceipt(stage, receipt);
  return receipt;
}

async function journalHeaderWitness(database: SqlConnection): Promise<string> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,a.backend_start::text AS start,
    a.datid::text AS database,pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,pg_catalog.current_setting('session_replication_role') AS replication,
    pg_catalog.pg_current_xact_id_if_assigned()::text AS xid
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1 || typeof row.start !== 'string'
    || ![row.database, row.schema, row.xid].every(value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/u.test(value))
    || typeof row.search_path !== 'string' || !row.search_path || row.isolation !== 'read committed'
    || row.read_only !== 'off' || row.replication !== 'origin') copyPhaseChanged();
  return JSON.stringify(row);
}

/** Read-only original-header binding for the fixed owner's admission check.
 * This can run inside a C3 borrowed writer on the same already assigned B/TX:
 * it neither opens another borrower nor allocates an XID or reads step bodies.
 * Its data is never an ACL, mutation, resume or COMMIT capability. */
export async function readNativeCopyPhaseJournalHeaderOnConnection(database: SqlConnection,
  stage: WorkspaceOperationOwnedCopyStage): Promise<WorkspaceOperationRecord | null> {
  const origin = decodeWorkspaceOperationCopyOrigin(stage.origin), serialized = serializeWorkspaceOperationRequest(stage.request);
  const expected = Object.freeze({ operationId: stage.identity.operationId, planId: stage.plan.planId,
    requestHash: stage.identity.canonicalRequestHash, requestJson: serialized.requestJson,
    sourceWorkspaceId: stage.identity.sourceWorkspaceId, destinationWorkspaceId: stage.identity.destinationWorkspaceId,
    expectedStepCount: nativeCopyPhaseStepCount(stage) });
  if (serialized.requestHash !== expected.requestHash || !equal(JSON.parse(serialized.requestJson).origin, origin)
    || !equal(stage.plan.sourceScope, origin.sourceScope) || !equal(stage.plan.destinationScope, origin.destinationScope)
    || expected.sourceWorkspaceId !== origin.sourceScope.workspaceId || expected.destinationWorkspaceId !== origin.destinationScope.workspaceId) copyPhaseChanged();
  await assertNativeCopySessionOnConnection(database, origin);
  const pinned = await journalHeaderWitness(database);
  if (pinned !== await journalHeaderWitness(database)) copyPhaseChanged();
  const header = await database.get(`SELECT operation_id,plan_id,request_hash,octet_length(request_json) AS request_bytes,
    CASE WHEN octet_length(request_json)<=65536 THEN request_json END AS request_json,
    actor_type,actor_id,source_workspace_id,destination_workspace_id,expected_step_count,status,phase,revision,error_code,created_at,updated_at
    FROM workspace_file_operations WHERE operation_id=$1`, [expected.operationId]) as Row | undefined;
  if (header && (!bounded(header.request_bytes, 65536) || header.operation_id !== expected.operationId || header.plan_id !== expected.planId
    || header.request_hash !== expected.requestHash || header.request_json !== expected.requestJson
    || header.actor_type !== origin.actor.type || header.actor_id !== origin.actor.userId
    || header.source_workspace_id !== expected.sourceWorkspaceId || header.destination_workspace_id !== expected.destinationWorkspaceId
    || header.expected_step_count !== expected.expectedStepCount
    || !['prepared', 'running', 'completed', 'failed', 'recovery_required'].includes(String(header.status))
    || !['prepared', 'path', 'link', 'completed'].includes(String(header.phase))
    || !bounded(Number(header.revision), Number.MAX_SAFE_INTEGER - 1) || Number(header.revision) < 1
    || !bounded(Number(header.created_at), Number.MAX_SAFE_INTEGER - 1) || !bounded(Number(header.updated_at), Number.MAX_SAFE_INTEGER - 1)
    || header.error_code !== null && typeof header.error_code !== 'string')) copyPhaseChanged();
  if (pinned !== await journalHeaderWitness(database)) copyPhaseChanged();
  await assertNativeCopySessionOnConnection(database, origin);
  return header ? { ...expected, actor: { type: origin.actor.type, id: origin.actor.userId },
    status: header.status as WorkspaceOperationRecord['status'], phase: header.phase as WorkspaceOperationRecord['phase'],
    revision: Number(header.revision), errorCode: header.error_code as string | null,
    createdAt: Number(header.created_at), updatedAt: Number(header.updated_at) } : null;
}

/** Header-first bounded journal view. Cooperating step writers lock this same
 * operation header first; byte sums precede the original payload reader. */
export async function readNativeCopyPhaseJournalOnConnection(database: SqlConnection,
  stage: WorkspaceOperationOwnedCopyStage): Promise<WorkspaceOperationWithSteps | null> {
  const header = await database.get('SELECT operation_id,octet_length(request_json) AS request_bytes FROM workspace_file_operations WHERE operation_id=$1 FOR UPDATE',
  [stage.identity.operationId]) as Row | undefined;
  if (!header) return null;
  if (!bounded(header.request_bytes, 65536)) throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_TOO_LARGE');
  const expectedStepCount = nativeCopyPhaseStepCount(stage);
  const size = await database.get(`SELECT count(*)::integer AS count,
    coalesce(sum(octet_length(receipt_json)),0)::bigint AS bytes,coalesce(max(octet_length(receipt_json)),0)::integer AS max_receipt
    FROM workspace_file_operation_steps WHERE operation_id=$1`,
  [stage.identity.operationId]) as Row | undefined;
  if (!size || !bounded(size.count, expectedStepCount) || !bounded(Number(size.bytes), MAX_TOTAL_BYTES)
    || !bounded(size.max_receipt, 16384)) {
    throw new NativeCopyPhaseError('NATIVE_COPY_PHASE_TOO_LARGE');
  }
  const journal = await readWorkspaceOperationJournalOnConnection(database, stage.identity.operationId, { forUpdate: true });
  const serialized = serializeWorkspaceOperationRequest(stage.request);
  if (!journal || journal.planId !== stage.plan.planId || journal.requestJson !== serialized.requestJson
    || journal.requestHash !== stage.identity.canonicalRequestHash || journal.requestHash !== serialized.requestHash
    || journal.actor.id !== stage.origin.actor.userId || journal.actor.type !== stage.origin.actor.type
    || journal.sourceWorkspaceId !== stage.identity.sourceWorkspaceId || journal.destinationWorkspaceId !== stage.identity.destinationWorkspaceId
    || journal.expectedStepCount !== expectedStepCount) copyPhaseChanged();
  return journal;
}

/** Immutable original C3 body only. No current registry/Yjs/lineage rescan and
 * no permission, resume grant, transaction or connection ownership. */
export async function readNativeCopyPhaseLedgerOnConnection(database: SqlConnection, stage: WorkspaceOperationOwnedCopyStage): Promise<{
  receipt: NativeCopyReceipt; xmin: string; createdAt: number;
} | null> {
  const header = await database.get(`SELECT workspace_id,operation_id,organization_id,actor_user_id,actor_session_id,version,kind,
    request_fingerprint,publication_fingerprint,publication_status,xmin::text AS xmin,created_at,
    octet_length(private_result::text) AS result_bytes,octet_length(scope_paths::text) AS scope_bytes
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2 FOR UPDATE`,
  [stage.identity.destinationWorkspaceId, stage.identity.operationId]) as Row | undefined;
  if (!header) return null;
  if (header.workspace_id !== stage.identity.destinationWorkspaceId || header.operation_id !== stage.identity.operationId
    || header.organization_id !== stage.origin.destinationScope.organizationId || header.actor_user_id !== stage.origin.actor.userId
    || header.actor_session_id !== stage.origin.actor.sessionId || header.version !== 1 || header.kind !== 'native_clone'
    || !hash(header.request_fingerprint) || header.publication_fingerprint !== stage.payloadSha256
    || !['native_committed', 'published'].includes(String(header.publication_status)) || typeof header.xmin !== 'string'
    || !bounded(header.result_bytes, 16 * 1024 * 1024) || !bounded(header.scope_bytes, 128 * 1024)
    || stage.version !== 2 && (!bounded(Number(header.created_at), Number.MAX_SAFE_INTEGER - 1) || Number(header.created_at) < 1)) copyPhaseChanged();
  const row = await database.get(`SELECT private_result,scope_paths FROM collaboration_native_copy_receipts
    WHERE workspace_id=$1 AND operation_id=$2 AND octet_length(private_result::text)<=$3 AND octet_length(scope_paths::text)<=$4`,
  [stage.identity.destinationWorkspaceId, stage.identity.operationId, 16 * 1024 * 1024, 128 * 1024]) as Row | undefined;
  if (!row || !equal(row.scope_paths, [...new Set(stage.plan.selections.map(selected => selected.destinationPath))].sort())
    || Buffer.byteLength(JSON.stringify(row.private_result)) > 8 * 1024 * 1024) copyPhaseChanged();
  const receipt = receiptBody(row.private_result, stage, header.publication_status as NativeCopyReceipt['publicationStatus']);
  if (receipt.requestFingerprint !== header.request_fingerprint) copyPhaseChanged();
  return { receipt, xmin: header.xmin, createdAt: Number(header.created_at) };
}

export type NativeCopyPhaseLinkReceipt = Readonly<{
  stepKey: string; mutationId: string; receiptProof: string; receipt: NativeLinkMutationReceipt;
}>;
export function nativeCopyPhaseLinkReceiptProof(receipt: NativeLinkMutationReceipt): string {
  return proof({ contractVersion: receipt.contractVersion, operationId: receipt.operationId, source: receipt.source,
    binding: receipt.binding, before: receipt.before, after: receipt.after,
    afterSnapshotHash: nativeCopyPhaseSha(receipt.afterStateSnapshot), inverseProof: proof(receipt.inverseRecipes) });
}
export async function readNativeCopyPhaseLinkReceiptsOnConnection(database: SqlConnection,
  stage: WorkspaceOperationOwnedCopyStage, receipt: NativeCopyReceipt): Promise<readonly NativeCopyPhaseLinkReceipt[]> {
  const expected = nativeCopyPhaseExpectedLinks(stage, receipt), ids = expected.map(link => link.mutationId);
  const header = await database.get(`SELECT count(*)::integer AS count,
    coalesce(sum(octet_length(after_state_snapshot)+octet_length(after_state_vector)+octet_length(before_state_vector)
      +octet_length(inverse_recipes::text)),0)::bigint AS bytes FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])`,
  [ids]) as Row | undefined;
  if (!header || header.count !== expected.length || !bounded(Number(header.bytes), MAX_TOTAL_BYTES)) copyPhaseChanged();
  if (!expected.length) return [];
  const rows = await database.all(`SELECT * FROM collaboration_native_link_mutation_receipts WHERE operation_id=ANY($1::text[])
    AND octet_length(after_state_snapshot)<=4194304 AND octet_length(inverse_recipes::text)<=4194304
    AND octet_length(before_state_vector)<=1048576 AND octet_length(after_state_vector)<=1048576`, [ids]) as Row[];
  if (rows.length !== expected.length) copyPhaseChanged();
  return expected.map(link => {
    const row = rows.find(row => row.operation_id === link.mutationId) ?? copyPhaseChanged();
    const original = stage.nativeRecords.find(record => record.state.documentId === link.document.source.documentId) ?? copyPhaseChanged();
    const source = { documentId: link.document.clone.documentId, workspaceId: stage.identity.destinationWorkspaceId,
      organizationId: stage.origin.destinationScope.organizationId, path: link.document.clone.path,
      representation: original.state.representation, lifecycleGeneration: 1, schemaVersion: original.state.schemaVersion };
    const binding = { actorUserId: stage.origin.actor.userId, actorId: stage.origin.actor.actorId, actorType: stage.origin.actor.type,
      actorSessionId: stage.origin.actor.sessionId, requestId: link.mutationId, requestHash: stage.identity.canonicalRequestHash,
      authorizedPreparedProof: row.authorized_prepared_proof as string };
    if (row.document_id !== source.documentId || row.workspace_id !== source.workspaceId || row.organization_id !== source.organizationId
      || row.path !== source.path || row.representation !== source.representation || Number(row.lifecycle_generation) !== 1
      || Number(row.schema_version) !== source.schemaVersion || row.actor_user_id !== binding.actorUserId || row.actor_id !== binding.actorId
      || row.actor_type !== binding.actorType || row.actor_session_id !== binding.actorSessionId || row.request_id !== binding.requestId
      || row.request_hash !== binding.requestHash || !hash(binding.authorizedPreparedProof)
      || Number(row.before_sequence) !== 0 || row.before_state_proof !== link.document.clone.stateProof || Number(row.after_sequence) !== 1
      || !stateProof(row.after_state_proof) || !bounded(Number(row.persisted_at), Number.MAX_SAFE_INTEGER - 1)
      || !(row.before_state_vector instanceof Uint8Array) || !(row.after_state_vector instanceof Uint8Array)
      || !(row.after_state_snapshot instanceof Uint8Array) || !Array.isArray(row.inverse_recipes)
      || `yjs-snapshot-sha256-v1:${nativeCopyPhaseSha(row.after_state_snapshot)}` !== row.after_state_proof) copyPhaseChanged();
    const native: NativeLinkMutationReceipt = { contractVersion: 2, operationId: link.mutationId, source, binding,
      before: { stateProof: row.before_state_proof as string, stateVector: Buffer.from(row.before_state_vector).toString('base64'), documentSequence: 0 },
      after: { stateProof: row.after_state_proof as string, stateVector: Buffer.from(row.after_state_vector).toString('base64'), documentSequence: 1,
        persistedAt: Number(row.persisted_at) }, afterStateSnapshot: Buffer.from(row.after_state_snapshot),
      inverseRecipes: row.inverse_recipes as NativeLinkMutationReceipt['inverseRecipes'] };
    return { stepKey: link.stepKey, mutationId: link.mutationId, receipt: native, receiptProof: nativeCopyPhaseLinkReceiptProof(native) };
  });
}

export type CompletedNativeCopyHistoryInput = Readonly<{
  operationId: string; origin: WorkspaceOperationCopyOrigin; requestHash: string; planId: string; storage: NativeCopyReceiptStorageIdentity;
  sceneStorage?: ExcalidrawCopyReceiptStorageIdentity;
}>;
async function historyWitness(database: SqlConnection): Promise<string> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,a.backend_start::text AS start,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted) AS virtual
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || row.isolation !== 'repeatable read' || row.read_only !== 'on' || row.xid !== null
    || typeof row.virtual !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.virtual)) copyPhaseChanged();
  return JSON.stringify(row);
}
async function historyRelations(database: SqlConnection, storage: NativeCopyReceiptStorageIdentity): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(storage.schemaName)) copyPhaseChanged();
  const rows = await database.all(`SELECT names.name,c.oid::bigint AS relation_oid,n.oid::bigint AS schema_oid,
    n.nspname AS schema_name,c.relkind,c.relpersistence,pg_catalog.to_regclass(names.name)::oid::bigint AS resolved_oid,
    pg_catalog.current_schema() AS current_schema,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid
    FROM unnest($2::text[]) AS names(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',$1::text,names.name))
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace ORDER BY names.name`,
  [storage.schemaName, ['workspace_file_operations', 'workspace_file_operation_steps']]) as Row[];
  if (rows.length !== 2 || rows.some(row => row.schema_name !== storage.schemaName || Number(row.schema_oid) !== storage.schemaOid
    || Number(row.database_oid) !== storage.databaseOid || row.current_schema !== storage.schemaName || row.relkind !== 'r'
    || row.relpersistence !== 'p' || !Number.isSafeInteger(Number(row.relation_oid)) || Number(row.relation_oid) < 1
    || Number(row.relation_oid) !== Number(row.resolved_oid))) copyPhaseChanged();
  return JSON.stringify(rows);
}
/** Stage-free historical reply only. Current authorization belongs to the
 * actual fixed owner before this caller-held RR/RO/no-XID read. An immutable
 * published receipt and original completion never authorize another mutation. */
export async function readCompletedNativeCopyHistoryOnConnection(database: SqlConnection,
  input: CompletedNativeCopyHistoryInput): Promise<Readonly<{ operation: WorkspaceOperationRecord; nativeReceipt: NativeCopyReceipt;
    stageVersion: 2 | 3 | 4; managedReceipt?: ExcalidrawCopyBirthReceipt }> | null> {
  const captured = captureWorkspaceOperationNativePlanData(input, copyPhaseChanged);
  const value = object(captured, ['operationId', 'origin', 'requestHash', 'planId', 'storage',
    ...(captured && typeof captured === 'object' && Object.hasOwn(captured, 'sceneStorage') ? ['sceneStorage'] : [])]) as unknown as CompletedNativeCopyHistoryInput;
  const origin = decodeWorkspaceOperationCopyOrigin(value.origin);
  if (typeof value.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(value.operationId)
    || !hash(value.requestHash) || !hash(value.planId)) copyPhaseChanged();
  await assertNativeCopySessionOnConnection(database, origin);
  const pinned = await historyWitness(database);
  const relations = await historyRelations(database, value.storage);
  if (pinned !== await historyWitness(database)) copyPhaseChanged();
  const header = await database.get(`SELECT operation_id,plan_id,request_hash,
    CASE WHEN octet_length(request_json)<=65536 THEN request_json END AS request_json,
    actor_type,actor_id,source_workspace_id,destination_workspace_id,expected_step_count,status,phase,revision,error_code,created_at,updated_at
    FROM workspace_file_operations WHERE operation_id=$1`, [value.operationId]) as Row | undefined;
  if (!header || header.status !== 'completed') {
    if (pinned !== await historyWitness(database) || relations !== await historyRelations(database, value.storage)) copyPhaseChanged();
    await assertNativeCopySessionOnConnection(database, origin); return null;
  }
  const step = await database.get(`SELECT phase,status,before_fence,after_fence,backup_ref,
    CASE WHEN octet_length(receipt_json)<=16384 THEN receipt_json END AS receipt_json
    FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key=$2`,
  [value.operationId, NATIVE_COPY_COMPLETION_STEP_KEY]) as Row | undefined;
  if (!step) {
    if (pinned !== await historyWitness(database) || relations !== await historyRelations(database, value.storage)) copyPhaseChanged();
    await assertNativeCopySessionOnConnection(database, origin); return null;
  }
  if (header.operation_id !== value.operationId || header.plan_id !== value.planId || header.request_hash !== value.requestHash
    || typeof header.request_json !== 'string' || header.actor_type !== origin.actor.type || header.actor_id !== origin.actor.userId
    || header.source_workspace_id !== origin.sourceScope.workspaceId || header.destination_workspace_id !== origin.destinationScope.workspaceId
    || header.phase !== 'completed' || !bounded(Number(header.expected_step_count), 10_000) || Number(header.expected_step_count) < 1
    || !bounded(Number(header.revision), Number.MAX_SAFE_INTEGER - 1) || Number(header.revision) < 1
    || !bounded(Number(header.created_at), Number.MAX_SAFE_INTEGER - 1) || !bounded(Number(header.updated_at), Number.MAX_SAFE_INTEGER - 1)
    || step.phase !== 'link' || step.status !== 'applied' || step.backup_ref !== null || !hash(step.before_fence)
    || !hash(step.after_fence) || typeof step.receipt_json !== 'string') copyPhaseChanged();
  const request = JSON.parse(header.request_json) as import('./workspace-operation-journal').WorkspaceOperationRequest;
  const serialized = serializeWorkspaceOperationRequest(request);
  if (request.kind !== 'copy' || !request.origin || !equal(request.origin, origin)
    || serialized.requestJson !== header.request_json || serialized.requestHash !== value.requestHash) copyPhaseChanged();
  const parsed: unknown = JSON.parse(step.receipt_json);
  const version = parsed && typeof parsed === 'object' ? Object.getOwnPropertyDescriptor(parsed, 'version')?.value : undefined;
  const completed = object(parsed, ['version', 'kind', 'canonicalRequestHash', 'planId', 'stageDigest',
    'nativeRequestFingerprint', 'copyReceiptProof', 'admissionsProof', ...(version === 2 ? ['coreV2StageDigest', 'metadata'] : []),
    ...(version === 3 ? ['metadata', 'sceneIntentProof', 'sceneBirthProof', 'assetReceiptProof'] : [])]);
  if (![1, 2, 3].includes(completed.version as number) || completed.kind !== 'native-copy-completion' || completed.canonicalRequestHash !== value.requestHash
    || completed.planId !== value.planId || completed.stageDigest !== step.after_fence
    || ![completed.stageDigest, completed.nativeRequestFingerprint, completed.copyReceiptProof, completed.admissionsProof].every(hash)) copyPhaseChanged();
  const metadata = completed.version === 2 || completed.version === 3 ? decodeNativeCopyMetadataCompletionWitness(completed.metadata) : null;
  if (completed.version === 2 && metadata && (!hash(completed.coreV2StageDigest)
    || nativeCopyMetadataCompositeDigest(completed.coreV2StageDigest, { version: metadata.version, kind: metadata.kind,
      snapshotProof: metadata.snapshotProof, sourceRowCount: metadata.sourceRowCount, copiedTitleCount: metadata.copiedTitleCount }) !== completed.stageDigest)) copyPhaseChanged();
  if (step.before_fence !== nativeCopyPhaseCompletionFence({ canonicalRequestHash: value.requestHash, planId: value.planId,
    stageDigest: completed.stageDigest as string })) copyPhaseChanged();
  const progress = await database.get(`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE status='applied')::integer AS applied FROM workspace_file_operation_steps WHERE operation_id=$1`,
  [value.operationId]) as Row | undefined;
  if (!progress || progress.total !== Number(header.expected_step_count) || progress.applied !== progress.total) copyPhaseChanged();
  const nativeReceipt = await readHistoricalNativeWorkspaceCopyReceiptOnConnection(database, { storage: value.storage,
    workspaceId: origin.destinationScope.workspaceId, organizationId: origin.destinationScope.organizationId,
    operationId: value.operationId, actorUserId: origin.actor.userId, actorSessionId: origin.actor.sessionId,
    kind: 'native_clone', requestFingerprint: completed.nativeRequestFingerprint as string, publicationFingerprint: completed.stageDigest as string });
  if (!nativeReceipt || nativeReceipt.publicationStatus !== 'published' || nativeCopyPhaseReceiptProof(nativeReceipt) !== completed.copyReceiptProof) copyPhaseChanged();
  let managedReceipt: ExcalidrawCopyBirthReceipt | undefined;
  if (completed.version === 3) {
    if (!value.sceneStorage || ![completed.sceneIntentProof, completed.sceneBirthProof, completed.assetReceiptProof].every(hash)) copyPhaseChanged();
    const scene = await readHistoricalExcalidrawCopyOnConnection(database, { operationId: value.operationId,
      stageDigest: completed.stageDigest as string, requestHash: value.requestHash, origin, storage: value.sceneStorage });
    if (!scene || scene.intent.nativeRequestFingerprint !== nativeReceipt.requestFingerprint
      || scene.intent.nativeReceiptProof !== nativeCopyPhaseReceiptProof(nativeReceipt) || scene.intent.intentDigest !== completed.sceneIntentProof
      || scene.receiptProof !== completed.sceneBirthProof || scene.assetReceipt.receiptProof !== completed.assetReceiptProof) copyPhaseChanged();
    managedReceipt = scene;
  }
  const scopes = await database.get(`SELECT CASE WHEN octet_length(scope_paths::text)<=131072 THEN scope_paths END AS scopes${metadata ? ',created_at' : ''}
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [origin.destinationScope.workspaceId, value.operationId]) as Row | undefined;
  if (!scopes || !equal(scopes.scopes, [...new Set(request.selections.map(selection => selection.destinationPath))].sort())
    || metadata && (!bounded(Number(scopes.created_at), Number.MAX_SAFE_INTEGER - 1) || Number(scopes.created_at) !== metadata.copyCreatedAt)) copyPhaseChanged();
  if (pinned !== await historyWitness(database) || relations !== await historyRelations(database, value.storage)) copyPhaseChanged();
  await assertNativeCopySessionOnConnection(database, origin);
  return { operation: { operationId: value.operationId, planId: value.planId, requestHash: value.requestHash, requestJson: header.request_json,
    actor: { type: origin.actor.type, id: origin.actor.userId }, sourceWorkspaceId: origin.sourceScope.workspaceId,
    destinationWorkspaceId: origin.destinationScope.workspaceId, expectedStepCount: Number(header.expected_step_count), status: 'completed', phase: 'completed',
    revision: Number(header.revision), errorCode: header.error_code as string | null, createdAt: Number(header.created_at), updatedAt: Number(header.updated_at) }, nativeReceipt,
    stageVersion: completed.version === 3 ? 4 : completed.version === 2 ? 3 : 2, ...(managedReceipt ? { managedReceipt } : {}) };
}
