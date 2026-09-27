import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Client, Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import type { AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import {
  createCollaborationAdmissionService,
  lockCollaborationAdmissionWorkspace,
} from '../app/lib/collaboration/room-admission';
import {
  collaborationAdmissionActionDigest,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';
import { PROPOSAL_GRAPH_STORAGE_UP_SQL } from '../app/lib/db/proposal-graph-migration';
import type { ProposalDocumentScopeV1, ProposalNodeV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const SCHEMA_PREFIX = 'canvas_pga_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const sourceRoot = process.env.PROPOSAL_RUNTIME_SOURCE_ROOT ?? process.cwd();

type Gate = { promise: Promise<void>; resolve: () => void };
type QueryHooks = {
  connections?: number;
  backendPids?: number[];
  statements?: Array<{ sql: string; backendPid: number }>;
  transactionActive?: boolean;
  beforeQuery?: (sql: string, backendPid: number) => Promise<void>;
};
type BuildSource = { content: string; update: Uint8Array; representation: string; structure: unknown };
type Created = { node: ProposalNodeV1; proposal: ProposalToolCreationResultV1; reused: boolean };
type RuntimeService = { scope: ProposalDocumentScopeV1; service: {
  createIndependent(input: {
    scope: ProposalDocumentScopeV1;
    actorId: string;
    idempotencyKey: string;
    mutation: unknown;
    allowCreate: boolean;
    buildTargets(source: BuildSource): AgentTextTarget[] | Promise<AgentTextTarget[]>;
  }): Promise<Created | null>;
} };
type Runtime = {
  createRuntimeProposalAgentService(input: {
    workspace: WorkspaceContext;
    documentId: string;
    path: string;
    identity: { initiatedByUserId: string; actorId: string; actorSessionId?: string };
  }): Promise<RuntimeService>;
};
type AgentBridge = {
  prepareProposalAgentOperation(input: unknown): Promise<unknown>;
  createAgentTextTarget(input: {
    text: Y.Text;
    from: number;
    to: number;
    replacement: string;
    targetId: string;
    groupId: string;
  }): AgentTextTarget;
};
type Fixture = {
  document: CollaborationAdmissionDocument;
  scope: ProposalDocumentScopeV1;
  workspace: WorkspaceContext;
  path: string;
  original: string;
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
  catch { throw new Error('Proposal-agent admission PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Proposal-agent admission test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated proposal-agent namespace.');
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return {
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 2_000,
    allowExitOnIdle: true,
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
  const code = typeof value.code === 'string' && /^[A-Z0-9_]{1,48}$/u.test(value.code) ? ` [${value.code}]` : '';
  const message = typeof value.message === 'string' ? value.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

function compile<T>(relativePath: string, mocks: Record<string, unknown>, append = ''): T {
  const filename = path.resolve(sourceRoot, relativePath);
  const runtimeRequire = createRequire(filename);
  const output = ts.transpileModule(`${readFileSync(filename, 'utf8')}\n${append}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : runtimeRequire(name), loaded, loaded.exports,
  );
  return loaded.exports as T;
}

function createConnectionAdapter(pool: Pool, hooksContext: AsyncLocalStorage<QueryHooks>) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
    const hooks = hooksContext.getStore();
    if (hooks) {
      hooks.connections = (hooks.connections ?? 0) + 1;
      (hooks.backendPids ??= []).push(backendPid);
    }
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const normalized = normalizedSql(sql);
      hooks?.statements?.push({ sql: normalized, backendPid });
      await hooks?.beforeQuery?.(normalized, backendPid);
      const result = await client.query(sql, params);
      if (hooks && normalized === 'BEGIN') hooks.transactionActive = true;
      if (hooks && (normalized === 'COMMIT' || normalized === 'ROLLBACK')) hooks.transactionActive = false;
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: async (error) => {
        assert.equal(closed, false, 'proposal-agent SQL connection closed twice');
        closed = true;
        if (hooks) hooks.transactionActive = false;
        client.release(error);
      },
    };
  };
}

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ database_name: string; server_version_num: string; state_table: boolean }>(
    `SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS state_table`,
  );
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18 || !row.state_table) {
    throw new Error('Proposal-agent admission test refused a server outside managed PG18.');
  }
}

async function waitForBlocked(pool: Pool, backendPid: number, label: string): Promise<void> {
  await within((async () => {
    for (;;) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [backendPid]);
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  })(), TEST_TIMEOUT_MS, `${label} did not become blocked`);
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error && typeof error === 'object' && 'code' in error, String(error));
    assert.equal(error.code, expected);
    return true;
  };
}

function admissionRequest(document: CollaborationAdmissionDocument): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify({ version: 1, purpose: 'proposal-agent-admission-postgres-test' });
  return {
    requestId: randomUUID(),
    actorId: 'proposal-test-actor',
    action: 'compact',
    actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
    scopes: [{ workspaceId: document.workspaceId, organizationId: document.organizationId,
      path: document.path, kind: 'exact' }],
    expectedDocuments: [document],
  };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  const schemaSql = schemaIdentifier(schema);
  const adminPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-control'), max: 5 });
  let fixturePool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let admissionPool: Pool | undefined;
  let schemaCreated = false;
  const poolErrors: Error[] = [];
  const cleanupErrors: unknown[] = [];
  adminPool.on('error', (error) => { poolErrors.push(error); });
  try {
    await verifyManagedPostgres(adminPool);
    await adminPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    for (const table of ['user', 'file_collaboration_lineages', 'collaboration_documents', 'file_revisions',
      'collaboration_yjs_states', 'collaboration_agent_operations']) {
      await adminPool.query(`CREATE TABLE ${schemaSql}."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await adminPool.query(`CREATE TABLE ${schemaSql}.proposal_test_authorizations (
      workspace_id text PRIMARY KEY, active boolean NOT NULL
    )`);

    const migration = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-migration', schema) });
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
      await migration.query(PROPOSAL_GRAPH_STORAGE_UP_SQL);
    } finally { await migration.end(); }

    fixturePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-fixture', schema), max: 5 });
    runtimePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-runtime', schema), max: 2 });
    admissionPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-service', schema), max: 4 });
    for (const pool of [fixturePool, runtimePool, admissionPool]) pool.on('error', (error) => { poolErrors.push(error); });

    const runtimeHooks = new AsyncLocalStorage<QueryHooks>();
    const admissionHooks = new AsyncLocalStorage<QueryHooks>();
    const runtimeOpen = createConnectionAdapter(runtimePool, runtimeHooks);
    const admissionOpen = createConnectionAdapter(admissionPool, admissionHooks);
    const databaseModule = compile<{ createRuntimeFileVersionCenterDatabase(): FileVersionCenterDatabase }>(
      'app/lib/file-version-center/database.ts', { 'server-only': {}, '@/app/lib/db': { openDb: runtimeOpen } },
    );
    process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'proposal-agent-admission-postgres-test-secret';
    const forbidden = (name: string) => () => { throw new Error(`Unexpected ${name}`); };
    const bridge = compile<AgentBridge>('app/lib/collaboration/agent-operations.ts', {
      'server-only': {},
      '@/app/lib/db': { openDb: forbidden('nested openDb') },
      './persistence': {
        loadCollaborationState: forbidden('global collaboration state load'),
        loadCollaborationStateOnConnection,
      },
      './server-runtime': { Y },
      '@/app/lib/file-version-center/agent-review-policy-adapter': {
        authorizeNewAgentDirectApply: forbidden('direct apply authorization'),
        readAgentReviewPolicySnapshot: forbidden('review policy read'),
      },
      './direct-connection': {
        AgentDirectConnectionAuthorizationError: class extends Error {},
        runCollaborationDirectConnection: forbidden('direct connection'),
      },
      './agent-direct-edit-grants': {
        AgentDirectEditGrantUnavailableError: class extends Error {},
        withAgentDirectEditGrant: forbidden('direct edit grant'),
      },
      './document-access': { readCurrentCollaborationDocument: forbidden('operation live apply') },
      '@/app/lib/file-version-center/history-service': {
        fileVersionHistoryService: { capturePersistedCollaboration: forbidden('history capture') },
      },
      './presence': { upsertDocumentPresenceEntry: forbidden('presence write'),
        removeDocumentPresenceEntry: forbidden('presence delete') },
      './diagnostics': { logCollaborationDiagnostic() {} },
      '@/app/lib/audit/audit-service': { recordAuditEvent: forbidden('audit write') },
    });

    const fixtureReader: SqlConnection = {
      get: async (sql, params = []) => {
        assert.notEqual(runtimeHooks.getStore()?.transactionActive, true,
          'global fixture reader cannot borrow while its runtime operation owns a transaction');
        return (await fixturePool!.query(sql, params)).rows[0];
      },
      all: async (sql, params = []) => {
        assert.notEqual(runtimeHooks.getStore()?.transactionActive, true,
          'global fixture reader cannot borrow while its runtime operation owns a transaction');
        return (await fixturePool!.query(sql, params)).rows;
      },
      run: async (sql, params = []) => {
        assert.notEqual(runtimeHooks.getStore()?.transactionActive, true,
          'global fixture reader cannot borrow while its runtime operation owns a transaction');
        return { changes: (await fixturePool!.query(sql, params)).rowCount ?? 0 };
      },
      close: async () => {},
    };
    const workspaces = new Map<string, WorkspaceContext>();
    const sessionWorkspaces = new Map<string, string>();
    const identity = { initiatedByUserId: 'proposal-owner', actorId: 'main' };
    const readAuthorizedWorkspace = async (reader: SqlConnection, workspaceId: string): Promise<WorkspaceContext> => {
      const row = await reader.get('SELECT active FROM proposal_test_authorizations WHERE workspace_id=$1',
        [workspaceId]) as { active: boolean } | undefined;
      const workspace = workspaces.get(workspaceId);
      if (!row?.active || !workspace) throw new Error('Session revoked');
      return structuredClone(workspace);
    };
    const runtime = compile<Runtime>('app/lib/file-version-center/proposal-agent-runtime.ts', {
      'server-only': {},
      './database': databaseModule,
      '../workspaces/context': { resolveWorkspaceActor: (actor: unknown) => actor },
      '../workspaces/postgres-runtime': {
        findPostgresUserById: async (reader: SqlConnection, userId: string) => {
          assert.equal(userId, identity.initiatedByUserId);
          await readAuthorizedWorkspace(reader, [...workspaces.keys()][0]!);
          return { id: userId, email: 'proposal-owner@test.invalid', role: 'member' };
        },
        readPostgresWorkspaceForActorOnConnection: async (reader: SqlConnection, _actor: unknown, workspaceId: string) =>
          readAuthorizedWorkspace(reader, workspaceId),
        readPostgresWorkspaceForActor: async (_actor: unknown, workspaceId: string) =>
          readAuthorizedWorkspace(fixtureReader, workspaceId),
      },
      '../pi/session-workspace-context': {
        resolveAgentExecutionContextForStoredSession: async (input: { sessionId: string }) => {
          const workspaceId = sessionWorkspaces.get(input.sessionId);
          assert.ok(workspaceId, 'stored test session is bound to one workspace');
          return { workspace: await readAuthorizedWorkspace(fixtureReader, workspaceId) };
        },
        readStoredAgentWorkspaceOnConnection: async (reader: SqlConnection, input: { sessionId: string; workspaceId: string }) => {
          assert.equal(sessionWorkspaces.get(input.sessionId), input.workspaceId);
          return readAuthorizedWorkspace(reader, input.workspaceId);
        },
        workspaceFromAgentExecutionContext: (context: { workspace: WorkspaceContext }) => context.workspace,
      },
      '../collaboration/persistence': {
        loadCollaborationState: (documentId: string) => loadCollaborationStateOnConnection(fixtureReader, documentId),
        loadCollaborationStateOnConnection,
      },
      '../collaboration/document-access': {
        readCurrentCollaborationDocument: async (input: {
          documentId: string;
          workspaceId: string;
          loadState?: (documentId: string) => Promise<Awaited<ReturnType<typeof loadCollaborationStateOnConnection>>>;
          read(document: Y.Doc): unknown;
        }) => {
          assert.ok(input.loadState, 'graph owner must supply the same-connection state loader');
          const state = await input.loadState!(input.documentId);
          assert.ok(state && state.workspaceId === input.workspaceId);
          const doc = new Y.Doc({ gc: false });
          try { Y.applyUpdate(doc, state.yjsState); return input.read(doc); }
          finally { doc.destroy(); }
        },
      },
      '../collaboration/room-admission': await import('../app/lib/collaboration/room-admission'),
      '../collaboration/agent-operations': bridge,
      '../collaboration/server-runtime': { Y },
      './proposal-review-capability': { proposalReviewWritesEnabled: () => true },
      './policy-v1': { resolveFileVersionRolloutV1: () => ({ restore: true }) },
    });
    const admission = createCollaborationAdmissionService({ openConnection: admissionOpen });

    const seed = async (label: string): Promise<Fixture> => {
      const documentId = `proposal-document-${label}`;
      const workspaceId = `proposal-workspace-${label}`;
      const lineageId = `proposal-lineage-${label}`;
      const filePath = `${label}.md`;
      const organizationId = `proposal-organization-${label}`;
      const original = `Original ${label}`;
      const doc = new Y.Doc({ gc: false });
      doc.getText('content').insert(0, original);
      const update = Buffer.from(Y.encodeStateAsUpdate(doc));
      const vector = Buffer.from(Y.encodeStateVector(doc));
      doc.destroy();
      await fixturePool!.query(`INSERT INTO file_collaboration_lineages
        (id,workspace_id,workspace_type,path,status,created_at) VALUES ($1,$2,'personal',$3,'active',$4)`,
      [lineageId, workspaceId, filePath, Date.now()]);
      await fixturePool!.query(`INSERT INTO collaboration_documents
        (id,workspace_id,workspace_type,path,lineage_id,provider,state_version,status,created_at,updated_at)
        VALUES ($1,$2,'personal',$3,$4,'yjs',0,'active',$5,$5)`,
      [documentId, workspaceId, filePath, lineageId, Date.now()]);
      await fixturePool!.query(`INSERT INTO collaboration_yjs_states (
        document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
        canonical_hash,serialized_hash,newline_style,has_bom,degraded,status
      ) VALUES ($1,$2,$3,$4,'plain_text',1,1,$5,$6,1,$7,$7,1,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, organizationId, filePath, update, vector, Date.now()]);
      await fixturePool!.query('INSERT INTO proposal_test_authorizations (workspace_id,active) VALUES ($1,true)', [workspaceId]);
      const workspace: WorkspaceContext = {
        workspaceId, workspaceType: 'personal', organizationId, rootPath: `/test-only/${workspaceId}`, legacy: false,
        permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false,
          canCreatePublicLinks: false, canManageWorkspace: false },
      };
      workspaces.set(workspaceId, workspace);
      return {
        document: { documentId, workspaceId, organizationId, path: filePath, representation: 'plain_text',
          lifecycleGeneration: 1, schemaVersion: 1, status: 'active' },
        scope: { workspaceId, lineageId, documentId, lifecycleGeneration: 1, schemaVersion: 1 },
        workspace, path: filePath, original,
      };
    };
    const factory = async (fixture: Fixture) => {
      const actorSessionId = `session-${fixture.workspace.workspaceId}`;
      sessionWorkspaces.set(actorSessionId, fixture.workspace.workspaceId);
      return runtime.createRuntimeProposalAgentService({
        workspace: fixture.workspace, documentId: fixture.document.documentId, path: fixture.path,
        identity: { ...identity, actorSessionId },
      });
    };
    const create = async (service: RuntimeService['service'], fixture: Fixture, key: string): Promise<Created> => {
      const value = await service.createIndependent({
        scope: fixture.scope, actorId: identity.actorId, idempotencyKey: key, allowCreate: true,
        mutation: { replacement: `${fixture.original} changed by ${key}` },
        buildTargets: (source) => {
          assert.equal(source.content, fixture.original);
          const doc = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(doc, source.update);
            return [bridge.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: source.content.length,
              replacement: `${fixture.original} changed by ${key}`, targetId: `target-${key}`, groupId: 'proposal-test' })];
          } finally { doc.destroy(); }
        },
      });
      assert.ok(value);
      return value;
    };
    const counts = async (documentId: string) => {
      const result: Record<string, number> = {};
      for (const table of ['collaboration_agent_operations', 'file_proposal_graphs', 'file_change_proposals',
        'file_proposal_artifacts', 'file_proposal_evaluations', 'file_proposal_artifact_pins']) {
        const where = table === 'collaboration_agent_operations' || table === 'file_proposal_graphs'
          ? ' WHERE document_id=$1' : table === 'file_change_proposals'
            ? ' WHERE document_id=$1' : '';
        const row = (await fixturePool!.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM ${table}${where}`, where ? [documentId] : [])).rows[0];
        result[table] = Number(row?.count ?? 0);
      }
      return result;
    };

    let groups = 0;
    const passed = (name: string) => { groups++; console.log(`✓ ${name}`); };

    const capacityFixture = await seed('capacity');
    const capacityRuntime = await factory(capacityFixture);
    const capacityHooks: QueryHooks[] = Array.from({ length: 3 }, () => ({ statements: [] }));
    const capacity = await Promise.all(capacityHooks.map((hooks, index) => runtimeHooks.run(hooks, () =>
      create(capacityRuntime.service, capacityFixture, `capacity-operation-${index}-key`))));
    assert.equal(new Set(capacity.map((entry) => entry.node.operationId)).size, 3);
    for (const hooks of capacityHooks) {
      assert.equal(hooks.connections, 1, 'each graph operation owns one pool lease');
      assert.equal(new Set(hooks.statements!.map((entry) => entry.backendPid)).size, 1,
        'authorization, state, graph and operation SQL share one backend');
      assert.ok(hooks.statements!.some((entry) => entry.sql.includes('FROM PROPOSAL_TEST_AUTHORIZATIONS')));
      assert.ok(hooks.statements!.some((entry) => entry.sql.includes('FROM COLLABORATION_YJS_STATES')));
      assert.ok(hooks.statements!.some((entry) => entry.sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')));
    }
    assert.ok(runtimePool.totalCount <= 2);
    assert.equal(runtimePool.waitingCount, 0);
    passed('three graph operations complete through a two-client pool with one backend per operation');

    const reservationFirstFixture = await seed('reservation-first');
    const reservationFirstRuntime = await factory(reservationFirstFixture);
    await admission.reserve(admissionRequest(reservationFirstFixture.document));
    await assert.rejects(create(reservationFirstRuntime.service, reservationFirstFixture,
      'reservation-first-operation-key'), code('ADMISSION_CONFLICT'));
    assert.equal((await counts(reservationFirstFixture.document.documentId)).collaboration_agent_operations, 0);
    assert.equal((await counts(reservationFirstFixture.document.documentId)).file_proposal_graphs, 0);
    passed('reservation-first rejects the new graph operation and rolls back graph metadata');

    const graphFirstFixture = await seed('graph-first');
    const graphFirstRuntime = await factory(graphFirstFixture);
    const graphInsertEntered = deferred();
    const releaseGraphInsert = deferred();
    const graphHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')) return;
      graphInsertEntered.resolve();
      await releaseGraphInsert.promise;
    } };
    const graphPromise = runtimeHooks.run(graphHooks, () =>
      create(graphFirstRuntime.service, graphFirstFixture, 'graph-first-operation-key'));
    const graphHandled = graphPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    let graphCreated: Created | undefined;
    const reserveTargetEntered = deferred();
    const releaseReserveTarget = deferred();
    const reserveHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_ADMISSION_TARGETS')) return;
      reserveTargetEntered.resolve();
      await releaseReserveTarget.promise;
    } };
    let reserveHandled: Promise<{ value: unknown; error: unknown }> | undefined;
    try {
      await within(graphInsertEntered.promise, TEST_TIMEOUT_MS, 'graph-first operation did not reach INSERT');
      const reservePromise = admissionHooks.run(reserveHooks, () => admission.reserve(admissionRequest(graphFirstFixture.document)));
      reserveHandled = reservePromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!reserveHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), TEST_TIMEOUT_MS, 'graph-first reservation did not open a backend');
      await waitForBlocked(adminPool, reserveHooks.backendPids![0]!, 'reservation behind graph operation');
      releaseGraphInsert.resolve();
      const graphResult = await graphHandled;
      if (graphResult.error) throw graphResult.error;
      graphCreated = graphResult.value;
      await within(reserveTargetEntered.promise, TEST_TIMEOUT_MS, 'reservation did not resume after graph commit');
      assert.equal((await counts(graphFirstFixture.document.documentId)).collaboration_agent_operations, 1,
        'operation is committed and visible before reservation completes');
      releaseReserveTarget.resolve();
      const reserveResult = await reserveHandled;
      if (reserveResult.error) throw reserveResult.error;
    } finally {
      releaseGraphInsert.resolve();
      releaseReserveTarget.resolve();
      await within(graphHandled.then(() => undefined), TEST_TIMEOUT_MS, 'graph-first operation did not settle');
      if (reserveHandled) await within(reserveHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'graph-first reservation did not settle');
    }
    assert.ok(graphCreated);
    const beforeGraphRetry = await counts(graphFirstFixture.document.documentId);
    const graphRetry = await graphFirstRuntime.service.createIndependent({
      scope: graphFirstFixture.scope, actorId: identity.actorId,
      idempotencyKey: 'graph-first-operation-key', allowCreate: true,
      mutation: { replacement: `${graphFirstFixture.original} changed by graph-first-operation-key` },
      buildTargets: () => { throw new Error('Exact retry must not rebuild a current candidate.'); },
    });
    assert.ok(graphRetry?.reused);
    assert.equal(graphRetry.node.operationId, graphCreated.node.operationId);
    assert.deepEqual(await counts(graphFirstFixture.document.documentId), beforeGraphRetry,
      'exact retry under the active reservation adds no operation, graph or artifact rows');
    passed('graph-first commit serializes reservation and makes the operation visible before reserve completion');

    const revokedFixture = await seed('revoked');
    const revokedRuntime = await factory(revokedFixture);
    const admissionGuard = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-revocation', schema) });
    await admissionGuard.connect();
    let admissionGuardOpen = false;
    let revokedHandled: Promise<{ value: Created | undefined; error: unknown }> | undefined;
    try {
      await admissionGuard.query('BEGIN');
      admissionGuardOpen = true;
      await lockCollaborationAdmissionWorkspace(async (sql, values) => (await admissionGuard.query(sql, values)).rows,
        revokedFixture.workspace.workspaceId);
      const revokedHooks: QueryHooks = { statements: [] };
      const revokedPromise = runtimeHooks.run(revokedHooks, () =>
        create(revokedRuntime.service, revokedFixture, 'revoked-after-wait-operation-key'));
      revokedHandled = revokedPromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!revokedHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), TEST_TIMEOUT_MS, 'revocation operation did not open a backend');
      await waitForBlocked(adminPool, revokedHooks.backendPids![0]!, 'operation behind external admission guard');
      await fixturePool.query('UPDATE proposal_test_authorizations SET active=false WHERE workspace_id=$1',
        [revokedFixture.workspace.workspaceId]);
      await admissionGuard.query('COMMIT');
      admissionGuardOpen = false;
      const revoked = await revokedHandled;
      assert.equal(revoked.value, undefined);
      code('PROPOSAL_ACCESS_DENIED')(revoked.error);
      assert.equal((await counts(revokedFixture.document.documentId)).collaboration_agent_operations, 0);
      assert.equal((await counts(revokedFixture.document.documentId)).file_proposal_graphs, 0);
    } finally {
      if (admissionGuardOpen) await admissionGuard.query('ROLLBACK').catch(() => undefined);
      await admissionGuard.end();
      if (revokedHandled) await within(revokedHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'revoked operation did not settle');
    }
    passed('authorization revoked during guard wait is observed before graph or operation writes');

    const lifecycleFirstFixture = await seed('lifecycle-first');
    const lifecycleFirstRuntime = await factory(lifecycleFirstFixture);
    const lifecycleRequest = admissionRequest(lifecycleFirstFixture.document);
    await admission.reserve(lifecycleRequest);
    const lifecycleClient = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-lifecycle', schema) });
    await lifecycleClient.connect();
    let lifecycleOpen = false;
    let lifecycleHandled: Promise<{ value: Created | undefined; error: unknown }> | undefined;
    try {
      await lifecycleClient.query('BEGIN');
      lifecycleOpen = true;
      const lifecyclePid = (await lifecycleClient.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
      await lifecycleClient.query('SELECT document_id FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',
        [lifecycleFirstFixture.document.documentId]);
      const lifecycleHooks: QueryHooks = { statements: [] };
      const lifecyclePromise = runtimeHooks.run(lifecycleHooks, () =>
        create(lifecycleFirstRuntime.service, lifecycleFirstFixture, 'lifecycle-first-operation-key'));
      lifecycleHandled = lifecyclePromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!lifecycleHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), TEST_TIMEOUT_MS, 'lifecycle-first operation did not open a backend');
      await waitForBlocked(adminPool, lifecycleHooks.backendPids![0]!, 'graph operation behind lifecycle state lock');
      const blockers = await adminPool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers',
        [lifecycleHooks.backendPids![0]!]);
      assert.deepEqual(blockers.rows[0]?.blockers, [lifecyclePid]);
      await lifecycleClient.query(`UPDATE collaboration_yjs_states
        SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1`, [lifecycleFirstFixture.document.documentId]);
      await lifecycleClient.query(`UPDATE collaboration_admission_targets
        SET active=false,status='completed' WHERE request_id=$1`, [lifecycleRequest.requestId]);
      await lifecycleClient.query(`UPDATE collaboration_admission_requests
        SET status='committed',revision=revision+1,completed_at=$2,outcome_text='{}' WHERE request_id=$1`,
      [lifecycleRequest.requestId, Date.now()]);
      await lifecycleClient.query('COMMIT');
      lifecycleOpen = false;
      const lifecycleResult = await lifecycleHandled;
      assert.equal(lifecycleResult.value, undefined);
      code('PROPOSAL_STALE_LIFECYCLE')(lifecycleResult.error);
      assert.equal((await counts(lifecycleFirstFixture.document.documentId)).collaboration_agent_operations, 0);
      assert.equal((await counts(lifecycleFirstFixture.document.documentId)).file_proposal_graphs, 0);
    } finally {
      if (lifecycleOpen) await lifecycleClient.query('ROLLBACK').catch(() => undefined);
      await lifecycleClient.end();
      if (lifecycleHandled) await within(lifecycleHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'lifecycle-first operation did not settle');
    }
    passed('lifecycle-first state handoff makes the waiting graph operation reject its stale generation');

    const stateFenceFixture = await seed('state-fence');
    const stateFenceRuntime = await factory(stateFenceFixture);
    const commitEntered = deferred();
    const releaseCommit = deferred();
    const stateFenceHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (sql !== 'COMMIT') return;
      commitEntered.resolve();
      await releaseCommit.promise;
    } };
    const stateFencePromise = runtimeHooks.run(stateFenceHooks, () =>
      create(stateFenceRuntime.service, stateFenceFixture, 'state-fence-operation-key'));
    const stateFenceHandled = stateFencePromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    const stateWriter = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-agent-admission-state-writer', schema) });
    let stateWriterConnected = false;
    let stateWriterOpen = false;
    let stateWriterHandled: Promise<{ error: unknown }> | undefined;
    try {
      await within(commitEntered.promise, TEST_TIMEOUT_MS, 'state-fence operation did not reach COMMIT');
      await stateWriter.connect();
      stateWriterConnected = true;
      await stateWriter.query('BEGIN');
      stateWriterOpen = true;
      const writerPid = (await stateWriter.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
      const update = stateWriter.query(`UPDATE collaboration_yjs_states
        SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1`, [stateFenceFixture.document.documentId]);
      stateWriterHandled = update.then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }));
      await waitForBlocked(adminPool, writerPid, 'lifecycle writer behind graph state fence');
      assert.deepEqual((await adminPool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers',
        [writerPid])).rows[0]?.blockers, [stateFenceHooks.backendPids![0]!]);
      releaseCommit.resolve();
      const stateFence = await stateFenceHandled;
      if (stateFence.error) throw stateFence.error;
      const writer = await stateWriterHandled;
      if (writer.error) throw writer.error;
      await stateWriter.query('ROLLBACK');
      stateWriterOpen = false;
      assert.equal((await counts(stateFenceFixture.document.documentId)).collaboration_agent_operations, 1);
    } finally {
      releaseCommit.resolve();
      await within(stateFenceHandled.then(() => undefined), TEST_TIMEOUT_MS, 'state-fence operation did not settle');
      if (stateWriterHandled) await within(stateWriterHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'state-fence writer did not settle');
      if (stateWriterOpen) await stateWriter.query('ROLLBACK').catch(() => undefined);
      if (stateWriterConnected) await stateWriter.end();
    }
    passed('graph-first operation retains the State row through atomic operation and proposal commit');

    const rollbackFixture = await seed('rollback');
    const rollbackRuntime = await factory(rollbackFixture);
    const beforeRollback = await counts(rollbackFixture.document.documentId);
    const rollbackHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (sql.startsWith('INSERT INTO FILE_CHANGE_PROPOSALS')) throw new Error('Injected proposal insertion failure');
    } };
    await assert.rejects(runtimeHooks.run(rollbackHooks, () =>
      create(rollbackRuntime.service, rollbackFixture, 'rollback-operation-key')), /Injected proposal insertion failure/u);
    assert.ok(rollbackHooks.statements!.some((entry) => entry.sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')),
      'real operation INSERT must precede the injected graph failure');
    const rollbackCounts = await counts(rollbackFixture.document.documentId);
    assert.deepEqual(rollbackCounts, beforeRollback,
      'operation, graph, proposal, artifact, evaluation and pin rows roll back together');
    passed('failure after operation preparation rolls back operation, graph and artifacts together');

    assert.equal(poolErrors.length, 0, 'dedicated proposal-agent pools must not emit background errors');
    console.log(`Proposal-agent admission PostgreSQL: ${groups} groups passed; schema ${schema}.`);
  } finally {
    for (const pool of [runtimePool, admissionPool, fixturePool]) {
      if (!pool) continue;
      try { await within(pool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing a proposal-agent pool.'); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated) {
      try {
        assertGeneratedSchema(schema);
        await adminPool.query(`DROP SCHEMA ${schemaSql} CASCADE`);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await within(adminPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing proposal-agent control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Proposal-agent admission cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('proposal-agent-admission-postgres-test: skipped (managed PostgreSQL environment is not configured)');
} else {
  void within(run(databaseUrl), 180_000, 'Proposal-agent admission PostgreSQL test timed out')
    .catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
