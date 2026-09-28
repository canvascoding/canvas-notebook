import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>>;
let signedIn = true;
let agentAllowed = true;
let workspaceAllowed = true;
moduleLoader._load = function loadWithMocks(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? { user: { id: 'owner' } } : null } } };
  if (request === '@/app/lib/agents/access') return {
    requireAgentAccess: async () => { if (!agentAllowed) throw new Error('Agent access denied.'); },
  };
  if (request === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentSessionWorkspaceForUser: async () => {
      if (!workspaceAllowed) throw new Error('Workspace access denied.');
      return { workspaceId: 'workspace-1', organizationId: 'org-1', projectId: null, workspaceType: 'personal' };
    },
  };
  if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/agents/management-actions') return { listManagedAgents: async () => [] };
  if (request === '@/app/lib/pi/delegation-actions') return { prepareUserDelegation: async () => { throw new Error('unused'); } };
  if (request === '@/app/lib/pi/delegation-dispatcher') return {
    enqueueDelegatedTask: async () => { throw new Error('unused'); },
    cancelDelegatedTask: async () => { throw new Error('unused'); },
  };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    testDatabase = await createPiTestDatabase();
    const { db } = testDatabase;
    const { user, piSessions, piMessages } = await import('../app/lib/db/schema');
    const { createPiDelegation, claimQueuedPiDelegation, completeRunningPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { appendPiDelegationProgress, readAuthorizedPiDelegationProgress } = await import('../app/lib/pi/delegation-progress');
    const progressRoute = await import('../app/api/delegations/[id]/progress/route');
    const detailRoute = await import('../app/api/delegations/[id]/route');
    const listRoute = await import('../app/api/delegations/route');
    const messagesRoute = await import('../app/api/sessions/messages/route');
    const now = new Date();
    await db.insert(user).values([
      { id: 'owner', name: 'Owner', email: 'owner-progress@example.test', emailVerified: true, createdAt: now, updatedAt: now },
      { id: 'stranger', name: 'Stranger', email: 'stranger-progress@example.test', emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(piSessions).values([
      { sessionId: 'parent-1', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1',
        createdAt: now, updatedAt: now },
      { sessionId: 'parent-2', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1',
        createdAt: now, updatedAt: now },
      { sessionId: 'child-1', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker', delegationDepth: 1, parentSessionId: 'parent-1', delegationId: 'task-1',
        workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now },
    ]);
    await createPiDelegation({ id: 'task-1', userId: 'owner', sourceSessionId: 'parent-1', sourceAgentId: 'bradley',
      workerSessionId: 'child-1', workerType: 'ephemeral', goal: 'Inspect files', toolsets: ['file'] });
    const queued = await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'queued', eventKey: 'queued' });
    assert.equal(queued?.revision, 1);
    await claimQueuedPiDelegation('task-1', 'progress-worker-owner');
    const running = await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'running', eventKey: 'running' });
    assert.equal(running?.revision, 2);
    const toolStart = await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'tool_start', preview: 'read_file', eventKey: 'tool:1:start' });
    assert.equal(toolStart?.revision, 3);
    assert.equal((await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'tool_start', preview: 'read_file', eventKey: 'tool:1:start' }))?.revision, 3);
    const toolEnd = await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'tool_end', preview: 'api_key=supersecret', eventKey: 'tool:1:end' });
    assert.equal(toolEnd?.revision, 4);
    assert.equal(toolEnd?.preview, null);
    assert.equal(await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'stranger', kind: 'tool_start' }), null);

    const authorized = await readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1', afterRevision: 2 });
    assert.deepEqual(authorized.events.map(event => event.revision), [3, 4]);
    await assert.rejects(readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-2' }));
    await assert.rejects(readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'stranger', sourceSessionId: 'parent-1' }));
    agentAllowed = false;
    await assert.rejects(readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' }));
    agentAllowed = true;
    workspaceAllowed = false;
    await assert.rejects(readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' }));
    workspaceAllowed = true;

    const [child] = await db.select().from(piSessions).where((await import('drizzle-orm')).eq(piSessions.sessionId, 'child-1'));
    await db.insert(piMessages).values([
      { piSessionDbId: child.id, role: 'user', sequence: 1, timestamp: 1, content: JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'api_key=supersecret' }] }) },
      { piSessionDbId: child.id, role: 'assistant', sequence: 2, timestamp: 2, content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Used bearer supersecret to inspect files.' }] }) },
      { piSessionDbId: child.id, role: 'toolResult', sequence: 3, timestamp: 3, content: JSON.stringify({ role: 'toolResult', toolName: 'read_file', content: [{ type: 'text', text: 'supersecret'.repeat(20_000) }] }) },
    ]);
    const context = { params: Promise.resolve({ id: 'task-1' }) };
    const url = 'http://localhost/api/delegations/task-1/progress?sourceSessionId=parent-1&afterRevision=2&tailLimit=3';
    const response = await progressRoute.GET(new NextRequest(url), context);
    assert.equal(response.status, 200);
    const body = await response.json() as { events: Array<{ revision: number }>; transcript: Array<{ role: string; text: string | null }> };
    assert.deepEqual(body.events.map(event => event.revision), [3, 4]);
    assert.equal(body.transcript.length, 3);
    assert.equal(body.transcript[0].text, null, 'user goal/context must not be copied into progress previews');
    assert.equal(body.transcript[2].text, null, 'raw tool output must not be copied into progress previews');
    assert.ok(!JSON.stringify(body).includes('supersecret'), 'secrets must not appear in progress response');
    assert.equal((await progressRoute.GET(new NextRequest(url.replace('parent-1', 'parent-2')), context)).status, 404);
    const detailUrl = 'http://localhost/api/delegations/task-1';
    assert.equal((await detailRoute.GET(new NextRequest(detailUrl), context)).status, 400);
    assert.equal((await detailRoute.GET(new NextRequest(`${detailUrl}?sourceSessionId=parent-2`), context)).status, 404);
    assert.equal((await detailRoute.GET(new NextRequest(`${detailUrl}?sourceSessionId=parent-1`), context)).status, 200);
    assert.equal((await listRoute.GET(new NextRequest('http://localhost/api/delegations'))).status, 400);
    const wrongParentList = await listRoute.GET(new NextRequest('http://localhost/api/delegations?sourceSessionId=parent-2'));
    assert.equal(wrongParentList.status, 200);
    assert.deepEqual((await wrongParentList.json() as { delegations: unknown[] }).delegations, []);
    signedIn = false;
    assert.equal((await progressRoute.GET(new NextRequest(url), context)).status, 401);
    signedIn = true;

    const messagesUrl = 'http://localhost/api/sessions/messages?sessionId=child-1&agentId=bradley';
    assert.equal((await messagesRoute.GET(new NextRequest(messagesUrl))).status, 403, 'known child ID alone grants no transcript access');
    assert.equal((await messagesRoute.GET(new NextRequest(`${messagesUrl}&sourceSessionId=parent-2&delegationId=task-1`))).status, 403);
    assert.equal((await messagesRoute.GET(new NextRequest(`${messagesUrl}&sourceSessionId=parent-1&delegationId=task-1`))).status, 200);

    const { piDelegations } = await import('../app/lib/db/schema');
    await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) }).where((await import('drizzle-orm')).eq(piDelegations.id, 'task-1'));
    assert.equal(await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'tool_start', eventKey: 'stale-tool' }), null,
      'expired workers must not confirm another tool start');
    await completeRunningPiDelegation({ id: 'task-1', resultStatus: 'ok', resultText: 'Done.' });
    assert.equal(await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'tool_start' }), null);
    assert.equal((await appendPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', kind: 'completed', eventKey: 'terminal' }))?.revision, 5);
    assert.equal((await readAuthorizedPiDelegationProgress({ delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' })).events.length, 5);

    // Recreate the additive schema on an already populated database, as a
    // production startup does when an older release has existing tasks.
    const postgres = testDatabase.getPostgresRuntimeQueryable();
    await postgres.query('DROP TABLE pi_delegations_progress');
    for (const column of ['progress_revision', 'run_owner_id', 'run_heartbeat_at', 'delivery_owner_id', 'delivery_heartbeat_at']) {
      await postgres.query(`ALTER TABLE pi_delegations DROP COLUMN ${column}`);
    }
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const columns = await postgres.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'pi_delegations'");
    const columnNames = new Set(columns.rows.map(row => row.column_name));
    for (const column of ['progress_revision', 'run_owner_id', 'run_heartbeat_at', 'delivery_owner_id', 'delivery_heartbeat_at']) {
      assert.ok(columnNames.has(column), `${column} was not restored on the populated table`);
    }
    const progressTable = await postgres.query<{ name: string | null }>("SELECT to_regclass('pi_delegations_progress') AS name");
    assert.equal(progressTable.rows[0].name, 'pi_delegations_progress');
    console.log('pi-delegation-progress-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await testDatabase?.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
