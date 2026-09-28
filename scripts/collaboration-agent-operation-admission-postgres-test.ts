import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';
import {
  createCollaborationAdmissionService,
  assertCollaborationAdmissionOpen,
  lockCollaborationAdmissionWorkspace,
} from '../app/lib/collaboration/room-admission';
import * as admissionContractRuntime from '../app/lib/collaboration/room-admission-contract';
import {
  collaborationAdmissionActionDigest,
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const SCHEMA_PREFIX = 'canvas_agent_operation_admission_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type Gate = { promise: Promise<void>; resolve: () => void };
type QueryHooks = {
  connections?: number;
  backendPids?: number[];
  writes?: number;
  beforeQuery?: (sql: string, ordinal: number, backendPid: number) => Promise<void>;
  afterQuery?: (sql: string, ordinal: number, backendPid: number) => Promise<void>;
  commitFault?: { ordinal: number; position: 'before' | 'after'; remaining: number };
  closeFault?: { ordinal: number; remaining: number };
};
type OperationRow = Record<string, unknown> & {
  operation_id: string;
  document_id: string;
  status: string;
  cas_version: number | string;
};
type OperationInput = {
  documentId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  actorId: string;
  idempotencyKey: string;
  runGeneration: number;
  targets: unknown[];
  independentGroups: boolean;
  requestedMode: 'direct_apply' | 'review';
  operationType: 'apply' | 'revert';
  actorSessionId?: string;
  documentPath: string;
  documentRepresentation: 'plain_text';
  documentLifecycleGeneration: number;
  documentSchemaVersion: number;
};
type AgentInternals = {
  createOrLoadAdmittedOperation(input: OperationInput): Promise<{ row: OperationRow; created: boolean }>;
};

function deferred(): Gate {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Agent-operation admission PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Agent-operation admission test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated agent-operation namespace.');
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return {
    connectionString: databaseUrl.toString(), application_name: applicationName,
    connectionTimeoutMillis: 3_000, idleTimeoutMillis: 2_000, allowExitOnIdle: true,
    options: [searchPath ? `-c search_path=${searchPath}` : '',
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`, `-c lock_timeout=${LOCK_TIMEOUT_MS}`]
      .filter(Boolean).join(' '),
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function sanitizeError(error: unknown): string {
  const value = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const name = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(value.name) ? value.name : 'Error';
  const code = typeof value.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(value.code) ? ` [${value.code}]` : '';
  const message = typeof value.message === 'string' ? value.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ database_name: string; server_version_num: string; operation_table: boolean }>(
    `SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_agent_operations') IS NOT NULL AS operation_table`,
  );
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18 || !row.operation_table) {
    throw new Error('Agent-operation admission test refused a server outside managed PG18.');
  }
}

function createConnectionAdapter(pool: Pool, hooksContext: AsyncLocalStorage<QueryHooks>) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
    const hooks = hooksContext.getStore();
    const ordinal = hooks ? (hooks.connections = (hooks.connections ?? 0) + 1) : 0;
    if (hooks) (hooks.backendPids ??= []).push(backendPid);
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const normalized = normalizedSql(sql);
      await hooks?.beforeQuery?.(normalized, ordinal, backendPid);
      if (normalized === 'COMMIT' && hooks?.commitFault?.ordinal === ordinal
        && hooks.commitFault.position === 'before' && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected rejected agent-operation COMMIT.');
      }
      if (/^(?:INSERT|UPDATE|DELETE) /u.test(normalized) && hooks) hooks.writes = (hooks.writes ?? 0) + 1;
      const result = await client.query(sql, params);
      await hooks?.afterQuery?.(normalized, ordinal, backendPid);
      if (normalized === 'COMMIT' && hooks?.commitFault?.ordinal === ordinal
        && hooks.commitFault.position === 'after' && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected lost agent-operation COMMIT reply.');
      }
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: async (error) => {
        assert.equal(closed, false, 'agent-operation SQL connection closed twice');
        closed = true;
        client.release(error);
        if (hooks?.closeFault?.ordinal === ordinal && hooks.closeFault.remaining > 0) {
          hooks.closeFault.remaining -= 1;
          throw new Error('Injected agent-operation connection discard failure.');
        }
      },
    };
  };
}

async function loadAgentInternals(openDb: () => Promise<SqlConnection>): Promise<AgentInternals> {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'agent-operation-admission-test-secret';
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const runtimeRequire = createRequire(filename);
  const source = ts.transpileModule(
    `${await readFile(filename, 'utf8')}\nexport { createOrLoadAdmittedOperation };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText;
  const mocks: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/db': { openDb },
    './server-runtime': { Y },
    './persistence': {
      loadCollaborationState: async () => { throw new Error('Legacy admitted creation borrowed an extra pool connection.'); },
      loadCollaborationStateOnConnection,
    },
    './lifecycle-transaction': { executeLifecycleTransaction },
    './room-admission': { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace },
    './room-admission-contract': admissionContractRuntime,
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => undefined },
    '@/app/lib/file-version-center/history-service': { fileVersionHistoryService: {} },
    './diagnostics': { logCollaborationDiagnostic() {} },
    './presence': { removeDocumentPresenceEntry() {}, upsertDocumentPresenceEntry() {} },
    './document-access': { readCurrentCollaborationDocument: async () => { throw new Error('Unexpected live document read.'); } },
  };
  const compiledModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', source)((name: string) =>
    Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : runtimeRequire(name),
  compiledModule, compiledModule.exports);
  return compiledModule.exports as AgentInternals;
}

function workspace(workspaceId: string, organizationId: string): WorkspaceContext {
  return { workspaceId, workspaceType: 'organization', organizationId, rootPath: `/test-only/${workspaceId}`,
    legacy: false, permissions: { canRead: true, canWrite: true, canDelete: false,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true } };
}

function admissionRequest(document: CollaborationAdmissionDocument): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify({ version: 1, purpose: 'agent-operation-admission-test' });
  return { requestId: randomUUID(), actorId: 'actor-admission-test', action: 'compact', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
    scopes: [{ workspaceId: document.workspaceId, organizationId: document.organizationId,
      path: document.path, kind: 'exact' }], expectedDocuments: [document] };
}

function operationInput(document: CollaborationAdmissionDocument, idempotencyKey: string): OperationInput {
  return { documentId: document.documentId, workspace: workspace(document.workspaceId, document.organizationId!),
    initiatedByUserId: 'user-admission-test', actorId: 'agent-admission-test', actorSessionId: 'session-admission-test',
    idempotencyKey, runGeneration: 1, targets: [], independentGroups: false, requestedMode: 'review',
    operationType: 'apply', documentPath: document.path, documentRepresentation: 'plain_text',
    documentLifecycleGeneration: document.lifecycleGeneration, documentSchemaVersion: document.schemaVersion };
}

function admissionConflict(error: unknown): boolean {
  assert.ok(error instanceof CollaborationAdmissionError);
  assert.equal(error.code, 'ADMISSION_CONFLICT');
  return true;
}

function admissionScopeChanged(error: unknown): boolean {
  assert.ok(error instanceof CollaborationAdmissionError);
  assert.equal(error.code, 'ADMISSION_SCOPE_CHANGED');
  return true;
}

async function waitForBlocked(pool: Pool, backendPid: number, label: string): Promise<void> {
  await within((async () => {
    for (;;) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [backendPid]);
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  })(), OPERATION_TIMEOUT_MS, `${label} did not block on the workspace admission guard`);
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  const schemaSql = schemaIdentifier(schema);
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-agent-operation-admission-control'), max: 5 });
  let runtimePool: Pool | undefined;
  let runtimePoolDrained = false;
  let schemaCreated = false;
  const cleanupErrors: unknown[] = [];
  const poolErrors: Error[] = [];
  controlPool.on('error', (error) => { poolErrors.push(error); });
  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    for (const table of ['user', 'collaboration_yjs_states', 'collaboration_agent_operations',
      'file_change_proposals', 'file_proposal_action_receipts']) {
      await controlPool.query(`CREATE TABLE ${schemaSql}."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    const migration = new Client({ ...poolConfig(databaseUrl, 'canvas-agent-operation-admission-migration', schema) });
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
    } finally { await migration.end(); }

    runtimePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-agent-operation-admission-runtime', schema), max: 12 });
    runtimePool.on('error', (error) => { poolErrors.push(error); });
    const hookContext = new AsyncLocalStorage<QueryHooks>();
    const openConnection = createConnectionAdapter(runtimePool, hookContext);
    const agent = await loadAgentInternals(openConnection);
    const admission = createCollaborationAdmissionService({ openConnection });
    const stateTable = `${schemaSql}.collaboration_yjs_states`;
    const operationTable = `${schemaSql}.collaboration_agent_operations`;
    const seed = async (documentId: string, workspaceId: string, filePath: string): Promise<CollaborationAdmissionDocument> => {
      const organizationId = `organization-${workspaceId}`;
      const doc = new Y.Doc();
      doc.getText('content').insert(0, `content:${documentId}`);
      const update = Buffer.from(Y.encodeStateAsUpdate(doc));
      const vector = Buffer.from(Y.encodeStateVector(doc));
      doc.destroy();
      await controlPool.query(`INSERT INTO ${stateTable} (
        document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
        canonical_hash,serialized_hash,newline_style,has_bom,degraded,status
      ) VALUES ($1,$2,$3,$4,'plain_text',1,1,$5,$6,1,$7,$7,1,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, organizationId, filePath, update, vector, Date.now()]);
      return { documentId, workspaceId, organizationId, path: filePath, representation: 'plain_text',
        lifecycleGeneration: 1, schemaVersion: 1, status: 'active' };
    };
    const readOperations = async (documentId: string) => (await controlPool.query<OperationRow>(
      `SELECT * FROM ${operationTable} WHERE document_id=$1 ORDER BY created_at`, [documentId])).rows;

    // An active reservation rejects only a genuinely new operation.
    const reservedDocument = await seed('agent-operation-reserved', 'workspace-reserved', 'reserved.md');
    const reservedRequest = admissionRequest(reservedDocument);
    const reserved = await admission.reserve(reservedRequest);
    await assert.rejects(agent.createOrLoadAdmittedOperation(operationInput(reservedDocument, 'reserved-new')), admissionConflict);
    assert.equal((await readOperations(reservedDocument.documentId)).length, 0);

    // Cancelling the reservation restores new-operation liveness.
    await admission.cancel(reservedRequest, reserved.revision);
    const first = await agent.createOrLoadAdmittedOperation(operationInput(reservedDocument, 'reserved-existing'));
    assert.equal(first.created, true);
    assert.equal(Number(first.row.cas_version), 0);

    // A later reservation does not reject the exact already-admitted retry.
    const retryRequest = admissionRequest(reservedDocument);
    const retryReservation = await admission.reserve(retryRequest);
    const retry = await agent.createOrLoadAdmittedOperation(operationInput(reservedDocument, 'reserved-existing'));
    assert.equal(retry.created, false);
    assert.equal(retry.row.operation_id, first.row.operation_id);
    assert.equal((await readOperations(reservedDocument.documentId)).length, 1);
    await admission.cancel(retryRequest, retryReservation.revision);

    // Handoff terminalization does not take the admission guard. If it owns the
    // state row first, the admitted reader must wait and then reject its stale
    // explicit lifecycle generation rather than inserting against old bytes.
    const lifecycleFirstDocument = await seed('agent-lifecycle-first', 'workspace-lifecycle-first', 'lifecycle-first.md');
    const lifecycleFirstRequest = admissionRequest(lifecycleFirstDocument);
    await admission.reserve(lifecycleFirstRequest);
    const lifecycleFirstClient = new Client({
      ...poolConfig(databaseUrl, 'canvas-agent-operation-admission-lifecycle-first', schema),
    });
    await lifecycleFirstClient.connect();
    let lifecycleFirstOpen = false;
    let lifecycleFirstHandled: Promise<{ value: { row: OperationRow; created: boolean } | undefined; error: unknown }> | undefined;
    try {
      await lifecycleFirstClient.query('BEGIN');
      lifecycleFirstOpen = true;
      const lifecyclePid = (await lifecycleFirstClient.query<{ pid: number }>(
        'SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
      await lifecycleFirstClient.query(
        'SELECT document_id FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
        [lifecycleFirstDocument.documentId]);
      const lifecycleFirstHooks: QueryHooks = {};
      const lifecycleFirstPromise = hookContext.run(lifecycleFirstHooks, () =>
        agent.createOrLoadAdmittedOperation(operationInput(lifecycleFirstDocument, 'lifecycle-first')));
      lifecycleFirstHandled = lifecycleFirstPromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!lifecycleFirstHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), OPERATION_TIMEOUT_MS, 'lifecycle-first operation connection did not open');
      await waitForBlocked(controlPool, lifecycleFirstHooks.backendPids![0]!, 'operation behind lifecycle state lock');
      const blockers = await controlPool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers',
        [lifecycleFirstHooks.backendPids![0]!]);
      assert.deepEqual(blockers.rows[0]?.blockers, [lifecyclePid]);
      await lifecycleFirstClient.query(`UPDATE collaboration_yjs_states
        SET lifecycle_generation = lifecycle_generation + 1 WHERE document_id = $1`,
      [lifecycleFirstDocument.documentId]);
      await lifecycleFirstClient.query(`UPDATE collaboration_admission_targets
        SET active = false, status = 'completed' WHERE request_id = $1`, [lifecycleFirstRequest.requestId]);
      await lifecycleFirstClient.query(`UPDATE collaboration_admission_requests
        SET status = 'committed', revision = revision + 1, completed_at = $2, outcome_text = '{}'
        WHERE request_id = $1`, [lifecycleFirstRequest.requestId, Date.now()]);
      await lifecycleFirstClient.query('COMMIT');
      lifecycleFirstOpen = false;
      admissionScopeChanged((await lifecycleFirstHandled).error);
      assert.equal((await readOperations(lifecycleFirstDocument.documentId)).length, 0);
    } finally {
      if (lifecycleFirstOpen) await lifecycleFirstClient.query('ROLLBACK').catch(() => undefined);
      await lifecycleFirstClient.end();
      if (lifecycleFirstHandled) await within(lifecycleFirstHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'lifecycle-first operation did not settle during cleanup');
    }

    // Conversely, once operation creation has read the row FOR SHARE, a state
    // rewrite must remain blocked until the operation INSERT commits.
    const sharedFirstDocument = await seed('agent-share-first', 'workspace-share-first', 'share-first.md');
    const operationCommitEntered = deferred();
    const releaseOperationCommit = deferred();
    const sharedFirstHooks: QueryHooks = { beforeQuery: async (sql) => {
      if (sql !== 'COMMIT') return;
      operationCommitEntered.resolve();
      await releaseOperationCommit.promise;
    } };
    const sharedFirstPromise = hookContext.run(sharedFirstHooks, () =>
      agent.createOrLoadAdmittedOperation(operationInput(sharedFirstDocument, 'share-first')));
    const sharedFirstHandled = sharedFirstPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    const blockedStateClient = new Client({
      ...poolConfig(databaseUrl, 'canvas-agent-operation-admission-share-first', schema),
    });
    let blockedStateConnected = false;
    let blockedStateOpen = false;
    let blockedStateHandled: Promise<{ error: unknown }> | undefined;
    try {
      await within(operationCommitEntered.promise, OPERATION_TIMEOUT_MS, 'share-first operation did not reach COMMIT');
      await blockedStateClient.connect();
      blockedStateConnected = true;
      await blockedStateClient.query('BEGIN');
      blockedStateOpen = true;
      const blockedStatePid = (await blockedStateClient.query<{ pid: number }>(
        'SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
      const blockedStateUpdate = blockedStateClient.query(`UPDATE collaboration_yjs_states
        SET lifecycle_generation = lifecycle_generation + 1 WHERE document_id = $1`,
      [sharedFirstDocument.documentId]);
      blockedStateHandled = blockedStateUpdate.then(() => ({ error: undefined as unknown }),
        (error: unknown) => ({ error }));
      await waitForBlocked(controlPool, blockedStatePid, 'state mutation behind admitted operation');
      const blockers = await controlPool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [blockedStatePid]);
      assert.deepEqual(blockers.rows[0]?.blockers, [sharedFirstHooks.backendPids![0]!]);
      releaseOperationCommit.resolve();
      const sharedFirst = await sharedFirstHandled;
      if (sharedFirst.error) throw sharedFirst.error;
      assert.equal(sharedFirst.value?.created, true);
      const blockedState = await blockedStateHandled;
      if (blockedState.error) throw blockedState.error;
      await blockedStateClient.query('ROLLBACK');
      blockedStateOpen = false;
      assert.equal((await readOperations(sharedFirstDocument.documentId)).length, 1);
    } finally {
      releaseOperationCommit.resolve();
      await within(sharedFirstHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'share-first operation did not settle during cleanup');
      if (blockedStateHandled) await within(blockedStateHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'share-first state mutation did not settle during cleanup');
      if (blockedStateOpen) await blockedStateClient.query('ROLLBACK').catch(() => undefined);
      if (blockedStateConnected) await blockedStateClient.end();
    }

    // If operation creation owns the guard first, reserve waits; its generic request may then capture the visible operation.
    const operationFirstDocument = await seed('agent-operation-first', 'workspace-operation-first', 'operation-first.md');
    const operationInsertEntered = deferred();
    const releaseOperationInsert = deferred();
    const operationHooks: QueryHooks = { beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')) return;
      operationInsertEntered.resolve();
      await releaseOperationInsert.promise;
    } };
    const operationPromise = hookContext.run(operationHooks, () =>
      agent.createOrLoadAdmittedOperation(operationInput(operationFirstDocument, 'operation-first')));
    const operationHandled = operationPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    const reserveInsertEntered = deferred();
    const releaseReserveInsert = deferred();
    const reserveHooks: QueryHooks = { beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_ADMISSION_REQUESTS')) return;
      reserveInsertEntered.resolve();
      await releaseReserveInsert.promise;
    } };
    let reserveHandled: Promise<{ value: Awaited<ReturnType<typeof admission.reserve>> | undefined; error: unknown }> | undefined;
    try {
      await within(operationInsertEntered.promise, OPERATION_TIMEOUT_MS, 'operation did not reach INSERT');
      const operationFirstRequest = admissionRequest(operationFirstDocument);
      const reservePromise = hookContext.run(reserveHooks, () => admission.reserve(operationFirstRequest));
      reserveHandled = reservePromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!reserveHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), OPERATION_TIMEOUT_MS, 'reserve connection did not open');
      await waitForBlocked(controlPool, reserveHooks.backendPids![0]!, 'reservation behind operation creation');
      releaseOperationInsert.resolve();
      const operationFirst = await operationHandled;
      if (operationFirst.error) throw operationFirst.error;
      await within(reserveInsertEntered.promise, OPERATION_TIMEOUT_MS, 'reservation did not resume after operation commit');
      assert.equal((await readOperations(operationFirstDocument.documentId)).length, 1,
        'the admitted operation is durable and visible before generic reservation completion');
      releaseReserveInsert.resolve();
      const operationFirstReservation = await reserveHandled;
      if (operationFirstReservation.error) throw operationFirstReservation.error;
      assert.equal(operationFirstReservation.value?.status, 'reserved');
    } finally {
      releaseOperationInsert.resolve();
      releaseReserveInsert.resolve();
      await within(operationHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'operation-first creation did not settle during cleanup');
      if (reserveHandled) await within(reserveHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'operation-first reservation did not settle during cleanup');
    }

    // Reservation-first is the inverse ordering: new creation waits, then observes the durable reservation and refuses.
    const reserveFirstDocument = await seed('agent-reservation-first', 'workspace-reservation-first', 'reservation-first.md');
    const reserveTargetEntered = deferred();
    const releaseReserveTarget = deferred();
    const reserveFirstHooks: QueryHooks = { beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_ADMISSION_TARGETS')) return;
      reserveTargetEntered.resolve();
      await releaseReserveTarget.promise;
    } };
    const reserveFirstRequest = admissionRequest(reserveFirstDocument);
    const reserveFirstPromise = hookContext.run(reserveFirstHooks, () => admission.reserve(reserveFirstRequest));
    const reserveFirstHandled = reserveFirstPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    let blockedOperationHandled: Promise<{ value: { row: OperationRow; created: boolean } | undefined; error: unknown }> | undefined;
    try {
      await within(reserveTargetEntered.promise, OPERATION_TIMEOUT_MS, 'reservation did not reach target INSERT');
      const blockedOperationHooks: QueryHooks = {};
      const blockedOperationPromise = hookContext.run(blockedOperationHooks, () =>
        agent.createOrLoadAdmittedOperation(operationInput(reserveFirstDocument, 'reservation-first')));
      blockedOperationHandled = blockedOperationPromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!blockedOperationHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), OPERATION_TIMEOUT_MS, 'blocked operation connection did not open');
      await waitForBlocked(controlPool, blockedOperationHooks.backendPids![0]!, 'operation behind reservation');
      releaseReserveTarget.resolve();
      const reserveFirst = await reserveFirstHandled;
      if (reserveFirst.error) throw reserveFirst.error;
      admissionConflict((await blockedOperationHandled).error);
      assert.equal((await readOperations(reserveFirstDocument.documentId)).length, 0);
    } finally {
      releaseReserveTarget.resolve();
      await within(reserveFirstHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'reservation-first reservation did not settle during cleanup');
      if (blockedOperationHandled) await within(blockedOperationHandled.then(() => undefined), OPERATION_TIMEOUT_MS,
        'reservation-first operation did not settle during cleanup');
    }

    // A rejected COMMIT leaves no row; retry creates it exactly once.
    const rejectedDocument = await seed('agent-rejected-commit', 'workspace-rejected-commit', 'rejected.md');
    const rejectedHooks: QueryHooks = { commitFault: { ordinal: 1, position: 'before', remaining: 1 } };
    await assert.rejects(hookContext.run(rejectedHooks, () =>
      agent.createOrLoadAdmittedOperation(operationInput(rejectedDocument, 'rejected-commit'))),
    /Injected rejected agent-operation COMMIT/u);
    assert.equal((await readOperations(rejectedDocument.documentId)).length, 0);
    assert.equal(rejectedHooks.connections, 2, 'rejected COMMIT performs one discarded attempt and one read-only recovery');
    assert.equal((await agent.createOrLoadAdmittedOperation(operationInput(rejectedDocument, 'rejected-commit'))).created, true);

    // A lost successful COMMIT is proven from the exact operation ID without a second INSERT.
    const lostDocument = await seed('agent-lost-commit', 'workspace-lost-commit', 'lost.md');
    const lostHooks: QueryHooks = { commitFault: { ordinal: 1, position: 'after', remaining: 1 } };
    const lost = await hookContext.run(lostHooks, () =>
      agent.createOrLoadAdmittedOperation(operationInput(lostDocument, 'lost-commit')));
    assert.equal(lost.created, true);
    assert.equal(Number(lost.row.cas_version), 0);
    assert.equal(lostHooks.connections, 2);
    assert.equal(lostHooks.writes, 1, 'lost COMMIT recovery never replays the operation INSERT');
    assert.equal((await readOperations(lostDocument.documentId)).length, 1);

    // Failed discard suppresses fresh recovery, while the durable row remains available to an explicit retry.
    const discardDocument = await seed('agent-discard-failure', 'workspace-discard-failure', 'discard.md');
    const discardHooks: QueryHooks = { commitFault: { ordinal: 1, position: 'after', remaining: 1 },
      closeFault: { ordinal: 1, remaining: 1 } };
    await assert.rejects(hookContext.run(discardHooks, () =>
      agent.createOrLoadAdmittedOperation(operationInput(discardDocument, 'discard-failure'))), AggregateError);
    assert.equal(discardHooks.connections, 1, 'failed discard must not open a recovery connection');
    assert.equal((await readOperations(discardDocument.documentId)).length, 1);
    const discardRetry = await agent.createOrLoadAdmittedOperation(operationInput(discardDocument, 'discard-failure'));
    assert.equal(discardRetry.created, false);

    assert.equal(poolErrors.length, 0, 'agent-operation admission pools must not emit background errors');
    console.log('Collaboration agent-operation admission PostgreSQL: 10 bounded boundaries passed—active reservation rejection, '
      + 'cancellation liveness, existing retry, both state-row lock orders, both workspace-guard race orders, rejected/lost COMMIT, '
      + 'and failed-discard recovery—in one isolated generated schema.');
  } finally {
    if (runtimePool) {
      try {
        await within(runtimePool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining agent-operation runtime pool.');
        runtimePoolDrained = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated && (!runtimePool || runtimePoolDrained)) {
      try { await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining agent-operation control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Agent-operation admission cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration agent-operation admission PostgreSQL test skipped: guarded managed database is not configured.');
} else {
  run(databaseUrl).catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
