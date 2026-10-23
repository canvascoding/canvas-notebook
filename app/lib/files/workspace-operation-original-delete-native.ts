import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';
import { ARCHIVED_NATIVE_BINARY_LIMIT, inspectArchivedNativeSnapshot } from '../collaboration/archived-native-snapshot';
import { inspectPersistedNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { getNativeInspectionSchema } from '../collaboration/native-inspection-schema';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import { captureNativeFileArchiveRestoreData, prepareNativeFileArchiveTransition, prepareNativeFileRestoreTransition,
  type NativeFileArchiveExpected, type NativeFileArchiveTransition,
  type NativeFileRestoreTransition } from '../collaboration/native-file-archive-transition';
import { validateRawState } from '../collaboration/native-session-state-reader';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from '../collaboration/persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isCollaborationStateProof } from '../collaboration/state-proof';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';
import type { WorkspaceContext } from '../workspaces/types';

type Row = Record<string, unknown>;
type Scope = Readonly<{ workspaceId: string; workspaceType: WorkspaceContext['workspaceType']; organizationId: string | null;
  customerId: string | null; projectId: string | null }>;
type Selection = Scope & Readonly<{ schema: string; documentId: string; lineageId: string; path: string }>;
type LockedRows = { registry: Row; lineage: Row; raw: Row; projection: Row | undefined };
type ReadInput = Readonly<{ schema: string; workspace: WorkspaceContext; documentId: string; lineageId: string; path: string }>;
type ArchiveInput = Readonly<{ schema: string; workspace: WorkspaceContext; expected: NativeFileArchiveExpected;
  trashEntryId: string; archivedAt: number }>;
type RestoreInput = Readonly<{ schema: string; workspace: WorkspaceContext; expected: NativeFileArchiveExpected;
  archived: NativeFileArchiveTransition; trashEntryId: string; restoredAt: number }>;
type ErrorCode = 'ORIGINAL_NATIVE_DELETE_INVALID' | 'ORIGINAL_NATIVE_DELETE_CHANGED' | 'ORIGINAL_NATIVE_DELETE_BUSY'
  | 'ORIGINAL_NATIVE_DELETE_TOO_LARGE' | 'ORIGINAL_NATIVE_DELETE_POSTCONDITION';
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_VECTOR_BYTES = 1024 * 1024;
const expectedKeys = ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion',
  'lifecycleGeneration', 'registryStateVersion', 'documentSequence', 'persistedAt', 'stateProof', 'binaryHash', 'vectorHash'] as const;
const stateWriteKeys = ['status', 'lifecycle_generation', 'checkpoint_sequence', 'checkpointed_at', 'canonical_hash',
  'serialized_hash', 'degraded', 'projection_error_code', 'projection_error_sequence', 'projection_error_generation',
  'projection_error_phase', 'projection_error_cause', 'projection_error_permanent'];
const terminalAgentStatuses = "'persisted_yjs','checkpointed_file','cancelled','expired','superseded','failed','rejected','reverted'";

function fail(code: ErrorCode): never { throw Object.assign(new Error(code), { code }); }
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const safe = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) && Number.isSafeInteger(Number(value))
  && Number(value) >= minimum && Number(value) < Number.MAX_SAFE_INTEGER;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const flag = (value: unknown): boolean => [0, 1, '0', '1', false, true].includes(value as never);
const trueFlag = (value: unknown): boolean => value === true || value === 1 || value === '1';
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string' && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);

function data(input: unknown, keys: readonly string[]): Row {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  const result: Row = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('ORIGINAL_NATIVE_DELETE_INVALID');
    result[key] = descriptor.value;
  }
  return result;
}
function own(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  return descriptor?.value;
}
function captureScope(input: unknown): Scope {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  const workspaceId = own(input, 'workspaceId'), workspaceType = own(input, 'workspaceType'),
    organizationId = own(input, 'organizationId') ?? null, customerId = own(input, 'customerId') ?? null,
    projectId = own(input, 'projectId') ?? null, legacy = own(input, 'legacy'), status = own(input, 'status');
  if (!id(workspaceId) || typeof workspaceType !== 'string' || !['personal', 'organization', 'team', 'project'].includes(workspaceType)
    || [organizationId, customerId, projectId].some(value => value !== null && !id(value))
    || legacy !== false || status !== undefined && status !== 'active') {
    fail('ORIGINAL_NATIVE_DELETE_INVALID');
  }
  // Identity data only: neither permission flags nor this WorkspaceContext grant authority.
  return Object.freeze({ workspaceId, workspaceType: workspaceType as Scope['workspaceType'],
    organizationId: organizationId as string | null, customerId: customerId as string | null, projectId: projectId as string | null });
}
function schemaName(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 63
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
}
function selection(schema: unknown, workspace: unknown, documentId: unknown, lineageId: unknown, path: unknown): Selection {
  const capturedSchema = schemaName(schema), scope = captureScope(workspace);
  if (!id(documentId) || !id(lineageId) || !isCanonicalAdmissionPath(path)) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  return Object.freeze({ ...scope, schema: capturedSchema, documentId, lineageId, path });
}
function captureExpected(input: NativeFileArchiveExpected): NativeFileArchiveExpected {
  const captured = data(input, expectedKeys);
  if (![captured.documentId, captured.lineageId, captured.workspaceId].every(id)
    || captured.organizationId !== null && !id(captured.organizationId) || !isCanonicalAdmissionPath(captured.path)
    || typeof captured.representation !== 'string' || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(captured.representation)
    || captured.schemaVersion !== COLLABORATION_SCHEMA_VERSION || !safe(captured.lifecycleGeneration, 1)
    || !safe(Number(captured.lifecycleGeneration) + 1, 1)
    || ['lifecycleGeneration', 'registryStateVersion', 'documentSequence', 'persistedAt'].some(key => typeof captured[key] !== 'number' || !safe(captured[key]))
    || !isCollaborationStateProof(captured.stateProof)
    || ![captured.binaryHash, captured.vectorHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) {
    fail('ORIGINAL_NATIVE_DELETE_INVALID');
  }
  return Object.freeze(captured) as unknown as NativeFileArchiveExpected;
}
function assertScope(row: Row, selected: Selection): void {
  if (row.workspace_id !== selected.workspaceId || row.workspace_type !== selected.workspaceType
    || row.organization_id !== selected.organizationId || row.customer_id !== null && row.customer_id !== selected.customerId
    || row.project_id !== null && row.project_id !== selected.projectId || row.path !== selected.path) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
}
function assertBounds(row: Row): void {
  if (!safe(row.state_bytes, 1) || Number(row.state_bytes) > MAX_STATE_BYTES
    || !safe(row.vector_bytes, 1) || Number(row.vector_bytes) > MAX_VECTOR_BYTES) fail('ORIGINAL_NATIVE_DELETE_TOO_LARGE');
}
async function assertNoAgentOperation(database: SqlConnection, selected: Selection, locking = true): Promise<void> {
  if (await database.get(`SELECT operation_id FROM ${selected.schema}.collaboration_agent_operations WHERE document_id=$1
    AND (status IS NULL OR status NOT IN (${terminalAgentStatuses})) LIMIT 1${locking ? ' FOR SHARE NOWAIT' : ''}`, [selected.documentId])) {
    fail('ORIGINAL_NATIVE_DELETE_BUSY');
  }
}
async function lockOriginalRows(database: SqlConnection, selected: Selection, maxStateBytes = MAX_STATE_BYTES,
  locking = true): Promise<LockedRows> {
  const lock = locking ? ' FOR UPDATE NOWAIT' : '';
  // Only the original D1/L1/D1, never a later same-path document. INNER JOIN
  // rejects missing/orphaned bindings before BLOB allocation. NOWAIT applies to
  // all three base rows; no planner-dependent row-lock order is assumed.
  // Do NOT serialize s: to_jsonb(s) would read the binary before its size gate.
  const header = await database.get(`SELECT pg_catalog.to_jsonb(d) AS registry,pg_catalog.to_jsonb(l) AS lineage,
    s.document_id,s.workspace_id,s.organization_id,s.path,s.representation,s.lifecycle_generation,
    s.schema_version,s.status,s.document_sequence,s.persisted_at,s.checkpoint_sequence,s.checkpointed_at,s.newline_style,s.has_bom,s.degraded,
    s.projection_error_code,s.projection_error_sequence,s.projection_error_generation,s.projection_error_phase,s.projection_error_permanent,
    octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes
    FROM ${selected.schema}.collaboration_documents d
      INNER JOIN ${selected.schema}.file_collaboration_lineages l ON l.id=d.lineage_id
      INNER JOIN ${selected.schema}.collaboration_yjs_states s ON s.document_id=d.id
    WHERE d.id=$1 AND l.id=$2${locking ? ' FOR UPDATE OF d,l,s NOWAIT' : ''}`,
  [selected.documentId, selected.lineageId]) as Row | undefined;
  if (!header || !header.registry || !header.lineage || typeof header.registry !== 'object' || typeof header.lineage !== 'object'
    || Object.getPrototypeOf(header.registry) !== Object.prototype || Object.getPrototypeOf(header.lineage) !== Object.prototype) {
    fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  }
  const { registry: registryValue, lineage: lineageValue, ...metadata } = header;
  const registry = registryValue as Row, lineage = lineageValue as Row;
  assertBounds(metadata);
  if (Number(metadata.state_bytes) > maxStateBytes) fail('ORIGINAL_NATIVE_DELETE_TOO_LARGE');
  const raw = await database.get(`SELECT * FROM ${selected.schema}.collaboration_yjs_states WHERE document_id=$1
    AND octet_length(yjs_state) BETWEEN 1 AND $2 AND octet_length(state_vector) BETWEEN 1 AND $3`,
  [selected.documentId, maxStateBytes, MAX_VECTOR_BYTES]) as Row | undefined;
  if (!raw || !(raw.yjs_state instanceof Uint8Array) || !(raw.state_vector instanceof Uint8Array)
    || raw.yjs_state.byteLength !== Number(metadata.state_bytes) || raw.state_vector.byteLength !== Number(metadata.vector_bytes)) {
    fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  }
  const projection = await database.get(`SELECT * FROM ${selected.schema}.collaboration_file_projections
    WHERE document_id=$1${lock}`, [selected.documentId]) as Row | undefined;
  return { registry, lineage, raw, projection };
}
async function mapBoundedRow(raw: Row, documentId: string): Promise<PersistedCollaborationState> {
  const normalized = { ...raw, has_bom: trueFlag(raw.has_bom) ? 1 : 0, degraded: trueFlag(raw.degraded) ? 1 : 0,
    projection_error_permanent: Number(raw.projection_error_permanent) };
  // Fixed already-read row adapter, not a second SQL reader or an authorization bypass.
  const state = await loadCollaborationStateOnConnection({ get: (sql, values) => {
    if (sql.replace(/\s+/gu, ' ').trim() !== 'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1'
      || values?.length !== 1 || values[0] !== documentId) fail('ORIGINAL_NATIVE_DELETE_INVALID');
    return normalized;
  } }, documentId, true);
  if (!state) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  return state;
}
function assertProjection(projection: Row | undefined, state: PersistedCollaborationState): void {
  if (projection && (projection.document_id !== state.documentId || !safe(projection.lifecycle_generation, 1)
    || !safe(projection.projected_sequence) || !safe(projection.updated_at) || !flag(projection.finalized)
    || ![projection.revision_id, projection.canonical_hash, projection.serialized_hash].every(nullableText)
    || Number(projection.lifecycle_generation) > state.lifecycleGeneration
    || Number(projection.lifecycle_generation) === state.lifecycleGeneration && Number(projection.projected_sequence) > state.documentSequence)) {
    fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  }
}
async function readActiveTarget(database: SqlConnection, selected: Selection, maxStateBytes = MAX_STATE_BYTES): Promise<LockedRows & {
  state: PersistedCollaborationState; expected: NativeFileArchiveExpected }> {
  const rows = await lockOriginalRows(database, selected, maxStateBytes), { registry, lineage, raw } = rows;
  assertScope(registry, selected); assertScope(lineage, selected);
  if (registry.id !== selected.documentId || registry.lineage_id !== selected.lineageId || lineage.id !== selected.lineageId
    || registry.provider !== 'yjs' || registry.yjs_state_lifecycle !== 'initialized' || registry.status !== 'active'
    || !safe(registry.state_version) || lineage.status !== 'active' || lineage.archived_at !== null
    || raw.document_id !== selected.documentId || raw.workspace_id !== selected.workspaceId
    || raw.organization_id !== selected.organizationId || raw.path !== selected.path
    || ![raw.canonical_hash, raw.serialized_hash].every(nullableText)) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  // The mapper intentionally omits stale errors and understands numeric flags:
  // reject malformed raw bindings/flags BEFORE allowing that normalization.
  validateRawState(raw);
  await assertNoAgentOperation(database, selected);
  const state = await mapBoundedRow(raw, selected.documentId);
  if (Number(registry.state_version) > state.documentSequence) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  assertProjection(rows.projection, state);
  const native = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
    assertNativeDocumentSchema(doc, state.representation, getNativeInspectionSchema());
    return snapshot;
  });
  const expected: NativeFileArchiveExpected = Object.freeze({ documentId: selected.documentId, lineageId: selected.lineageId,
    workspaceId: selected.workspaceId, organizationId: selected.organizationId, path: selected.path,
    representation: state.representation, schemaVersion: state.schemaVersion, lifecycleGeneration: state.lifecycleGeneration,
    registryStateVersion: Number(registry.state_version), documentSequence: state.documentSequence, persistedAt: state.persistedAt,
    stateProof: native.version.stateProof, binaryHash: hash(state.yjsState), vectorHash: hash(state.stateVector) });
  return { ...rows, state, expected };
}

/** Mechanical observation under caller-owned B/TX. Returned values are NOT
 * retained authority, current rights, admission/room fences or a commit receipt. */
export async function readOriginalNativeDeleteTargetOnConnection(database: SqlConnection, input: ReadInput):
Promise<Readonly<{ state: PersistedCollaborationState; expected: NativeFileArchiveExpected }>> {
  const captured = data(input, ['schema', 'workspace', 'documentId', 'lineageId', 'path']);
  const selected = selection(captured.schema, captured.workspace, captured.documentId, captured.lineageId, captured.path);
  const result = await readActiveTarget(database, selected);
  return Object.freeze({ state: result.state, expected: result.expected });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength)
      .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  }
  return Object.is(a, b);
}
function preserved(before: Row, after: Row, changed: readonly string[]): void {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length || keys.some(key => !Object.hasOwn(after, key)
    || !changed.includes(key) && !sameValue(before[key], after[key]))) fail('ORIGINAL_NATIVE_DELETE_POSTCONDITION');
}
async function verifyArchived(database: SqlConnection, selected: Selection, original: LockedRows,
  transition: NativeFileArchiveTransition, locking = true): Promise<void> {
  const after = await lockOriginalRows(database, selected, ARCHIVED_NATIVE_BINARY_LIMIT, locking), { registry, lineage, raw, projection } = after;
  assertScope(registry, selected); assertScope(lineage, selected);
  preserved(original.registry, registry, ['status', 'state_version', 'snapshot_revision_id', 'updated_at']);
  preserved(original.lineage, lineage, ['status', 'archived_at', 'trash_entry_id']);
  preserved(original.raw, raw, stateWriteKeys);
  if (registry.status !== 'archived' || !safe(registry.state_version) || Number(registry.state_version) !== 0 || registry.snapshot_revision_id !== null
    || !safe(registry.updated_at) || Number(registry.updated_at) !== transition.writes.registry.updatedAt || lineage.status !== 'archived'
    || !safe(lineage.archived_at) || Number(lineage.archived_at) !== transition.writes.lineage.archivedAt || lineage.trash_entry_id !== transition.writes.lineage.trashEntryId
    || raw.status !== 'archived' || !safe(raw.lifecycle_generation, 1) || Number(raw.lifecycle_generation) !== transition.after.identity.lifecycleGeneration
    || !safe(raw.checkpoint_sequence) || Number(raw.checkpoint_sequence) !== 0 || raw.checkpointed_at !== null || raw.canonical_hash !== null || raw.serialized_hash !== null
    || !flag(raw.degraded) || trueFlag(raw.degraded) || !flag(raw.projection_error_permanent) || trueFlag(raw.projection_error_permanent)
    || ['code', 'sequence', 'generation', 'phase', 'cause'].some(key => raw[`projection_error_${key}`] !== null)
    || !projection || projection.document_id !== selected.documentId || !safe(projection.lifecycle_generation, 1)
    || Number(projection.lifecycle_generation) !== transition.writes.projection.lifecycleGeneration
    || !safe(projection.projected_sequence) || Number(projection.projected_sequence) !== transition.writes.projection.projectedSequence
    || !flag(projection.finalized) || trueFlag(projection.finalized) || projection.revision_id !== null
    || projection.canonical_hash !== null || projection.serialized_hash !== null
    || !safe(projection.updated_at) || Number(projection.updated_at) !== transition.writes.projection.updatedAt) fail('ORIGINAL_NATIVE_DELETE_POSTCONDITION');
  if (original.projection) preserved(original.projection, projection,
    ['lifecycle_generation', 'projected_sequence', 'finalized', 'revision_id', 'canonical_hash', 'serialized_hash', 'updated_at']);
  const state = await mapBoundedRow(raw, selected.documentId), archived = inspectArchivedNativeSnapshot(state);
  if (archived.version.stateProof !== transition.after.clock.stateProof || hash(state.yjsState) !== transition.after.clock.binaryHash
    || hash(state.stateVector) !== transition.after.clock.vectorHash) fail('ORIGINAL_NATIVE_DELETE_POSTCONDITION');
  await assertNoAgentOperation(database, selected, locking);
}

/** Mechanical D1/L1 archive only. Caller supplies genuine Owner/current auth,
 * storage realm, lifecycle/admission quiescence and the SAME-TX trash/public/
 * immutable receipt. On any error the caller MUST roll back the whole TX.
 * No retry by path, already-archived adoption, SQL checkout, TX or cleanup here. */
export async function archiveOriginalNativeDeleteTargetOnConnection(database: SqlConnection, input: ArchiveInput,
  assertCurrent?: () => Promise<void>):
Promise<NativeFileArchiveTransition> {
  type DeleteArchiveTimingStage = 'enter' | 'original-read' | 'transition-prepared' | 'cas-complete' | 'postcondition-complete';
  let deleteArchiveStartedAt = 0, deleteArchiveLastStage: DeleteArchiveTimingStage = 'enter';
  const deleteArchiveMilestones: { stage: DeleteArchiveTimingStage; elapsedMs: number }[] = [];
  const markDeleteArchive = (stage: DeleteArchiveTimingStage) => {
    try {
      deleteArchiveLastStage = stage;
      const now = performance.now();
      if (stage === 'enter') deleteArchiveStartedAt = now;
      deleteArchiveMilestones.push({ stage, elapsedMs: Math.round(now - deleteArchiveStartedAt) });
    } catch { /* Timing diagnostics never replace the original operation result. */ }
  };
  try {
    markDeleteArchive('enter');
    const captured = data(input, ['schema', 'workspace', 'expected', 'trashEntryId', 'archivedAt']);
    const expected = captureExpected(captured.expected as NativeFileArchiveExpected);
    const selected = selection(captured.schema, captured.workspace, expected.documentId, expected.lineageId, expected.path);
    const trashEntryId = captured.trashEntryId, archivedAt = captured.archivedAt;
    if (expected.workspaceId !== selected.workspaceId || expected.organizationId !== selected.organizationId
      || !id(trashEntryId) || typeof archivedAt !== 'number' || !safe(archivedAt) || archivedAt < expected.persistedAt) {
      fail('ORIGINAL_NATIVE_DELETE_INVALID');
    }
    if (assertCurrent !== undefined) await assertCurrent();
    const original = await readActiveTarget(database, selected);
    markDeleteArchive('original-read');
    if (expectedKeys.some(key => original.expected[key] !== expected[key])) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    // The frozen pure core additionally enforces its existing 16MiB archive bound
    // before any write; the observation reader's 64MiB bound is not an archive grant.
    const transition = prepareNativeFileArchiveTransition(original.state, expected, { trashEntryId, archivedAt });
    markDeleteArchive('transition-prepared');
    if (assertCurrent !== undefined) await assertCurrent();
    // RETURNING dependencies couple the four CAS writes into one statement.
    // A missing predecessor cannot authorize a later write; the caller rolls
    // back the whole transaction if any returned identity is absent or changed.
    // Keep current authority at the actual statement boundary, without extra
    // client roundtrips between its dependent writes.
    const projectionWrite = original.projection
      ? `UPDATE ${selected.schema}.collaboration_file_projections SET lifecycle_generation=$1,projected_sequence=$9,
      revision_id=NULL,canonical_hash=NULL,serialized_hash=NULL,finalized=0,updated_at=$13 WHERE document_id=$2
      AND lifecycle_generation=$18 AND projected_sequence=$19
      AND EXISTS (SELECT 1 FROM archived_lineage WHERE id=$14) RETURNING document_id`
      : `INSERT INTO ${selected.schema}.collaboration_file_projections
      (document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
      SELECT $2,$1,$9,NULL,NULL,NULL,0,$13 FROM archived_lineage WHERE id=$14
      ON CONFLICT(document_id) DO NOTHING RETURNING document_id`;
    const changed = await database.get(`WITH archived_state AS (
    UPDATE ${selected.schema}.collaboration_yjs_states SET status='archived',lifecycle_generation=$1,
    checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL,degraded=0,
    projection_error_code=NULL,projection_error_sequence=NULL,projection_error_generation=NULL,projection_error_phase=NULL,
    projection_error_cause=NULL,projection_error_permanent=0 WHERE document_id=$2 AND workspace_id=$3
    AND organization_id IS NOT DISTINCT FROM $4 AND path=$5 AND representation=$6 AND schema_version=$7
    AND lifecycle_generation=$8 AND status='active' AND document_sequence=$9 AND persisted_at=$10
    AND yjs_state=$11 AND state_vector=$12 RETURNING document_id
    ), archived_registry AS (
    UPDATE ${selected.schema}.collaboration_documents SET status='archived',state_version=0,
    snapshot_revision_id=NULL,updated_at=$13 WHERE id=$2 AND lineage_id=$14 AND provider='yjs' AND yjs_state_lifecycle='initialized'
    AND workspace_id=$3 AND workspace_type=$15 AND organization_id IS NOT DISTINCT FROM $4 AND path=$5
    AND status='active' AND state_version=$16
    AND EXISTS (SELECT 1 FROM archived_state WHERE document_id=$2) RETURNING id
    ), archived_lineage AS (
    UPDATE ${selected.schema}.file_collaboration_lineages SET status='archived',archived_at=$13,
    trash_entry_id=$17 WHERE id=$14 AND workspace_id=$3 AND workspace_type=$15 AND organization_id IS NOT DISTINCT FROM $4
    AND path=$5 AND status='active' AND EXISTS (SELECT 1 FROM archived_registry WHERE id=$2) RETURNING id
    ), archived_projection AS (${projectionWrite})
    SELECT (SELECT document_id FROM archived_state) AS state_document_id,
      (SELECT id FROM archived_registry) AS registry_document_id,(SELECT id FROM archived_lineage) AS lineage_id,
      (SELECT document_id FROM archived_projection) AS projection_document_id`,
    [transition.after.identity.lifecycleGeneration, expected.documentId, expected.workspaceId, expected.organizationId, expected.path,
      expected.representation, expected.schemaVersion, expected.lifecycleGeneration, expected.documentSequence, expected.persistedAt,
      original.raw.yjs_state, original.raw.state_vector, archivedAt, expected.lineageId, selected.workspaceType,
      expected.registryStateVersion, trashEntryId,
      ...(original.projection ? [original.projection.lifecycle_generation, original.projection.projected_sequence] : [])]) as Row | undefined;
    if (changed?.state_document_id !== expected.documentId || changed.registry_document_id !== expected.documentId
      || changed.lineage_id !== expected.lineageId || changed.projection_document_id !== expected.documentId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    markDeleteArchive('cas-complete');
    if (assertCurrent !== undefined) await assertCurrent();
    await verifyArchived(database, selected, original, transition);
    if (assertCurrent !== undefined) await assertCurrent();
    markDeleteArchive('postcondition-complete');
    return transition;
  } finally {
    try { console.info('[File action owner] Delete B2 archive timings.', JSON.stringify({ version: 1,
      elapsedMs: Math.round(performance.now() - deleteArchiveStartedAt), lastStage: deleteArchiveLastStage,
      milestones: deleteArchiveMilestones })); }
    catch { /* Timing diagnostics never replace the original operation result. */ }
  }
}

type CohortArchiveTarget = Readonly<{ expected: NativeFileArchiveExpected; trashEntryId: string; archivedAt: number }>;
type CohortArchiveInput = Readonly<{ schema: string; workspace: WorkspaceContext; targets: readonly CohortArchiveTarget[] }>;
type CapturedCohortArchiveTarget = Readonly<{ selected: Selection; expected: NativeFileArchiveExpected;
  trashEntryId: string; archivedAt: number }>;
type PreparedCohortArchiveTarget = Readonly<{ target: CapturedCohortArchiveTarget;
  original: Awaited<ReturnType<typeof readActiveTarget>>; transition: NativeFileArchiveTransition }>;
// One accepted original plus one fresh postcondition row never retains more
// binary/vector bytes than the existing single-target archive. Larger cohorts
// use more chunks on the SAME caller-owned B/TX; no partial receipt is returned.
const COHORT_ARCHIVE_RETAINED_BYTES = ARCHIVED_NATIVE_BINARY_LIMIT + MAX_VECTOR_BYTES;
const COHORT_ARCHIVE_SQL_TARGETS = 64;
const COHORT_ARCHIVE_MAX_TARGETS = 1024;

async function readCohortArchiveSizes(database: SqlConnection, targets: readonly CapturedCohortArchiveTarget[]): Promise<number[]> {
  const first = targets[0].selected;
  const rows = await database.all(`SELECT s.document_id,requested.ordinal::integer AS ordinal,
    octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes
    FROM pg_catalog.unnest($2::text[]) WITH ORDINALITY requested(document_id,ordinal)
      JOIN ${first.schema}.collaboration_yjs_states s ON s.document_id=requested.document_id
    WHERE s.workspace_id=$1 ORDER BY requested.ordinal LIMIT $3 FOR UPDATE OF s NOWAIT`,
  [first.workspaceId, targets.map(target => target.expected.documentId), targets.length + 1]) as Row[];
  if (rows.length !== targets.length) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  return rows.map((row, index) => {
    if (row.document_id !== targets[index].expected.documentId || !safe(row.ordinal, 1) || Number(row.ordinal) !== index + 1) {
      fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    }
    assertBounds(row);
    if (Number(row.state_bytes) > ARCHIVED_NATIVE_BINARY_LIMIT) fail('ORIGINAL_NATIVE_DELETE_TOO_LARGE');
    return Number(row.state_bytes);
  });
}

function cohortArchiveStatement(prepared: readonly PreparedCohortArchiveTarget[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const types = ['bigint', 'text', 'text', 'text', 'text', 'text', 'bigint', 'bigint', 'bigint', 'bigint',
    'bytea', 'bytea', 'bigint', 'text', 'text', 'bigint', 'text', 'boolean', 'bigint', 'bigint'];
  const rows = prepared.map(({ target, original, transition }, index) => {
    const expected = target.expected;
    const row = [transition.after.identity.lifecycleGeneration, expected.documentId, expected.workspaceId,
      expected.organizationId, expected.path, expected.representation, expected.schemaVersion, expected.lifecycleGeneration,
      expected.documentSequence, expected.persistedAt, original.raw.yjs_state, original.raw.state_vector,
      target.archivedAt, expected.lineageId, target.selected.workspaceType, expected.registryStateVersion, target.trashEntryId,
      original.projection !== undefined, original.projection?.lifecycle_generation ?? null, original.projection?.projected_sequence ?? null];
    const parameters = row.map((value, column) => { values.push(value); return `$${values.length}::${types[column]}`; });
    return `(${index + 1}::integer,${parameters.join(',')})`;
  });
  const schema = prepared[0].target.selected.schema;
  const sql = `WITH selected(ordinal,next_generation,document_id,workspace_id,organization_id,path,representation,schema_version,
    lifecycle_generation,document_sequence,persisted_at,yjs_state,state_vector,archived_at,lineage_id,workspace_type,
    registry_state_version,trash_entry_id,has_projection,projection_generation,projection_sequence) AS MATERIALIZED (
    VALUES ${rows.join(',')}
    ), archived_state AS (
    UPDATE ${schema}.collaboration_yjs_states s SET status='archived',lifecycle_generation=q.next_generation,
      checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL,degraded=0,
      projection_error_code=NULL,projection_error_sequence=NULL,projection_error_generation=NULL,projection_error_phase=NULL,
      projection_error_cause=NULL,projection_error_permanent=0 FROM selected q
    WHERE s.document_id=q.document_id AND s.workspace_id=q.workspace_id
      AND s.organization_id IS NOT DISTINCT FROM q.organization_id AND s.path=q.path AND s.representation=q.representation
      AND s.schema_version=q.schema_version AND s.lifecycle_generation=q.lifecycle_generation AND s.status='active'
      AND s.document_sequence=q.document_sequence AND s.persisted_at=q.persisted_at
      AND s.yjs_state=q.yjs_state AND s.state_vector=q.state_vector RETURNING s.document_id
    ), archived_registry AS (
    UPDATE ${schema}.collaboration_documents d SET status='archived',state_version=0,snapshot_revision_id=NULL,updated_at=q.archived_at
      FROM selected q JOIN archived_state s ON s.document_id=q.document_id
    WHERE d.id=q.document_id AND d.lineage_id=q.lineage_id AND d.provider='yjs' AND d.yjs_state_lifecycle='initialized'
      AND d.workspace_id=q.workspace_id AND d.workspace_type=q.workspace_type
      AND d.organization_id IS NOT DISTINCT FROM q.organization_id AND d.path=q.path AND d.status='active'
      AND d.state_version=q.registry_state_version RETURNING d.id
    ), archived_lineage AS (
    UPDATE ${schema}.file_collaboration_lineages l SET status='archived',archived_at=q.archived_at,trash_entry_id=q.trash_entry_id
      FROM selected q JOIN archived_registry d ON d.id=q.document_id
    WHERE l.id=q.lineage_id AND l.workspace_id=q.workspace_id AND l.workspace_type=q.workspace_type
      AND l.organization_id IS NOT DISTINCT FROM q.organization_id AND l.path=q.path AND l.status='active' RETURNING l.id
    ), updated_projection AS (
    UPDATE ${schema}.collaboration_file_projections p SET lifecycle_generation=q.next_generation,projected_sequence=q.document_sequence,
      revision_id=NULL,canonical_hash=NULL,serialized_hash=NULL,finalized=0,updated_at=q.archived_at
      FROM selected q JOIN archived_lineage l ON l.id=q.lineage_id
    WHERE q.has_projection AND p.document_id=q.document_id AND p.lifecycle_generation=q.projection_generation
      AND p.projected_sequence=q.projection_sequence RETURNING p.document_id
    ), inserted_projection AS (
    INSERT INTO ${schema}.collaboration_file_projections
      (document_id,lifecycle_generation,projected_sequence,revision_id,canonical_hash,serialized_hash,finalized,updated_at)
    SELECT q.document_id,q.next_generation,q.document_sequence,NULL,NULL,NULL,0,q.archived_at
      FROM selected q JOIN archived_lineage l ON l.id=q.lineage_id WHERE NOT q.has_projection
      ON CONFLICT(document_id) DO NOTHING RETURNING document_id
    ), archived_projection AS (
    SELECT document_id FROM updated_projection UNION ALL SELECT document_id FROM inserted_projection
    )
    SELECT q.ordinal,q.document_id,
      (SELECT document_id FROM archived_state WHERE document_id=q.document_id) AS state_document_id,
      (SELECT id FROM archived_registry WHERE id=q.document_id) AS registry_document_id,
      (SELECT id FROM archived_lineage WHERE id=q.lineage_id) AS lineage_id,
      (SELECT document_id FROM archived_projection WHERE document_id=q.document_id) AS projection_document_id
      FROM selected q ORDER BY q.ordinal`;
  if (!prepared.length || prepared.length > COHORT_ARCHIVE_SQL_TARGETS || values.length > 65535 || sql.length > 32768) {
    fail('ORIGINAL_NATIVE_DELETE_INVALID');
  }
  return { sql, values };
}

/** Fixed Cohort archive mechanics only. The genuine Owner supplies every target
 * from its freshly verified original intent and owns authorization/admission,
 * rollback, the unchanged B/TX and the final all-cohort receipts. Four fresh
 * Current fences surround each bounded atomic SQL group; no authority or rows
 * survive this call and no partial result escapes if any later group fails. */
export async function archiveOriginalNativeCohortDeleteTargetsOnConnection(database: SqlConnection, input: CohortArchiveInput,
  assertCurrent: () => Promise<void>): Promise<readonly Readonly<{ path: string; transition: NativeFileArchiveTransition }>[]> {
  const captured = data(input, ['schema', 'workspace', 'targets']);
  if (typeof assertCurrent !== 'function' || !Array.isArray(captured.targets)
    || captured.targets.length > COHORT_ARCHIVE_MAX_TARGETS) fail('ORIGINAL_NATIVE_DELETE_INVALID');
  // Validate the common realm even when the original cohort has no native targets.
  schemaName(captured.schema); captureScope(captured.workspace);
  const ids = new Set<string>(), lineages = new Set<string>(), paths = new Set<string>();
  const targets: CapturedCohortArchiveTarget[] = captured.targets.map(item => {
    const fields = data(item, ['expected', 'trashEntryId', 'archivedAt']);
    const expected = captureExpected(fields.expected as NativeFileArchiveExpected);
    const selected = selection(captured.schema, captured.workspace, expected.documentId, expected.lineageId, expected.path);
    const trashEntryId = fields.trashEntryId, archivedAt = fields.archivedAt;
    if (expected.workspaceId !== selected.workspaceId || expected.organizationId !== selected.organizationId
      || !id(trashEntryId) || typeof archivedAt !== 'number' || !safe(archivedAt) || archivedAt < expected.persistedAt
      || ids.has(expected.documentId) || lineages.has(expected.lineageId) || paths.has(expected.path)) fail('ORIGINAL_NATIVE_DELETE_INVALID');
    ids.add(expected.documentId); lineages.add(expected.lineageId); paths.add(expected.path);
    return Object.freeze({ selected, expected, trashEntryId, archivedAt });
  });
  const result: Readonly<{ path: string; transition: NativeFileArchiveTransition }>[] = [];
  for (let offset = 0; offset < targets.length;) {
    await assertCurrent(); // 1: before every fresh header/BLOB read in this group.
    const candidates = targets.slice(offset, offset + COHORT_ARCHIVE_SQL_TARGETS);
    const sizes = await readCohortArchiveSizes(database, candidates);
    let count = 0, reservedBytes = 0;
    while (count < candidates.length && reservedBytes + sizes[count] + MAX_VECTOR_BYTES <= COHORT_ARCHIVE_RETAINED_BYTES) {
      reservedBytes += sizes[count] + MAX_VECTOR_BYTES; count++;
    }
    if (!count) fail('ORIGINAL_NATIVE_DELETE_TOO_LARGE');
    const prepared: PreparedCohortArchiveTarget[] = [];
    let retainedBytes = 0;
    for (let index = 0; index < count; index++) {
      const target = candidates[index];
      const original = await readActiveTarget(database, target.selected,
        Math.min(ARCHIVED_NATIVE_BINARY_LIMIT, COHORT_ARCHIVE_RETAINED_BYTES - retainedBytes - MAX_VECTOR_BYTES));
      if (original.state.yjsState.byteLength !== sizes[index]
        || expectedKeys.some(key => original.expected[key] !== target.expected[key])) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
      retainedBytes += original.state.yjsState.byteLength + original.state.stateVector.byteLength;
      const transition = prepareNativeFileArchiveTransition(original.state, target.expected,
        { trashEntryId: target.trashEntryId, archivedAt: target.archivedAt });
      prepared.push({ target, original, transition });
    }
    const statement = cohortArchiveStatement(prepared);
    await assertCurrent(); // 2: every original/transition is proven, immediately before the atomic CAS.
    const changed = await database.all(statement.sql, statement.values) as Row[];
    if (changed.length !== prepared.length) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    for (const [index, item] of prepared.entries()) {
      const row = changed[index], expected = item.target.expected;
      if (!row || !safe(row.ordinal, 1) || Number(row.ordinal) !== index + 1 || row.document_id !== expected.documentId
        || row.state_document_id !== expected.documentId || row.registry_document_id !== expected.documentId
        || row.lineage_id !== expected.lineageId || row.projection_document_id !== expected.documentId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    }
    await assertCurrent(); // 3: after the CAS, before fresh complete postcondition reads.
    for (const item of prepared) await verifyArchived(database, item.target.selected, item.original, item.transition);
    await assertCurrent(); // 4: after all postconditions, before the next group or returning.
    for (const item of prepared) result.push(Object.freeze({ path: item.target.expected.path, transition: item.transition }));
    offset += count;
  }
  return Object.freeze(result);
}

type CapturedRestore = Readonly<{ selected: Selection; expected: NativeFileArchiveExpected;
  archived: NativeFileArchiveTransition; trashEntryId: string; restoredAt: number }>;
function captureRestore(input: RestoreInput): CapturedRestore {
  const captured = data(input, ['schema', 'workspace', 'expected', 'archived', 'trashEntryId', 'restoredAt']);
  const expected = captureExpected(captured.expected as NativeFileArchiveExpected);
  const selected = selection(captured.schema, captured.workspace, expected.documentId, expected.lineageId, expected.path);
  const archived = captureNativeFileArchiveRestoreData(captured.archived as NativeFileArchiveTransition);
  const trashEntryId = captured.trashEntryId, restoredAt = captured.restoredAt;
  if (expected.workspaceId !== selected.workspaceId || expected.organizationId !== selected.organizationId
    || !id(trashEntryId) || typeof restoredAt !== 'number' || !safe(restoredAt)) {
    fail('ORIGINAL_NATIVE_DELETE_INVALID');
  }
  return Object.freeze({ selected, expected, archived, trashEntryId, restoredAt });
}

function assertArchivedRawState(raw: Row, selected: Selection): void {
  // Validate the ACTUAL archived row before mapState can normalize flags or omit
  // stale errors. Never relabel it as active to borrow an active-only validator.
  if (raw.document_id !== selected.documentId || raw.workspace_id !== selected.workspaceId
    || raw.organization_id !== selected.organizationId || raw.path !== selected.path || raw.status !== 'archived'
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(String(raw.representation))
    || Number(raw.schema_version) !== COLLABORATION_SCHEMA_VERSION || !safe(raw.schema_version, 1)
    || !safe(raw.lifecycle_generation, 1) || !safe(raw.document_sequence) || !safe(raw.persisted_at)
    || !safe(raw.checkpoint_sequence) || Number(raw.checkpoint_sequence) !== 0 || raw.checkpointed_at !== null
    || !['lf', 'crlf'].includes(String(raw.newline_style)) || !flag(raw.has_bom)
    || !flag(raw.degraded) || trueFlag(raw.degraded) || !flag(raw.projection_error_permanent) || trueFlag(raw.projection_error_permanent)
    || raw.canonical_hash !== null || raw.serialized_hash !== null
    || ['code', 'sequence', 'generation', 'phase', 'cause'].some(key => raw[`projection_error_${key}`] !== null)) {
    fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  }
}

async function assertRestorePathVacant(database: SqlConnection, selected: Selection, restored = false,
  locking = true): Promise<void> {
  // A collision check, NOT a predicate/admission fence. The genuine outer owner
  // must prevent concurrent births/moves for the entire caller-owned transaction.
  // No later D2/S2 is selected, archived, rebound or adopted by this check.
  for (const [table, key, originalId] of [
    ['collaboration_documents', 'id', selected.documentId],
    ['collaboration_yjs_states', 'document_id', selected.documentId],
    ['file_collaboration_lineages', 'id', selected.lineageId],
  ] as const) {
    if (await database.get(`SELECT ${key} FROM ${selected.schema}.${table} WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left(path,length($2)+1)=$2||'/' OR left($2,length(path)+1)=path||'/')
      ${restored ? `AND NOT (${key}=$3 AND path=$2)` : ''} LIMIT 1${locking ? ' FOR SHARE NOWAIT' : ''}`,
    restored ? [selected.workspaceId, selected.path, originalId] : [selected.workspaceId, selected.path])) {
      fail('ORIGINAL_NATIVE_DELETE_CHANGED');
    }
  }
}

async function readRestoreTarget(database: SqlConnection, captured: CapturedRestore, locking = true): Promise<LockedRows & {
  state: PersistedCollaborationState; transition: NativeFileRestoreTransition }> {
  const { selected, expected, archived, trashEntryId, restoredAt } = captured;
  const rows = await lockOriginalRows(database, selected, ARCHIVED_NATIVE_BINARY_LIMIT, locking);
  assertScope(rows.registry, selected); assertScope(rows.lineage, selected);
  if (rows.registry.id !== expected.documentId || rows.registry.lineage_id !== expected.lineageId
    || rows.registry.provider !== 'yjs' || rows.registry.yjs_state_lifecycle !== 'initialized'
    || rows.lineage.id !== expected.lineageId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  assertArchivedRawState(rows.raw, selected);
  const state = await mapBoundedRow(rows.raw, selected.documentId);
  const transition = prepareNativeFileRestoreTransition(state, expected, archived, { trashEntryId, restoredAt });
  // Reuse the same archive postcondition used by Delete, including real archived
  // native inspection, projection receipt, original trash binding and agent gate.
  await verifyArchived(database, selected, rows, archived, locking);
  await assertRestorePathVacant(database, selected, false, locking);
  return { ...rows, state, transition };
}

/** Pre-FS observation on the genuine caller-owned B. No writes or retained
 * authority: the mutation must perform the SAME checks again in atomic B2. */
export async function readOriginalNativeRestoreTargetOnConnection(database: SqlConnection, input: RestoreInput):
Promise<Readonly<{ state: PersistedCollaborationState; transition: NativeFileRestoreTransition }>> {
  const captured = captureRestore(input);
  const observed = await readRestoreTarget(database, captured);
  return Object.freeze({ state: observed.state, transition: observed.transition });
}

/** Current factual availability observation on the caller's consistent read
 * connection. This deliberately takes no row locks, starts no transaction and
 * grants no lifecycle or mutation authority. Actual Undo repeats the locked
 * original-D1 checks under its genuine Owner before and after the FS step. */
export async function observeOriginalNativeRestoreTargetOnConnection(database: SqlConnection, input: RestoreInput):
Promise<Readonly<{ state: PersistedCollaborationState; transition: NativeFileRestoreTransition }>> {
  const observed = await readRestoreTarget(database, captureRestore(input), false);
  return Object.freeze({ state: observed.state, transition: observed.transition });
}

async function verifyRestored(database: SqlConnection, captured: CapturedRestore, original: LockedRows,
  transition: NativeFileRestoreTransition): Promise<void> {
  const { selected, expected } = captured, after = await readActiveTarget(database, selected);
  preserved(original.registry, after.registry, ['status', 'state_version', 'snapshot_revision_id', 'updated_at']);
  preserved(original.lineage, after.lineage, ['status', 'archived_at', 'trash_entry_id']);
  preserved(original.raw, after.raw, stateWriteKeys);
  const expectedAfter = { ...expected, lifecycleGeneration: transition.after.identity.lifecycleGeneration, registryStateVersion: 0 };
  if (expectedKeys.some(key => after.expected[key] !== expectedAfter[key]) || after.registry.snapshot_revision_id !== null
    || !safe(after.registry.updated_at) || Number(after.registry.updated_at) !== transition.writes.registry.updatedAt
    || after.lineage.trash_entry_id !== null || after.raw.checkpointed_at !== null
    || Number(after.raw.checkpoint_sequence) !== 0 || after.raw.canonical_hash !== null || after.raw.serialized_hash !== null
    || trueFlag(after.raw.degraded) || trueFlag(after.raw.projection_error_permanent)
    || ['code', 'sequence', 'generation', 'phase', 'cause'].some(key => after.raw[`projection_error_${key}`] !== null)) {
    fail('ORIGINAL_NATIVE_DELETE_POSTCONDITION');
  }
  const projection = after.projection;
  if (!projection || projection.document_id !== expected.documentId
    || !safe(projection.lifecycle_generation, 1) || Number(projection.lifecycle_generation) !== transition.writes.projection.lifecycleGeneration
    || !safe(projection.projected_sequence) || Number(projection.projected_sequence) !== expected.documentSequence
    || !flag(projection.finalized) || trueFlag(projection.finalized) || projection.revision_id !== null
    || projection.canonical_hash !== null || projection.serialized_hash !== null
    || !safe(projection.updated_at) || Number(projection.updated_at) !== transition.writes.projection.updatedAt) {
    fail('ORIGINAL_NATIVE_DELETE_POSTCONDITION');
  }
  if (original.projection) preserved(original.projection, projection,
    ['lifecycle_generation', 'projected_sequence', 'finalized', 'revision_id', 'canonical_hash', 'serialized_hash', 'updated_at']);
  await assertRestorePathVacant(database, selected, true);
}

/** Mechanical original D1/L1 restore only, with no SQL checkout, TX, actor or
 * DA04 grant. Caller binds authentic original receipts/trash, current Undo rights,
 * lifecycle quiescence and the SAME-TX completion. Every error requires rollback.
 * No public share is read or revived here; no already-restored adoption by path. */
export async function restoreOriginalNativeDeleteTargetOnConnection(database: SqlConnection, input: RestoreInput):
Promise<NativeFileRestoreTransition> {
  const captured = captureRestore(input), { selected, expected, trashEntryId, restoredAt } = captured;
  const original = await readRestoreTarget(database, captured), transition = original.transition;
  const stateChanged = await database.get(`UPDATE ${selected.schema}.collaboration_yjs_states SET status='active',lifecycle_generation=$1,
    checkpoint_sequence=0,checkpointed_at=NULL,canonical_hash=NULL,serialized_hash=NULL,degraded=0,
    projection_error_code=NULL,projection_error_sequence=NULL,projection_error_generation=NULL,projection_error_phase=NULL,
    projection_error_cause=NULL,projection_error_permanent=0 WHERE document_id=$2 AND workspace_id=$3
    AND organization_id IS NOT DISTINCT FROM $4 AND path=$5 AND representation=$6 AND schema_version=$7
    AND lifecycle_generation=$8 AND status='archived' AND document_sequence=$9 AND persisted_at=$10
    AND yjs_state=$11 AND state_vector=$12 RETURNING document_id`,
  [transition.after.identity.lifecycleGeneration, expected.documentId, expected.workspaceId, expected.organizationId, expected.path,
    expected.representation, expected.schemaVersion, transition.before.identity.lifecycleGeneration, expected.documentSequence,
    expected.persistedAt, original.raw.yjs_state, original.raw.state_vector]) as Row | undefined;
  if (stateChanged?.document_id !== expected.documentId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  const registryChanged = await database.get(`UPDATE ${selected.schema}.collaboration_documents SET status='active',state_version=0,
    snapshot_revision_id=NULL,updated_at=$1 WHERE id=$2 AND lineage_id=$3 AND provider='yjs' AND yjs_state_lifecycle='initialized'
    AND workspace_id=$4 AND workspace_type=$5 AND organization_id IS NOT DISTINCT FROM $6 AND path=$7
    AND status='archived' AND state_version=0 RETURNING id`,
  [restoredAt, expected.documentId, expected.lineageId, expected.workspaceId, selected.workspaceType, expected.organizationId, expected.path]) as Row | undefined;
  if (registryChanged?.id !== expected.documentId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  const lineageChanged = await database.get(`UPDATE ${selected.schema}.file_collaboration_lineages SET status='active',archived_at=NULL,
    trash_entry_id=NULL WHERE id=$1 AND workspace_id=$2 AND workspace_type=$3 AND organization_id IS NOT DISTINCT FROM $4
    AND path=$5 AND status='archived' AND archived_at=$6 AND trash_entry_id=$7 RETURNING id`,
  [expected.lineageId, expected.workspaceId, selected.workspaceType, expected.organizationId, expected.path,
    transition.archive.archivedAt, trashEntryId]) as Row | undefined;
  if (lineageChanged?.id !== expected.lineageId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  const projectionChanged = await database.get(`UPDATE ${selected.schema}.collaboration_file_projections SET lifecycle_generation=$1,
    projected_sequence=$2,revision_id=NULL,canonical_hash=NULL,serialized_hash=NULL,finalized=0,updated_at=$3
    WHERE document_id=$4 AND lifecycle_generation=$5 AND projected_sequence=$6 AND finalized=0
    AND revision_id IS NULL AND canonical_hash IS NULL AND serialized_hash IS NULL AND updated_at=$7 RETURNING document_id`,
  [transition.writes.projection.lifecycleGeneration, expected.documentSequence, restoredAt, expected.documentId,
    transition.before.identity.lifecycleGeneration, expected.documentSequence, transition.archive.archivedAt]);
  if ((projectionChanged as Row | undefined)?.document_id !== expected.documentId) fail('ORIGINAL_NATIVE_DELETE_CHANGED');
  await verifyRestored(database, captured, original, transition);
  return transition;
}
