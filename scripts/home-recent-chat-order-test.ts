import assert from 'node:assert/strict';
import Module from 'node:module';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let legacyAvailable = false;
internals._load = (request, parent, isMain) => {
  if (request === '@/app/lib/db') return database;
  if (request === '@/app/lib/agents/access') return { listAgentAccessForUser: async () => new Map([['bradley', { canUse: true }]]) };
  if (request === '@/app/lib/agents/registry') return { listAgentProfiles: async () => [{ agentId: 'bradley', iconId: 'bot' }] };
  if (request === '@/app/lib/db/legacy-ai-tables') return { legacyAiTablesExist: async () => legacyAvailable };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  const { db } = database;
  const { user, piSessions, piMessages, aiSessions, aiMessages } = await import('../app/lib/db/schema');
  const { listHomeChats } = await import('../app/lib/home/recent-chats');
  const epoch = new Date('2026-09-22T12:00:00Z').getTime();
  const now = new Date(epoch);
  const workspace = { workspaceId: 'personal', workspaceType: 'personal', permissions: { canRunAgent: true } } as WorkspaceContext;
  await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@test.invalid', emailVerified: true, createdAt: now, updatedAt: now });
  for (let index = 0; index < 12; index++) {
    const [session] = await db.insert(piSessions).values({
      sessionId: `session-${index.toString().padStart(2, '0')}`, agentId: 'bradley', userId: 'owner', workspaceId: 'personal',
      provider: 'test', model: 'test', title: `Chat ${index}`, createdAt: now, updatedAt: now,
    }).returning();
    await db.insert(piMessages).values([
      { piSessionDbId: session.id, role: 'user', content: '{}', timestamp: epoch + index * 1000, sequence: 1 },
      { piSessionDbId: session.id, role: 'assistant', content: '{}', timestamp: epoch + index * 1000 + 100, sequence: 2 },
      // Tool activity cannot make an otherwise old conversation appear recent.
      { piSessionDbId: session.id, role: 'toolResult', content: '{}', timestamp: epoch + 1_000_000, sequence: 3 },
    ]);
  }
  const page = await listHomeChats('owner', workspace, '', 10);
  assert.equal(page.chats[0].sessionId, 'session-11', 'newest chat stays first when the result exceeds ten entries');
  assert.equal(page.chats.length, 10);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.chats.map(chat => chat.activityAt), Array.from({ length: 10 }, (_, index) => epoch + (11 - index) * 1000 + 100), 'correlated SELECT returns each session’s own last conversational activity');

  await database.getPostgresRuntimeQueryable().exec(`
    CREATE TABLE IF NOT EXISTS ai_sessions (id bigserial PRIMARY KEY, session_id text NOT NULL, user_id text NOT NULL, model text NOT NULL, title text, created_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_messages (id bigserial PRIMARY KEY, ai_session_db_id bigint NOT NULL, role text NOT NULL, content text NOT NULL, type text, attachments text, created_at bigint NOT NULL);
  `);
  legacyAvailable = true;
  const [legacy] = await db.insert(aiSessions).values({ sessionId: 'legacy-newest', userId: 'owner', model: 'test', title: 'Legacy newest', createdAt: now }).returning();
  await db.insert(aiMessages).values([
    { aiSessionDbId: legacy.id, role: 'user', content: 'Older', createdAt: new Date(epoch + 20_000) },
    { aiSessionDbId: legacy.id, role: 'assistant', content: 'Newest', createdAt: new Date(epoch + 30_000) },
  ]);
  const merged = await listHomeChats('owner', workspace, '', 10);
  assert.equal(merged.chats[0].sessionId, 'legacy-newest');
  assert.equal(merged.chats[0].activityAt, epoch + 30_000, 'legacy correlated MAX includes the latest message, not a message whose own ID matches its session ID');
  assert.equal(merged.chats[1].sessionId, 'session-11');
  const searched = await listHomeChats('owner', workspace, 'Chat 11', 10);
  assert.deepEqual(searched.chats.map(chat => chat.sessionId), ['session-11']);
  console.log('Home recent chats: per-session correlated activity, latest-first limit and legacy merge passed.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  internals._load = originalLoad;
  await database?.close();
});
