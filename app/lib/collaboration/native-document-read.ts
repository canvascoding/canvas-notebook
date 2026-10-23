import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import type { SqlConnection } from '../db';
import { DocumentReadError } from '../documents/contracts';
import type { WorkspaceContext } from '../workspaces/types';
import { CollaborationCheckpointQuarantinedError } from './checkpoint-errors';
import { readCurrentCollaborationDocument } from './document-access';
import { inspectPersistedNativeCollaborationSnapshot, inspectNativeDocument, type NativeCollaborationDocumentRead,
  type NativeCollaborationSnapshot } from './document-snapshot';
import { isCollaborationStateQuarantined } from './failure';
import { assertNativeDocumentSchema } from './native-document-schema';
import { getNativeInspectionSchema } from './native-inspection-schema';
import { mapValidatedNativeStateRow, NativeSessionStateReaderError, validateRawState } from './native-session-state-reader';
import type { ExistingNativeSessionIdentity } from './native-session-state-reader';
import type { PersistedCollaborationState } from './persistence';
import { assertCollaborationAdmissionOpen } from './room-admission';
import { CollaborationAdmissionError, collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { assertNativeDocumentWithinReadBudget, captureNativeDocumentReadBudget, type NativeDocumentReadBudget } from './native-search-budget';
import { assertNativeDocumentEditTargetStorageBudget, captureNativeDocumentEditTargets,
  nativeDocumentEditTargetsReadBudget, type NativeDocumentEditTargetV1 } from './native-document-edit-targets';

type Row = Record<string, unknown>;
type Realm = Readonly<{ schema: string; schemaOid: string; searchPath: string; database: string;
  backend: number; backendStart: string; transaction: string }>;
export type NativeDocumentReadObservation = Readonly<{
  identity: ExistingNativeSessionIdentity;
  native: NativeCollaborationDocumentRead;
  metadata: Readonly<{ title: string | null; revision: number | null }>;
  /** Comparison data captured synchronously from the same observed native Doc. */
  editTargets?: readonly NativeDocumentEditTargetV1[];
}>;
const MAX_STATE_BYTES = 64 * 1024 * 1024, MAX_VECTOR_BYTES = 1024 * 1024;
const reads = new WeakMap<SqlConnection, { poison: (error: unknown) => void }>();
const requiredTables = ['canvas_workspaces', 'collaboration_documents', 'file_collaboration_lineages',
  'collaboration_yjs_states', 'workspace_file_metadata', 'collaboration_admission_requests',
  'collaboration_admission_scopes', 'collaboration_admission_targets'];
const stateFields = ['document_id', 'workspace_id', 'organization_id', 'path', 'representation', 'lifecycle_generation',
  'schema_version', 'status', 'document_sequence', 'persisted_at', 'checkpoint_sequence', 'checkpointed_at', 'newline_style',
  'has_bom', 'degraded', 'projection_error_code', 'projection_error_sequence', 'projection_error_generation',
  'projection_error_phase', 'projection_error_permanent'] as const;
const stateTextLimits: Readonly<Record<string, number>> = { document_id: 1024, workspace_id: 1024, organization_id: 1024,
  path: 16384, representation: 256, status: 256, newline_style: 32, projection_error_code: 1024, projection_error_phase: 1024 };
type TextColumn = readonly [expression: string, alias: string, maxBytes: number];
const registryTextColumns: readonly TextColumn[] = [['d.id', 'id', 1024], ['d.lineage_id', 'lineage_id', 1024],
  ['d.workspace_id', 'workspace_id', 1024], ['d.workspace_type', 'workspace_type', 256],
  ['d.organization_id', 'organization_id', 1024], ['d.customer_id', 'customer_id', 1024], ['d.project_id', 'project_id', 1024],
  ['d.path', 'path', 16384], ['d.provider', 'provider', 256], ['d.status', 'status', 256],
  ['d.yjs_state_lifecycle', 'yjs_state_lifecycle', 256], ['l.id', 'lineage_actual_id', 1024],
  ['l.workspace_id', 'lineage_workspace_id', 1024], ['l.workspace_type', 'lineage_workspace_type', 256],
  ['l.organization_id', 'lineage_organization_id', 1024], ['l.customer_id', 'lineage_customer_id', 1024],
  ['l.project_id', 'lineage_project_id', 1024], ['l.path', 'lineage_path', 16384], ['l.status', 'lineage_status', 256],
  ['l.trash_entry_id', 'lineage_trash_entry_id', 1024], ['m.title', 'metadata_title', 16384]];
const headerTextColumns: readonly TextColumn[] = [...registryTextColumns,
  ...Object.entries(stateTextLimits).map(([field, limit]) => [`s.${field}`, `state_${field}`, limit] as const)];
const boundedText = ([expression, alias, limit]: TextColumn): string =>
  `CASE WHEN octet_length(${expression})<=${limit} THEN ${expression} END AS ${alias}`;
const oversizedText = (columns: readonly TextColumn[]): string => columns.map(([expression, , limit]) =>
  `COALESCE(octet_length(${expression}),0)>${limit}`).join(' OR ');
const stableHeaderFields = ['id', 'lineage_id', 'workspace_id', 'workspace_type', 'organization_id', 'customer_id', 'project_id',
  'path', 'provider', 'status', 'yjs_state_lifecycle', 'lineage_actual_id', 'lineage_workspace_id', 'lineage_workspace_type',
  'lineage_organization_id', 'lineage_customer_id', 'lineage_project_id', 'lineage_path', 'lineage_status', 'lineage_archived_at',
  'lineage_trash_entry_id', 'state_document_id', 'state_workspace_id', 'state_organization_id', 'state_path', 'state_status',
  'state_lifecycle_generation', 'state_representation', 'state_schema_version', 'metadata_title', 'metadata_revision'] as const;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
const integer = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
function fail(code: ConstructorParameters<typeof DocumentReadError>[0]): never { throw new DocumentReadError(code); }

async function readRealm(connection: SqlConnection): Promise<Realm> {
  const row = await connection.get(`SELECT current_schema() AS schema_name,
    to_regnamespace(current_schema())::oid::text AS schema_oid,
    CASE WHEN octet_length(current_setting('search_path'))<=16384 THEN current_setting('search_path') END AS search_path,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    pg_backend_pid() AS backend_pid,extract(epoch FROM a.backend_start)::text AS backend_start,
    pg_current_xact_id_if_assigned()::text AS transaction_id,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  if (!row || !validId(row.schema_name) || row.schema_name.length > 63 || !integer(row.schema_oid, 1)
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096
    || !integer(row.database_oid, 1) || !integer(row.backend_pid, 1)
    || typeof row.backend_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.backend_start)
    || !integer(row.transaction_id, 1) || row.isolation !== 'read committed' || row.read_only !== 'off') {
    fail('DOCUMENT_SCOPE_CHANGED');
  }
  return Object.freeze({ schema: row.schema_name, schemaOid: String(row.schema_oid), searchPath: row.search_path,
    database: String(row.database_oid), backend: Number(row.backend_pid), backendStart: row.backend_start,
    transaction: String(row.transaction_id) });
}

async function assertRealm(connection: SqlConnection, expected: Realm): Promise<void> {
  if (!isDeepStrictEqual(await readRealm(connection), expected)) fail('DOCUMENT_SCOPE_CHANGED');
  const rows = await connection.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($2::text[]) names(name)`, [quote(expected.schema), requiredTables]) as Row[];
  if (rows.length !== requiredTables.length || new Set(rows.map(row => row.name)).size !== requiredTables.length
    || rows.some(row => !requiredTables.includes(String(row.name)) || row.same_relation !== true)) fail('DOCUMENT_SCOPE_CHANGED');
}

async function assertWorkspaceScope(connection: SqlConnection, realm: Realm, workspace: WorkspaceContext): Promise<void> {
  const columns: readonly TextColumn[] = [['id', 'id', 1024], ['type', 'type', 256], ['organization_id', 'organization_id', 1024],
    ['customer_id', 'customer_id', 1024], ['project_id', 'project_id', 1024], ['owner_user_id', 'owner_user_id', 1024],
    ['root_relative_path', 'root_relative_path', 16384], ['status', 'status', 256]];
  const rows = await connection.all(`SELECT ${columns.map(boundedText).join(',')},(${oversizedText(columns)}) AS oversized_text
    FROM ${quote(realm.schema)}.canvas_workspaces WHERE id=$1 LIMIT 2`, [workspace.workspaceId]) as Row[];
  const row = rows[0];
  if (row?.oversized_text === true) fail('DOCUMENT_TOO_LARGE');
  if (rows.length !== 1 || row.id !== workspace.workspaceId || row.type !== workspace.workspaceType
    || row.organization_id !== (workspace.organizationId ?? null) || row.customer_id !== (workspace.customerId ?? null)
    || row.project_id !== (workspace.projectId ?? null) || row.owner_user_id !== (workspace.ownerUserId ?? null)
    || row.root_relative_path !== workspace.rootRelativePath || row.status !== 'active') fail('DOCUMENT_SCOPE_CHANGED');
}

async function assertSharedFence(connection: SqlConnection, realm: Realm, workspaceId: string): Promise<void> {
  const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspaceId)));
  const rows = await connection.all(`SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.database=$1::oid AND l.classid::bigint=$2 AND l.objid::bigint=$3
      AND l.objsubid=1 AND l.pid=$4 AND extract(epoch FROM a.backend_start)::text=$5`,
  [realm.database, Number(key >> BigInt(32)), Number(key & BigInt(0xffffffff)), realm.backend, realm.backendStart]) as Row[];
  if (!rows.some(row => row.mode === 'ShareLock') || rows.some(row => row.mode !== 'ShareLock')) fail('DOCUMENT_SCOPE_CHANGED');
}

async function readHeader(connection: SqlConnection, realm: Realm, workspace: WorkspaceContext, documentId: string,
  budget?: NativeDocumentReadBudget): Promise<Row> {
  const schema = quote(realm.schema);
  const rows = await connection.all(`SELECT ${headerTextColumns.map(boundedText).join(',')},d.state_version,
    l.archived_at AS lineage_archived_at,
    ${stateFields.filter(field => stateTextLimits[field] === undefined).map(field => `s.${field} AS state_${field}`).join(',')},
    octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes,
    m.updated_at AS metadata_revision,(${oversizedText(headerTextColumns)}) AS oversized_text
    FROM ${schema}.collaboration_documents d FULL JOIN ${schema}.collaboration_yjs_states s ON s.document_id=d.id
    LEFT JOIN ${schema}.file_collaboration_lineages l ON l.id=d.lineage_id
    LEFT JOIN ${schema}.workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
    WHERE (d.id=$1 AND d.workspace_id=$2) OR (s.document_id=$1 AND s.workspace_id=$2) LIMIT 2`,
  [documentId, workspace.workspaceId]) as Row[];
  if (!rows.length) fail('DOCUMENT_NOT_FOUND');
  if (rows.length !== 1) fail('DOCUMENT_STATE_INVALID');
  const row = rows[0];
  if (row.oversized_text === true) fail('DOCUMENT_TOO_LARGE');
  if (row.id == null || row.status !== 'active') {
    if (row.state_status === 'active') fail('DOCUMENT_STATE_INVALID');
    fail('DOCUMENT_NOT_FOUND');
  }
  if (row.provider !== 'yjs') fail('DOCUMENT_FORMAT_UNAVAILABLE');
  if (row.state_document_id == null) fail('DOCUMENT_STATE_MISSING');
  if (row.id !== documentId || !validId(row.lineage_id) || row.lineage_actual_id !== row.lineage_id
    || row.workspace_id !== workspace.workspaceId || row.workspace_type !== workspace.workspaceType
    || row.organization_id !== (workspace.organizationId ?? null) || !isCanonicalAdmissionPath(row.path)
    || row.yjs_state_lifecycle !== 'initialized' || !integer(row.state_version)
    || row.lineage_workspace_id !== workspace.workspaceId || row.lineage_workspace_type !== workspace.workspaceType
    || row.lineage_organization_id !== (workspace.organizationId ?? null) || row.lineage_path !== row.path
    || row.lineage_status !== 'active' || row.lineage_archived_at !== null
    || row.lineage_trash_entry_id !== null && !validId(row.lineage_trash_entry_id)
    || row.state_document_id !== documentId || row.state_workspace_id !== workspace.workspaceId
    || row.state_organization_id !== (workspace.organizationId ?? null) || row.state_path !== row.path || row.state_status !== 'active') {
    fail('DOCUMENT_SCOPE_CHANGED');
  }
  // Legacy nullable scope fields stay original nullable observations. Non-null
  // values must match the current workspace; final checks never fill them in.
  for (const [field, expected] of [['customer_id', workspace.customerId ?? null], ['project_id', workspace.projectId ?? null]] as const) {
    for (const value of [row[field], row[`lineage_${field}`]]) {
      if (value !== null && (!validId(value) || value !== expected)) fail('DOCUMENT_SCOPE_CHANGED');
    }
  }
  validateRawState(Object.fromEntries(stateFields.map(field => [field, row[`state_${field}`]])));
  if (!integer(row.state_bytes, 1) || !integer(row.vector_bytes, 1)) fail('DOCUMENT_STATE_INVALID');
  if (Number(row.state_bytes) > (budget?.maxStateBytes ?? MAX_STATE_BYTES)
    || Number(row.vector_bytes) > (budget?.maxVectorBytes ?? MAX_VECTOR_BYTES)) fail('DOCUMENT_TOO_LARGE');
  if (Number(row.state_version) > Number(row.state_document_sequence)) fail('DOCUMENT_STATE_INVALID');
  if (row.metadata_revision === null ? row.metadata_title !== null
    : !integer(row.metadata_revision) || row.metadata_title !== null && (typeof row.metadata_title !== 'string'
      || row.metadata_title.length > 4096)) fail('DOCUMENT_STATE_INVALID');
  await assertCollaborationAdmissionOpen((sql, values) => connection.all(sql, values) as Promise<Row[]>,
    { documentId, workspaceId: workspace.workspaceId, path: row.path as string });
  return row;
}

function freezeObservation<T extends object>(value: T): T {
  const pending: Array<{ value: object; depth: number }> = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 262144 || current.depth > 64) fail('DOCUMENT_TOO_LARGE');
    Object.freeze(current.value);
    for (const child of Object.values(current.value)) if (child !== null && typeof child === 'object') {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

/** Existing-only header comparison data. The caller owns a genuine current
 * principal and one RC/RW B, including completion/disposal before publication.
 * This variant never awaits a live room or allocates the persisted body. */
export async function readNativeDocumentHeaderByIdOnConnection(connection: SqlConnection,
  input: { workspace: WorkspaceContext; documentId: string }): Promise<Readonly<{
    identity: ExistingNativeSessionIdentity;
    metadata: Readonly<{ title: string | null; revision: number | null }>;
  }>> {
  const previous = reads.get(connection);
  if (previous) {
    const error = new DocumentReadError('DOCUMENT_SCOPE_CHANGED'); previous.poison(error); throw error;
  }
  const workspace = structuredClone(input.workspace), documentId = input.documentId;
  if (!validId(documentId) || !validId(workspace.workspaceId) || workspace.legacy || workspace.status !== 'active'
    || !workspace.permissions.canRead || typeof workspace.rootRelativePath !== 'string'
    || !workspace.rootRelativePath || workspace.rootRelativePath.length > 4096) fail('INVALID_REQUEST');
  let failure: unknown;
  const phase = { poison: (error: unknown) => { failure ??= error; } };
  reads.set(connection, phase);
  try {
    const realm = await readRealm(connection);
    const acquired = await connection.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired',
      [collaborationAdmissionLockKey(workspace.workspaceId)]) as Row | undefined;
    if (acquired?.acquired !== true) fail('DOCUMENT_BUSY');
    await connection.run(`LOCK TABLE ${requiredTables.map(table => `${quote(realm.schema)}.${quote(table)}`).join(',')}
      IN ACCESS SHARE MODE NOWAIT`);
    await assertRealm(connection, realm); await assertSharedFence(connection, realm, workspace.workspaceId);
    await assertWorkspaceScope(connection, realm, workspace);
    const initial = await readHeader(connection, realm, workspace, documentId);
    await assertWorkspaceScope(connection, realm, workspace);
    const final = await readHeader(connection, realm, workspace, documentId);
    if (stableHeaderFields.some(field => !Object.is(final[field], initial[field]))) fail('DOCUMENT_SCOPE_CHANGED');
    await assertRealm(connection, realm); await assertSharedFence(connection, realm, workspace.workspaceId);
    if (failure !== undefined) throw failure;
    return freezeObservation({ identity: { documentId, lineageId: initial.lineage_id as string,
      workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, path: initial.path as string,
      lifecycleGeneration: Number(initial.state_lifecycle_generation),
      representation: initial.state_representation as ExistingNativeSessionIdentity['representation'],
      schemaVersion: Number(initial.state_schema_version) },
    metadata: { title: initial.metadata_title as string | null,
      revision: initial.metadata_revision === null ? null : Number(initial.metadata_revision) } });
  } catch (error) {
    if (error instanceof DocumentReadError) throw error;
    if (error instanceof NativeSessionStateReaderError) fail('DOCUMENT_STATE_INVALID');
    if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT'
      || (error as { code?: string })?.code === '55P03') fail('DOCUMENT_BUSY');
    if (['42P01', '3F000', '42703'].includes((error as { code?: string })?.code ?? '')) fail('DOCUMENT_SCOPE_CHANGED');
    throw error;
  } finally { if (reads.get(connection) === phase) reads.delete(connection); }
}

/** Internal observation kernel, NOT authentication or a standalone public read.
 * Caller owns one actual RC/RW transaction, genuine current principal phase,
 * successful COMMIT/ROLLBACK and awaited connection disposal before publishing.
 * This acquires the shared lifecycle fence; it never seeds, migrates, exports
 * Markdown, touches disk, or changes native content. Registry ID is the selector. */
export async function readNativeDocumentByIdOnConnection(connection: SqlConnection,
  input: { workspace: WorkspaceContext; documentId: string; budget?: NativeDocumentReadBudget;
    includeEditTargets?: boolean;
    expectedPersistedBinary?: Readonly<{ stateSha256: string; vectorSha256: string }> }): Promise<NativeDocumentReadObservation> {
  const previous = reads.get(connection);
  if (previous) {
    const error = new DocumentReadError('DOCUMENT_SCOPE_CHANGED'); previous.poison(error); throw error;
  }
  const workspace = structuredClone(input.workspace), documentId = input.documentId;
  const targetDescriptor = Object.getOwnPropertyDescriptor(input, 'includeEditTargets');
  if (targetDescriptor && (!targetDescriptor.enumerable || !Object.prototype.hasOwnProperty.call(targetDescriptor, 'value')
    || typeof targetDescriptor.value !== 'boolean')) fail('INVALID_REQUEST');
  const includeEditTargets = targetDescriptor?.value === true;
  const requestedBudget = input.budget === undefined ? undefined : captureNativeDocumentReadBudget(input.budget);
  const budget = includeEditTargets ? nativeDocumentEditTargetsReadBudget(requestedBudget) : requestedBudget;
  let expectedBinary: Readonly<{ stateSha256: string; vectorSha256: string }> | undefined;
  if (input.expectedPersistedBinary !== undefined) {
    const value = input.expectedPersistedBinary;
    if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_REQUEST');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const stateDescriptor = Object.prototype.hasOwnProperty.call(descriptors, 'stateSha256') ? descriptors.stateSha256 : undefined;
    const vectorDescriptor = Object.prototype.hasOwnProperty.call(descriptors, 'vectorSha256') ? descriptors.vectorSha256 : undefined;
    const stateSha256: unknown = stateDescriptor?.value, vectorSha256: unknown = vectorDescriptor?.value;
    if (Reflect.ownKeys(descriptors).length !== 2 || !stateDescriptor?.enumerable || !vectorDescriptor?.enumerable
      || !Object.prototype.hasOwnProperty.call(stateDescriptor, 'value') || !Object.prototype.hasOwnProperty.call(vectorDescriptor, 'value')
      || typeof stateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(stateSha256)
      || typeof vectorSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(vectorSha256)) fail('INVALID_REQUEST');
    expectedBinary = Object.freeze({ stateSha256, vectorSha256 });
  }
  if (!validId(documentId) || !validId(workspace.workspaceId) || workspace.legacy || workspace.status !== 'active'
    || !workspace.permissions.canRead || typeof workspace.rootRelativePath !== 'string'
    || !workspace.rootRelativePath || workspace.rootRelativePath.length > 4096) fail('INVALID_REQUEST');
  let active = true, failure: unknown, pending: Promise<PersistedCollaborationState> | undefined;
  let loadedState: PersistedCollaborationState | undefined, observed: NativeCollaborationDocumentRead | undefined;
  let validatedState: NativeCollaborationSnapshot | undefined, loadCount = 0;
  let editTargets: readonly NativeDocumentEditTargetV1[] | undefined;
  const inspectionSchema = getNativeInspectionSchema();
  const phase = { poison: (error: unknown) => { failure ??= error; } };
  reads.set(connection, phase);
  try {
    const realm = await readRealm(connection);
    const acquired = await connection.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired',
      [collaborationAdmissionLockKey(workspace.workspaceId)]) as Row | undefined;
    if (acquired?.acquired !== true) fail('DOCUMENT_BUSY');
    await connection.run(`LOCK TABLE ${requiredTables.map(table => `${quote(realm.schema)}.${quote(table)}`).join(',')}
      IN ACCESS SHARE MODE NOWAIT`);
    await assertRealm(connection, realm); await assertSharedFence(connection, realm, workspace.workspaceId);
    await assertWorkspaceScope(connection, realm, workspace);
    const initial = await readHeader(connection, realm, workspace, documentId, requestedBudget);
    if (includeEditTargets) {
      // Decide unsupported representation from the actual header, before any
      // binary load. Explicit opt-in cannot silently yield a guardless body.
      if (initial.state_representation !== 'tiptap_blocks') fail('DOCUMENT_FORMAT_UNAVAILABLE');
      if (Number(initial.state_bytes) > budget!.maxStateBytes || Number(initial.vector_bytes) > budget!.maxVectorBytes) {
        fail('DOCUMENT_TOO_LARGE');
      }
    }
    const loadState = (selectedId: string): Promise<PersistedCollaborationState> => {
      if (!active || pending || selectedId !== documentId || failure !== undefined || ++loadCount !== 1) {
        failure ??= new DocumentReadError('DOCUMENT_SCOPE_CHANGED'); return Promise.reject(failure);
      }
      const operation = (async () => {
        await assertRealm(connection, realm); await assertSharedFence(connection, realm, workspace.workspaceId);
        const header = await readHeader(connection, realm, workspace, documentId, budget);
        if (stableHeaderFields.some(field => !Object.is(header[field], initial[field]))) fail('DOCUMENT_SCOPE_CHANGED');
        // Exclude unneeded owner/cause/hash columns. Bound every selected text
        // before PG sends it, including growth after the header observation.
        const rows = await connection.all(`SELECT ${stateFields.map(field => `s.${field}`).join(',')},
          s.yjs_state,s.state_vector,NULL::text AS canonical_hash,NULL::text AS serialized_hash
          FROM ${quote(realm.schema)}.collaboration_yjs_states s
          WHERE s.document_id=$1 AND octet_length(s.yjs_state)=$2 AND octet_length(s.state_vector)=$3
            AND octet_length(s.yjs_state) BETWEEN 1 AND $4 AND octet_length(s.state_vector) BETWEEN 1 AND $5
            AND NOT (${oversizedText(Object.entries(stateTextLimits).map(([field, limit]) => [`s.${field}`, field, limit] as const))})
            AND (SELECT count(*) FROM ${quote(realm.schema)}.collaboration_yjs_states WHERE document_id=$1)=1 LIMIT 2`,
        [documentId, Number(header.state_bytes), Number(header.vector_bytes),
          budget?.maxStateBytes ?? MAX_STATE_BYTES, budget?.maxVectorBytes ?? MAX_VECTOR_BYTES]) as Row[];
        if (rows.length !== 1) fail('DOCUMENT_VERSION_CONFLICT');
        const raw = rows[0];
        if (!(raw.yjs_state instanceof Uint8Array) || !(raw.state_vector instanceof Uint8Array)
          || raw.yjs_state.byteLength !== Number(header.state_bytes) || raw.state_vector.byteLength !== Number(header.vector_bytes)
          || stateFields.some(field => !Object.is(raw[field], header[`state_${field}`]))) fail('DOCUMENT_VERSION_CONFLICT');
        if (expectedBinary && (createHash('sha256').update(raw.yjs_state).digest('hex') !== expectedBinary.stateSha256
          || createHash('sha256').update(raw.state_vector).digest('hex') !== expectedBinary.vectorSha256)) fail('DOCUMENT_VERSION_CONFLICT');
        const state = await mapValidatedNativeStateRow(raw, documentId);
        if (!state || state.documentId !== documentId || state.workspaceId !== workspace.workspaceId
          || state.organizationId !== (workspace.organizationId ?? null) || state.path !== initial.path
          || state.lifecycleGeneration !== Number(initial.state_lifecycle_generation)
          || state.representation !== initial.state_representation || state.schemaVersion !== Number(initial.state_schema_version)) {
          fail('DOCUMENT_SCOPE_CHANGED');
        }
        if (isCollaborationStateQuarantined(state)) fail('DOCUMENT_QUARANTINED');
        // Validate the original persisted binary before the room handoff's
        // decoder can run. Reuse this snapshot in the fixed callback below;
        // there is no extra persisted decode and no Markdown serialization.
        try { validatedState = inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
          assertNativeDocumentSchema(doc, state.representation, inspectionSchema); return snapshot;
        }, budget); }
        catch (error) { if (error instanceof DocumentReadError) throw error; fail('DOCUMENT_STATE_INVALID'); }
        loadedState = state;
        return state;
      })();
      pending = operation;
      void operation.then(() => { if (pending === operation) pending = undefined; },
        error => { failure ??= error; if (pending === operation) pending = undefined; });
      return operation;
    };
    const native = await readCurrentCollaborationDocument({ documentId, workspaceId: workspace.workspaceId, loadState,
      read: (doc, state): NativeCollaborationDocumentRead => {
        try {
          if (!active || failure !== undefined || observed || !state || state !== loadedState || !validatedState) {
            fail('DOCUMENT_SCOPE_CHANGED');
          }
          const { version, source: _source, content: _content, ...snapshot } = validatedState;
          if (budget) assertNativeDocumentWithinReadBudget(doc, budget);
          if (includeEditTargets) assertNativeDocumentEditTargetStorageBudget(doc);
          assertNativeDocumentSchema(doc, state.representation, inspectionSchema);
          const current = inspectNativeDocument(doc, state.representation);
          if (includeEditTargets) editTargets = captureNativeDocumentEditTargets(doc, current.content, current.version.stateProof);
          const durable = current.version.stateProof === version.stateProof;
          observed = { ...snapshot, source: durable ? 'persisted_yjs' : 'live_yjs',
            observed: { ...current.version, content: current.content, durable }, durable: version };
          return observed;
        } catch (error) {
          failure ??= error instanceof DocumentReadError ? error
            : new DocumentReadError(error instanceof CollaborationCheckpointQuarantinedError
              ? 'DOCUMENT_QUARANTINED' : 'DOCUMENT_STATE_INVALID');
          throw failure;
        }
      } });
    active = false;
    if (pending) { await Promise.allSettled([pending]); fail('DOCUMENT_SCOPE_CHANGED'); }
    if (failure !== undefined) throw failure;
    if (!observed || native !== observed) fail('DOCUMENT_SCOPE_CHANGED');
    if (native.documentId !== documentId || native.workspaceId !== workspace.workspaceId
      || native.organizationId !== (workspace.organizationId ?? null) || native.path !== initial.path
      || native.lifecycleGeneration !== Number(initial.state_lifecycle_generation)
      || native.representation !== initial.state_representation || native.schemaVersion !== Number(initial.state_schema_version)) {
      fail('DOCUMENT_SCOPE_CHANGED');
    }
    await assertWorkspaceScope(connection, realm, workspace);
    const final = await readHeader(connection, realm, workspace, documentId, budget);
    if (stableHeaderFields.some(field => !Object.is(final[field], initial[field]))) fail('DOCUMENT_SCOPE_CHANGED');
    await assertRealm(connection, realm); await assertSharedFence(connection, realm, workspace.workspaceId);
    if (failure !== undefined) throw failure;
    return freezeObservation({ identity: { documentId, lineageId: initial.lineage_id as string,
      workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, path: initial.path as string,
      lifecycleGeneration: native.lifecycleGeneration, representation: native.representation, schemaVersion: native.schemaVersion },
    native, metadata: { title: initial.metadata_title as string | null,
      revision: initial.metadata_revision === null ? null : Number(initial.metadata_revision) },
    ...(editTargets === undefined ? {} : { editTargets }) });
  } catch (error) {
    if (error instanceof DocumentReadError) throw error;
    if (error instanceof CollaborationCheckpointQuarantinedError) fail('DOCUMENT_QUARANTINED');
    if (error instanceof NativeSessionStateReaderError) fail('DOCUMENT_STATE_INVALID');
    if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT'
      || (error as { code?: string })?.code === '55P03') fail('DOCUMENT_BUSY');
    if (['42P01', '3F000', '42703'].includes((error as { code?: string })?.code ?? '')) fail('DOCUMENT_SCOPE_CHANGED');
    throw error;
  } finally {
    active = false;
    if (pending) await Promise.allSettled([pending]);
    if (reads.get(connection) === phase) reads.delete(connection);
  }
}
