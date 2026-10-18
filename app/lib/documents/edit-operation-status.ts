import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { captureNativeDocumentEditOriginal, captureNativeDocumentEditAfter, nativeDocumentEditOwnerTuple,
  NativeDocumentEditOperationError, type NativeDocumentEditOriginalV1, type NativeDocumentEditAfterV1 } from '../collaboration/native-document-edit-operation-contract';
import { withNativeDocumentEditWriteAuthorityOnConnection, type NativeDocumentEditWriteAuthority,
  type NativeDocumentEditWriteAuthorityAccess } from './edit-principal';
import { DocumentEditError } from './edit-contracts';
import { decodeDocumentEditStatusRequestV1, encodeDocumentEditOperationResultV1,
  type DocumentEditOperationResultV1, type DocumentEditStatusRequestV1 } from './edit-result-contract';

const ORIGINAL_BYTES = 32 * 1024, AFTER_BYTES = 16 * 1024, HEADER_BYTES = 16 * 1024;
const VECTOR_BYTES = 1024 * 1024, SNAPSHOT_BYTES = 64 * 1024 * 1024;
type Row = Record<string, unknown>;
type ProjectedRow = { header_bytes: number | string; header_json: string | null;
  original_bytes: number | string | null; original_json: string | null;
  after_bytes: number | string | null; after_json: string | null };
function invalid(): never { throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED'); }
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function nullableInteger(value: unknown): value is number | null { return value === null || integer(value); }
function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function boundedJson(value: unknown, byteCount: unknown, maximum: number): unknown {
  const length = typeof byteCount === 'string' && /^[0-9]{1,16}$/u.test(byteCount) ? Number(byteCount) : byteCount;
  if (!integer(length, 1) || length > maximum || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') !== length) invalid();
  try { return JSON.parse(value) as unknown; } catch { return invalid(); }
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Row;
}

/** A single bounded operation-row statement, independent of today's document
 * registry/path/lifecycle. Binary values are never transferred to this reader. */
const operationSql = (schema: string): string => `WITH selected AS (
  SELECT native_edit_original_json AS original,native_edit_after_json AS after,
    pg_catalog.jsonb_build_object(
      'operation_id',operation_id,'document_id',document_id,'workspace_id',workspace_id,'organization_id',organization_id,
      'document_path',document_path,'document_representation',document_representation,
      'document_lifecycle_generation',document_lifecycle_generation,'schema_version',schema_version,
      'initiated_by_user_id',initiated_by_user_id,'actor_id',actor_id,'actor_session_id',actor_session_id,
      'operation_type',operation_type,'requested_mode',requested_mode,'atomicity',atomicity,
      'file_edit_absent',file_edit_request_json IS NULL,'expected_hash_absent',expected_canonical_hash IS NULL,
      'base_document_sequence',base_document_sequence,'base_vector_bytes',pg_catalog.octet_length(base_state_vector),
      'base_vector_hash',CASE WHEN pg_catalog.octet_length(base_state_vector) BETWEEN 1 AND ${VECTOR_BYTES} THEN pg_catalog.encode(pg_catalog.sha256(base_state_vector),'hex') END,
      'snapshot_bytes',pg_catalog.octet_length(resulting_state_snapshot),
      'snapshot_hash',CASE WHEN pg_catalog.octet_length(resulting_state_snapshot) BETWEEN 1 AND ${SNAPSHOT_BYTES} THEN pg_catalog.encode(pg_catalog.sha256(resulting_state_snapshot),'hex') END,
      'resulting_state_vector_hash',resulting_state_vector_hash,'status',status,'error_code',error_code,
      'applied_at',applied_at,'persisted_at',persisted_at,'checkpointed_at',checkpointed_at,
      'applied_document_sequence',applied_document_sequence,'checkpoint_revision_id',checkpoint_revision_id,'version_revision_id',version_revision_id
    ) AS header
  FROM ${schema}.collaboration_agent_operations
  WHERE operation_id=$1 AND workspace_id=$2 AND initiated_by_user_id=$3 AND native_edit_original_json IS NOT NULL LIMIT 1
)
SELECT pg_catalog.octet_length(header::text) AS header_bytes,
  CASE WHEN pg_catalog.octet_length(header::text)<=${HEADER_BYTES} THEN header::text END AS header_json,
  pg_catalog.octet_length(original::text) AS original_bytes,
  CASE WHEN pg_catalog.octet_length(original::text)<=${ORIGINAL_BYTES} THEN original::text END AS original_json,
  pg_catalog.octet_length(after::text) AS after_bytes,
  CASE WHEN pg_catalog.octet_length(after::text)<=${AFTER_BYTES} THEN after::text END AS after_json FROM selected`;

function currentOwner(original: NativeDocumentEditOriginalV1, access: NativeDocumentEditWriteAuthorityAccess): void {
  access.assertActive();
  const current = access.origin, past = original.origin;
  // A renewed SID/PI invocation is current authority; historical SID/profile and
  // tool-call facts are not compared or adopted as grants.
  if (original.identity.workspaceId !== access.workspace.workspaceId || original.identity.organizationId !== (access.workspace.organizationId ?? null)
    || past.workspaceType !== current.workspaceType || past.customerId !== current.customerId || past.projectId !== current.projectId
    || past.ownerUserId !== current.ownerUserId || past.schema !== current.schema || past.schemaOid !== current.schemaOid
    || past.databaseOid !== current.databaseOid || past.searchPath !== current.searchPath
    || !isDeepStrictEqual(nativeDocumentEditOwnerTuple(past), nativeDocumentEditOwnerTuple(current))) throw new DocumentEditError('DOCUMENT_NOT_FOUND');
}
async function currentSchema(database: SqlConnection, access: NativeDocumentEditWriteAuthorityAccess): Promise<string> {
  access.assertActive();
  const origin = access.origin;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(origin.schema) || origin.schema.startsWith('pg_')
    || !integer(origin.schemaOid, 1) || !integer(origin.databaseOid, 1)) invalid();
  const row = await database.get(`SELECT n.oid::bigint AS schema_oid,d.oid::bigint AS database_oid
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database()
    WHERE n.nspname=$1`, [origin.schema]) as { schema_oid: unknown; database_oid: unknown } | undefined;
  const oid = (value: unknown): number | null => typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value)
    ? Number(value) : integer(value, 1) ? value : null;
  if (!row || oid(row.schema_oid) !== origin.schemaOid || oid(row.database_oid) !== origin.databaseOid) {
    throw new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
  }
  return `"${origin.schema}"`;
}
function originalFacts(h: Row, original: NativeDocumentEditOriginalV1, request: DocumentEditStatusRequestV1): void {
  if (h.operation_id !== request.operationId || h.workspace_id !== request.workspaceId || h.document_id !== original.identity.documentId
    || h.workspace_id !== original.identity.workspaceId || h.organization_id !== original.identity.organizationId
    || h.document_path !== original.source.path || h.document_representation !== original.identity.representation
    || h.document_lifecycle_generation !== original.identity.lifecycleGeneration || h.schema_version !== original.identity.schemaVersion
    || h.initiated_by_user_id !== original.actor.userId || h.actor_id !== original.actor.actorId || h.actor_session_id !== original.actor.sessionId
    || h.operation_type !== 'apply' || h.requested_mode !== 'direct_apply' || h.atomicity !== 'all_or_nothing'
    || h.file_edit_absent !== true || h.expected_hash_absent !== true
    || !integer(h.base_document_sequence) || h.base_document_sequence !== original.source.persistedSequence
    || !integer(h.base_vector_bytes, 1) || h.base_vector_bytes > VECTOR_BYTES || h.base_vector_hash !== original.source.stateVectorHash
    || !nullableInteger(h.applied_at) || !nullableInteger(h.persisted_at) || !nullableInteger(h.checkpointed_at)
    || !nullableInteger(h.applied_document_sequence)
    || h.checkpoint_revision_id !== null && !text(h.checkpoint_revision_id, 128)
    || h.version_revision_id !== null && !text(h.version_revision_id, 128)
    || h.error_code !== null && !text(h.error_code, 128)) invalid();
}
function effectFacts(h: Row, original: NativeDocumentEditOriginalV1, after: NativeDocumentEditAfterV1 | null): void {
  if (after) {
    if (h.applied_at !== after.appliedAt || h.resulting_state_vector_hash !== after.stateVectorHash
      || !integer(h.snapshot_bytes, 1) || h.snapshot_bytes > SNAPSHOT_BYTES || h.snapshot_hash !== after.stateSnapshotHash) invalid();
  } else if (h.applied_at !== null || h.snapshot_bytes !== null || h.snapshot_hash !== null || h.resulting_state_vector_hash !== null
    || h.persisted_at !== null || h.applied_document_sequence !== null || h.checkpointed_at !== null
    || h.checkpoint_revision_id !== null || h.version_revision_id !== null) invalid();
  if (h.applied_document_sequence !== null && (!integer(h.applied_document_sequence)
    || h.applied_document_sequence < original.source.persistedSequence)) invalid();
  // These inequalities are explicit in confirmDurableAgentOperation's two
  // Math.max assignments, not inferred from unrelated wall-clock observations.
  if (after && h.persisted_at !== null && (!integer(h.persisted_at) || h.persisted_at < after.appliedAt)
    || h.checkpointed_at !== null && (!integer(h.checkpointed_at) || !integer(h.persisted_at) || h.checkpointed_at < h.persisted_at)) invalid();
}

const historySql = (schema: string): string => `SELECT pg_catalog.octet_length(header::text) AS header_bytes,
  CASE WHEN pg_catalog.octet_length(header::text)<=${HEADER_BYTES} THEN header::text END AS header_json FROM (
  SELECT pg_catalog.jsonb_build_object('revision_id',r.id,'workspace_id',r.workspace_id,'lineage_id',r.lineage_id,'path',r.path,
    'history_only',r.history_only,'content_hash',r.content_hash,'size_bytes',r.size_bytes,
    'created_by_user_id',r.created_by_user_id,'created_by_actor_type',r.created_by_actor_type,'source_session_id',r.source_session_id,'created_at',r.created_at,
    'binding_workspace_id',c.workspace_id,'binding_lineage_id',c.lineage_id,'content_format',c.content_format,'source',c.source,'state_vector_hash',c.state_vector_hash,
    'blob_id',b.blob_id,'blob_workspace_id',b.workspace_id,'content_sha256',b.content_sha256,'codec',b.codec,
    'raw_size_bytes',b.raw_size_bytes,'stored_size_bytes',b.stored_size_bytes,'actual_stored_bytes',pg_catalog.octet_length(b.compressed_content)) AS header
  FROM ${schema}.file_revisions r JOIN ${schema}.file_revision_contents c ON c.revision_id=r.id JOIN ${schema}.file_version_blobs b ON b.blob_id=c.blob_id
  WHERE r.id=$1 AND r.workspace_id=$2 AND r.lineage_id=$3 LIMIT 1
) stored`;
async function recordedHistory(database: SqlConnection, h: Row, original: NativeDocumentEditOriginalV1,
  after: NativeDocumentEditAfterV1 | null, operationId: string, schema: string): Promise<DocumentEditOperationResultV1['history']> {
  if (!after) return { status: 'unconfirmed', revisionId: null };
  if (after.history.status === 'over_limit') {
    if (h.version_revision_id !== null) invalid();
    return { status: 'over_limit', revisionId: null };
  }
  if (h.version_revision_id === null) return { status: 'unconfirmed', revisionId: null };
  const id = `file-rev-op-${createHash('sha256').update(`${original.identity.workspaceId}\0${operationId}`).digest('hex')}`;
  if (h.version_revision_id !== id) return { status: 'unconfirmed', revisionId: null };
  const row = await database.get(historySql(schema), [id,original.identity.workspaceId,original.identity.lineageId]) as { header_bytes: unknown; header_json: unknown } | undefined;
  if (!row) return { status: 'unconfirmed', revisionId: null };
  const header = object(boundedJson(row.header_json, row.header_bytes, HEADER_BYTES));
  const actor = original.actor, identity = original.identity, expectedSource = actor.actorType === 'user' ? 'manual' : 'agent_apply';
  // Metadata/receipt inspection only. No compressed body, binary update or
  // current document is read; this does not perform a content-store audit.
  const exact = header.revision_id === id && header.workspace_id === identity.workspaceId && header.lineage_id === identity.lineageId
    && header.path === original.source.path && header.history_only === true && header.content_hash === after.history.sha256
    && header.size_bytes === after.history.sizeBytes && header.created_by_user_id === actor.userId
    && header.created_by_actor_type === actor.actorType && header.source_session_id === actor.sessionId && header.created_at === after.appliedAt
    && header.binding_workspace_id === identity.workspaceId && header.binding_lineage_id === identity.lineageId
    && header.content_format === 'binary' && header.source === expectedSource && header.state_vector_hash === after.stateVectorHash
    && text(header.blob_id, 128) && header.blob_workspace_id === identity.workspaceId && header.content_sha256 === after.history.sha256
    && header.codec === 'gzip' && header.raw_size_bytes === after.history.sizeBytes && integer(header.stored_size_bytes, 1)
    && header.stored_size_bytes <= 1024 * 1024 + 64 * 1024 && header.actual_stored_bytes === header.stored_size_bytes;
  return exact ? { status: 'captured', revisionId: id } : { status: 'unconfirmed', revisionId: null };
}

async function readStatus(database: SqlConnection, access: NativeDocumentEditWriteAuthorityAccess,
  request: DocumentEditStatusRequestV1): Promise<DocumentEditOperationResultV1> {
  if (access.workspace.workspaceId !== request.workspaceId) throw new DocumentEditError('DOCUMENT_NOT_FOUND');
  const schema = await currentSchema(database, access);
  const row = await database.get(operationSql(schema), [request.operationId,request.workspaceId,access.userId]) as ProjectedRow | undefined;
  if (!row) { await access.assertCurrent(); throw new DocumentEditError('DOCUMENT_NOT_FOUND'); }
  const original = captureNativeDocumentEditOriginal(boundedJson(row.original_json, row.original_bytes, ORIGINAL_BYTES));
  currentOwner(original, access);
  const h = object(boundedJson(row.header_json, row.header_bytes, HEADER_BYTES)); originalFacts(h, original, request);
  const after = row.after_bytes === null && row.after_json === null ? null
    : captureNativeDocumentEditAfter(boundedJson(row.after_json, row.after_bytes, AFTER_BYTES), original);
  effectFacts(h, original, after);
  const statuses = ['preparing', 'ready', 'applying', 'applied_to_ydoc', 'partially_applied', 'persisted_yjs', 'checkpointed_file', 'failed'];
  if (typeof h.status !== 'string' || !statuses.includes(h.status)) invalid();
  const confirmed = h.status === 'persisted_yjs' || h.status === 'checkpointed_file';
  if (confirmed ? !after || !integer(h.persisted_at) || !integer(h.applied_document_sequence)
    : h.persisted_at !== null || h.applied_document_sequence !== null || h.checkpointed_at !== null || h.checkpoint_revision_id !== null) invalid();
  if (h.status === 'failed' && after || (h.status === 'applied_to_ydoc' || h.status === 'partially_applied') && !after) invalid();
  if (h.status === 'partially_applied' && h.error_code !== 'persistence_degraded') invalid();
  if (after && (h.status === 'preparing' || h.status === 'ready' || h.status === 'applying')) invalid();
  const checkpointed = h.status === 'checkpointed_file';
  if (checkpointed ? !integer(h.checkpointed_at) || !text(h.checkpoint_revision_id, 128)
    : h.checkpointed_at !== null || h.checkpoint_revision_id !== null) invalid();
  const history = await recordedHistory(database, h, original, after, request.operationId, schema);
  const state = confirmed ? 'confirmed' : h.status === 'failed'
    ? h.error_code === 'DOCUMENT_VERSION_CONFLICT' || h.error_code === 'DOCUMENT_EDIT_CONFLICT' ? 'conflict' : 'failed' : 'pending';
  const result = encodeDocumentEditOperationResultV1({ apiVersion: 1, operationId: request.operationId, state,
    document: { kind: 'native_document', ...original.identity },
    effect: after ? { outcome: after.outcome, beforeVersion: after.beforeVersion, afterVersion: after.afterVersion, appliedAt: after.appliedAt } : null,
    persistence: confirmed ? { status: 'confirmed', confirmedInSequence: h.applied_document_sequence, confirmedAt: h.persisted_at }
      : { status: 'unconfirmed', confirmedInSequence: null, confirmedAt: null },
    projection: checkpointed ? { status: 'checkpointed', checkpointedAt: h.checkpointed_at, revisionId: h.checkpoint_revision_id }
      : { status: 'unconfirmed', checkpointedAt: null, revisionId: null }, history });
  await access.assertCurrent();
  if (await currentSchema(database, access) !== schema) throw new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
  access.assertActive(); return result;
}

/** Pure stored status under the SAME current Write/tool policy. There is no
 * reconciliation, history capture, native-state read, filesystem or room wait.
 * RC/RW is required by the existing principal; it assigns a transaction XID,
 * but this module issues only SELECTs and changes no domain row/xmin. */
export async function readNativeDocumentEditOperationStatus(authority: NativeDocumentEditWriteAuthority,
  value: unknown): Promise<DocumentEditOperationResultV1> {
  const request = decodeDocumentEditStatusRequestV1(value);
  return executeLifecycleTransaction({ openConnection: openDb,
    execute: database => withNativeDocumentEditWriteAuthorityOnConnection(database, authority, access => readStatus(database, access, request)),
    // A status read has no operation mutation to recover. Never route a failed
    // read COMMIT/cleanup through a mutating Owner or retry the whole phase.
    recoverCommitted: async () => { throw new NativeDocumentEditOperationError('EDIT_OUTCOME_UNCONFIRMED', request.operationId); },
  });
}
