import 'server-only';

import { NextRequest } from 'next/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlConnection } from '../db';
import { openDb } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { getWorkspaceFileLifecycleLeases } from './file-lifecycle-admission-context';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { loadCollaborationStateOnConnection, type PersistedCollaborationState } from './persistence';
import { isCollaborationStateQuarantined } from './failure';
import { CollaborationAdmissionError, isCanonicalAdmissionPath, type CollaborationAdmissionRequest } from './room-admission-contract';
import { captureRepresentationAdmissionRequest } from './representation-admission-contract';
import { COLLABORATION_SCHEMA_VERSION } from './types';
import { tryLockCollaborationAdmissionWorkspace } from './room-admission';
import type { RichMigrationWriteRequestInput, RichMigrationWriteRequestAccess } from './rich-migration-write-request';

/** Domain callback only; the existing owner still controls BEGIN/COMMIT/disposal. */
export type RichMigrationTransaction = <T>(database: SqlConnection, operation: () => Promise<T>) => Promise<T>;
type Realm = Readonly<{ database: number; schema: string; schemaOid: number; searchPath: string }>;
type Native = { state: PersistedCollaborationState; workspace: WorkspaceContext; lineageId: string;
  userId: string; sessionId: string; realm: Realm };
type Row = Record<string, unknown>;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const safeNumber = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
function changed(): never { throw new CollaborationAdmissionError('ADMISSION_SCOPE_CHANGED'); }
const workspaceOriginKeys = ['workspaceId','workspaceType','organizationId','customerId','projectId','ownerUserId',
  'rootPath','rootRelativePath','legacy','status'] as const;

/** Validate the original SQL row before the existing mapper can normalize it. */
function validateRawNativeState(row: Row): void {
  if (!['plain_text','tiptap_xml','tiptap_blocks'].includes(String(row.representation)) || row.status !== 'active'
    || !safeNumber(row.schema_version, 1) || Number(row.schema_version) !== COLLABORATION_SCHEMA_VERSION
    || !safeNumber(row.lifecycle_generation, 1) || !safeNumber(row.document_sequence) || !safeNumber(row.checkpoint_sequence)
    || Number(row.checkpoint_sequence) > Number(row.document_sequence) || !safeNumber(row.persisted_at)
    || row.checkpointed_at !== null && !safeNumber(row.checkpointed_at)
    || !['lf','crlf'].includes(String(row.newline_style)) || ![0,1,'0','1',false,true].includes(row.has_bom as never)
    || ![0,1,'0','1',false,true].includes(row.degraded as never)
    || ![0,1,'0','1'].includes(row.projection_error_permanent as never)
    || !(row.yjs_state instanceof Uint8Array) || row.yjs_state.byteLength < 1 || row.yjs_state.byteLength > 64 * 1024 * 1024
    || !(row.state_vector instanceof Uint8Array) || row.state_vector.byteLength < 1 || row.state_vector.byteLength > 1024 * 1024) changed();
  const code = row.projection_error_code, permanent = Number(row.projection_error_permanent);
  if (code !== null) {
    if (!validId(code) || !safeNumber(row.projection_error_sequence) || !safeNumber(row.projection_error_generation, 1)
      || Number(row.projection_error_sequence) > Number(row.document_sequence)
      || Number(row.projection_error_generation) > Number(row.lifecycle_generation)
      || permanent === 1 && Number(row.projection_error_generation) !== Number(row.lifecycle_generation)
      || row.projection_error_phase !== null && (typeof row.projection_error_phase !== 'string'
        || row.projection_error_phase.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.projection_error_phase))) changed();
  } else if (permanent !== 0 || row.projection_error_sequence !== null || row.projection_error_generation !== null
    || row.projection_error_phase !== null) changed();
}

async function realmOnConnection(database: SqlConnection): Promise<Realm> {
  const row = await database.get(`SELECT current_schema() AS schema,to_regnamespace(current_schema())::oid AS schema_oid,
    current_setting('search_path') AS search_path,(SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database`) as Row | undefined;
  if (!row || typeof row.schema !== 'string' || !row.schema || typeof row.search_path !== 'string'
    || !Number.isSafeInteger(Number(row.schema_oid)) || Number(row.schema_oid) < 1
    || !Number.isSafeInteger(Number(row.database)) || Number(row.database) < 1) changed();
  return Object.freeze({ database:Number(row.database),schema:row.schema,schemaOid:Number(row.schema_oid),searchPath:row.search_path });
}

/** Keep the genuine initial selectors private across every coordinator await. */
export function captureRichMigrationHttpRequest(request: NextRequest, workspaceId: string, path: string): NextRequest {
  if (!(request instanceof NextRequest) || !validId(workspaceId) || !isCanonicalAdmissionPath(path)
    || !/\.(?:md|markdown|txt)$/iu.test(path)) changed();
  return new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
}

async function nativeOnConnection(database: SqlConnection, workspace: WorkspaceContext, path: string,
  userId: string, sessionId: string, lockMetadata = true): Promise<Native> {
  if (!validId(userId) || !validId(sessionId) || workspace.actor?.userId !== userId) changed();
  const realm = await realmOnConnection(database);
  const tables = ['collaboration_documents','file_collaboration_lineages','collaboration_yjs_states',
    'collaboration_yjs_state_backups','collaboration_agent_operations','collaboration_file_projections',
    'collaboration_admission_requests','collaboration_admission_scopes','collaboration_admission_targets','canvas_workspaces'];
  const relations = await database.all(`SELECT name,to_regclass(name)::oid=
    to_regclass(quote_ident(current_schema())||'.'||quote_ident(name))::oid AS same_relation
    FROM unnest($1::text[]) names(name)`, [tables]) as Row[];
  if (relations.length !== tables.length || relations.some(row => row.same_relation !== true || !tables.includes(String(row.name)))) changed();
  const actualWorkspace = await database.get(`SELECT id,organization_id,type,status,customer_id,project_id,owner_user_id,root_relative_path
    FROM canvas_workspaces WHERE id=$1`, [workspace.workspaceId]) as Row | undefined;
  if (!actualWorkspace || actualWorkspace.id !== workspace.workspaceId || actualWorkspace.organization_id !== workspace.organizationId
    || actualWorkspace.type !== workspace.workspaceType || actualWorkspace.status !== workspace.status
    || actualWorkspace.customer_id !== (workspace.customerId ?? null) || actualWorkspace.project_id !== (workspace.projectId ?? null)
    || actualWorkspace.owner_user_id !== (workspace.ownerUserId ?? null) || actualWorkspace.root_relative_path !== workspace.rootRelativePath) changed();
  const metadataSql = `SELECT d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.path,
    d.provider,d.status,d.state_version,d.yjs_state_lifecycle,l.workspace_id AS lineage_workspace_id,
    l.workspace_type AS lineage_workspace_type,l.organization_id AS lineage_organization_id,
    l.path AS lineage_path,l.status AS lineage_status,s.document_id AS state_document_id
    FROM collaboration_documents d FULL JOIN collaboration_yjs_states s ON s.document_id=d.id
    LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    WHERE ((d.workspace_id=$1 AND d.path=$2) OR (s.workspace_id=$1 AND s.path=$2))
      AND (d.status='active' OR s.status='active') LIMIT 2`;
  const rows = await database.all(metadataSql, [workspace.workspaceId, path]) as Row[];
  if (rows.length !== 1) changed();
  const row = rows[0], organizationId = workspace.organizationId ?? null;
  if (!validId(row.id) || !validId(row.lineage_id) || row.state_document_id !== row.id
    || row.workspace_id !== workspace.workspaceId || row.workspace_type !== workspace.workspaceType
    || row.organization_id !== organizationId || row.path !== path || row.provider !== 'yjs'
    || row.status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
    || !/^(?:0|[1-9][0-9]*)$/u.test(String(row.state_version)) || !Number.isSafeInteger(Number(row.state_version))
    || row.lineage_workspace_id !== workspace.workspaceId || row.lineage_workspace_type !== workspace.workspaceType
    || row.lineage_organization_id !== organizationId || row.lineage_path !== path || row.lineage_status !== 'active') changed();
  // These metadata locks persist through the caller's final auth and COMMIT.
  // Native state locks remain in the existing operation -> header -> state order.
  if (lockMetadata) {
    await database.get('SELECT id FROM collaboration_documents WHERE id=$1 FOR SHARE', [row.id]);
    await database.get('SELECT id FROM file_collaboration_lineages WHERE id=$1 FOR SHARE', [row.lineage_id]);
    const locked = await database.all(metadataSql, [workspace.workspaceId, path]) as Row[];
    if (locked.length !== 1 || JSON.stringify(locked[0]) !== JSON.stringify(row)) changed();
  }
  const sizes = await database.get(`SELECT octet_length(yjs_state) AS bytes,octet_length(state_vector) AS vector_bytes
    FROM collaboration_yjs_states WHERE document_id=$1`, [row.id]) as Row | undefined;
  if (!sizes || !safeNumber(sizes.bytes, 1) || Number(sizes.bytes) > 64 * 1024 * 1024
    || !safeNumber(sizes.vector_bytes, 1) || Number(sizes.vector_bytes) > 1024 * 1024) changed();
  const state = await loadCollaborationStateOnConnection({ get: async (sql, values) => {
    if (sql.replace(/\s+/gu, ' ').trim() !== 'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1'
      || values?.length !== 1 || values[0] !== row.id) changed();
    // This is the actual mapper row, not an earlier preflight snapshot. SQL
    // bounds also prevent allocation growth between the two READ COMMITTED reads.
    const raw = await database.get(`SELECT * FROM collaboration_yjs_states WHERE document_id=$1
      AND octet_length(yjs_state) BETWEEN 1 AND $2 AND octet_length(state_vector) BETWEEN 1 AND $3 LIMIT 1`,
    [row.id,64 * 1024 * 1024,1024 * 1024]) as Row | undefined;
    if (!raw || raw.document_id !== row.id || raw.workspace_id !== workspace.workspaceId
      || raw.organization_id !== organizationId || raw.path !== path) changed();
    validateRawNativeState(raw);
    return raw;
  } }, row.id, true);
  if (!state || state.status !== 'active' || state.workspaceId !== workspace.workspaceId
    || state.organizationId !== organizationId || state.path !== path || !Number.isSafeInteger(state.lifecycleGeneration)
    || state.lifecycleGeneration < 1 || !Number.isSafeInteger(state.documentSequence) || state.documentSequence < 0
    || !['plain_text','tiptap_xml','tiptap_blocks'].includes(state.representation) || state.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || isCollaborationStateQuarantined(state)) changed();
  if (JSON.stringify(await realmOnConnection(database)) !== JSON.stringify(realm)) changed();
  return { state, workspace, lineageId: row.lineage_id, userId, sessionId, realm };
}

/** Genuine canWrite discovery; no Caller Workspace/state creates authority. */
export async function readAuthenticatedRichMigrationNative(request: NextRequest, workspaceId: string, path: string): Promise<Native> {
  const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../workspaces/request-principal');
  return withWorkspaceRequestPrincipal(request, { permission: 'canWrite', workspaceId }, principal =>
    executeLifecycleTransaction({ openConnection: openDb,
      execute: database => withWorkspaceRequestPrincipalOnConnection(database, principal, async access => {
        const native = await nativeOnConnection(database, access.workspace, path, access.userId, access.sessionId);
        await access.assertCurrent();
        return native;
      }),
      // A pre-close read is no longer a current auth/scope grant. The core has
      // discarded B; fail closed without replay or publishing its old value.
      recoverCommitted: async () => { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); },
    }));
}

/** Installed only by the authenticated product entries. Each short B has a
 * fresh genuine FIXED-canWrite request phase, including its outer final SQL.
 * The native reader cannot be nested here: our own reservation may be active. */
export function createAuthenticatedRichMigrationDomain(request: NextRequest,
  input: RichMigrationWriteRequestInput, original: Native, targetRepresentation: 'tiptap_xml' | 'tiptap_blocks' = 'tiptap_blocks') {
  const context = new AsyncLocalStorage<{ database: SqlConnection; access: RichMigrationWriteRequestAccess; active: boolean }>();
  const sameNative = (native: Native) => {
    if (native.state.documentId !== original.state.documentId || native.lineageId !== original.lineageId
      || native.workspace.workspaceId !== input.workspaceId || native.state.path !== input.path
      || native.state.organizationId !== original.state.organizationId || native.userId !== original.userId
      || native.sessionId !== original.sessionId || JSON.stringify(native.realm) !== JSON.stringify(original.realm)
      || workspaceOriginKeys.some(key => (native.workspace[key] ?? null) !== (original.workspace[key] ?? null))) changed();
  };
  const phase = async <T>(database: SqlConnection, operation: (native: Native) => Promise<T>, mutation: boolean, projection = false): Promise<T> => {
    const { withRichMigrationWriteRequest, withRichMigrationWriteRequestOnConnection } = await import('./rich-migration-write-request');
    return withRichMigrationWriteRequest(request, input, attempt => withRichMigrationWriteRequestOnConnection(database, attempt, async access => {
      const lease = getWorkspaceFileLifecycleLeases()?.get(input.workspaceId);
      const assertLease = async () => {
        if (lease && (!lease.active || getWorkspaceFileLifecycleLeases()?.get(input.workspaceId) !== lease || !await lease.verify())) changed();
      };
      if (mutation) {
        await assertLease();
        // An ALS lease's public shape alone cannot mint a SAME-B lock bypass.
        // Authenticated session entries own their actual exclusive B guard.
        await tryLockCollaborationAdmissionWorkspace((sql, values) => database.all(sql, values) as Promise<Row[]>, input.workspaceId);
      }
      const before = await nativeOnConnection(database, access.workspace, input.path, access.userId, access.sessionId, !projection); sameNative(before);
      const held = { database, access, active: true };
      let value: T;
      try { value = await context.run(held, () => operation(before)); }
      finally { held.active = false; }
      const after = await nativeOnConnection(database, access.workspace, input.path, access.userId, access.sessionId, !projection); sameNative(after);
      if (after.state.lifecycleGeneration !== before.state.lifecycleGeneration) {
        if (!mutation || after.state.lifecycleGeneration !== before.state.lifecycleGeneration + 1
          || after.state.representation !== targetRepresentation || after.state.documentSequence !== before.state.documentSequence + 1) changed();
      } else if (after.state.representation !== before.state.representation) changed();
      if (mutation) await assertLease();
      await access.assertCurrent();
      return value;
    }));
  };
  const withMutationTransaction: RichMigrationTransaction = (database, operation) => phase(database, () => operation(), true);
  const read = () => executeLifecycleTransaction({ openConnection: openDb,
    execute: database => phase(database, native => Promise.resolve(native), false),
    recoverCommitted: async () => { throw new CollaborationAdmissionError('ADMISSION_RECOVERY_REQUIRED'); },
  });
  return {
    withMutationTransaction,
    read,
    /** Retain actual Workspace/Auth locks through physical projection and final
     * auth, with NO native/registry/lineage/admission locks on this outer B.
     * The existing projector owns its auxiliary native fences and journal.
     * A lost COMMIT discards B; a fresh read confirms scope, never replays FS. */
    project: <T>(operation: (workspace: WorkspaceContext) => Promise<T>): Promise<T> => executeLifecycleTransaction({
      openConnection: openDb,
      execute: database => phase(database, native => operation(native.workspace), false, true),
      recoverCommitted: async verified => { await read(); return verified; },
    }),
    authorize: async (request: CollaborationAdmissionRequest, terminal: boolean) => {
      const captured = captureRepresentationAdmissionRequest(request);
      if (JSON.stringify(captured.migration) !== JSON.stringify(input.migration)
        || captured.document.workspaceId !== input.workspaceId || captured.document.organizationId !== original.state.organizationId
        || !terminal && captured.document.path !== input.path) changed();
      const held = context.getStore();
      const native = held ? await (async () => {
        if (!held.active) changed();
        await held.access.assertCurrent();
        return nativeOnConnection(held.database, held.access.workspace, input.path, held.access.userId, held.access.sessionId);
      })() : await read();
      sameNative(native);
      if (request.actorId !== native.workspace.actor?.userId || !terminal
        && (native.state.lifecycleGeneration !== captured.document.lifecycleGeneration
          || native.state.representation !== captured.document.representation)) changed();
    },
  };
}
