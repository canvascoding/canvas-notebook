import 'server-only';

import { getSchema } from '@tiptap/core';
import { NextRequest } from 'next/server';
import * as decoding from 'lib0/decoding';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceRequestPrincipal, WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { getWorkspaceFileLifecycleLeases } from './file-lifecycle-admission-context';
import { inspectNativeDocument, inspectPersistedNativeCollaborationSnapshot, type NativeCollaborationSnapshot } from './document-snapshot';
import { isCollaborationStateQuarantined } from './failure';
import { richMarkdownSchemaExtensions } from './markdown-state';
import { assertNativeDocumentSchema } from './native-document-schema';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from './persistence';
import { assertCollaborationAdmissionOpen } from './room-admission';
import { CollaborationAdmissionError, collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { COLLABORATION_SCHEMA_VERSION, type TextCollaborationRepresentation } from './types';
import { Y } from './server-runtime';

export type ExistingNativeSessionIdentity = Readonly<{
  documentId: string; lineageId: string; workspaceId: string; organizationId: string | null; path: string;
  lifecycleGeneration: number; representation: TextCollaborationRepresentation; schemaVersion: number;
}>;
/** Internal session metadata only. No binary, native body, checkpoint hashes or grant flags. */
export type ExistingNativeSessionSnapshot = ExistingNativeSessionIdentity & Readonly<{
  documentSequence: number; checkpointSequence: number; persistedAt: number; checkpointedAt: number | null;
  stateVector: string; stateProof: string; newlineStyle: 'lf' | 'crlf'; hasBom: boolean; degraded: boolean;
  projectionError?: Readonly<NonNullable<PersistedCollaborationState['projectionError']>>;
}>;
/** Authenticity is private WeakMap membership, never the shape of this object. */
export type ExistingNativeCollaborationSession = Readonly<{ snapshot: ExistingNativeSessionSnapshot }>;
/** Separate diagnosis capability. It can never authorize editing or migration. */
export type ReadOnlyNativeSessionDiagnosis = Readonly<{ snapshot: ExistingNativeSessionSnapshot; permission: 'read' }>;
/** Callback-only facts from the actual SAME-Connection principal phase. The
 * workspace is its frozen entry observation, not a write grant. A canRead
 * principal never proves current write permission; writes require a genuinely
 * canWrite-authorized phase and its final check. No credentials are exposed. */
export type ExistingNativeSessionRequestAccess = WorkspaceRequestPrincipalAccess;
type Row = Record<string, unknown>;
type ConnectionIdentity = Readonly<{ schema: string; searchPath: string; backend: number; backendStart: string;
  transaction: string; database: number }>;
/** Minted only inside the actual principal callback; never a public mode option. */
type PrincipalReaderPhase = { connection: SqlConnection; active: boolean; failure: unknown; assertCurrent: () => Promise<void> };
const authenticatedReaders = new WeakMap<SqlConnection, PrincipalReaderPhase>();
type Capture = {
  connection: SqlConnection; phase: 'preparing' | 'active' | 'closed'; accepting: boolean; failure: unknown;
  workspaceId: string; workspaceType: string; organizationId: string | null; path: string; key: string; high: number; low: number;
  identity?: ConnectionIdentity; target?: ExistingNativeSessionIdentity; expected?: ExistingNativeSessionIdentity;
  snapshot?: ExistingNativeSessionSnapshot; native?: NativeCollaborationSnapshot; pending: Set<Promise<unknown>>;
  principal?: PrincipalReaderPhase;
  purpose?: 'quarantine-diagnosis';
};
const connections = new WeakMap<SqlConnection, Capture>();
const capabilities = new WeakMap<ExistingNativeCollaborationSession, Capture>();
const diagnoses = new WeakMap<ReadOnlyNativeSessionDiagnosis, { connection: SqlConnection; native: ExistingNativeCollaborationSession }>();
const requiredTables = ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states',
  'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
const identityKeys = ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'path', 'lifecycleGeneration', 'representation', 'schemaVersion'] as const;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_VECTOR_BYTES = 1024 * 1024;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const safeNumber = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;

export class NativeSessionStateReaderError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_SESSION_INVALID' | 'NATIVE_SESSION_REQUIRED' | 'NATIVE_SESSION_BUSY'
    | 'NATIVE_SESSION_SCOPE_CHANGED' | 'NATIVE_SESSION_STATE_MISSING' | 'NATIVE_SESSION_STATE_INVALID'
    | 'NATIVE_SESSION_QUARANTINED' | 'NATIVE_SESSION_QUARANTINE_REQUIRED'
    | 'NATIVE_SESSION_TOO_LARGE' | 'NATIVE_SESSION_REENTRANT' | 'NATIVE_SESSION_DETACHED') {
    super(code); this.name = 'NativeSessionStateReaderError';
  }
}
function fail(code: NativeSessionStateReaderError['code']): never { throw new NativeSessionStateReaderError(code); }
function poisonPrincipalReader(phase: PrincipalReaderPhase | undefined, error: unknown): void {
  if (phase?.active) phase.failure ??= error ?? new NativeSessionStateReaderError('NATIVE_SESSION_REQUIRED');
}
function poison(captured: Capture, error: unknown): void {
  captured.failure ??= error ?? new NativeSessionStateReaderError('NATIVE_SESSION_REQUIRED');
  poisonPrincipalReader(captured.principal,captured.failure);
}
function poisonCapabilityFailure(connection: SqlConnection, capability: ExistingNativeCollaborationSession, error: unknown): void {
  const owner = capabilities.get(capability);
  for (const captured of [owner, connections.get(connection), owner && connections.get(owner.connection)]) {
    if (captured && captured.phase !== 'closed') poison(captured, error);
    poisonPrincipalReader(captured?.principal,error);
  }
  // The native capability closes before the actual Principal callback's final
  // SQL check; misuse in that completion window must still reject the phase.
  poisonPrincipalReader(authenticatedReaders.get(connection),error);
  if (owner) poisonPrincipalReader(authenticatedReaders.get(owner.connection),error);
}

function captureExpected(input: ExistingNativeSessionIdentity): ExistingNativeSessionIdentity {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== identityKeys.length
    || identityKeys.some(key => !Object.getOwnPropertyDescriptor(input, key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input, key), 'value'))
    || !validId(input.documentId) || !validId(input.lineageId) || !validId(input.workspaceId)
    || input.organizationId !== null && !validId(input.organizationId) || !isCanonicalAdmissionPath(input.path)
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(input.representation)
    || !Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1
    || input.schemaVersion !== COLLABORATION_SCHEMA_VERSION) fail('NATIVE_SESSION_INVALID');
  return Object.freeze({ ...input });
}
function captureScope(connection: SqlConnection, input: { workspace: WorkspaceContext; path: string;
  expectedIdentity?: ExistingNativeSessionIdentity }): Capture {
  const { workspace, path } = input;
  if (!workspace || !validId(workspace.workspaceId) || workspace.legacy || !workspace.permissions?.canRead
    || workspace.status !== undefined && workspace.status !== 'active'
    || !['personal', 'organization', 'team', 'project'].includes(workspace.workspaceType)
    || workspace.organizationId != null && !validId(workspace.organizationId) || !isCanonicalAdmissionPath(path)
    || !/\.(?:md|markdown|txt)$/iu.test(path)) fail('NATIVE_SESSION_INVALID');
  const organizationId = workspace.organizationId ?? null;
  const expected = input.expectedIdentity === undefined ? undefined : captureExpected(input.expectedIdentity);
  if (expected && (expected.workspaceId !== workspace.workspaceId || expected.organizationId !== organizationId || expected.path !== path)) {
    fail('NATIVE_SESSION_SCOPE_CHANGED');
  }
  const key = collaborationAdmissionLockKey(workspace.workspaceId), unsigned = BigInt.asUintN(64, BigInt(key));
  return { connection, phase: 'preparing', accepting: true, failure: undefined, workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType, organizationId, path, key, high: Number(unsigned >> BigInt(32)),
    low: Number(unsigned & BigInt(0xffffffff)), expected, pending: new Set() };
}

async function connectionIdentity(connection: SqlConnection, principal?: PrincipalReaderPhase): Promise<ConnectionIdentity> {
  if (principal && (!principal.active || principal.connection !== connection || authenticatedReaders.get(connection) !== principal)) {
    fail('NATIVE_SESSION_REQUIRED');
  }
  const row = await connection.get(`SELECT current_schema() AS schema_name,current_setting('search_path') AS search_path,
    pg_backend_pid() AS backend_pid,extract(epoch FROM a.backend_start)::text AS backend_start,
    (SELECT virtualxid FROM pg_locks WHERE locktype='virtualxid' AND pid=pg_backend_pid()
      AND granted AND mode='ExclusiveLock') AS transaction_id,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  if (!row || typeof row.schema_name !== 'string' || !row.schema_name || row.schema_name.length > 63
    || /[\u0000-\u001f\u007f]/u.test(row.schema_name) || typeof row.search_path !== 'string'
    || !Number.isSafeInteger(row.backend_pid) || Number(row.backend_pid) < 1
    || typeof row.backend_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.backend_start)
    || typeof row.transaction_id !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.transaction_id)
    || !safeNumber(row.database_oid, 1) || row.isolation !== 'read committed'
    || row.read_only !== (principal ? 'off' : 'on')) fail('NATIVE_SESSION_SCOPE_CHANGED');
  return Object.freeze({ schema: row.schema_name, searchPath: row.search_path, backend: Number(row.backend_pid),
    backendStart: row.backend_start, transaction: row.transaction_id, database: Number(row.database_oid) });
}
function assertActive(captured: Capture): void {
  const held = connections.get(captured.connection);
  if (held !== captured || captured.phase === 'closed') {
    const error = new NativeSessionStateReaderError('NATIVE_SESSION_REQUIRED');
    if (held && held !== captured) poison(held,error);
    poisonPrincipalReader(captured.principal,error);
    poisonPrincipalReader(authenticatedReaders.get(captured.connection),error);
    throw error;
  }
  if (captured.failure !== undefined) throw captured.failure;
  if (captured.principal && (!captured.principal.active || authenticatedReaders.get(captured.connection) !== captured.principal)) {
    fail('NATIVE_SESSION_REQUIRED');
  }
  if (captured.principal?.failure !== undefined) throw captured.principal.failure;
}
async function checkConnection(captured: Capture): Promise<void> {
  assertActive(captured);
  const current = await connectionIdentity(captured.connection,captured.principal), expected = captured.identity;
  assertActive(captured);
  if (!expected || Object.keys(expected).some(key => current[key as keyof ConnectionIdentity] !== expected[key as keyof ConnectionIdentity])) {
    fail('NATIVE_SESSION_SCOPE_CHANGED');
  }
  const rows = await captured.connection.all(`SELECT name,to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($2::text[]) names(name)`, [quote(expected.schema), requiredTables]) as Row[];
  assertActive(captured);
  if (rows.length !== requiredTables.length || rows.some(row => row.same_relation !== true || !requiredTables.includes(String(row.name)))) {
    fail('NATIVE_SESSION_SCOPE_CHANGED');
  }
}
async function ownLockModes(captured: Capture): Promise<string[]> {
  const identity = captured.identity!;
  const rows = await captured.connection.all(`SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.database=$1::oid AND l.classid::bigint=$2 AND l.objid::bigint=$3
      AND l.objsubid=1 AND l.pid=$4 AND extract(epoch FROM a.backend_start)::text=$5`,
  [identity.database, captured.high, captured.low, identity.backend, identity.backendStart]) as Row[];
  assertActive(captured);
  return rows.map(row => String(row.mode));
}
function freezeNative(snapshot: NativeCollaborationSnapshot): NativeCollaborationSnapshot {
  const pending: Array<{ value: object; depth: number }> = [{ value: snapshot, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 262144 || depth > 64) fail('NATIVE_SESSION_TOO_LARGE');
    Object.freeze(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
  }
  return snapshot;
}
function validateRawState(row: Row): void {
  if (!['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(String(row.representation)) || row.status !== 'active'
    || row.schema_version !== COLLABORATION_SCHEMA_VERSION && Number(row.schema_version) !== COLLABORATION_SCHEMA_VERSION
    || !safeNumber(row.lifecycle_generation, 1) || !safeNumber(row.document_sequence) || !safeNumber(row.checkpoint_sequence)
    || Number(row.checkpoint_sequence) > Number(row.document_sequence) || !safeNumber(row.persisted_at)
    || row.checkpointed_at !== null && !safeNumber(row.checkpointed_at)
    || !['lf', 'crlf'].includes(String(row.newline_style)) || ![0, 1, '0', '1', false, true].includes(row.has_bom as never)
    || ![0, 1, '0', '1', false, true].includes(row.degraded as never)
    || ![0, 1, '0', '1'].includes(row.projection_error_permanent as never)) fail('NATIVE_SESSION_STATE_INVALID');
  const code = row.projection_error_code, permanent = Number(row.projection_error_permanent);
  if (code !== null) {
    if (!validId(code) || !safeNumber(row.projection_error_sequence) || !safeNumber(row.projection_error_generation, 1)
      || Number(row.projection_error_sequence) > Number(row.document_sequence)
      || Number(row.projection_error_generation) > Number(row.lifecycle_generation)
      || permanent === 1 && Number(row.projection_error_generation) !== Number(row.lifecycle_generation)
      || row.projection_error_phase !== null && (typeof row.projection_error_phase !== 'string'
        || row.projection_error_phase.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.projection_error_phase))) fail('NATIVE_SESSION_STATE_INVALID');
  } else if (permanent !== 0 || row.projection_error_sequence !== null || row.projection_error_generation !== null
    || row.projection_error_phase !== null) fail('NATIVE_SESSION_STATE_INVALID');
}
/** Private diagnostic decoder only. Preserve the quarantine flags; the general
 * editing snapshot API must keep refusing this state. Raw SQL validation and
 * bounds have already run on this SAME B before allocating the temporary Doc. */
function inspectQuarantinedNativeState(state: PersistedCollaborationState): NativeCollaborationSnapshot {
  if (!isCollaborationStateQuarantined(state)) fail('NATIVE_SESSION_QUARANTINE_REQUIRED');
  const doc = new Y.Doc({ gc: true });
  try {
    const decoder = decoding.createDecoder(state.yjsState); Y.readUpdate(decoder, doc);
    if (decoding.hasContent(decoder)) fail('NATIVE_SESSION_STATE_INVALID');
    const native = inspectNativeDocument(doc, state.representation);
    if (native.version.stateVector !== Buffer.from(state.stateVector).toString('base64')) fail('NATIVE_SESSION_STATE_INVALID');
    assertNativeDocumentSchema(doc, state.representation, getSchema(richMarkdownSchemaExtensions()));
    return { snapshotVersion: 1, source: 'persisted_yjs', documentId: state.documentId, workspaceId: state.workspaceId,
      organizationId: state.organizationId, path: state.path, lifecycleGeneration: state.lifecycleGeneration,
      representation: state.representation, schemaVersion: state.schemaVersion,
      version: { ...native.version, documentSequence: state.documentSequence, persistedAt: state.persistedAt },
      projection: { checkpointSequence: state.checkpointSequence, checkpointedAt: state.checkpointedAt,
        ...(state.projectionError ? { error: { ...state.projectionError } } : {}) }, content: native.content };
  } finally { doc.destroy(); }
}
async function readCurrent(captured: Capture): Promise<ExistingNativeSessionSnapshot> {
  if (captured.principal) { await captured.principal.assertCurrent(); assertActive(captured); }
  await checkConnection(captured);
  const modes = await ownLockModes(captured);
  if (!modes.includes('ShareLock') || modes.includes('ExclusiveLock')) fail('NATIVE_SESSION_SCOPE_CHANGED');
  const schema = quote(captured.identity!.schema);
  const rows = await captured.connection.all(`SELECT d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.path,d.provider,
    d.status,d.state_version,d.yjs_state_lifecycle,l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,
    l.organization_id AS lineage_organization_id,l.path AS lineage_path,l.status AS lineage_status,
    s.document_id AS state_document_id,s.workspace_id AS state_workspace_id,s.organization_id AS state_organization_id,
    s.path AS state_path,s.status AS state_status,octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes
    FROM ${schema}.collaboration_documents d FULL JOIN ${schema}.collaboration_yjs_states s ON s.document_id=d.id
      LEFT JOIN ${schema}.file_collaboration_lineages l ON l.id=d.lineage_id
    WHERE ((d.workspace_id=$1 AND d.path=$2) OR (s.workspace_id=$1 AND s.path=$2))
      AND (d.status='active' OR s.status='active') LIMIT 2`, [captured.workspaceId, captured.path]) as Row[];
  assertActive(captured);
  if (rows.length === 0 || rows.length === 1 && rows[0].state_document_id == null) fail('NATIVE_SESSION_STATE_MISSING');
  if (rows.length !== 1) fail('NATIVE_SESSION_SCOPE_CHANGED');
  const metadata = rows[0];
  if (!validId(metadata.id) || !validId(metadata.lineage_id) || metadata.workspace_id !== captured.workspaceId
    || metadata.workspace_type !== captured.workspaceType || metadata.organization_id !== captured.organizationId || metadata.path !== captured.path
    || metadata.provider !== 'yjs' || metadata.status !== 'active' || metadata.yjs_state_lifecycle !== 'initialized'
    || !safeNumber(metadata.state_version) || metadata.lineage_workspace_id !== captured.workspaceId
    || metadata.lineage_workspace_type !== captured.workspaceType || metadata.lineage_organization_id !== captured.organizationId
    || metadata.lineage_path !== captured.path || metadata.lineage_status !== 'active'
    || metadata.state_document_id !== metadata.id || metadata.state_workspace_id !== captured.workspaceId
    || metadata.state_organization_id !== captured.organizationId || metadata.state_path !== captured.path || metadata.state_status !== 'active') {
    fail('NATIVE_SESSION_SCOPE_CHANGED');
  }
  if (!safeNumber(metadata.state_bytes, 1) || Number(metadata.state_bytes) > MAX_STATE_BYTES
    || !safeNumber(metadata.vector_bytes, 1) || Number(metadata.vector_bytes) > MAX_VECTOR_BYTES) fail('NATIVE_SESSION_TOO_LARGE');
  try { await assertCollaborationAdmissionOpen((sql, values) => captured.connection.all(sql, values) as Promise<Row[]>,
    { documentId: metadata.id, workspaceId: captured.workspaceId, path: captured.path }); }
  catch (error) { if (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_CONFLICT') fail('NATIVE_SESSION_BUSY'); throw error; }
  assertActive(captured);
  // SQL bounds also cover growth by an ordinary peer between the metadata and binary reads.
  const raw = await captured.connection.get(`SELECT * FROM ${schema}.collaboration_yjs_states WHERE document_id=$1
    AND octet_length(yjs_state)<=$2 AND octet_length(state_vector)<=$3 LIMIT 1`,
  [metadata.id, MAX_STATE_BYTES, MAX_VECTOR_BYTES]) as Row | undefined;
  assertActive(captured);
  if (!raw) fail('NATIVE_SESSION_STATE_MISSING');
  validateRawState(raw);
  // pg may return bigint flags as strings. The existing mapper expects 0/1 or booleans;
  // retain their proven values without changing the native bytes or byte profile.
  const mappedRow = { ...raw, has_bom: raw.has_bom === true ? 1 : Number(raw.has_bom),
    degraded: raw.degraded === true ? 1 : Number(raw.degraded), projection_error_permanent: Number(raw.projection_error_permanent) };
  // Reuse the existing mapper with this already bounded SAME-Connection row; no pool or second authority probe.
  const state = await loadCollaborationStateOnConnection({ get: (sql, values) => {
    if (sql.replace(/\s+/gu, ' ').trim() !== 'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1'
      || values?.length !== 1 || values[0] !== metadata.id) fail('NATIVE_SESSION_STATE_INVALID');
    return mappedRow;
  } }, metadata.id, true);
  assertActive(captured);
  if (!state || state.documentId !== metadata.id || state.workspaceId !== captured.workspaceId || state.organizationId !== captured.organizationId
    || state.path !== captured.path || state.status !== 'active') fail('NATIVE_SESSION_SCOPE_CHANGED');
  const target: ExistingNativeSessionIdentity = Object.freeze({ documentId: metadata.id, lineageId: metadata.lineage_id,
    workspaceId: captured.workspaceId, organizationId: captured.organizationId, path: captured.path,
    lifecycleGeneration: state.lifecycleGeneration, representation: state.representation, schemaVersion: state.schemaVersion });
  for (const expected of [captured.expected, captured.target]) if (expected && identityKeys.some(key => expected[key] !== target[key])) fail('NATIVE_SESSION_SCOPE_CHANGED');
  const quarantined = isCollaborationStateQuarantined(state);
  if (captured.purpose === 'quarantine-diagnosis') {
    if (!quarantined) fail('NATIVE_SESSION_QUARANTINE_REQUIRED');
  } else if (quarantined) fail('NATIVE_SESSION_QUARANTINED');
  let native: NativeCollaborationSnapshot;
  try { native = captured.purpose === 'quarantine-diagnosis' ? inspectQuarantinedNativeState(state)
    : inspectPersistedNativeCollaborationSnapshot(state, (doc, snapshot) => {
    // The general native semantic reader deliberately permits opaque fields.
    // Validate the original raw storage before accepting its normalized JSON for a session.
    assertNativeDocumentSchema(doc, state.representation, getSchema(richMarkdownSchemaExtensions()));
    return snapshot;
  }); }
  catch (error) { if (error instanceof NativeSessionStateReaderError) throw error; fail('NATIVE_SESSION_STATE_INVALID'); }
  const provenNative = freezeNative(native);
  await checkConnection(captured);
  if (captured.principal) { await captured.principal.assertCurrent(); await checkConnection(captured); }
  captured.target = target; captured.native = provenNative;
  captured.snapshot = Object.freeze({ ...target, documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
    persistedAt: state.persistedAt, checkpointedAt: state.checkpointedAt, stateVector: native.version.stateVector, stateProof: native.version.stateProof,
    newlineStyle: state.newlineStyle, hasBom: state.hasBom, degraded: state.degraded,
    ...(state.projectionError ? { projectionError: Object.freeze({ ...state.projectionError }) } : {}) });
  return captured.snapshot;
}

/**
 * Inactive existing-only foundation. Caller owns BEGIN READ COMMITTED READ ONLY,
 * COMMIT/ROLLBACK/disposal and current principal rights. On ANY failure ROLLBACK.
 * No seed, filesystem, Markdown serializer, grant, mutation or room ownership.
 * One fresh capability per connection/TX; the actual shared key lasts until TX end.
 */
export async function withExistingNativeCollaborationSessionOnConnection<T>(connection: SqlConnection,
  input: { workspace: WorkspaceContext; path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (session: ExistingNativeCollaborationSession) => Promise<T>): Promise<T> {
  const previous = connections.get(connection);
  if (previous) { poison(previous, new NativeSessionStateReaderError('NATIVE_SESSION_REENTRANT')); throw previous.failure; }
  const captured = captureScope(connection, input);
  // Explicitly RO even if an authenticated reader/Principal exists on this DB.
  return withCapturedNativeSession(captured,consume);
}

/** Actual request rights plus the SAME private existing reader kernel. No
 * caller-issued Workspace/Actor/Access, public RW flag, init or ticket grant. */
export async function withAuthenticatedExistingNativeCollaborationSessionOnConnection<T>(connection: SqlConnection,
  principal: WorkspaceRequestPrincipal, input: { path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (session: ExistingNativeCollaborationSession, access: ExistingNativeSessionRequestAccess) => Promise<T>): Promise<T> {
  return withAuthenticatedNativeSession(connection, principal, input, consume);
}

/** Genuine FIXED canRead diagnosis; no principal/permission/ignore flag is
 * accepted from callers. The private editing capability never leaves this
 * adapter. Caller owns RC/RW B, all TX completion and connection disposal. */
export async function withAuthenticatedNativeSessionDiagnosisOnConnection<T>(connection: SqlConnection,
  request: NextRequest, input: { workspaceId: string; path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (diagnosis: ReadOnlyNativeSessionDiagnosis, access: ExistingNativeSessionRequestAccess) => Promise<T>): Promise<T> {
  if (!(request instanceof NextRequest) || !input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => !['workspaceId', 'path', 'expectedIdentity'].includes(String(key)))
    || ['workspaceId', 'path'].some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
    }) || Object.prototype.hasOwnProperty.call(input, 'expectedIdentity') && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(input, 'expectedIdentity');
      return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
    })() || !validId(input.workspaceId) || !isCanonicalAdmissionPath(input.path) || typeof consume !== 'function') fail('NATIVE_SESSION_INVALID');
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const workspaceId = input.workspaceId, path = input.path;
  const expectedIdentity = input.expectedIdentity === undefined ? undefined : captureExpected(input.expectedIdentity);
  const { withWorkspaceRequestPrincipal } = await import('../workspaces/request-principal');
  return withWorkspaceRequestPrincipal(original, { workspaceId, permission: 'canRead' }, principal =>
    withAuthenticatedNativeSession(connection, principal, { path, expectedIdentity }, async (native, access) => {
      const assertBound = () => {
        try { requireCapability(connection, native); }
        catch (error) { poisonCapabilityFailure(connection, native, error); throw error; }
      };
      const diagnosis: ReadOnlyNativeSessionDiagnosis = Object.freeze({
        get snapshot() { assertBound(); return native.snapshot; },
        get permission(): 'read' { assertBound(); return 'read'; },
      });
      diagnoses.set(diagnosis, { connection, native });
      return consume(diagnosis, access);
    }, 'quarantine-diagnosis'));
}

/** Same bound diagnostic snapshot, including actual final native/auth checks. */
export function assertReadOnlyNativeSessionDiagnosisCurrentOnConnection(connection: SqlConnection,
  diagnosis: ReadOnlyNativeSessionDiagnosis): Promise<ExistingNativeSessionSnapshot> {
  const bound = diagnoses.get(diagnosis);
  if (!bound || bound.connection !== connection) {
    const error = new NativeSessionStateReaderError('NATIVE_SESSION_REQUIRED');
    if (bound) poisonCapabilityFailure(bound.connection, bound.native, error);
    const held = connections.get(connection); if (held) poison(held, error);
    return Promise.reject(error);
  }
  return assertExistingNativeCollaborationSessionCurrentOnConnection(connection, bound.native);
}

async function withAuthenticatedNativeSession<T>(connection: SqlConnection,
  principal: WorkspaceRequestPrincipal, input: { path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (session: ExistingNativeCollaborationSession, access: ExistingNativeSessionRequestAccess) => Promise<T>,
  purpose?: 'quarantine-diagnosis'): Promise<T> {
  let path: string | undefined, expected: ExistingNativeSessionIdentity | undefined, inputError: unknown;
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || typeof consume !== 'function'
      || Reflect.ownKeys(input).some(key => key !== 'path' && key !== 'expectedIdentity')
      || !Object.getOwnPropertyDescriptor(input,'path')?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(input,'path'),'value')
      || !isCanonicalAdmissionPath(input.path) || !/\.(?:md|markdown|txt)$/iu.test(input.path)) fail('NATIVE_SESSION_INVALID');
    path = input.path;
    if (Object.prototype.hasOwnProperty.call(input,'expectedIdentity')) {
      const descriptor = Object.getOwnPropertyDescriptor(input,'expectedIdentity');
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor,'value')) fail('NATIVE_SESSION_INVALID');
      if (input.expectedIdentity !== undefined) expected = captureExpected(input.expectedIdentity);
    }
  } catch (error) {
    inputError = error ?? new NativeSessionStateReaderError('NATIVE_SESSION_INVALID');
    const held = connections.get(connection); if (held) poison(held,inputError);
  }
  // This lazy import never runs for the original pure READ ONLY entry.
  const { withWorkspaceRequestPrincipalOnConnection } = await import('../workspaces/request-principal');
  let privatePhase: PrincipalReaderPhase | undefined;
  try {
    const result = await withWorkspaceRequestPrincipalOnConnection(connection,principal,async access => {
      if (inputError !== undefined) throw inputError;
      if (!path) fail('NATIVE_SESSION_INVALID');
      privatePhase = { connection,active:true,failure:undefined,assertCurrent:access.assertCurrent };
      authenticatedReaders.set(connection,privatePhase);
      await access.assertCurrent();
      const captured = captureScope(connection,{ workspace:access.workspace,path,expectedIdentity:expected });
      captured.principal = privatePhase;
      captured.purpose = purpose;
      const result = await withCapturedNativeSession(captured,session => consume(session,bindNativeSessionRequestAccess(connection,session,access)));
      if (privatePhase.failure !== undefined) throw privatePhase.failure;
      await access.assertCurrent();
      if (privatePhase.failure !== undefined) throw privatePhase.failure;
      return result;
    });
    // The actual Principal service checks current rights again after its
    // callback returns. Keep the opaque reader failure binding through that
    // final SQL await as well, without extending any native capability.
    if (privatePhase?.failure !== undefined) throw privatePhase.failure;
    return result;
  } finally {
    if (privatePhase) {
      privatePhase.active = false;
      if (authenticatedReaders.get(connection) === privatePhase) authenticatedReaders.delete(connection);
    }
  }
}

function bindNativeSessionRequestAccess(connection: SqlConnection, session: ExistingNativeCollaborationSession,
  access: WorkspaceRequestPrincipalAccess): ExistingNativeSessionRequestAccess {
  const assertBound = (): void => {
    try { requireCapability(connection,session); }
    catch (error) { poisonCapabilityFailure(connection,session,error); throw error; }
  };
  // Reuse the native guard so lifetime, SAME backend/TX, native admission,
  // pending checks and permanent failure binding apply to this facade too.
  const assertCurrent = (): Promise<void> => assertExistingNativeCollaborationSessionCurrentOnConnection(connection,session).then(() => undefined);
  return Object.freeze({
    get workspace() { assertBound(); return access.workspace; },
    get userId() { assertBound(); return access.userId; },
    get sessionId() { assertBound(); return access.sessionId; },
    get assertCurrent() { assertBound(); return assertCurrent; },
  });
}

async function withCapturedNativeSession<T>(captured: Capture,
  consume: (session: ExistingNativeCollaborationSession) => Promise<T>): Promise<T> {
  const connection = captured.connection, previous = connections.get(connection);
  if (previous) { poison(previous,new NativeSessionStateReaderError('NATIVE_SESSION_REENTRANT')); throw previous.failure; }
  connections.set(connection, captured);
  try {
    if (getWorkspaceFileLifecycleLeases()?.has(captured.workspaceId)) fail('NATIVE_SESSION_REENTRANT');
    captured.identity = await connectionIdentity(connection,captured.principal);
    await checkConnection(captured); // Distinct statements prove a caller-owned TX, not autocommit.
    if ((await ownLockModes(captured)).length) fail('NATIVE_SESSION_REENTRANT');
    const lock = await connection.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked', [captured.key]) as Row | undefined;
    assertActive(captured);
    if (lock?.locked !== true) fail('NATIVE_SESSION_BUSY');
    await readCurrent(captured); captured.phase = 'active';
    const capability = Object.freeze({ get snapshot() {
      assertActive(captured);
      if (captured.phase !== 'active' || !captured.accepting) {
        const error = new NativeSessionStateReaderError('NATIVE_SESSION_REQUIRED'); poison(captured,error); throw error;
      }
      return captured.snapshot!;
    } });
    capabilities.set(capability, captured);
    let result: T | undefined;
    try { result = await consume(capability); } catch (error) { poison(captured, error); }
    captured.accepting = false;
    if (captured.pending.size) {
      poison(captured, new NativeSessionStateReaderError('NATIVE_SESSION_DETACHED'));
      await Promise.allSettled([...captured.pending]);
    }
    if (captured.failure !== undefined) throw captured.failure;
    await readCurrent(captured);
    return result as T;
  } finally {
    captured.accepting = false; captured.phase = 'closed'; captured.native = undefined; captured.snapshot = undefined;
    if (connections.get(connection) === captured) connections.delete(connection);
  }
}

function requireCapability(connection: SqlConnection, capability: ExistingNativeCollaborationSession): Capture {
  const captured = capabilities.get(capability);
  if (!captured || captured.connection !== connection || captured.phase !== 'active' || !captured.accepting) fail('NATIVE_SESSION_REQUIRED');
  assertActive(captured);
  if (captured.pending.size) fail('NATIVE_SESSION_REENTRANT');
  return captured;
}

/** Must be awaited immediately before a later, separately authorized grant is assembled. */
export function assertExistingNativeCollaborationSessionCurrentOnConnection(connection: SqlConnection,
  capability: ExistingNativeCollaborationSession): Promise<ExistingNativeSessionSnapshot> {
  let captured: Capture;
  try { captured = requireCapability(connection, capability); }
  catch (error) { poisonCapabilityFailure(connection, capability, error); return Promise.reject(error); }
  const pending = readCurrent(captured).catch(error => { poison(captured, error); throw error; });
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}

/** Synchronous analysis of the last proven SAME binary. Frozen native structure is private to the callback. */
export function inspectExistingNativeCollaborationSessionOnConnection<T>(connection: SqlConnection,
  capability: ExistingNativeCollaborationSession, inspect: (snapshot: NativeCollaborationSnapshot) => T): T {
  let captured: Capture | undefined;
  try {
    captured = requireCapability(connection, capability);
    const result = inspect(captured.native!);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as { then?: unknown }).then === 'function') fail('NATIVE_SESSION_INVALID');
    return result;
  } catch (error) { poisonCapabilityFailure(connection, capability, error); throw error; }
}
