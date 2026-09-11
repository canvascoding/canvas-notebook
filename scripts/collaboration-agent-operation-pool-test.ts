import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Agent from '../app/lib/collaboration/agent-operations';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = { workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization',
  rootPath: '/unused', legacy: false, permissions: { canRead: true, canWrite: true, canRunAgent: true,
    canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false } };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown> & { operation_id: string; document_id: string; cas_version: number; status: string };
type Internals = typeof Agent & { sealPayload(value: unknown): string; createAgentOperationDatabase(): SqlConnection };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 0));
  assert(condition(), 'parallel operations must progress without exhausting the pool');
}

function harness(count = 10) {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'operation-pool-test-secret-32-characters';
  const docs = Array.from({ length: count }, () => { const doc = new Y.Doc(); doc.getText('content').insert(0, 'Original'); return doc; });
  const states = docs.map((doc, index) => ({ documentId: `document-${index}`, workspaceId: workspace.workspaceId,
    organizationId: workspace.organizationId, path: `document-${index}.md`, representation: 'plain_text', status: 'active',
    lifecycleGeneration: 1, schemaVersion: 1, degraded: false, documentSequence: 1, checkpointSequence: 0,
    persistedAt: Date.now(), yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }));
  const rows = new Map<string, Row>();
  const firstReads = gate();
  const reviews = gate();
  const grants = gate();
  let firstReadCount = 0;
  let reviewCount = 0;
  let grantCount = 0;
  let directCount = 0;
  let leased = 0;
  let opened = 0;
  let maxLeased = 0;
  let closed = false;
  let failMethod: 'get' | 'run' | 'all' | null = null;
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const indexFor = (documentId: string) => Number(documentId.split('-').at(-1));
  const query = async (method: 'get' | 'run' | 'all', sql: string, params: unknown[] = []) => {
    if (method === failMethod) throw new Error(`EXPECTED_${method.toUpperCase()}_ERROR`);
    if (method === 'all') return [...rows.values()].filter((row) => row.document_id === params[0]).map((row) => ({ ...row }));
    if (method === 'get') {
      if (sql.includes('SELECT name, email')) return { name: 'User' };
      if (firstReadCount < count) {
        firstReadCount++;
        if (firstReadCount === count) firstReads.resolve();
        await firstReads.promise;
      }
      const row = sql.includes('WHERE document_id = $1 AND initiated_by_user_id')
        ? [...rows.values()].find((entry) => entry.document_id === params[0] && entry.idempotency_key === params[2])
        : rows.get(String(params[0]));
      return row ? { ...row } : undefined;
    }
    if (sql.includes('INSERT INTO collaboration_agent_operations')) {
      const insert = /\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/u.exec(sql)!;
      const row: Record<string, unknown> = {};
      const columns = insert[1].split(',').map((value) => value.trim());
      insert[2].split(',').map((value) => value.trim()).forEach((value, index) => {
        row[columns[index]] = value.startsWith('$') ? params[Number(value.slice(1)) - 1]
          : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1) : Number(value);
      });
      rows.set(String(row.operation_id), row as Row); return { changes: 1 };
    }
    const assignments = [.../SET ([\s\S]*?)\s+WHERE/u.exec(sql)![1].matchAll(/(\w+) = \$(\d+)/gu)];
    const row = rows.get(String(params[assignments.length]));
    if (!row || row.cas_version !== params[assignments.length + 1]) return { changes: 0 };
    for (const [, name, position] of assignments) row[name] = params[Number(position) - 1];
    if (sql.includes('cas_version = cas_version + 1')) row.cas_version++;
    return { changes: 1 };
  };
  const openDb = async (): Promise<SqlConnection> => {
    if (closed) throw new Error('Test pool closed');
    if (leased === 10) await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    else { leased++; maxLeased = Math.max(maxLeased, leased); }
    opened++;
    let released = false;
    const run = async (method: 'get' | 'run' | 'all', sql: string, params?: unknown[]) => {
      assert(!released, 'no query may use a released pool client');
      return query(method, sql, params);
    };
    return { get: (sql, params) => run('get', sql, params), run: (sql, params) => run('run', sql, params),
      all: async (sql, params) => await run('all', sql, params) as unknown[], close() {
        assert(!released, 'a pool client is released exactly once'); released = true;
        const next = waiting.shift(); if (next) next.resolve(); else leased--;
      } };
  };
  const nestedRead = async <T>(read: () => T): Promise<T> => {
    const connection = await openDb();
    try { return read(); } finally { await connection.close(); }
  };
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const source = ts.transpileModule(readFileSync(filename, 'utf8') + '\nexport { sealPayload, createAgentOperationDatabase };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const load = createRequire(filename);
  const exports = {};
  const mock = (name: string) => {
    if (name === '@/app/lib/db') return { openDb };
    if (name === './server-runtime') return { Y };
    if (name === './persistence') return { loadCollaborationState: async (documentId: string) => nestedRead(() => ({ ...states[indexFor(documentId)] })) };
    if (name === './document-access') return { readCurrentCollaborationDocument: async (input: { documentId: string; read: (doc: Y.Doc) => unknown }) => {
      await nestedRead(() => undefined); reviewCount++; await reviews.promise;
      return input.read(docs[indexFor(input.documentId)]);
    } };
    if (name === './agent-direct-edit-grants') return {
      resolveAgentDirectEditGrant: async () => ({ id: 'grant', expiresAt: Date.now() + 60_000 }),
      AgentDirectEditGrantUnavailableError: class extends Error {},
      withAgentDirectEditGrant: async (_input: unknown, apply: (grant: { id: string; expiresAt: number }) => unknown) => {
        grantCount++; await grants.promise; return apply({ id: 'grant', expiresAt: Date.now() + 60_000 });
      },
    };
    if (name === './direct-connection') return {
      AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: async (input: { documentId: string }, apply: (doc: Y.Doc) => Agent.AgentApplyResult,
        onApplied: (result: Agent.AgentApplyResult) => Promise<void>) => {
        await nestedRead(() => undefined);
        const result = apply(docs[indexFor(input.documentId)]); await onApplied(result); directCount++; return result;
      },
    };
    if (name === './presence') return { upsertDocumentPresenceEntry() {}, removeDocumentPresenceEntry() {} };
    if (name === './diagnostics') return { logCollaborationDiagnostic() {} };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {} };
    return load(name);
  };
  new Function('require', 'module', 'exports', source)(mock, { exports }, exports);
  const agent = exports as Internals;
  const targets = docs.map((doc, index) => agent.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: 8,
    replacement: '', targetId: `target-${index}`, groupId: 'group' }));
  const addReviews = () => states.forEach((state, index) => {
    rows.set(`operation-${index}`, { operation_id: `operation-${index}`, document_id: state.documentId,
      workspace_id: workspace.workspaceId, organization_id: workspace.organizationId,
      document_path: state.path, document_representation: state.representation, document_lifecycle_generation: 1, schema_version: 1,
      initiated_by_user_id: 'user', actor_id: 'agent', actor_session_id: 'session', operation_type: 'apply', requested_mode: 'review',
      atomicity: 'all_or_nothing', run_generation: 1, payload_hash: hash(JSON.stringify(targets[index])),
      operation_payload: agent.sealPayload([targets[index]]), reverse_payload: null, status: 'needs_review', cas_version: 1,
      action_keys_json: '{}', base_state_vector: state.stateVector, base_document_sequence: 1, resulting_state_snapshot: null,
      expected_canonical_hash: null, expires_at: Date.now() + 60_000, created_at: Date.now(), updated_at: Date.now(),
      result_json: JSON.stringify({ status: 'needs_review', appliedTargetIds: [], conflicts: [], stateVector: '', durability: 'needs_review' }) });
  });
  return { agent, docs, rows, states, targets, addReviews, firstReads, reviews, grants,
    stats: () => ({ leased, opened, maxLeased, waiting: waiting.length, reviewCount, grantCount, directCount }),
    fail: (method: typeof failMethod) => { failMethod = method; },
    nestedRead,
    persist: () => states.forEach((state, index) => {
      state.documentSequence++; state.yjsState = Y.encodeStateAsUpdate(docs[index]); state.stateVector = Y.encodeStateVector(docs[index]); state.persistedAt = Date.now();
    }),
    close: () => {
      closed = true; firstReads.resolve(); reviews.resolve(); grants.resolve();
      for (const waiter of waiting.splice(0)) waiter.reject(new Error('Test pool closed'));
      docs.forEach((doc) => doc.destroy());
    },
  };
}

test('ten actual status reviews release operation clients before nested reads and room waits', async () => {
  const h = harness(); h.addReviews();
  const pending = Promise.all(h.states.map((_, index) => h.agent.getAgentOperation({ operationId: `operation-${index}`, workspace, userId: 'user' })));
  try {
    await until(() => h.stats().reviewCount === 10);
    assert.equal(h.stats().leased, 0); assert.equal(h.stats().waiting, 0); assert.equal(h.stats().maxLeased, 10);
    assert.equal(await h.nestedRead(() => 'other database work progresses'), 'other database work progresses');
    h.reviews.resolve();
    const result = await pending;
    assert(result.every((entry) => entry?.proposalVersion)); assert.equal(h.stats().leased, 0);
  } finally { h.close(); await pending.catch(() => {}); }
});

test('ten actual direct pure deletions keep pool capacity during grant and durable-receipt waits', async () => {
  const h = harness();
  const pending = Promise.all(h.states.map((state, index) => h.agent.applyPersistedAgentTextOperation({
    documentId: state.documentId, workspace, initiatedByUserId: 'user', actorId: 'agent', actorSessionId: 'session',
    actorDisplayName: 'Agent', idempotencyKey: `delivery-${index}`, runGeneration: 1, targets: [h.targets[index]],
    documentPath: state.path, documentRepresentation: 'plain_text', documentLifecycleGeneration: 1, documentSchemaVersion: 1,
  })));
  try {
    await until(() => h.stats().grantCount === 10);
    assert.equal(h.stats().leased, 0); assert.equal(h.stats().waiting, 0);
    h.grants.resolve();
    await until(() => h.stats().directCount === 10);
    assert.equal(h.stats().leased, 0); assert.equal(h.stats().waiting, 0);
    assert(h.docs.every((doc) => doc.getText('content').toString() === ''));
    assert([...h.rows.values()].every((row) => row.status === 'applied_to_ydoc'), 'unpersisted deletes are not confirmed');
    await h.nestedRead(() => undefined); h.persist();
    const result = await pending;
    assert(result.every((entry) => entry.durability === 'persisted_yjs'));
    assert.equal(h.rows.size, 10); assert.equal(h.stats().directCount, 10); assert.equal(h.stats().leased, 0);
  } finally { h.close(); await pending.catch(() => {}); }
});

test('failed get/run/all release their clients and invalid session SQL never leases one', async () => {
  const h = harness(1); h.addReviews(); h.firstReads.resolve(); h.reviews.resolve();
  try {
    h.fail('get'); await assert.rejects(h.agent.getAgentOperation({ operationId: 'operation-0', workspace, userId: 'user' }), /EXPECTED_GET_ERROR/u);
    assert.equal(h.stats().leased, 0);
    h.fail('run'); await assert.rejects(h.agent.rejectAgentOperation({ operationId: 'operation-0', workspace, userId: 'user', idempotencyKey: 'reject' }), /EXPECTED_RUN_ERROR/u);
    assert.equal(h.stats().leased, 0);
    h.fail('all'); await assert.rejects(h.agent.listAgentOperations({ documentId: 'document-0', workspace, userId: 'user' }), /EXPECTED_ALL_ERROR/u);
    assert.equal(h.stats().leased, 0); h.fail(null);
    const database = h.agent.createAgentOperationDatabase(); const before = h.stats().opened;
    for (const sql of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'SET search_path TO private',
      'LISTEN changes', 'SELECT 1; COMMIT', 'SELECT * FROM collaboration_agent_operations FOR UPDATE',
      'SELECT * FROM collaboration_agent_operations FOR SHARE', 'SELECT pg_advisory_lock(1)', 'SELECT pg_advisory_xact_lock(1)',
      "SELECT set_config('search_path', 'private', false)", "SELECT nextval('seq')", 'SELECT "pg_advisory_lock"(1)',
      'SELECT * INTO TEMP backup FROM collaboration_agent_operations', 'WITH changes AS (DELETE FROM x) SELECT 1']) {
      await assert.rejects(Promise.resolve().then(() => database.get(sql)), /standalone statements/u, sql);
    }
    await database.close(); assert.equal(h.stats().opened, before); assert.equal(h.stats().leased, 0);
  } finally { h.close(); }
});
