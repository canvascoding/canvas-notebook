import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import type * as Service from '../app/lib/collaboration/agent-direct-edit-grants';
import type * as Route from '../app/api/files/collaboration/operations/[operationId]/direct-edit-grant/route';
import { AGENT_DIRECT_EDIT_GRANT_STATEMENTS } from '../app/lib/db/agent-direct-edit-grant-migration';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const scope: Service.AgentDirectEditGrantScope = {
  userId: 'owner', workspaceId: 'workspace', agentId: 'agent', actorSessionId: 'session',
  documentId: 'document', lifecycleGeneration: 3,
};
const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'personal', rootPath: '/unused', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: true,
    canCreatePublicLinks: true, canManageWorkspace: true },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function compile<T>(filename: string, dependencies: Record<string, unknown>, now: () => number) {
  const absolute = path.resolve(filename);
  const load = createRequire(absolute);
  const { outputText } = ts.transpileModule(await fs.readFile(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  class Clock extends Date { static now() { return now(); } }
  new Function('require', 'module', 'exports', 'Date', outputText)(
    (name: string) => name === 'server-only' ? {} : name in dependencies ? dependencies[name] : load(name),
    { exports }, exports, Clock,
  );
  return exports as T;
}

async function harness(t: TestContext, simulateLocks = false) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE pi_sessions (id INTEGER PRIMARY KEY, user_id TEXT, session_id TEXT, agent_id TEXT, archived_at INTEGER);
    CREATE TABLE collaboration_yjs_states (document_id TEXT PRIMARY KEY, workspace_id TEXT, lifecycle_generation INTEGER, status TEXT);
    CREATE TABLE collaboration_agent_operations (operation_id TEXT PRIMARY KEY, document_id TEXT, workspace_id TEXT,
      initiated_by_user_id TEXT, actor_id TEXT, actor_session_id TEXT, document_lifecycle_generation INTEGER,
      operation_type TEXT, status TEXT, direct_edit_grant_id TEXT);
    INSERT INTO pi_sessions VALUES (11, 'owner', 'session', 'agent', NULL);
    INSERT INTO collaboration_yjs_states VALUES ('document', 'workspace', 3, 'active');
    INSERT INTO collaboration_agent_operations VALUES ('operation', 'document', 'workspace', 'owner', 'agent', 'session', 3,
      'apply', 'proposed', NULL);
  `);
  for (const sql of AGENT_DIRECT_EDIT_GRANT_STATEMENTS) {
    if (!sql.startsWith('ALTER TABLE')) sqlite.exec(sql);
  }
  let now = 1_000_000;
  let allowed = true;
  let currentWorkspace = 'workspace';
  let permissionChecks = 0;
  let connectionCount = 0;
  const transactions: string[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const locks = new Map<string, Promise<void>>();
  const waiters: string[] = [];
  const args = (values: unknown[] = []) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value as SQLInputValue]));
  async function openDb() {
    const id = ++connectionCount;
    const held: (() => void)[] = [];
    async function lock(key: string) {
      const previous = locks.get(key) ?? Promise.resolve();
      const gate = deferred();
      locks.set(key, gate.promise);
      waiters.push(key);
      await previous;
      held.push(() => {
        gate.resolve();
        if (locks.get(key) === gate.promise) locks.delete(key);
      });
    }
    function release() { held.splice(0).reverse().forEach((unlock) => unlock()); }
    return {
      async get(sql: string, values: unknown[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          if (simulateLocks) await lock(`scope:${values[0]}`);
          return {};
        }
        const clean = sql.replace(/ FOR UPDATE$/u, '');
        if (simulateLocks && clean !== sql) {
          const row = sqlite.prepare(clean).get(args(values)) as { grant_id: string } | undefined;
          if (row) await lock(`grant:${row.grant_id}`);
        }
        return sqlite.prepare(clean).get(args(values));
      },
      async run(sql: string, values: unknown[] = []) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
          transactions.push(`${id}:${sql}`);
          if (!simulateLocks) sqlite.exec(sql);
          if (sql !== 'BEGIN') release();
          return {};
        }
        return sqlite.prepare(sql).run(args(values));
      },
      async all(sql: string, values: unknown[] = []) { return sqlite.prepare(sql).all(args(values)); },
      async close() { release(); },
    };
  }
  const service = await compile<typeof Service>('app/lib/collaboration/agent-direct-edit-grants.ts', {
    './diagnostics': { logCollaborationDiagnostic(_level: string, data: Record<string, unknown>) { diagnostics.push(data); } },
    '@/app/lib/db': { openDb },
    '@/app/lib/pi/session-workspace-context': {
      async resolveAgentExecutionContextForStoredSession(input: Record<string, unknown>) {
        permissionChecks++;
        assert.deepEqual(input.permissions, ['canRead', 'canRunAgent', 'canWrite']);
        assert.equal(input.userId, scope.userId);
        assert.equal(input.sessionId, scope.actorSessionId);
        assert.equal(input.agentId, scope.agentId);
        if (!allowed) throw new Error('Current access denied.');
        return { userId: input.userId, sessionId: input.sessionId, agentId: input.agentId,
          workspaceId: currentWorkspace, canWrite: true };
      },
    },
  }, () => now);
  const input = { operationId: 'operation', userId: 'owner', workspace };
  const grant = (key = 'grant-1') => service.setAgentDirectEditGrantForOperation({ ...input, action: 'grant', idempotencyKey: key });
  const revoke = (key = 'revoke-1') => service.setAgentDirectEditGrantForOperation({ ...input, action: 'revoke', idempotencyKey: key });
  return { service, sqlite, input, grant, revoke, transactions, waiters, diagnostics,
    setNow(value: number) { now = value; }, get now() { return now; },
    setAllowed(value: boolean) { allowed = value; },
    setWorkspace(value: string) { currentWorkspace = value; },
    get permissionChecks() { return permissionChecks; } };
}

test('grant derives exact scope from an owned proposal and never accepts the proposal', async (t) => {
  const h = await harness(t);
  const grant = await h.grant();
  assert.ok(grant?.active);
  assert.equal(grant.expiresAt, h.now + 30 * 60_000);
  assert.equal(grant.revokedAt, null);
  assert.deepEqual(await h.service.resolveAgentDirectEditGrant(scope), { id: grant.id, expiresAt: grant.expiresAt });
  assert.equal(h.sqlite.prepare('SELECT status FROM collaboration_agent_operations').get()?.status, 'proposed');
  const row = h.sqlite.prepare('SELECT * FROM collaboration_agent_direct_edit_grants').get();
  assert.equal(row?.pi_session_db_id, 11);
  assert.equal(row?.document_id, 'document');
  assert.equal(row?.lifecycle_generation, 3);
});

test('another owner or workspace manager cannot grant somebody else’s operation', async (t) => {
  const h = await harness(t);
  await assert.rejects(h.service.setAgentDirectEditGrantForOperation({ ...h.input, userId: 'admin', action: 'grant', idempotencyKey: 'admin' }),
    h.service.AgentDirectEditGrantUnavailableError);
  await assert.rejects(h.service.setAgentDirectEditGrantForOperation({ ...h.input,
    workspace: { ...workspace, workspaceId: 'another-workspace' }, action: 'grant', idempotencyKey: 'cross-workspace' }),
  h.service.AgentDirectEditGrantUnavailableError);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM collaboration_agent_direct_edit_grants').get()?.count, 0);
});

test('a stored, active exact session is mandatory; no default-session or missing-row fallback', async (t) => {
  const h = await harness(t);
  for (const mutation of [
    "UPDATE collaboration_agent_operations SET actor_session_id = NULL",
    "UPDATE collaboration_agent_operations SET actor_session_id = 'missing'",
    "UPDATE collaboration_agent_operations SET actor_session_id = 'session'; UPDATE pi_sessions SET archived_at = 1",
  ]) {
    h.sqlite.exec(mutation);
    await assert.rejects(h.grant(), h.service.AgentDirectEditGrantUnavailableError);
  }
  assert.equal(h.permissionChecks, 0);
});

test('review-only or reverted operations cannot be used to forge another scope', async (t) => {
  const h = await harness(t);
  h.sqlite.exec("UPDATE collaboration_agent_operations SET operation_type = 'revert'");
  await assert.rejects(h.grant(), h.service.AgentDirectEditGrantUnavailableError);
});

test('new clicks and idempotent replay do not extend an active grant', async (t) => {
  const h = await harness(t);
  const first = await h.grant();
  h.setNow(h.now + 60_000);
  assert.deepEqual(await h.grant(), first);
  assert.deepEqual(await h.grant('second-click'), first);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM collaboration_agent_direct_edit_grants').get()?.count, 1);
});

test('expired grants fail at the boundary and a new action creates a new id', async (t) => {
  const h = await harness(t);
  const first = (await h.grant())!;
  h.setNow(first.expiresAt);
  assert.equal(await h.service.resolveAgentDirectEditGrant(scope), null);
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: first.id, scope }, async () => assert.fail('must not apply')),
    h.service.AgentDirectEditGrantUnavailableError);
  assert.equal((await h.grant())?.active, false);
  const next = (await h.grant('fresh-explicit-grant'))!;
  assert.notEqual(next.id, first.id);
  assert.equal(next.expiresAt, h.now + 30 * 60_000);
});

test('revoke denies a captured queued id and old requests cannot reactivate it', async (t) => {
  const h = await harness(t);
  const first = (await h.grant())!;
  const revoked = (await h.revoke())!;
  assert.equal(revoked.active, false);
  assert.equal(revoked.revokedAt, h.now);
  assert.equal(await h.service.resolveAgentDirectEditGrant(scope), null);
  assert.equal((await h.grant())?.active, false);
  const next = (await h.grant('new-grant'))!;
  assert.notEqual(next.id, first.id);
  assert.equal((await h.revoke())?.id, first.id);
  assert.equal((await h.service.resolveAgentDirectEditGrant(scope))?.id, next.id);
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: first.id, scope }, async () => assert.fail()),
    h.service.AgentDirectEditGrantUnavailableError);
});

test('idempotency keys cannot change action and an empty revoke stays empty on replay', async (t) => {
  const h = await harness(t);
  assert.equal(await h.revoke('empty'), null);
  const grant = (await h.grant())!;
  assert.equal(await h.revoke('empty'), null);
  assert.equal((await h.service.resolveAgentDirectEditGrant(scope))?.id, grant.id);
  await assert.rejects(h.revoke('grant-1'), /already used/u);
});

test('permission revocation is checked on every apply; revoke still works without write rights', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  assert.equal(await h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => 'applied'), 'applied');
  const priorChecks = h.permissionChecks;
  h.setAllowed(false);
  assert.equal(await h.service.resolveAgentDirectEditGrant(scope), null);
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => assert.fail()),
    h.service.AgentDirectEditGrantUnavailableError);
  assert.ok(h.permissionChecks >= priorChecks + 2);
  const restricted = { ...workspace, permissions: { ...workspace.permissions, canWrite: false, canRunAgent: false } };
  assert.equal((await h.service.setAgentDirectEditGrantForOperation({ ...h.input, workspace: restricted,
    action: 'revoke', idempotencyKey: 'lost-rights' }))?.active, false);
});

test('workspace access, archived documents and new lifecycle generations invalidate grants', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  h.setWorkspace('foreign');
  assert.equal(await h.service.resolveAgentDirectEditGrant(scope), null);
  h.setWorkspace('workspace');
  for (const mutation of ["UPDATE collaboration_yjs_states SET lifecycle_generation = 4",
    "UPDATE collaboration_yjs_states SET lifecycle_generation = 3, status = 'archived'"]) {
    h.sqlite.exec(mutation);
    await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => assert.fail()),
      h.service.AgentDirectEditGrantUnavailableError);
  }
});

test('a recreated session with the same public id cannot inherit the previous grant', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  h.sqlite.exec("DELETE FROM pi_sessions; INSERT INTO pi_sessions VALUES (12, 'owner', 'session', 'agent', NULL)");
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM collaboration_agent_direct_edit_grants').get()?.count, 0);
  assert.equal(await h.grant(), null, 'historic action does not grant authority to a recreated session');
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => assert.fail()),
    h.service.AgentDirectEditGrantUnavailableError);
});

test('child sessions, other agents, users, workspaces, documents and generations do not inherit', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  const variants: Service.AgentDirectEditGrantScope[] = [
    { ...scope, actorSessionId: 'child-session' }, { ...scope, agentId: 'child-agent' },
    { ...scope, userId: 'other' }, { ...scope, workspaceId: 'other' },
    { ...scope, documentId: 'other' }, { ...scope, lifecycleGeneration: 4 },
  ];
  for (const variant of variants) {
    assert.equal(await h.service.resolveAgentDirectEditGrant(variant), null);
    await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope: variant }, async () => assert.fail()),
      h.service.AgentDirectEditGrantUnavailableError);
  }
});

test('status reports eligibility without granting or accepting and denies foreign operations', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.service.getAgentDirectEditGrantForOperation(h.input), { grant: null, canGrant: true });
  const grant = (await h.grant())!;
  assert.deepEqual(await h.service.getAgentDirectEditGrantForOperation(h.input), { grant, canGrant: true });
  h.setAllowed(false);
  const state = await h.service.getAgentDirectEditGrantForOperation(h.input);
  assert.equal(state.canGrant, false);
  assert.equal(state.grant?.active, false);
  await assert.rejects(h.service.getAgentDirectEditGrantForOperation({ ...h.input, userId: 'admin' }),
    h.service.AgentDirectEditGrantUnavailableError);
});

test('status prefers the active regrant even when wall-clock timestamps do not increase', async (t) => {
  const h = await harness(t);
  await h.grant();
  await h.revoke();
  h.setNow(h.now - 1);
  const current = await h.grant('new-grant');
  assert.deepEqual((await h.service.getAgentDirectEditGrantForOperation(h.input)).grant, current);
});

test('callback failure rolls back and releases its dedicated connection', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => { throw new Error('mutation failed'); }),
    /mutation failed/u);
  assert.ok(h.transactions.at(-1)?.endsWith(':ROLLBACK'));
  assert.equal((await h.revoke())?.active, false);
});

test('revoke waits for a running grant-locked callback; later callbacks are denied', async (t) => {
  // The adapter models PostgreSQL FOR UPDATE waits; the service runs its real SQL/transaction boundaries.
  const h = await harness(t, true);
  const grant = (await h.grant())!;
  const entered = deferred();
  const finish = deferred();
  const applying = h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async (current) => {
    assert.deepEqual(current, { id: grant.id, expiresAt: grant.expiresAt });
    entered.resolve();
    await finish.promise;
    return 'applied';
  });
  await entered.promise;
  let revoked = false;
  const revoking = h.revoke().then((result) => { revoked = true; return result; });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  assert.equal(revoked, false);
  assert.ok(h.waiters.filter((key) => key === `grant:${grant.id}`).length >= 2);
  finish.resolve();
  assert.equal(await applying, 'applied');
  assert.equal((await revoking)?.active, false);
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => assert.fail()),
    h.service.AgentDirectEditGrantUnavailableError);
});

test('concurrent first grants for one scope share one identity and expiry', async (t) => {
  const h = await harness(t, true);
  const [first, second] = await Promise.all([h.grant('first'), h.grant('second')]);
  assert.deepEqual(first, second);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM collaboration_agent_direct_edit_grants').get()?.count, 1);
});

test('invalid scopes and oversized or empty action keys fail closed', async (t) => {
  const h = await harness(t);
  assert.equal(await h.service.resolveAgentDirectEditGrant({ ...scope, actorSessionId: '' }), null);
  assert.equal(await h.service.resolveAgentDirectEditGrant({ ...scope, lifecycleGeneration: 1.5 }), null);
  await assert.rejects(h.grant(' '.repeat(10)), /required/u);
  await assert.rejects(h.grant('x'.repeat(201)), /required/u);
});

test('private diagnostics log committed grants and revokes once, without session ids or document text', async (t) => {
  const h = await harness(t);
  const grant = (await h.grant())!;
  await h.grant();
  await h.grant('another-click');
  await h.revoke();
  await h.revoke();
  await assert.rejects(h.service.withAgentDirectEditGrant({ grantId: grant.id, scope }, async () => assert.fail()));
  assert.deepEqual(h.diagnostics.map((entry) => entry.event), [
    'agent_direct_edit_grant_created', 'agent_direct_edit_grant_revoked', 'agent_direct_edit_grant_denied',
  ]);
  assert.deepEqual(Object.keys(h.diagnostics[0]).sort(), ['documentId', 'event', 'generation', 'operationId', 'workspaceId']);
  for (const entry of h.diagnostics) {
    assert.equal('actorSessionId' in entry, false);
    assert.equal('grantId' in entry, false);
    assert.equal('text' in entry, false);
  }
});

async function routeHarness(t: TestContext) {
  const h = await harness(t);
  let authenticated = true;
  let limited = false;
  let userId = 'owner';
  let currentWorkspace = workspace;
  const route = await compile<typeof Route>('app/api/files/collaboration/operations/[operationId]/direct-edit-grant/route.ts', {
    '@/app/lib/collaboration/agent-direct-edit-grants': h.service,
    '@/app/lib/workspaces/request': {
      async requireRequestWorkspace(_request: NextRequest, options: unknown) {
        assert.deepEqual(options, { permissions: 'canRead' });
        return authenticated ? { workspace: currentWorkspace, session: { user: { id: userId } } }
          : { response: NextResponse.json({ success: false }, { status: 401 }) };
      },
    },
    '@/app/lib/api/route-helpers': {
      applyRateLimit() { return limited ? NextResponse.json({ success: false }, { status: 429 }) : null; },
    },
  }, () => h.now);
  const context = { params: Promise.resolve({ operationId: 'operation' }) };
  return { ...h,
    post(body: unknown) { return route.POST(new NextRequest('http://localhost/api/grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), context); },
    raw(body: string) { return route.POST(new NextRequest('http://localhost/api/grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }), context); },
    get() { return route.GET(new NextRequest('http://localhost/api/grant'), context); },
    setAuthenticated(value: boolean) { authenticated = value; },
    setLimited(value: boolean) { limited = value; },
    setUser(value: string) { userId = value; },
    restrictWorkspace() { currentWorkspace = { ...workspace,
      permissions: { ...workspace.permissions, canWrite: false, canRunAgent: false } }; },
  };
}

test('real grant API supports grant, status, and revoke without accepting its proposal', async (t) => {
  const h = await routeHarness(t);
  const response = await h.post({ action: 'grant', idempotencyKey: 'route-grant' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.grant.active, true);
  const status = await h.get();
  assert.deepEqual(await status.json(), { success: true, canGrant: true, grant: result.grant });
  assert.equal(h.sqlite.prepare('SELECT status FROM collaboration_agent_operations').get()?.status, 'proposed');
  const revoked = await h.post({ action: 'revoke', idempotencyKey: 'route-revoke' });
  assert.equal((await revoked.json()).grant.active, false);
});

test('grant API rejects untrusted scope, grant identity, lifetime and authorization fields', async (t) => {
  const h = await routeHarness(t);
  for (const extra of [
    { userId: 'admin' }, { workspaceId: 'other' }, { actorSessionId: 'child' }, { documentId: 'other' },
    { lifecycleGeneration: 4 }, { grantId: 'reused' }, { expiresAt: 999999999 }, { explicitUserRequest: true },
    { scope }, { approved: true },
  ]) {
    const response = await h.post({ action: 'grant', idempotencyKey: 'untrusted', ...extra });
    assert.equal(response.status, 400);
  }
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM collaboration_agent_direct_edit_grants').get()?.count, 0);
});

test('grant API rejects malformed, unsupported and unbounded action bodies', async (t) => {
  const h = await routeHarness(t);
  for (const body of [null, [], 'grant', {}, { action: 'accept', idempotencyKey: 'x' },
    { action: 'grant' }, { action: 'grant', idempotencyKey: '' },
    { action: 'grant', idempotencyKey: 'x'.repeat(201) }]) {
    assert.equal((await h.post(body)).status, 400);
  }
  assert.equal((await h.raw('{')).status, 400);
});

test('grant API uses authenticated ownership and current rate limits', async (t) => {
  const h = await routeHarness(t);
  const body = { action: 'grant', idempotencyKey: 'request' };
  h.setAuthenticated(false);
  assert.equal((await h.post(body)).status, 401);
  assert.equal((await h.get()).status, 401);
  h.setAuthenticated(true);
  h.setLimited(true);
  assert.equal((await h.post(body)).status, 429);
  h.setLimited(false);
  h.setUser('admin');
  assert.equal((await h.post(body)).status, 409);
  assert.equal((await h.get()).status, 409);
});

test('API rejects a new grant after rights loss but permits revocation', async (t) => {
  const h = await routeHarness(t);
  assert.equal((await h.post({ action: 'grant', idempotencyKey: 'first' })).status, 200);
  h.restrictWorkspace();
  h.setAllowed(false);
  assert.equal((await h.post({ action: 'grant', idempotencyKey: 'second' })).status, 409);
  const response = await h.post({ action: 'revoke', idempotencyKey: 'lost-rights' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).grant.active, false);
});


test('grant API reports bounded capacity exhaustion as retryable without exposing internals', async (t) => {
  const h = await routeHarness(t);
  h.service.getAgentDirectEditGrantForOperation = async () => {
    // A shared admission queue can throw an Error created by another Next.js bundle.
    throw Object.assign(new Error('private pool details'), { code: 'agent_database_busy' });
  };
  const response = await h.get();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '5');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { success: false, code: 'agent_database_busy', error: 'Agent editing is busy. Please try again.' });
});
