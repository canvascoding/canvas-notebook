import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Client, Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import type { AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import { loadCollaborationStateOnConnection } from '../app/lib/collaboration/persistence';
import { createCollaborationAdmissionService, lockCollaborationAdmissionWorkspace } from '../app/lib/collaboration/room-admission';
import { collaborationAdmissionActionDigest, type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { PROPOSAL_GRAPH_STORAGE_UP_SQL } from '../app/lib/db/proposal-graph-migration';
import type { ProposalActionReceiptV1, ProposalDocumentScopeV1, ProposalNodeV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { hashProposalEvaluationSelectionV1 } from '../app/lib/file-version-center/proposal-action-fence';
import { proposalYjsCurrentProof } from '../app/lib/file-version-center/proposal-yjs-candidate';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const SCHEMA_PREFIX = 'canvas_pra_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const sourceRoot = process.env.PROPOSAL_RUNTIME_SOURCE_ROOT ?? process.cwd();

type Gate = { promise: Promise<void>; resolve: () => void };
type QueryHooks = {
  connections?: number;
  openConnections?: number;
  maxOpenConnections?: number;
  backendPids?: number[];
  statements?: Array<{ sql: string; backendPid: number }>;
  transactionActive?: boolean;
  beforeQuery?: (sql: string, backendPid: number) => Promise<void>;
};
type BuildSource = { content: string; update: Uint8Array; representation: string; structure: unknown };
type Created = { node: ProposalNodeV1; proposal: { proposalId: string }; reused: boolean };
type ProposalRead = { metadata: { source: { kind: string; evaluationId?: string; current: ReturnType<typeof proposalYjsCurrentProof> };
  graphRevision: number }; content: string };
type AgentRuntimeService = { scope: ProposalDocumentScopeV1; service: {
  createIndependent(input: { scope: ProposalDocumentScopeV1; actorId: string; idempotencyKey: string;
    mutation: unknown; allowCreate: boolean;
    buildTargets(source: BuildSource): AgentTextTarget[] | Promise<AgentTextTarget[]> }): Promise<Created | null>;
  readExact(input: { scope: ProposalDocumentScopeV1; proposalId: string | null }): Promise<ProposalRead>;
} };
type AgentRuntime = { createRuntimeProposalAgentService(input: { workspace: WorkspaceContext; documentId: string;
  path: string; identity: { initiatedByUserId: string; actorId: string; actorSessionId?: string } }): Promise<AgentRuntimeService> };
type AgentBridge = { prepareProposalAgentOperation(input: unknown): Promise<unknown>;
  prepareProposalGraphActionOperation(input: unknown): Promise<void>;
  createAgentTextTarget(input: { text: Y.Text; from: number; to: number; replacement: string;
    targetId: string; groupId: string }): AgentTextTarget };
type ReviewService = {
  scope: ProposalDocumentScopeV1;
  prepare(input: { selectedProposalIds: readonly string[]; actionType: 'accept'; binding: {
    evaluationId: string; selectedProposalIds: readonly string[]; selectionHash: string; graphRevision: number;
    current: ReturnType<typeof proposalYjsCurrentProof> } }): Promise<{ fence: Record<string, unknown>; fenceToken: string }>;
  execute(input: unknown): Promise<ProposalActionReceiptV1>;
};
type ReviewRuntime = { createRuntimeProposalReviewActionService(input: {
  target: ResolvedFileVersionTarget; workspace: WorkspaceContext; access: FileVersionCenterAccess;
  reviewerSessionId: string; dependencies: Record<string, unknown>;
}): Promise<ReviewService> };
type Fixture = { document: CollaborationAdmissionDocument; scope: ProposalDocumentScopeV1;
  workspace: WorkspaceContext; target: ResolvedFileVersionTarget; access: FileVersionCenterAccess;
  path: string; original: string };
type PreparedAction = { service: ReviewService; action: Record<string, unknown>; proposalId: string;
  durableFailure: () => string | null };

function deferred(): Gate {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function normalizedSql(sql: string): string { return sql.replace(/\s+/gu, ' ').trim().toUpperCase(); }

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Proposal review admission PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Proposal review admission test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated proposal review namespace.');
}

function schemaIdentifier(schema: string): string { assertGeneratedSchema(schema); return `"${schema}"`; }

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return { connectionString: databaseUrl.toString(), application_name: applicationName,
    connectionTimeoutMillis: 3_000, idleTimeoutMillis: 2_000, allowExitOnIdle: true,
    options: [searchPath ? `-c search_path=${searchPath}` : '', `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`].filter(Boolean).join(' ') };
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
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
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
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : runtimeRequire(name),
    compiledModule, compiledModule.exports,
  );
  return compiledModule.exports as T;
}

function createConnectionAdapter(pool: Pool, hooksContext: AsyncLocalStorage<QueryHooks>) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
    const hooks = hooksContext.getStore();
    if (hooks) {
      hooks.connections = (hooks.connections ?? 0) + 1;
      hooks.openConnections = (hooks.openConnections ?? 0) + 1;
      hooks.maxOpenConnections = Math.max(hooks.maxOpenConnections ?? 0, hooks.openConnections);
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
        assert.equal(closed, false, 'proposal review SQL connection closed twice');
        closed = true;
        if (hooks) {
          hooks.transactionActive = false;
          hooks.openConnections = (hooks.openConnections ?? 1) - 1;
        }
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
    throw new Error('Proposal review admission test refused a server outside managed PG18.');
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
  const actionPayloadText = JSON.stringify({ version: 1, purpose: 'proposal-review-action-admission-postgres-test' });
  return { requestId: randomUUID(), actorId: 'proposal-review-actor', action: 'compact', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
    scopes: [{ workspaceId: document.workspaceId, organizationId: document.organizationId,
      path: document.path, kind: 'exact' }], expectedDocuments: [document] };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  const schemaSql = schemaIdentifier(schema);
  const adminPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-control'), max: 5 });
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

    const migration = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-migration', schema) });
    await migration.connect();
    try {
      await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
      await migration.query(PROPOSAL_GRAPH_STORAGE_UP_SQL);
    } finally { await migration.end(); }

    fixturePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-fixture', schema), max: 5 });
    runtimePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-runtime', schema), max: 2 });
    admissionPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-service', schema), max: 4 });
    for (const pool of [fixturePool, runtimePool, admissionPool]) pool.on('error', (error) => { poolErrors.push(error); });

    const runtimeHooks = new AsyncLocalStorage<QueryHooks>();
    const admissionHooks = new AsyncLocalStorage<QueryHooks>();
    const runtimeOpen = createConnectionAdapter(runtimePool, runtimeHooks);
    const admissionOpen = createConnectionAdapter(admissionPool, admissionHooks);
    const databaseModule = compile<{ createRuntimeFileVersionCenterDatabase(): FileVersionCenterDatabase;
      createFileVersionCenterTransactionReader: unknown }>('app/lib/file-version-center/database.ts', {
      'server-only': {}, '@/app/lib/db': { openDb: runtimeOpen },
    });
    process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'proposal-review-admission-postgres-secret';
    const forbidden = (name: string) => () => { throw new Error(`Unexpected ${name}`); };
    const bridge = compile<AgentBridge>('app/lib/collaboration/agent-operations.ts', {
      'server-only': {},
      '@/app/lib/db': { openDb: forbidden('nested openDb') },
      './persistence': { loadCollaborationState: forbidden('global collaboration state load'),
        loadCollaborationStateOnConnection },
      './server-runtime': { Y },
      '@/app/lib/file-version-center/agent-review-policy-adapter': {
        authorizeNewAgentDirectApply: forbidden('direct apply authorization'),
        readAgentReviewPolicySnapshot: forbidden('review policy read'),
      },
      './direct-connection': { AgentDirectConnectionAuthorizationError: class extends Error {},
        runCollaborationDirectConnection: forbidden('direct connection') },
      './agent-direct-edit-grants': { AgentDirectEditGrantUnavailableError: class extends Error {},
        withAgentDirectEditGrant: forbidden('direct edit grant') },
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
          'global fixture reader cannot borrow while a review action owns a transaction');
        return (await fixturePool!.query(sql, params)).rows[0];
      },
      all: async (sql, params = []) => {
        assert.notEqual(runtimeHooks.getStore()?.transactionActive, true,
          'global fixture reader cannot borrow while a review action owns a transaction');
        return (await fixturePool!.query(sql, params)).rows;
      },
      run: async (sql, params = []) => {
        assert.notEqual(runtimeHooks.getStore()?.transactionActive, true,
          'global fixture reader cannot borrow while a review action owns a transaction');
        return { changes: (await fixturePool!.query(sql, params)).rowCount ?? 0 };
      },
      close: async () => {},
    };
    const workspaces = new Map<string, WorkspaceContext>();
    const sessionWorkspaces = new Map<string, string>();
    const readAuthorizedWorkspace = async (reader: SqlConnection, workspaceId: string): Promise<WorkspaceContext> => {
      const row = await reader.get('SELECT active FROM proposal_test_authorizations WHERE workspace_id=$1',
        [workspaceId]) as { active: boolean } | undefined;
      const workspace = workspaces.get(workspaceId);
      if (!row?.active || !workspace) throw Object.assign(new Error('Workspace write access changed.'),
        { code: 'PROPOSAL_ACCESS_DENIED' });
      return structuredClone(workspace);
    };
    const readCurrentCollaborationDocument = async (input: {
      documentId: string; workspaceId: string;
      loadState?: (documentId: string) => Promise<Awaited<ReturnType<typeof loadCollaborationStateOnConnection>>>;
      read(document: Y.Doc): unknown;
    }) => {
      assert.ok(input.loadState, 'review graph must supply the same-connection state loader');
      const state = await input.loadState!(input.documentId);
      assert.ok(state && state.workspaceId === input.workspaceId);
      const doc = new Y.Doc({ gc: false });
      try { Y.applyUpdate(doc, state.yjsState); return input.read(doc); }
      finally { doc.destroy(); }
    };
    const agentIdentity = { initiatedByUserId: 'reviewer', actorId: 'main' };
    const agentRuntime = compile<AgentRuntime>('app/lib/file-version-center/proposal-agent-runtime.ts', {
      'server-only': {}, './database': databaseModule,
      '../workspaces/context': { resolveWorkspaceActor: (actor: unknown) => actor },
      '../workspaces/postgres-runtime': {
        findPostgresUserById: async (reader: SqlConnection, userId: string) => ({ id: userId,
          email: 'proposal-owner@test.invalid', role: (await readAuthorizedWorkspace(reader,
            sessionWorkspaces.values().next().value as string)).actor?.role ?? 'member' }),
        readPostgresWorkspaceForActorOnConnection: async (reader: SqlConnection, _actor: unknown, workspaceId: string) =>
          readAuthorizedWorkspace(reader, workspaceId),
        readPostgresWorkspaceForActor: async (_actor: unknown, workspaceId: string) =>
          readAuthorizedWorkspace(fixtureReader, workspaceId),
      },
      '../pi/session-workspace-context': {
        resolveAgentExecutionContextForStoredSession: async (input: { sessionId: string }) => {
          const workspaceId = sessionWorkspaces.get(input.sessionId);
          assert.ok(workspaceId);
          return { workspace: await readAuthorizedWorkspace(fixtureReader, workspaceId) };
        },
        readStoredAgentWorkspaceOnConnection: async (reader: SqlConnection,
          input: { sessionId: string; workspaceId: string }) => {
          assert.equal(sessionWorkspaces.get(input.sessionId), input.workspaceId);
          return readAuthorizedWorkspace(reader, input.workspaceId);
        },
        workspaceFromAgentExecutionContext: (context: { workspace: WorkspaceContext }) => context.workspace,
      },
      '../collaboration/persistence': { loadCollaborationState: (documentId: string) =>
        loadCollaborationStateOnConnection(fixtureReader, documentId), loadCollaborationStateOnConnection },
      '../collaboration/document-access': { readCurrentCollaborationDocument },
      '../collaboration/room-admission': await import('../app/lib/collaboration/room-admission'),
      '../collaboration/agent-operations': bridge, '../collaboration/server-runtime': { Y },
      './proposal-review-capability': { proposalReviewWritesEnabled: () => true },
      './policy-v1': { resolveFileVersionRolloutV1: () => ({ restore: true }) },
    });
    const reviewRuntime = compile<ReviewRuntime>('app/lib/file-version-center/proposal-review-action-runtime.ts', {
      'server-only': {}, './database': databaseModule,
      '../collaboration/agent-operations': bridge,
      '../collaboration/persistence': { loadCollaborationState: (documentId: string) =>
        loadCollaborationStateOnConnection(fixtureReader, documentId), loadCollaborationStateOnConnection },
      '../collaboration/document-access': { readCurrentCollaborationDocument },
      '../collaboration/room-admission': await import('../app/lib/collaboration/room-admission'),
      '../collaboration/server-runtime': { Y },
      '../workspaces/context': { resolveWorkspaceActor: (actor: unknown) => actor },
      '../workspaces/postgres-runtime': {
        findPostgresUserById: forbidden('default reviewer user read'),
        readPostgresWorkspaceForActorOnConnection: forbidden('default scoped reviewer workspace read'),
        resolveExistingPostgresWorkspaceForActor: forbidden('default reviewer workspace read'),
      },
      './proposal-review-capability': { proposalReviewWritesEnabled: () => true },
      './policy-v1': { resolveFileVersionRolloutV1: () => ({ restore: true }) },
    });
    const admission = createCollaborationAdmissionService({ openConnection: admissionOpen });

    const seed = async (label: string): Promise<Fixture> => {
      const documentId = `review-document-${label}`;
      const workspaceId = `review-workspace-${label}`;
      const lineageId = `review-lineage-${label}`;
      const filePath = `${label}.md`;
      const organizationId = `review-organization-${label}`;
      const original = `Original ${label}`;
      const doc = new Y.Doc({ gc: false });
      doc.getText('content').insert(0, original);
      const update = Buffer.from(Y.encodeStateAsUpdate(doc));
      const vector = Buffer.from(Y.encodeStateVector(doc));
      doc.destroy();
      const now = Date.now();
      await fixturePool!.query(`INSERT INTO file_collaboration_lineages
        (id,workspace_id,workspace_type,path,status,created_at) VALUES ($1,$2,'personal',$3,'active',$4)`,
      [lineageId, workspaceId, filePath, now]);
      await fixturePool!.query(`INSERT INTO collaboration_documents
        (id,workspace_id,workspace_type,path,lineage_id,provider,state_version,status,created_at,updated_at)
        VALUES ($1,$2,'personal',$3,$4,'yjs',0,'active',$5,$5)`,
      [documentId, workspaceId, filePath, lineageId, now]);
      await fixturePool!.query(`INSERT INTO collaboration_yjs_states (
        document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
        canonical_hash,serialized_hash,newline_style,has_bom,degraded,status
      ) VALUES ($1,$2,$3,$4,'plain_text',1,1,$5,$6,1,$7,$7,1,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, organizationId, filePath, update, vector, now]);
      await fixturePool!.query('INSERT INTO proposal_test_authorizations (workspace_id,active) VALUES ($1,true)', [workspaceId]);
      const workspace: WorkspaceContext = { workspaceId, workspaceType: 'personal', organizationId,
        rootPath: `/test-only/${workspaceId}`, legacy: false,
        actor: { userId: 'reviewer', email: 'reviewer@test.invalid', role: 'member' },
        permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false,
          canCreatePublicLinks: false, canManageWorkspace: false } };
      workspaces.set(workspaceId, workspace);
      return {
        document: { documentId, workspaceId, organizationId, path: filePath, representation: 'plain_text',
          lifecycleGeneration: 1, schemaVersion: 1, status: 'active' },
        scope: { workspaceId, lineageId, documentId, lifecycleGeneration: 1, schemaVersion: 1 },
        workspace,
        target: { workspaceId, lineageId, documentId, path: filePath,
          latestRevisionId: null, latestRevisionHash: null, latestRevisionSize: 0 },
        access: { userId: 'reviewer', authenticatedWorkspaceId: workspaceId, requestedWorkspaceId: workspaceId,
          membership: 'active', permissionsResolved: true, canRead: true, canWrite: true, canManageWorkspace: false },
        path: filePath, original,
      };
    };

    const createProposal = async (fixture: Fixture, label: string) => {
      const actorSessionId = `agent-session-${fixture.workspace.workspaceId}`;
      sessionWorkspaces.set(actorSessionId, fixture.workspace.workspaceId);
      const runtime = await agentRuntime.createRuntimeProposalAgentService({ workspace: fixture.workspace,
        documentId: fixture.document.documentId, path: fixture.path,
        identity: { ...agentIdentity, actorSessionId } });
      const created = await runtime.service.createIndependent({ scope: fixture.scope, actorId: agentIdentity.actorId,
        idempotencyKey: `proposal-${label}-operation-key`, allowCreate: true,
        mutation: { replacement: `${fixture.original} accepted ${label}` },
        buildTargets: (source) => {
          assert.equal(source.content, fixture.original);
          const doc = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(doc, source.update);
            return [bridge.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: source.content.length,
              replacement: `${fixture.original} accepted ${label}`, targetId: `target-${label}`,
              groupId: 'review-action-test' })];
          } finally { doc.destroy(); }
        },
      });
      assert.ok(created);
      const read = await runtime.service.readExact({ scope: fixture.scope, proposalId: created.node.proposalId });
      assert.equal(read.metadata.source.kind, 'proposal');
      assert.ok(read.metadata.source.evaluationId);
      return { created, read };
    };

    const createReview = async (fixture: Fixture, label: string): Promise<PreparedAction> => {
      const { created, read } = await createProposal(fixture, label);
      const selectedProposalIds = [created.node.proposalId];
      const selectionHash = hashProposalEvaluationSelectionV1({ selectedProposalIds,
        closureProposalIds: selectedProposalIds, applyProposalIds: selectedProposalIds,
        graphRevision: read.metadata.graphRevision });
      const storedEvaluation = (await fixturePool!.query<{
        graph_id: string; evaluation_json: Record<string, unknown>; created_at: number | string; expires_at: number | string;
      }>(`SELECT graph_id,evaluation_json,created_at,expires_at FROM file_proposal_evaluations
        WHERE evaluation_id=$1`, [read.metadata.source.evaluationId])).rows[0];
      assert.ok(storedEvaluation);
      const evaluationId = `review-evaluation-${randomUUID()}`;
      const evaluationJson = { ...storedEvaluation.evaluation_json, evaluationId, selectionHash };
      await fixturePool!.query(`INSERT INTO file_proposal_evaluations
        (evaluation_id,graph_id,proposal_id,evaluation_json,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [evaluationId, storedEvaluation.graph_id, created.node.proposalId,
        JSON.stringify(evaluationJson), storedEvaluation.created_at, storedEvaluation.expires_at]);
      let durableFailure: string | null = null;
      const applyDurably = async (input: { actionId: string; candidateUpdate: Uint8Array; candidateSha256: string }) => {
        durableFailure = 'entered';
        const revisionId = `review-revision-${input.actionId}`;
        const now = Date.now();
        const candidateHash = createHash('sha256').update(input.candidateUpdate).digest('hex');
        assert.equal(candidateHash, input.candidateSha256);
        try {
          await fixturePool!.query(`INSERT INTO file_revisions
            (id,workspace_id,workspace_type,path,content_hash,size_bytes,created_by_actor_type,lineage_id,revision_number,created_at)
            VALUES ($1,$2,'personal',$3,$4,$5,'user',$6,1,$7)`,
          [revisionId, fixture.workspace.workspaceId, fixture.path,
            candidateHash, input.candidateUpdate.byteLength,
            fixture.scope.lineageId, now]);
        } catch {
          durableFailure = 'revision-insert';
          throw new Error('Controlled durable apply could not insert its isolated revision fixture.');
        }
        const operation = await fixturePool!.query<{ status: string }>(
          'SELECT status FROM collaboration_agent_operations WHERE operation_id=$1', [input.actionId]);
        durableFailure = 'operation-read';
        if (operation.rows[0]?.status !== 'preparing') {
          durableFailure = `operation-${operation.rows[0]?.status ?? 'missing'}`;
          throw new Error(`Controlled durable apply observed operation status ${operation.rows[0]?.status ?? 'missing'}.`);
        }
        await fixturePool!.query(`UPDATE collaboration_agent_operations SET version_revision_id=$2,
          resulting_state_snapshot=$3,persisted_at=$4,updated_at=$4 WHERE operation_id=$1`,
        [input.actionId, revisionId, Buffer.from(input.candidateUpdate), now]);
        const current = proposalYjsCurrentProof({ update: input.candidateUpdate,
          representation: 'plain_text', revisionId });
        durableFailure = null;
        return { operationId: input.actionId, revisionId,
          current };
      };
      const service = await reviewRuntime.createRuntimeProposalReviewActionService({
        target: fixture.target, workspace: fixture.workspace, access: fixture.access,
        reviewerSessionId: `review-session-${label}`,
        dependencies: {
          database: databaseModule.createRuntimeFileVersionCenterDatabase(),
          loadState: (documentId: string) => loadCollaborationStateOnConnection(fixtureReader, documentId),
          loadStateOnConnection: loadCollaborationStateOnConnection,
          readWorkspace: async (_actor: unknown, workspaceId: string) => readAuthorizedWorkspace(fixtureReader, workspaceId),
          readWorkspaceOnConnection: async (reader: SqlConnection, _userId: string, workspaceId: string) =>
            readAuthorizedWorkspace(reader, workspaceId),
          signingSecret: 'proposal-review-admission-signing-secret', writesEnabled: () => true,
          rolloutWritable: () => true, applyDurably,
        },
      });
      const prepared = await service.prepare({ selectedProposalIds, actionType: 'accept',
        binding: { evaluationId, selectedProposalIds,
          selectionHash, graphRevision: read.metadata.graphRevision, current: read.metadata.source.current } });
      return { service, proposalId: created.node.proposalId, durableFailure: () => durableFailure,
        action: { contractVersion: 1, ...prepared, idempotencyKey: `review-${label}-action-key`, creation: null } };
    };

    const counts = async (documentId: string) => {
      const operations = await fixturePool!.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM collaboration_agent_operations WHERE document_id=$1', [documentId]);
      const receipts = await fixturePool!.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM file_proposal_action_receipts WHERE document_id=$1', [documentId]);
      return { operations: Number(operations.rows[0]?.count ?? 0), receipts: Number(receipts.rows[0]?.count ?? 0) };
    };
    const assertOpenUnreservedGraph = async (fixture: Fixture, proposalId: string) => {
      const graph = await fixturePool!.query<{ active_action_id: string | null }>(
        'SELECT active_action_id FROM file_proposal_graphs WHERE document_id=$1', [fixture.document.documentId]);
      const proposal = await fixturePool!.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM file_change_proposals WHERE proposal_id=$1', [proposalId]);
      assert.equal(graph.rows[0]?.active_action_id, null);
      assert.equal(proposal.rows[0]?.lifecycle, 'open');
    };

    let groups = 0;
    const passed = (name: string) => { groups++; console.log(`✓ ${name}`); };

    const reservationFirstFixture = await seed('reservation-first');
    const reservationFirst = await createReview(reservationFirstFixture, 'reservation-first');
    const reservationFirstBaseline = await counts(reservationFirstFixture.document.documentId);
    await admission.reserve(admissionRequest(reservationFirstFixture.document));
    await assert.rejects(reservationFirst.service.execute(reservationFirst.action), code('ADMISSION_CONFLICT'));
    assert.deepEqual(await counts(reservationFirstFixture.document.documentId), reservationFirstBaseline,
      'reservation-first must add neither an action operation nor a receipt');
    await assertOpenUnreservedGraph(reservationFirstFixture, reservationFirst.proposalId);
    passed('reservation-first rejects review-action operation and receipt creation');

    const actionFirstFixture = await seed('action-first');
    const actionFirst = await createReview(actionFirstFixture, 'action-first');
    const actionOperationEntered = deferred();
    const releaseActionOperation = deferred();
    const actionHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')) return;
      actionOperationEntered.resolve();
      await releaseActionOperation.promise;
    } };
    const actionPromise = runtimeHooks.run(actionHooks, () => actionFirst.service.execute(actionFirst.action));
    const actionHandled = actionPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    const reserveTargetEntered = deferred();
    const releaseReserveTarget = deferred();
    const reserveHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_ADMISSION_TARGETS')) return;
      reserveTargetEntered.resolve();
      await releaseReserveTarget.promise;
    } };
    let actionReserveHandled: Promise<{ value: unknown; error: unknown }> | undefined;
    let actionReceipt: ProposalActionReceiptV1 | undefined;
    try {
      await within(actionOperationEntered.promise, TEST_TIMEOUT_MS, 'review action did not reach operation INSERT');
      const reservePromise = admissionHooks.run(reserveHooks,
        () => admission.reserve(admissionRequest(actionFirstFixture.document)));
      actionReserveHandled = reservePromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!reserveHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), TEST_TIMEOUT_MS, 'action-first reservation did not open a backend');
      await waitForBlocked(adminPool, reserveHooks.backendPids![0]!, 'reservation behind review action');
      releaseActionOperation.resolve();
      const actionResult = await actionHandled;
      if (actionResult.error) {
        assert.equal(actionFirst.durableFailure(), null, `controlled durable apply failed at ${actionFirst.durableFailure()}`);
        throw actionResult.error;
      }
      actionReceipt = actionResult.value;
      assert.equal(actionReceipt?.phase, 'succeeded');
      await within(reserveTargetEntered.promise, TEST_TIMEOUT_MS, 'reservation did not continue after review action');
      const visible = await counts(actionFirstFixture.document.documentId);
      assert.equal(visible.operations, 2, 'source plus synthetic review operation are committed before reserve finishes');
      assert.equal(visible.receipts, 1, 'the durable review receipt is visible before reserve finishes');
      releaseReserveTarget.resolve();
      const reserveResult = await actionReserveHandled;
      if (reserveResult.error) throw reserveResult.error;
    } finally {
      releaseActionOperation.resolve();
      releaseReserveTarget.resolve();
      await within(actionHandled.then(() => undefined), TEST_TIMEOUT_MS, 'action-first review did not settle');
      if (actionReserveHandled) await within(actionReserveHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'action-first reservation did not settle');
    }
    assert.ok(actionReceipt);
    const beforeActionRetry = await counts(actionFirstFixture.document.documentId);
    const actionRetry = await actionFirst.service.execute(actionFirst.action);
    assert.deepEqual(actionRetry, actionReceipt);
    assert.deepEqual(await counts(actionFirstFixture.document.documentId), beforeActionRetry,
      'exact review retry under the active reservation adds no operation or receipt');
    passed('action-first commit serializes reserve, exposes the synthetic operation, and exact retry remains idempotent');

    const revokedFixture = await seed('revoked');
    const revoked = await createReview(revokedFixture, 'revoked');
    const revokedBaseline = await counts(revokedFixture.document.documentId);
    const externalGuard = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-revocation', schema) });
    await externalGuard.connect();
    let externalGuardOpen = false;
    let revokedHandled: Promise<{ value: ProposalActionReceiptV1 | undefined; error: unknown }> | undefined;
    try {
      await externalGuard.query('BEGIN');
      externalGuardOpen = true;
      await lockCollaborationAdmissionWorkspace(async (sql, values) => (await externalGuard.query(sql, values)).rows,
        revokedFixture.workspace.workspaceId);
      const revokedHooks: QueryHooks = { statements: [] };
      const revokedPromise = runtimeHooks.run(revokedHooks, () => revoked.service.execute(revoked.action));
      revokedHandled = revokedPromise.then((value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: undefined, error }));
      await within((async () => {
        while (!revokedHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), TEST_TIMEOUT_MS, 'revoked review action did not open a backend');
      await waitForBlocked(adminPool, revokedHooks.backendPids![0]!, 'review action behind external admission guard');
      await fixturePool.query('UPDATE proposal_test_authorizations SET active=false WHERE workspace_id=$1',
        [revokedFixture.workspace.workspaceId]);
      await externalGuard.query('COMMIT');
      externalGuardOpen = false;
      const result = await revokedHandled;
      assert.equal(result.value, undefined);
      assert.ok(code('PROPOSAL_ACCESS_DENIED')(result.error));
      assert.deepEqual(await counts(revokedFixture.document.documentId), revokedBaseline,
        'revoked reviewer creates no synthetic operation or receipt');
    } finally {
      if (externalGuardOpen) await externalGuard.query('ROLLBACK').catch(() => undefined);
      await externalGuard.end();
      if (revokedHandled) await within(revokedHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'revoked review action did not settle');
    }
    passed('authorization revoked while the admission guard waits is observed before writes');

    const stateFenceFixture = await seed('state-fence');
    const stateFence = await createReview(stateFenceFixture, 'state-fence');
    const firstCommitEntered = deferred();
    const releaseFirstCommit = deferred();
    let syntheticInserted = false;
    const stateHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')) syntheticInserted = true;
      if (sql !== 'COMMIT' || !syntheticInserted) return;
      firstCommitEntered.resolve();
      await releaseFirstCommit.promise;
    } };
    const stateActionPromise = runtimeHooks.run(stateHooks, () => stateFence.service.execute(stateFence.action));
    const stateActionHandled = stateActionPromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    const stateWriter = new Client({ ...poolConfig(databaseUrl, 'canvas-proposal-review-admission-state-writer', schema) });
    let stateWriterConnected = false;
    let stateWriterOpen = false;
    let writerHandled: Promise<{ error: unknown }> | undefined;
    try {
      await within(firstCommitEntered.promise, TEST_TIMEOUT_MS, 'review operation did not reach its owning COMMIT');
      await stateWriter.connect();
      stateWriterConnected = true;
      await stateWriter.query('BEGIN');
      stateWriterOpen = true;
      const writerPid = (await stateWriter.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
      const write = stateWriter.query(`UPDATE collaboration_yjs_states SET persisted_at=persisted_at+1
        WHERE document_id=$1`, [stateFenceFixture.document.documentId]);
      writerHandled = write.then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }));
      await waitForBlocked(adminPool, writerPid, 'state writer behind review operation commit');
      assert.deepEqual((await adminPool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers',
        [writerPid])).rows[0]?.blockers, [stateHooks.backendPids![0]!]);
      releaseFirstCommit.resolve();
      const writerResult = await writerHandled;
      if (writerResult.error) throw writerResult.error;
      await stateWriter.query('ROLLBACK');
      stateWriterOpen = false;
      const actionResult = await stateActionHandled;
      if (actionResult.error) throw actionResult.error;
      assert.equal(actionResult.value?.phase, 'succeeded');
    } finally {
      releaseFirstCommit.resolve();
      await within(stateActionHandled.then(() => undefined), TEST_TIMEOUT_MS, 'state-fence review action did not settle');
      if (writerHandled) await within(writerHandled.then(() => undefined), TEST_TIMEOUT_MS,
        'state-fence writer did not settle');
      if (stateWriterOpen) await stateWriter.query('ROLLBACK').catch(() => undefined);
      if (stateWriterConnected) await stateWriter.end();
    }
    passed('review action retains its state row lock through synthetic operation commit');

    const rollbackFixture = await seed('rollback');
    const rollback = await createReview(rollbackFixture, 'rollback');
    const rollbackBaseline = await counts(rollbackFixture.document.documentId);
    let rollbackOperationInserted = false;
    const rollbackHooks: QueryHooks = { statements: [], beforeQuery: async (sql) => {
      if (sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')) rollbackOperationInserted = true;
      if (rollbackOperationInserted && sql.startsWith('UPDATE FILE_PROPOSAL_ACTION_RECEIPTS SET PHASE')) {
        throw new Error('Injected failure after review operation preparation');
      }
    } };
    await assert.rejects(runtimeHooks.run(rollbackHooks, () => rollback.service.execute(rollback.action)),
      /Injected failure after review operation preparation/u);
    assert.equal(rollbackOperationInserted, true);
    assert.deepEqual(await counts(rollbackFixture.document.documentId), rollbackBaseline,
      'receipt and synthetic operation roll back in their shared transaction');
    await assertOpenUnreservedGraph(rollbackFixture, rollback.proposalId);
    passed('failure after review operation preparation rolls back receipt and operation atomically');

    const capacityFixtures = await Promise.all(['capacity-a', 'capacity-b', 'capacity-c'].map(seed));
    const capacityActions: PreparedAction[] = [];
    for (const [index, fixture] of capacityFixtures.entries()) {
      capacityActions.push(await createReview(fixture, `capacity-${index}`));
    }
    const capacityHooks = capacityActions.map((): QueryHooks => ({ statements: [] }));
    const capacityResults = await Promise.all(capacityActions.map((prepared, index) =>
      runtimeHooks.run(capacityHooks[index]!, () => prepared.service.execute(prepared.action))));
    assert.ok(capacityResults.every((receipt) => receipt.phase === 'succeeded'));
    for (const hooks of capacityHooks) {
      assert.equal(hooks.maxOpenConnections, 1,
        'one review action never holds a nested runtime pool lease');
      assert.ok(hooks.statements!.some((entry) => entry.sql.includes('FROM PROPOSAL_TEST_AUTHORIZATIONS')),
        'fresh scoped authorization executes on the runtime backend');
      assert.ok(hooks.statements!.some((entry) => entry.sql.includes('FROM COLLABORATION_YJS_STATES')),
        'fresh scoped state reads execute on the runtime backend');
      assert.ok(hooks.statements!.some((entry) => entry.sql.startsWith('INSERT INTO COLLABORATION_AGENT_OPERATIONS')),
        'real synthetic operation preparation executes');
    }
    assert.ok(runtimePool.totalCount <= 2);
    assert.equal(runtimePool.waitingCount, 0);
    passed('three review actions finish through pool max-two without nested connection borrowing');

    assert.equal(poolErrors.length, 0, 'dedicated proposal-review pools must not emit background errors');
    console.log(`Proposal review action admission PostgreSQL: ${groups} groups passed; schema ${schema}.`);
  } finally {
    for (const pool of [runtimePool, admissionPool, fixturePool]) {
      if (!pool) continue;
      try { await within(pool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing a proposal-review pool.'); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated) {
      try {
        assertGeneratedSchema(schema);
        await adminPool.query(`DROP SCHEMA ${schemaSql} CASCADE`);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await within(adminPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing proposal-review control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Proposal-review admission cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('proposal-review-action-admission-postgres-test: skipped (managed PostgreSQL environment is not configured)');
} else {
  void within(run(databaseUrl), 240_000, 'Proposal review action admission PostgreSQL test timed out')
    .catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
