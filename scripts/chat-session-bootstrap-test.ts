import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let signedIn = true;
let denyAgent = false;
const workspaceChecks: unknown[] = [];
const agentChecks: unknown[] = [];
moduleInternals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? { user: { id: 'owner', name: 'Owner', email: 'owner@test.invalid' } } : null } } };
  if (request === '@/app/lib/agents/access') return { requireAgentAccess: async (...args: unknown[]) => {
    agentChecks.push(args);
    if (denyAgent) throw new Error('Denied');
  } };
  if (request === '@/app/lib/agents/registry') return { normalizeManagedAgentId: (agentId: string | null) => agentId || 'main' };
  if (request === '@/app/lib/db/legacy-ai-tables') return { legacyAiTablesExist: async () => true };
  if (request === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentSessionWorkspaceForUser: async (input: { workspaceId: string }) => {
      workspaceChecks.push(input);
      if (input.workspaceId === 'denied') throw new Error('Denied');
      return { workspaceId: input.workspaceId, workspaceType: input.workspaceId === 'personal' ? 'personal' : 'team', organizationId: 'org', projectId: null };
    },
    storedPiSessionWorkspaceToSummary: (row: { workspaceId: string | null; workspaceType: string | null }) => row.workspaceId ? { workspaceId: row.workspaceId, workspaceType: row.workspaceType, workspaceName: 'Test' } : null,
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const { db } = database;
  const { piSessions, piMessages, aiSessions, aiMessages, user } = await import('../app/lib/db/schema');
  const { GET: bootstrap } = await import('../app/api/sessions/[sessionId]/bootstrap/route');
  const { GET: messages } = await import('../app/api/sessions/messages/route');
  const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
  const now = new Date('2026-09-22T12:00:00Z');
  await db.insert(user).values(['owner', 'other'].map(id => ({ id, name: id, email: `${id}@test.invalid`, emailVerified: true, createdAt: now, updatedAt: now })));
  const insertSession = async (sessionId: string, agentId = 'main', userId = 'owner', workspaceId: string | null = 'team-a') => (await db.insert(piSessions).values({
    sessionId, agentId, userId, workspaceId, workspaceType: workspaceId === 'personal' ? 'personal' : 'team',
    provider: 'test', model: 'test-model', createdAt: now, updatedAt: now, title: sessionId,
    systemPromptSnapshot: 'PRIVATE: must not appear in bootstrap metadata',
  }).returning())[0];
  const source = await insertSession('old-target', 'special-agent');
  // The explicit target remains available even when it is outside the history's 100-row window.
  await db.insert(piSessions).values(Array.from({ length: 105 }, (_, i) => ({
    sessionId: `newer-${i}`, agentId: 'main', userId: 'owner', workspaceId: 'team-a', workspaceType: 'team',
    provider: 'test', model: 'test-model', createdAt: new Date(now.getTime() + i + 1), updatedAt: now,
  })));
  await db.insert(piMessages).values(Array.from({ length: 55 }, (_, i) => ({
    piSessionDbId: source.id, role: 'user', content: JSON.stringify({ role: 'user', content: `message-${i + 1}` }),
    timestamp: now.getTime(), sequence: i + 1,
  })));
  const open = (sessionId: string, workspaceId = 'team-a') => bootstrap(
    new NextRequest(`https://canvas.test/api/sessions/${sessionId}/bootstrap?workspaceId=${workspaceId}`),
    { params: Promise.resolve({ sessionId }) },
  );
  const read = (sessionId: string, agentId: string, query = '') => messages(new NextRequest(
    `https://canvas.test/api/sessions/messages?sessionId=${sessionId}&agentId=${agentId}&workspaceId=team-a${query}`,
  ));
  const response = await open('old-target');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.sessionId, 'old-target');
  assert.equal(body.session.agentId, 'special-agent');
  assert.equal(body.session.systemPromptSnapshot, undefined);
  assert.equal(body.session.createdAt, now.toISOString());
  assert.equal(body.messages.messages.length, 50);
  assert.equal(body.messages.oldestSequence, 6);
  assert.equal(body.messages.newestSequence, 55);
  assert.equal(body.messages.hasMoreBefore, true);
  assert.deepEqual(body.messages, await (await read('old-target', 'special-agent')).json());
  assert.deepEqual(workspaceChecks[0], { userId: 'owner', workspaceId: 'team-a', permissions: ['canRead', 'canRunAgent'] });
  assert.deepEqual(agentChecks[0], ['owner', 'special-agent', 'canUse', { organizationId: 'org', workspaceId: 'team-a', projectId: null }]);
  const older = await (await read('old-target', 'special-agent', `&beforeSequence=6&beforeId=${body.messages.oldestMessageId}`)).json();
  assert.deepEqual(older.messages.map((message: { sequence: number }) => message.sequence), [1, 2, 3, 4, 5]);
  assert.equal(older.hasMoreBefore, false);
  const forward = await (await read('old-target', 'special-agent', '&afterSequence=50')).json();
  assert.deepEqual(forward.messages.map((message: { sequence: number }) => message.sequence), [51, 52, 53, 54, 55]);
  assert.equal((await read('old-target', 'special-agent', '&beforeSequence=nope')).status, 400);
  assert.equal((await open('old-target', 'team-b')).status, 403);
  assert.equal((await open('old-target', 'denied')).status, 403);
  assert.equal((await open('old-target', '')).status, 400);
  assert.equal((await open('missing')).status, 404);
  await insertSession('not-owned', 'main', 'other');
  assert.equal((await open('not-owned')).status, 404);
  denyAgent = true;
  assert.equal((await open('old-target')).status, 403);
  denyAgent = false;
  signedIn = false;
  assert.equal((await open('old-target')).status, 401);
  signedIn = true;
  // Simulate an older installation before the cross-agent uniqueness migration.
  await database.getPostgresRuntimeQueryable().exec('DROP INDEX idx_pi_sessions_user_session');
  await insertSession('ambiguous', 'agent-a');
  await insertSession('ambiguous', 'agent-b');
  assert.equal((await open('ambiguous')).status, 409);
  await insertSession('legacy-pi', 'main', 'owner', null);
  assert.equal((await open('legacy-pi', 'personal')).status, 200);
  assert.equal((await open('legacy-pi', 'team-a')).status, 403);

  // Production migration removed these tables; existing installations can still have them.
  await database.getPostgresRuntimeQueryable().exec(`
    CREATE TABLE IF NOT EXISTS ai_sessions (id bigserial PRIMARY KEY, session_id text NOT NULL, user_id text NOT NULL, model text NOT NULL, title text, created_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_messages (id bigserial PRIMARY KEY, ai_session_db_id bigint NOT NULL, role text NOT NULL, content text NOT NULL, type text, attachments text, created_at bigint NOT NULL);
  `);
  const [legacy] = await db.insert(aiSessions).values({ sessionId: 'legacy', userId: 'owner', model: 'legacy-model', title: 'Legacy', createdAt: now }).returning();
  await db.insert(aiMessages).values(Array.from({ length: 52 }, (_, i) => ({ aiSessionDbId: legacy.id, role: 'user', content: `legacy-${i}`, createdAt: now })));
  const legacyResponse = await open('legacy', 'personal');
  assert.equal(legacyResponse.status, 200);
  const legacyBody = await legacyResponse.json();
  assert.equal(legacyBody.session.engine, 'legacy');
  assert.equal(legacyBody.session.agentId, DEFAULT_AGENT_ID);
  assert.equal(legacyBody.messages.messages.length, 50);
  assert.equal(legacyBody.messages.hasMoreBefore, true);
  assert.equal((await open('legacy', 'team-a')).status, 404);
  const legacyPage = await messages(new NextRequest(`https://canvas.test/api/sessions/messages?sessionId=legacy&agentId=${DEFAULT_AGENT_ID}&workspaceId=personal&before=${now.getTime()}&beforeId=${legacyBody.messages.oldestMessageId}`));
  const legacyOlder = await legacyPage.json();
  assert.equal(legacyOlder.messages.length, 2);
  assert.equal(legacyOlder.hasMoreBefore, false);
  assert.ok(legacyOlder.messages[0].id < legacyOlder.messages[1].id);
  console.log('Chat bootstrap: targeted lookup, scope/ownership/access, ambiguity, legacy and paging passed.');
}

main().finally(async () => {
  moduleInternals._load = originalLoad;
  await database?.close();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
