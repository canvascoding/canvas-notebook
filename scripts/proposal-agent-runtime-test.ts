import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import * as Y from 'yjs';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import type { ProposalDocumentScopeV1, ProposalNodeV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type {
  ProposalToolCreationResultV1, ProposalToolEditV1, ProposalToolReadResultV1,
} from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { seedProposalGraphStorageTestScope, type ProposalGraphStorageTestDatabase } from './proposal-graph-storage-test';

// This is deliberately an SQL integration harness, not a live-room/E2E test.
// Runtime, provenance, graph storage, Yjs composition and operation preparation
// are production implementations. Authentication, persistence reads and live
// room access are controlled boundaries; every SQL statement runs in PGlite.
const sourceRoot = process.env.PROPOSAL_RUNTIME_SOURCE_ROOT ?? process.cwd();
const scope: ProposalDocumentScopeV1 = { workspaceId: 'proposal-workspace', lineageId: 'proposal-lineage',
  documentId: 'proposal-document', lifecycleGeneration: 1, schemaVersion: 1 };
const workspace: WorkspaceContext = { workspaceId: scope.workspaceId, workspaceType: 'personal',
  organizationId: 'proposal-org', rootPath: '/unused-proposal-runtime-test', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false,
    canCreatePublicLinks: false, canManageWorkspace: false } };
const identity = { initiatedByUserId: 'proposal-owner', actorId: 'main', actorSessionId: 'runtime-session' };

type BuildSource = { content: string; update: Uint8Array; representation: string; structure: unknown };
type CreationInput = { scope: ProposalDocumentScopeV1; actorId: string; idempotencyKey: string;
  proposal: ProposalToolEditV1; mutation: unknown; buildTargets(source: BuildSource): AgentTextTarget[] | Promise<AgentTextTarget[]> };
type Created = { node: ProposalNodeV1; proposal: ProposalToolCreationResultV1; reused: boolean;
  authoringPreview: { beforeContent: string; proposedContent: string; beforeSha256: string; proposedSha256: string } };
type RuntimeService = { scope: ProposalDocumentScopeV1; service: {
  readExact(input: { scope: ProposalDocumentScopeV1; proposalId: string | null }): Promise<{
    metadata: ProposalToolReadResultV1; content: string; structure: unknown; sourceStateVector: string }>;
  create(input: CreationInput): Promise<Created>;
} };
type Runtime = {
  assertProposalToolsEnabled(): void;
  createRuntimeProposalAgentService(input: { workspace: WorkspaceContext; documentId: string; path: string;
    identity: { initiatedByUserId: string; actorId: string; actorSessionId?: string } }): Promise<RuntimeService>;
};
type AgentBridge = {
  prepareProposalAgentOperation(input: unknown): Promise<unknown>;
  createAgentTextTarget(input: { text: Y.Text; from: number; to: number; replacement: string;
    targetId: string; groupId: string }): AgentTextTarget;
};

function compile<T>(relativePath: string, mocks: Record<string, unknown>): T {
  const filename = path.resolve(sourceRoot, relativePath);
  const require = createRequire(filename);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), loaded, loaded.exports,
  );
  return loaded.exports as T;
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error && typeof error === 'object' && 'code' in error, String(error));
    assert.equal(error.code, expected);
    return true;
  };
}

async function harness() {
  // Never select a configured production/test PostgreSQL URL or touch a server.
  const pg = new PGlite();
  let activeSql: FileVersionCenterTransaction | null = null;
  const statements: string[] = [];
  let afterStatement: ((sql: string) => void) | null = null;
  let failStatement: ((sql: string) => boolean) | null = null;
  const database: ProposalGraphStorageTestDatabase = {
    kind: 'pglite', query: (sql, params) => pg.query(sql, params),
    exec: async (sql) => { await pg.exec(sql); }, close: () => pg.close(),
    transaction: (action) => pg.transaction(async (tx) => {
      assert.equal(activeSql, null, 'runtime queries must reuse the graph-owner transaction');
      const sql: FileVersionCenterTransaction = { query: async <Row>(statement: string, params?: unknown[]) => {
        statements.push(statement);
        if (failStatement?.(statement)) throw new Error('Injected graph insertion failure');
        const result = await tx.query<Row>(statement, params);
        afterStatement?.(statement);
        return result;
      } };
      activeSql = sql;
      try { return await action(sql); } finally { activeSql = null; }
    }),
  };
  await runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
  await seedProposalGraphStorageTestScope(database);
  let live = new Y.Doc({ gc: false });
  live.getText('content').insert(0, 'Insurance 50. Tail.');
  const originalUpdate = Y.encodeStateAsUpdate(live);
  const state = { documentId: scope.documentId, workspaceId: scope.workspaceId, organizationId: 'proposal-org',
    path: 'shipping.md', representation: 'plain_text' as const, status: 'active' as const,
    lifecycleGeneration: 1, schemaVersion: 1, degraded: false, documentSequence: 7,
    checkpointSequence: 7, persistedAt: 100, yjsState: originalUpdate, stateVector: Y.encodeStateVector(live) };
  await database.query(`INSERT INTO collaboration_yjs_states (
    document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
    yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence
  ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,7,100,7)`, [state.documentId, state.workspaceId,
    state.organizationId, state.path, state.representation, Buffer.from(state.yjsState), Buffer.from(state.stateVector)]);
  let freshWorkspace = structuredClone(workspace);
  let sessionAvailable = true;
  const sessionCalls: Array<{ sessionId: string; userId: string; agentId: string; permissions: string[] }> = [];
  const directAuthCalls: Array<{ userId: string; role: string }> = [];
  const forbiddenCalls: string[] = [];
  const forbidden = (name: string) => () => { forbiddenCalls.push(name); throw new Error(`Unexpected ${name}`); };
  const loadState = async (documentId: string) => { assert.equal(documentId, scope.documentId); return { ...state }; };
  process.env.CANVAS_COLLABORATION_TICKET_SECRET ??= 'proposal-runtime-test-secret-not-for-production';
  const bridge = compile<AgentBridge>('app/lib/collaboration/agent-operations.ts', {
    '@/app/lib/db': { openDb: forbidden('openDb') }, './persistence': { loadCollaborationState: loadState },
    './server-runtime': { Y },
    '@/app/lib/file-version-center/agent-review-policy-adapter': {
      authorizeNewAgentDirectApply: forbidden('authorizeNewAgentDirectApply'),
      readAgentReviewPolicySnapshot: forbidden('readAgentReviewPolicySnapshot'),
    },
    './direct-connection': { AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: forbidden('runCollaborationDirectConnection') },
    './agent-direct-edit-grants': { AgentDirectEditGrantUnavailableError: class extends Error {},
      withAgentDirectEditGrant: forbidden('withAgentDirectEditGrant') },
    './document-access': { readCurrentCollaborationDocument: forbidden('bridge live apply') },
    '@/app/lib/file-version-center/history-service': {
      fileVersionHistoryService: { capturePersistedCollaboration: forbidden('capturePersistedCollaboration') },
    },
    './presence': { upsertDocumentPresenceEntry: forbidden('upsertDocumentPresenceEntry'),
      removeDocumentPresenceEntry: forbidden('removeDocumentPresenceEntry') },
    './diagnostics': { logCollaborationDiagnostic: () => {} },
    '@/app/lib/audit/audit-service': { recordAuditEvent: forbidden('recordAuditEvent') },
  });
  const runtime = compile<Runtime>('app/lib/file-version-center/proposal-agent-runtime.ts', {
    './database': { createRuntimeFileVersionCenterDatabase: () => database },
    '../workspaces/postgres-runtime': { readPostgresWorkspaceForActor: async (actor: { userId: string; role: string }, workspaceId: string) => {
      directAuthCalls.push(actor); assert.equal(workspaceId, scope.workspaceId); return freshWorkspace;
    } },
    '../pi/session-workspace-context': {
      resolveAgentExecutionContextForStoredSession: async (input: typeof sessionCalls[number]) => {
        sessionCalls.push(input);
        if (!sessionAvailable) throw new Error('Session revoked');
        return { workspace: freshWorkspace };
      },
      workspaceFromAgentExecutionContext: (context: { workspace: WorkspaceContext }) => context.workspace,
    },
    '../collaboration/persistence': { loadCollaborationState: loadState },
    '../collaboration/document-access': { readCurrentCollaborationDocument: async (input: {
      documentId: string; workspaceId: string; read(document: Y.Doc): unknown;
    }) => {
      assert.equal(input.documentId, scope.documentId); assert.equal(input.workspaceId, scope.workspaceId);
      assert.ok(activeSql, 'current reads stay inside the graph transaction');
      return input.read(live);
    } },
    '../collaboration/agent-operations': bridge, '../collaboration/server-runtime': { Y },
  });
  const factory = (override: Partial<Parameters<Runtime['createRuntimeProposalAgentService']>[0]> = {}) =>
    runtime.createRuntimeProposalAgentService({ workspace, documentId: scope.documentId, path: state.path, identity, ...override });
  const resetLive = () => { live.destroy(); live = new Y.Doc({ gc: false }); Y.applyUpdate(live, originalUpdate); };
  const counts = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['collaboration_agent_operations', 'file_proposal_graphs', 'file_change_proposals',
      'file_proposal_artifacts', 'file_proposal_evaluations', 'file_proposal_artifact_pins']) {
      result[table] = (await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows;
    }
    result.graphs = (await database.query('SELECT graph_id,graph_revision FROM file_proposal_graphs ORDER BY graph_id')).rows;
    result.sequence = (await database.query('SELECT document_sequence,lifecycle_generation,schema_version FROM collaboration_yjs_states')).rows;
    return result;
  };
  const targets = (source: BuildSource, oldText: string, newText: string) => {
    assert.equal(source.representation, 'plain_text');
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, source.update);
      assert.equal(doc.getText('content').toString(), source.content);
      const from = source.content.indexOf(oldText); assert.ok(from >= 0);
      return [bridge.createAgentTextTarget({ text: doc.getText('content'), from, to: from + oldText.length,
        replacement: newText, targetId: 'insurance-target', groupId: 'insurance-group' })];
    } finally { doc.destroy(); }
  };
  return { database, runtime, factory, state, statements, counts, targets, forbiddenCalls, sessionCalls, directAuthCalls,
    live: () => live, resetLive, activeSql: () => { assert.ok(activeSql); return activeSql; },
    fresh: (next: WorkspaceContext) => { freshWorkspace = next; },
    session: (available: boolean) => { sessionAvailable = available; },
    failSql: (predicate: typeof failStatement) => { failStatement = predicate; },
    afterSql: (callback: typeof afterStatement) => { afterStatement = callback; },
    close: async () => { live.destroy(); await database.close(); } };
}

function edit(source: ProposalToolReadResultV1['source']): ProposalToolEditV1 {
  return { contractVersion: 1, creationKind: source.kind === 'proposal' ? 'extends' : 'independent', source,
    expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null,
    expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null, replaces: null, choice: null };
}

async function main() {
  const h = await harness();
  let groups = 0;
  const passed = (name: string) => { groups++; console.log(`✓ ${name}`); };
  try {
    assert.throws(() => h.runtime.assertProposalToolsEnabled(), code('PROPOSAL_UPGRADE_REQUIRED'));
    const runtime = await h.factory();
    assert.deepEqual(runtime.scope, scope);
    await assert.rejects(h.factory({ path: 'another.md' }), code('PROPOSAL_STALE_LIFECYCLE'));
    await assert.rejects(runtime.service.readExact({ scope: { ...scope, workspaceId: 'proposal-other-workspace' }, proposalId: null }), code('PROPOSAL_SCOPE_MISMATCH'));
    passed('rollout stays closed; internal factory and path/workspace scope are exact');

    const authoritative = await runtime.service.readExact({ scope, proposalId: null });
    assert.equal(authoritative.content, 'Insurance 50. Tail.');
    assert.equal(authoritative.metadata.source.kind, 'authoritative');
    assert.equal(typeof authoritative.sourceStateVector, 'string');
    const request: CreationInput = { scope, actorId: identity.actorId, idempotencyKey: 'runtime-independent-request',
      proposal: edit(authoritative.metadata.source), mutation: { oldText: '50', newText: '100' },
      buildTargets: (source) => h.targets(source, '50', '100') };
    const parent = await runtime.service.create(request);
    assert.equal(parent.reused, false); assert.equal(parent.proposal.reviewRequired, true);
    assert.equal(parent.authoringPreview.beforeContent, 'Insurance 50. Tail.');
    assert.equal(parent.authoringPreview.proposedContent, 'Insurance 100. Tail.');
    const operation = (await h.database.query<Record<string, unknown>>(`SELECT * FROM collaboration_agent_operations WHERE operation_id=$1`, [parent.node.operationId])).rows[0];
    assert.equal(operation.status, 'needs_review'); assert.equal(operation.requested_mode, 'review');
    assert.equal(operation.actor_session_id, identity.actorSessionId); assert.equal(operation.direct_edit_grant_id, null);
    assert.equal(Number(operation.base_document_sequence), 7); assert.equal(operation.error_code, 'proposal_graph_review_required');
    assert.equal(h.live().getText('content').toString(), authoritative.content);
    passed('actual operation SQL and graph insertion are atomic, review-only and never mutate live content');

    const parentRead = await runtime.service.readExact({ scope, proposalId: parent.node.proposalId });
    assert.equal(parentRead.content, 'Insurance 100. Tail.');
    assert.equal(parentRead.metadata.source.kind, 'proposal');
    const childRequest: CreationInput = { ...request, idempotencyKey: 'runtime-dependent-request',
      proposal: edit(parentRead.metadata.source), mutation: { oldText: '100', newText: '150' },
      buildTargets: (source) => h.targets(source, '100', '150') };
    const child = await runtime.service.create(childRequest);
    assert.equal(child.node.relationships.dependency?.proposalId, parent.node.proposalId);
    assert.equal(child.node.relationships.dependency?.candidateHash, parent.node.authoredCandidate.cumulativeCandidate.sha256);
    assert.equal((await runtime.service.readExact({ scope, proposalId: child.node.proposalId })).content, 'Insurance 150. Tail.');
    assert.equal(h.live().getText('content').toString(), authoritative.content);
    passed('exact parent read anchors a child to its stored candidate, not the unchanged live document');

    const retryBefore = await h.counts();
    h.live().getText('content').insert(h.live().getText('content').length, ' Human change.');
    const retry = await runtime.service.create(request);
    assert.equal(retry.reused, true); assert.equal(retry.node.proposalId, parent.node.proposalId);
    assert.deepEqual(retry.authoringPreview, parent.authoringPreview); assert.deepEqual(await h.counts(), retryBefore);
    await assert.rejects(runtime.service.create({ ...request, mutation: { oldText: '50', newText: '200' } }), code('PROPOSAL_IDEMPOTENCY_MISMATCH'));
    await assert.rejects(runtime.service.create({ ...request, idempotencyKey: 'proposal-legacy-key' }), code('PROPOSAL_IDEMPOTENCY_MISMATCH'));
    h.resetLive();
    passed('exact retries survive later current edits; changed requests and legacy operations cannot be adopted');

    const foreignSession = await h.factory({ identity: { ...identity, actorSessionId: 'another-session' } });
    await assert.rejects(foreignSession.service.create(request), code('PROPOSAL_IDEMPOTENCY_MISMATCH'));
    const foreignActor = await h.factory({ identity: { ...identity, actorId: 'another-agent' } });
    assert.equal((await foreignActor.service.readExact({ scope, proposalId: parent.node.proposalId })).content, parentRead.content);
    await assert.rejects(foreignActor.service.create({ ...childRequest, actorId: 'another-agent', idempotencyKey: 'foreign-actor-dependent-request' }), code('PROPOSAL_ACCESS_DENIED'));
    const foreignUser = await h.factory({ identity: { ...identity, initiatedByUserId: 'another-user' } });
    assert.equal((await foreignUser.service.readExact({ scope, proposalId: parent.node.proposalId })).content, parentRead.content);
    await assert.rejects(foreignUser.service.create({ ...childRequest, idempotencyKey: 'foreign-user-dependent-request' }), code('PROPOSAL_ACCESS_DENIED'));
    passed('read permission does not confer parent-management rights; user, agent and originating session are bound');

    h.session(false);
    await assert.rejects(h.factory(), code('PROPOSAL_ACCESS_DENIED'));
    await assert.rejects(runtime.service.readExact({ scope, proposalId: null }), code('PROPOSAL_ACCESS_DENIED'));
    h.session(true);
    h.fresh({ ...workspace, workspaceId: 'proposal-other-workspace' });
    await assert.rejects(h.factory(), code('PROPOSAL_ACCESS_DENIED'));
    h.fresh({ ...workspace, permissions: { ...workspace.permissions, canWrite: false } });
    await assert.rejects(runtime.service.create({ ...request, idempotencyKey: 'revoked-write-request' }), code('PROPOSAL_ACCESS_DENIED'));
    assert.equal((await runtime.service.readExact({ scope, proposalId: null })).content, authoritative.content);
    h.fresh(structuredClone(workspace));
    await h.factory({ identity: { initiatedByUserId: identity.initiatedByUserId, actorId: identity.actorId } });
    assert.deepEqual(h.directAuthCalls.at(-1), { userId: identity.initiatedByUserId, role: 'member' });
    assert.ok(h.sessionCalls.some((call) => call.permissions.includes('canWrite') && call.sessionId === identity.actorSessionId
      && call.userId === identity.initiatedByUserId && call.agentId === identity.actorId));
    passed('fresh session/workspace authorization is required for every access and write');

    for (const column of ['lifecycle_generation', 'schema_version'] as const) {
      await h.database.query(`UPDATE collaboration_yjs_states SET ${column}=2 WHERE document_id=$1`, [scope.documentId]);
      await assert.rejects(runtime.service.readExact({ scope, proposalId: null }), code('PROPOSAL_STALE_LIFECYCLE'));
      await h.database.query(`UPDATE collaboration_yjs_states SET ${column}=1 WHERE document_id=$1`, [scope.documentId]);
    }
    passed('a stale factory cannot cross a lifecycle or schema generation');

    const rollback = async (key: string, inject: () => Promise<void> | void, expected: string) => {
      const before = await h.counts();
      await assert.rejects(runtime.service.create({ ...request, idempotencyKey: key,
        buildTargets: async (source) => { const targets = h.targets(source, '50', '110'); await inject(); return targets; },
      }), code(expected));
      assert.deepEqual(await h.counts(), before, 'artifacts, pins, graph revision and operations roll back together');
    };
    await rollback('revoked-during-preparation', () => {
      h.fresh({ ...workspace, permissions: { ...workspace.permissions, canWrite: false } });
    }, 'PROPOSAL_ACCESS_DENIED');
    h.fresh(structuredClone(workspace));
    passed('permission revoked during preparation leaves no staged graph/operation/artifact orphan');

    await rollback('sequence-changed-during-preparation', async () => {
      await h.activeSql().query('UPDATE collaboration_yjs_states SET document_sequence=8 WHERE document_id=$1', [scope.documentId]);
    }, 'PROPOSAL_CURRENT_CHANGED');
    await rollback('live-changed-during-preparation', () => { h.live().getText('content').insert(0, 'Human '); }, 'PROPOSAL_CURRENT_CHANGED');
    assert.match(h.live().getText('content').toString(), /^Human /u, 'rollback must not overwrite an independent live edit');
    h.resetLive();
    passed('persisted sequence and live Yjs changes invalidate preparation without undoing human edits');

    const beforeGraphFailure = await h.counts();
    h.failSql((sql) => sql.includes('INSERT INTO file_change_proposals'));
    await assert.rejects(runtime.service.create({ ...request, idempotencyKey: 'failed-graph-insertion-request' }), /Injected graph insertion failure/u);
    h.failSql(null);
    assert.deepEqual(await h.counts(), beforeGraphFailure);
    assert.ok(h.statements.some((sql) => sql.includes('INSERT INTO collaboration_agent_operations')));
    passed('failure after the real review operation INSERT rolls back the entire SQL transaction');

    const beforeLateChange = await h.counts();
    h.afterSql((sql) => {
      if (sql.includes('INSERT INTO file_change_proposals')) { h.afterSql(null); h.live().getText('content').insert(0, 'Late '); }
    });
    await assert.rejects(runtime.service.create({ ...request, idempotencyKey: 'late-live-change-request' }), code('PROPOSAL_CURRENT_CHANGED'));
    assert.deepEqual(await h.counts(), beforeLateChange);
    assert.match(h.live().getText('content').toString(), /^Late /u);
    h.resetLive();
    passed('final current-proof check catches changes after node insertion and rolls back both durable records');

    assert.ok(h.statements.some((sql) => sql.includes('FOR UPDATE OF document,lineage,state')));
    assert.ok(h.statements.some((sql) => sql.includes('file_proposal_graphs') && sql.includes('FOR UPDATE')));
    assert.ok(h.statements.some((sql) => sql.includes('proposal.proposal_id=ANY($6::text[])')));
    assert.ok(h.statements.some((sql) => sql.includes("proposal.node_json->'relationships' AS authored_relationships")));
    assert.deepEqual(h.forbiddenCalls, []);
    assert.equal((await h.database.query('SELECT count(*)::integer AS count FROM file_change_proposals')).rows[0].count, 2);
    assert.equal((await h.database.query('SELECT count(*)::integer AS count FROM collaboration_agent_operations')).rows[0].count, 4);
    passed('actual migrated schema accepts all scoped lock/lookup/operation statements; no direct apply or global connection used');
    console.log(`Proposal agent runtime: ${groups} SQL integration groups passed (in-memory PGlite; auth/live boundaries mocked).`);
  } finally { await h.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
