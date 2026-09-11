import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type * as Grants from '../app/lib/collaboration/agent-direct-edit-grants';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const scope: Grants.AgentDirectEditGrantScope = { userId: 'owner', workspaceId: 'workspace', agentId: 'agent',
  actorSessionId: 'session', documentId: 'document', lifecycleGeneration: 1 };
const workspace = { workspaceId: 'workspace', permissions: { canRead: true, canWrite: true, canRunAgent: true } } as WorkspaceContext;

function pool(max: number) {
  let leased = 0;
  let peak = 0;
  let stopped = false;
  const queue: { resolve: () => void; reject: (error: Error) => void }[] = [];
  async function acquire(): Promise<() => void> {
    if (stopped) throw new Error('Pool closed.');
    if (leased >= max) await new Promise<void>((resolve, reject) => queue.push({ resolve, reject }));
    else leased++;
    peak = Math.max(peak, leased);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const next = queue.shift();
      if (next) next.resolve(); else leased--;
    };
  }
  return { acquire, get peak() { return peak; }, get leased() { return leased; },
    get waiting() { return queue.length; }, stop() { stopped = true; queue.splice(0).forEach((entry) => entry.reject(new Error('Pool closed.'))); } };
}

function service(capacity: ReturnType<typeof pool>) {
  const grant = { grant_id: 'grant', user_id: 'owner', workspace_id: 'workspace', agent_id: 'agent',
    actor_session_id: 'session', document_id: 'document', lifecycle_generation: 1,
    pi_session_db_id: 42, expires_at: Date.now() + 60_000, revoked_at: null };
  const openDb = async (): Promise<SqlConnection> => {
    const release = await capacity.acquire();
    return { close: release, run: async () => ({ changes: 1 }), all: async () => [],
      get: async (sql) => {
        if (sql.includes('FROM pi_sessions')) return { id: 42 };
        if (sql.includes('FROM collaboration_yjs_states')) return { document_id: 'document' };
        if (sql.includes('FROM collaboration_agent_operations')) return { ...grant, initiated_by_user_id: 'owner',
          actor_id: 'agent', document_lifecycle_generation: 1, operation_type: 'apply' };
        if (sql.includes('FROM collaboration_agent_direct_edit_grants')) return grant;
        throw new Error(`Unexpected query: ${sql}`);
      } };
  };
  const filename = path.resolve('app/lib/collaboration/agent-direct-edit-grants.ts');
  const load = createRequire(filename);
  const exports = {};
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', 'module', source)((name: string) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db') return { openDb };
    if (name === './diagnostics') return { logCollaborationDiagnostic() {} };
    if (name === '@/app/lib/pi/session-workspace-context') return {
      async resolveAgentExecutionContextForStoredSession() {
        // The real resolver queries the shared pool through Drizzle, independently of the grant connection.
        const release = await capacity.acquire();
        try { return { ...scope, sessionId: scope.actorSessionId, canWrite: true }; } finally { release(); }
      },
    };
    return load(name);
  }, exports, { exports });
  return exports as typeof Grants;
}

async function completes<T>(pending: Promise<T>, capacity: ReturnType<typeof pool>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Agent requests stalled: ${capacity.leased} leased, ${capacity.waiting} waiting.`)), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const mode of ['inspect', 'apply'] as const) {
  test(`ten concurrent grant ${mode} requests leave capacity for authorization and persistence`, async (t) => {
    const capacity = pool(10);
    t.after(() => capacity.stop());
    const grants = service(capacity);
    const requests = Array.from({ length: 10 }, () => mode === 'inspect'
      ? grants.getAgentDirectEditGrantForOperation({ operationId: 'operation', userId: 'owner', workspace })
      : grants.withAgentDirectEditGrant({ scope, grantId: 'grant' }, async () => {
        const release = await capacity.acquire();
        try { return 'durably applied'; } finally { release(); }
      }));
    const results = await completes(Promise.all(requests), capacity);
    assert.equal(results.length, 10);
    assert.equal(capacity.leased, 0);
    assert.equal(capacity.waiting, 0);
    assert.ok(capacity.peak <= 10);
  });
}

test('admission is bounded, FIFO, releases failures and removes timed-out waiters', async () => {
  const { createAgentDatabaseAdmission, AgentDatabaseCapacityError } = await import('../app/lib/collaboration/agent-database-capacity');
  const run = createAgentDatabaseAdmission(3, { maxWaiters: 2, waitMs: 30 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: number[] = [];
  const first = run(async () => { order.push(1); await gate; });
  const expired = assert.rejects(run(async () => assert.fail('expired work must not execute')), AgentDatabaseCapacityError);
  const expiredToo = assert.rejects(run(async () => assert.fail('expired work must not execute')), AgentDatabaseCapacityError);
  await assert.rejects(run(async () => assert.fail('overflow work must not execute')), AgentDatabaseCapacityError);
  await Promise.all([expired, expiredToo]);
  const next = run(async () => { order.push(2); throw new Error('Query failed'); });
  const last = run(async () => { order.push(3); return 'complete'; });
  const rejected = assert.rejects(next, /Query failed/u);
  release();
  await first;
  await rejected;
  assert.equal(await last, 'complete');
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(await run(async () => 'reused'), 'reused');
});

test('undersized operator pools fail before acquiring any database connection', async () => {
  const { createAgentDatabaseAdmission, AgentDatabaseCapacityError } = await import('../app/lib/collaboration/agent-database-capacity');
  for (const max of [1, 2]) {
    await assert.rejects(createAgentDatabaseAdmission(max)(async () => assert.fail('no lease may be acquired')),
      AgentDatabaseCapacityError);
  }
});
