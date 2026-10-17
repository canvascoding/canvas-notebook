import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { openDb, type SqlConnection } from '../db';
import { readNativeDocumentByIdOnConnection, type NativeDocumentReadObservation } from '../collaboration/native-document-read';
import { getFileDisplayName } from '../files/display-name';
import { SeatLimitGuardError } from '../license/seat-limit';
import { AgentToolInvocationError } from '../pi/agent-tool-invocation';
import { DirectMcpAuthorizationError } from '../mcp/server/access-token-verifier';
import { withDirectMcpDocumentReadPrincipal, withDirectMcpDocumentReadPrincipalOnConnection,
  DirectMcpDocumentReadPrincipalError, type DirectMcpDocumentReadHistoricalOrigin } from '../mcp/server/document-read-principal';
import { withWorkspaceRequestPrincipalOriginalOrigin, withWorkspaceRequestPrincipalOnConnection,
  withWorkspaceAgentToolPrincipalOriginalOrigin, withWorkspaceAgentToolPrincipalOnConnection,
  WorkspaceRequestPrincipalError, type WorkspaceRequestHistoricalOrigin,
  type WorkspaceAgentToolHistoricalOrigin } from '../workspaces/request-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { decodeDocumentReadRequestV1, DocumentReadError, type DecodedDocumentReadRequestV1,
  type DocumentReadPageV1, type DocumentProjectionV1 } from './contracts';
import { encodeDocumentReadBodyV1 } from './read-body';
import { decodeDocumentReadContinuationV1, encodeDocumentReadContinuationV1 } from './read-continuation';
import { documentMetadataVersionV1, documentVersionV1 } from './read-version';
import { sliceDocumentUtf8PageV1 } from './utf8-page';

type HistoricalScope = Pick<WorkspaceRequestHistoricalOrigin, 'workspaceId' | 'workspaceType' | 'organizationId'
  | 'customerId' | 'projectId' | 'ownerUserId' | 'rootPath' | 'rootRelativePath' | 'legacy' | 'status'
  | 'schema' | 'schemaOid' | 'searchPath' | 'databaseOid'>;
type Origin = Readonly<{ scope: HistoricalScope; actor: readonly string[] }>;
type Row = Record<string, unknown>;
type Realm = Readonly<{ schema: string; schemaOid: string; searchPath: string; database: string;
  backend: number; start: string; transaction: string }>;
type ReadPhase = { active: boolean; connection: SqlConnection; origin: Origin; workspace: WorkspaceContext;
  realm: Realm; authorityScopeSha256: string; document?: Readonly<{ id: string; witness: string | null }> };
const tables = ['canvas_workspaces', 'collaboration_documents', 'file_collaboration_lineages',
  'collaboration_yjs_states', 'workspace_file_metadata', 'collaboration_file_projections'];
const scopeFields = ['workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId', 'ownerUserId',
  'rootPath', 'rootRelativePath', 'legacy', 'status'] as const;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const positive = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0;
function changed(): never { throw new DocumentReadError('DOCUMENT_SCOPE_CHANGED'); }

function origin(scope: HistoricalScope, actor: readonly string[]): Origin {
  return Object.freeze({ scope: Object.freeze({ ...scope }), actor: Object.freeze([...actor]) });
}
function observe<T>(record: { value?: T }, value: T): void {
  if (record.value !== undefined && !isDeepStrictEqual(record.value, value)) changed();
  record.value ??= value;
}
function assertWorkspace(workspace: WorkspaceContext, expected: HistoricalScope): void {
  if (workspace.legacy || workspace.status !== 'active' || !workspace.permissions.canRead
    || scopeFields.some(key => (Reflect.get(workspace, key) ?? null) !== (Reflect.get(expected, key) ?? null))) changed();
}
async function readRealm(connection: SqlConnection): Promise<Realm> {
  const row = await connection.get(`SELECT current_schema() AS schema,
    to_regnamespace(current_schema())::oid::text AS schema_oid,
    CASE WHEN octet_length(current_setting('search_path'))<=16384 THEN current_setting('search_path') END AS search_path,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS start,
    pg_current_xact_id_if_assigned()::text AS transaction_id,
    current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
    current_setting('session_replication_role') AS replication
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Row | undefined;
  if (!row || typeof row.schema !== 'string' || !row.schema || row.schema.length > 63
    || !positive(row.schema_oid) || !positive(row.database_oid) || !positive(row.backend) || !positive(row.transaction_id)
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') changed();
  return Object.freeze({ schema: row.schema, schemaOid: String(row.schema_oid), searchPath: row.search_path,
    database: String(row.database_oid), backend: Number(row.backend), start: row.start, transaction: String(row.transaction_id) });
}
async function assertBinding(phase: ReadPhase): Promise<void> {
  if (!phase.active) changed();
  const current = await readRealm(phase.connection), expected = phase.origin.scope;
  if (!phase.active || !isDeepStrictEqual(current, phase.realm) || current.schema !== expected.schema
    || current.schemaOid !== String(expected.schemaOid) || current.database !== String(expected.databaseOid)
    || current.searchPath !== expected.searchPath) changed();
  const relations = await phase.connection.all(`SELECT name,
    to_regclass(name)::oid=to_regclass($1||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($2::text[]) names(name)`, [quote(current.schema), tables]) as Row[];
  if (!phase.active || relations.length !== tables.length || new Set(relations.map(row => row.name)).size !== tables.length
    || relations.some(row => !tables.includes(String(row.name)) || row.same_relation !== true)) changed();
  const columns = ['id', 'type', 'organization_id', 'customer_id', 'project_id', 'owner_user_id', 'root_relative_path', 'status'];
  const workspace = await phase.connection.get(`SELECT ${columns.map(name =>
    `CASE WHEN octet_length(${name})<=16384 THEN ${name} END AS ${name}`).join(',')},
    (${columns.map(name => `COALESCE(octet_length(${name}),0)>16384`).join(' OR ')}) AS oversized_text
    FROM ${quote(current.schema)}.canvas_workspaces WHERE id=$1`, [expected.workspaceId]) as Row | undefined;
  if (workspace?.oversized_text === true) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
  if (!phase.active || !workspace || workspace.id !== expected.workspaceId || workspace.type !== expected.workspaceType
    || workspace.organization_id !== expected.organizationId || workspace.customer_id !== expected.customerId
    || workspace.project_id !== expected.projectId || workspace.owner_user_id !== expected.ownerUserId
    || workspace.root_relative_path !== expected.rootRelativePath || workspace.status !== 'active') changed();
}
async function phaseFor(connection: SqlConnection, workspace: WorkspaceContext, source: Origin): Promise<ReadPhase> {
  const captured = structuredClone(workspace);
  assertWorkspace(captured, source.scope);
  const realm = await readRealm(connection);
  const phase: ReadPhase = { active: true, connection, origin: source, workspace: captured, realm,
    authorityScopeSha256: digest(['canvas-document-read-authority', 1, source.actor,
      ...scopeFields.map(key => source.scope[key]), source.scope.schema, source.scope.schemaOid,
      source.scope.searchPath, source.scope.databaseOid]) };
  await assertBinding(phase);
  await connection.run(`LOCK TABLE ${tables.map(table => `${quote(realm.schema)}.${quote(table)}`).join(',')}
    IN ACCESS SHARE MODE NOWAIT`);
  await assertBinding(phase);
  return phase;
}

const witnessText = [
  ...['id', 'lineage_id', 'workspace_id', 'workspace_type', 'organization_id', 'customer_id', 'project_id',
    'path', 'provider', 'status', 'yjs_state_lifecycle'].map(field => `d.${field}`),
  ...['id', 'workspace_id', 'workspace_type', 'organization_id', 'customer_id', 'project_id', 'path', 'status',
    'trash_entry_id'].map(field => `l.${field}`),
  ...['document_id', 'workspace_id', 'organization_id', 'path', 'representation', 'status'].map(field => `s.${field}`), 'm.title',
];
/** Pins lifecycle, original nullable scope and shared metadata across all later
 * awaits. Ordinary content persistence/checkpoint advancement is not a rename. */
async function headerWitness(phase: ReadPhase, documentId: string): Promise<string | null> {
  const schema = quote(phase.realm.schema);
  const rows = await phase.connection.all(`SELECT CASE WHEN ${witnessText.map(field =>
    `COALESCE(octet_length(${field}),0)>16384`).join(' OR ')} THEN NULL ELSE
      encode(sha256(convert_to(jsonb_build_array(${witnessText.join(',')},l.archived_at,
        s.lifecycle_generation,s.schema_version,m.updated_at)::text,'UTF8')),'hex') END AS witness
    FROM ${schema}.collaboration_documents d FULL JOIN ${schema}.collaboration_yjs_states s ON s.document_id=d.id
    LEFT JOIN ${schema}.file_collaboration_lineages l ON l.id=d.lineage_id
    LEFT JOIN ${schema}.workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
    WHERE (d.id=$1 AND d.workspace_id=$2) OR (s.document_id=$1 AND s.workspace_id=$2) LIMIT 2`,
  [documentId, phase.workspace.workspaceId]) as Row[];
  if (!phase.active || rows.length > 1) changed();
  if (!rows.length) return null;
  if (rows[0].witness === null) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
  if (typeof rows[0].witness !== 'string' || !/^[a-f0-9]{64}$/u.test(rows[0].witness)) changed();
  return rows[0].witness;
}
async function projection(phase: ReadPhase, observation: NativeDocumentReadObservation): Promise<DocumentProjectionV1> {
  const n = observation.native, schema = quote(phase.realm.schema);
  const row = await phase.connection.get(`SELECT EXISTS(SELECT 1 FROM ${schema}.collaboration_yjs_states y
    JOIN ${schema}.collaboration_file_projections p ON p.document_id=y.document_id
    JOIN ${schema}.collaboration_documents d ON d.id=y.document_id
    WHERE y.document_id=$1 AND y.workspace_id=$2 AND y.organization_id IS NOT DISTINCT FROM $3 AND y.path=$4
      AND y.lifecycle_generation=$5 AND y.representation=$6 AND y.schema_version=$7 AND y.status='active'
      AND y.document_sequence=$8 AND y.checkpoint_sequence=$9 AND y.checkpointed_at=$10
      AND y.canonical_hash IS NOT NULL AND y.serialized_hash IS NOT NULL
      AND p.lifecycle_generation=y.lifecycle_generation AND p.projected_sequence=y.checkpoint_sequence
      AND p.canonical_hash=y.canonical_hash AND p.serialized_hash=y.serialized_hash
      AND p.revision_id IS NOT NULL AND p.finalized=1 AND d.status='active' AND d.provider='yjs'
      AND d.workspace_id=y.workspace_id AND d.organization_id IS NOT DISTINCT FROM y.organization_id
      AND d.path=y.path AND d.state_version>=y.checkpoint_sequence) AS finalized`,
  [n.documentId, n.workspaceId, n.organizationId, n.path, n.lifecycleGeneration, n.representation,
    n.schemaVersion, n.durable.documentSequence, n.projection.checkpointSequence, n.projection.checkpointedAt]) as Row | undefined;
  if (!phase.active || !row || typeof row.finalized !== 'boolean') changed();
  return Object.freeze({ checkpointSequence: n.projection.checkpointSequence, checkpointedAt: n.projection.checkpointedAt,
    status: n.observed.durable && row.finalized && n.projection.checkpointSequence === n.durable.documentSequence ? 'current'
      : n.projection.error?.permanent ? 'unavailable' : 'pending',
    ...(n.projection.error ? { errorCode: n.projection.error.code } : {}) });
}

async function readPage(phase: ReadPhase, selection: DecodedDocumentReadRequestV1): Promise<DocumentReadPageV1> {
  await assertBinding(phase);
  const originalHeader = await headerWitness(phase, selection.documentId);
  phase.document = Object.freeze({ id: selection.documentId, witness: originalHeader });
  const observation = await readNativeDocumentByIdOnConnection(phase.connection,
    { workspace: phase.workspace, documentId: selection.documentId });
  const n = observation.native, identity = { workspaceId: n.workspaceId, organizationId: n.organizationId,
    documentId: n.documentId, lineageId: observation.identity.lineageId, lifecycleGeneration: n.lifecycleGeneration,
    representation: n.representation, schemaVersion: n.schemaVersion };
  const version = documentVersionV1(identity, n.observed.stateProof);
  if (selection.expectedVersion !== undefined && selection.expectedVersion !== version) throw new DocumentReadError('DOCUMENT_VERSION_CONFLICT');
  const title = observation.metadata.title ?? getFileDisplayName({ name: n.path.split('/').at(-1)!, type: 'file' });
  const metadataVersion = documentMetadataVersionV1(identity, { path: n.path, title, metadataRevision: observation.metadata.revision });
  const body = encodeDocumentReadBodyV1(observation, selection.format);
  const continuation = Object.freeze({ authorityScopeSha256: phase.authorityScopeSha256,
    identitySha256: digest(['canvas-document-read-identity', 1, identity]), lifecycleGeneration: n.lifecycleGeneration,
    contentVersion: version, metadataVersion, format: selection.format, totalBytes: body.totalBytes, bodySha256: body.bodySha256 });
  const offset = selection.cursor === undefined ? 0 : decodeDocumentReadContinuationV1(selection.cursor, continuation);
  const page = sliceDocumentUtf8PageV1(body.bytes, offset, selection.maxBytes);
  const projected = await projection(phase, observation);
  await assertBinding(phase);
  if (await headerWitness(phase, selection.documentId) !== originalHeader) changed();
  return Object.freeze({ apiVersion: 1, document: Object.freeze({ kind: 'native_document', ...identity,
    path: n.path, title, version, metadataVersion }),
  currency: Object.freeze({ source: n.source, observedVersion: version, observedDurable: n.observed.durable,
    durableVersion: documentVersionV1(identity, n.durable.stateProof), durableSequence: n.durable.documentSequence,
    persistedAt: n.durable.persistedAt }), projection: projected, format: body.format, mediaType: body.mediaType,
  encoding: 'utf-8', fragment: page.fragment, byteOffset: page.byteOffset, byteLength: page.byteLength,
  totalBytes: page.totalBytes, nextCursor: page.nextOffset === null ? null : encodeDocumentReadContinuationV1(continuation, page.nextOffset),
  complete: page.complete });
}

function normalizeError(error: unknown): Error {
  if (error instanceof DocumentReadError || error instanceof DirectMcpAuthorizationError) return error;
  if (error instanceof SeatLimitGuardError) return new DocumentReadError('ACCESS_DENIED');
  if (error instanceof AgentToolInvocationError) return new DocumentReadError(error.code === 'AGENT_TOOL_INVOCATION_ABORTED'
    || error.code === 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED' ? 'DOCUMENT_SCOPE_CHANGED' : 'AUTHENTICATION_REQUIRED');
  if (error instanceof DirectMcpDocumentReadPrincipalError) {
    if (error.code === 'MCP_READ_PRINCIPAL_REQUIRED') return new DocumentReadError('AUTHENTICATION_REQUIRED');
    if (error.code === 'MCP_READ_PRINCIPAL_INVALID') return new DocumentReadError('INVALID_REQUEST');
    if (error.code === 'MCP_READ_PRINCIPAL_ACCESS_DENIED') return new DocumentReadError('ACCESS_DENIED');
    if (error.code === 'MCP_READ_PRINCIPAL_BUSY' || error.code === 'MCP_READ_PRINCIPAL_EXPIRED') return new DocumentReadError('DOCUMENT_BUSY');
    if (error.code === 'MCP_READ_PRINCIPAL_SCHEMA_INVALID') return new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
    return new DocumentReadError('DOCUMENT_SCOPE_CHANGED');
  }
  if (error instanceof WorkspaceRequestPrincipalError) {
    if (error.code === 'PRINCIPAL_AUTH_REVOKED' || error.code === 'PRINCIPAL_REQUIRED') return new DocumentReadError('AUTHENTICATION_REQUIRED');
    if (error.code === 'PRINCIPAL_ACCESS_DENIED') return new DocumentReadError('ACCESS_DENIED');
    if (error.code === 'PRINCIPAL_BUSY') return new DocumentReadError('DOCUMENT_BUSY');
    if (error.code === 'PRINCIPAL_TOO_LARGE') return new DocumentReadError('DOCUMENT_TOO_LARGE');
    if (error.code === 'PRINCIPAL_WORKSPACE_UNCONFIRMED' || error.code === 'PRINCIPAL_EXPIRED') return new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
    return new DocumentReadError('DOCUMENT_SCOPE_CHANGED');
  }
  if ((error as { code?: string } | null)?.code === '55P03') return new DocumentReadError('DOCUMENT_BUSY');
  return new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
}
/** Fixed actual connection owner. No fake principal/SQL adapter or retry hook
 * can be supplied. Successful output waits for both COMMIT and disposal. */
async function transaction<T>(operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await openDb(); let beginAttempted = false, began = false, committing = false, discard: Error | undefined;
  try {
    beginAttempted = true; await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
    const result = await operation(connection);
    committing = true;
    try { await connection.run('COMMIT'); began = false; }
    catch (error) { discard = new Error('Unconfirmed document read COMMIT.', { cause: error }); throw new DocumentReadError('READ_OUTCOME_UNCONFIRMED'); }
    return result;
  } catch (error) {
    if (began && !committing) {
      try { await connection.run('ROLLBACK'); began = false; }
      catch (rollback) { discard = new Error('Unconfirmed document read ROLLBACK.', { cause: rollback }); throw new DocumentReadError('READ_OUTCOME_UNCONFIRMED'); }
    } else if (beginAttempted && !committing) {
      discard = new Error('Unconfirmed document read BEGIN.', { cause: error });
      throw new DocumentReadError('READ_OUTCOME_UNCONFIRMED');
    }
    throw normalizeError(error);
  } finally {
    try { await connection.close(discard); }
    catch { throw new DocumentReadError('READ_OUTCOME_UNCONFIRMED'); }
  }
}

async function consume<T>(source: { value?: T }, connection: SqlConnection, workspace: WorkspaceContext,
  toOrigin: (value: T) => Origin, selection: DecodedDocumentReadRequestV1): Promise<{ phase: ReadPhase; page: DocumentReadPageV1 }> {
  if (source.value === undefined) changed();
  const phase = await phaseFor(connection, workspace, toOrigin(source.value));
  try { return { phase, page: await readPage(phase, selection) }; }
  catch (error) { phase.active = false; throw error; }
}
async function finish(held: { phase: ReadPhase; page: DocumentReadPageV1 }): Promise<DocumentReadPageV1> {
  try {
    await assertBinding(held.phase);
    const target = held.phase.document;
    if (!target || await headerWitness(held.phase, target.id) !== target.witness) changed();
    await assertBinding(held.phase);
    return held.page;
  }
  finally { held.phase.active = false; }
}

/** Genuine Better Auth request; selectors and continuation evidence grant no rights. */
export async function readDocumentForRequest(request: Request, input: unknown): Promise<DocumentReadPageV1> {
  const selection = decodeDocumentReadRequestV1(input);
  // Compiled route/core bundles can carry distinct NextRequest constructors.
  // Require a genuine Web Request and normalize to this module's local class.
  if (!(request instanceof Request)) throw new DocumentReadError('INVALID_REQUEST');
  const captured = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const historical: { value?: WorkspaceRequestHistoricalOrigin } = {};
  try { return await withWorkspaceRequestPrincipalOriginalOrigin(captured, { workspaceId: selection.workspaceId, permission: 'canRead' },
    value => observe(historical, value), principal => transaction(async connection => {
      const held = await withWorkspaceRequestPrincipalOnConnection(connection, principal, access => consume(historical,
        connection, access.workspace, value => origin(value, ['request', value.userId, value.sessionId, value.impersonatedBy ?? '']), selection));
      return finish(held);
    })); } catch (error) { throw normalizeError(error); }
}

/** Actual current PI invocation; never constructs a member request or accepts an actor DTO. */
export async function readDocumentForAgentTool(input: unknown): Promise<DocumentReadPageV1> {
  const selection = decodeDocumentReadRequestV1(input), historical: { value?: WorkspaceAgentToolHistoricalOrigin } = {};
  try { return await withWorkspaceAgentToolPrincipalOriginalOrigin({ workspaceId: selection.workspaceId, permission: 'canRead' },
    value => observe(historical, value), principal => transaction(async connection => {
      const held = await withWorkspaceAgentToolPrincipalOnConnection(connection, principal, access => consume(historical,
        connection, access.workspace, value => origin(value, ['agent_tool', value.userId, value.agentId, value.piSessionId, value.toolName]), selection));
      return finish(held);
    })); } catch (error) { throw normalizeError(error); }
}

/** Actual Direct MCP token, /mcp audience and knowledge:read purpose. Search does not grant read. */
export async function readDocumentForDirectMcp(authInfo: AuthInfo, input: unknown): Promise<DocumentReadPageV1> {
  const selection = decodeDocumentReadRequestV1(input), historical: { value?: DirectMcpDocumentReadHistoricalOrigin } = {};
  try { return await withDirectMcpDocumentReadPrincipal(authInfo, { workspaceId: selection.workspaceId, purpose: 'read' },
    value => observe(historical, value), principal => transaction(async connection => {
      const held = await withDirectMcpDocumentReadPrincipalOnConnection(connection, principal, access => consume(historical,
        connection, access.workspace, value => origin(value, ['direct_mcp', value.userId, value.clientId, value.sessionId]), selection));
      return finish(held);
    })); } catch (error) { throw normalizeError(error); }
}
