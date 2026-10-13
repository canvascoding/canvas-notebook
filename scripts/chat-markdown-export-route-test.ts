import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import ts from 'typescript';

async function main() {
  const filename = path.resolve('app/api/sessions/[sessionId]/export/route.ts');
  const load = createRequire(filename);
  const { parsePersistedPiMessage } = await import('../app/lib/pi/message-projection');
  const { exportSessionMarkdown } = await import('../app/lib/chat/session-markdown-export');
  const controls = { signedIn: true, workspaceAllowed: true, agentAllowed: true, legacy: false, corrupt: false };
  const owner = { id: 7, sessionId: 'chat-a', userId: 'user-a', agentId: 'agent-a', workspaceId: 'workspace-a',
    organizationId: null, title: 'Debug chat', sessionKind: 'chat' };
  let owned: typeof owner | null = owner;
  const tables = {
    piMessages: { table: 'pi', piSessionDbId: 'piSessionDbId', sequence: 'sequence', id: 'id' },
    aiSessions: { table: 'legacy-sessions', sessionId: 'sessionId', userId: 'userId' },
    aiMessages: { table: 'legacy-messages', aiSessionDbId: 'aiSessionDbId', createdAt: 'createdAt', id: 'id' },
  };
  const reads: unknown[] = [];
  const rows = Array.from({ length: 240 }, (_, index) => ({ id: index + 1, sequence: index + 1, timestamp: 1000 + index,
    content: JSON.stringify({ role: 'user', content: index === 120 ? 'middle'.repeat(7000) : `Message ${index}` }),
  }));
  const mocks: Record<string, unknown> = {
    '@/app/lib/auth': { auth: { api: { getSession: async () => controls.signedIn ? { user: { id: 'user-a' } } : null } } },
    'drizzle-orm': { eq: (column: string, value: unknown) => [column, value], and: (...values: unknown[]) => values, asc: (column: string) => column },
    '@/app/lib/db/schema': tables,
    '@/app/lib/db': { db: { select: () => {
      let table: { table: string };
      return {
        from(value: { table: string }) { table = value; return this; },
        where(condition: unknown) { reads.push({ table: table.table, condition }); return this; },
        orderBy(...order: unknown[]) {
          if (controls.corrupt) throw new Error('Unreadable transcript');
          reads.push({ order });
          return table.table === 'pi' ? rows : [{ id: 1, role: 'assistant', content: 'Legacy output' }];
        },
        limit() { return [{ id: 9, title: 'Legacy chat' }]; },
      };
    } } },
    '@/app/lib/db/legacy-ai-tables': { legacyAiTablesExist: async () => controls.legacy },
    '@/app/lib/channels/constants': { DEFAULT_AGENT_ID: 'agent-a' },
    '@/app/lib/agents/registry': { normalizeManagedAgentId: (value: unknown) => { if (value !== 'agent-a') throw new Error('Invalid agent'); return value; } },
    '@/app/lib/agents/access': { requireAgentAccess: async (userId: string, agentId: string, permission: string, scope: { workspaceId: string }) => {
      assert.equal(userId, 'user-a'); assert.equal(agentId, 'agent-a'); assert.equal(permission, 'canUse'); assert.equal(scope.workspaceId, 'workspace-a');
      if (!controls.agentAllowed) throw new Error('Denied');
    } },
    '@/app/lib/pi/session-runtime-access': {
      findOwnedPiSessionForRuntime: async (input: { sessionId: string; userId: string; agentId: string }) => {
        assert.deepEqual(input, { sessionId: 'chat-a', userId: 'user-a', agentId: 'agent-a' });
        return owned;
      },
      isPiSessionInWorkspace: (session: typeof owner, workspace: { workspaceId: string }) => session.workspaceId === workspace.workspaceId,
    },
    '@/app/lib/pi/session-workspace-context': { resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId: string; permissions: string[] }) => {
      assert.deepEqual(input, { userId: 'user-a', workspaceId: 'workspace-a', permissions: ['canRead', 'canRunAgent'] });
      if (!controls.workspaceAllowed) throw new Error('Denied');
      return { workspaceId: 'workspace-a', workspaceType: 'personal', organizationId: null, projectId: null };
    } },
    '@/app/lib/pi/message-projection': { parsePersistedPiMessage },
    '@/app/lib/chat/session-markdown-export': { exportSessionMarkdown },
  };
  const exports: Record<string, unknown> = {};
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', compiled)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  const get = exports.GET as typeof import('../app/api/sessions/[sessionId]/export/route').GET;
  const request = (query = 'agentId=agent-a&workspaceId=workspace-a') => new NextRequest(`https://canvas.test/api/sessions/chat-a/export?${query}`);
  const context = { params: Promise.resolve({ sessionId: 'chat-a' }) };
  controls.signedIn = false;
  assert.equal((await get(request(), context)).status, 401);
  controls.signedIn = true;
  assert.equal((await get(request('agentId=../invalid&workspaceId=workspace-a'), context)).status, 400);
  assert.equal((await get(request('agentId=agent-a'), context)).status, 400);
  controls.workspaceAllowed = false;
  assert.equal((await get(request(), context)).status, 403);
  controls.workspaceAllowed = true; controls.agentAllowed = false;
  assert.equal((await get(request(), context)).status, 403);
  controls.agentAllowed = true;
  owned = { ...owner, workspaceId: 'foreign-workspace' };
  assert.equal((await get(request(), context)).status, 403);
  owned = { ...owner, sessionKind: 'delegation_worker' };
  assert.equal((await get(request(), context)).status, 403);
  assert.equal(reads.length, 0, 'no transcript data is read before all access checks pass');
  owned = owner;
  const response = await get(request(), context);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const body = await response.json();
  assert(body.markdown.includes('Message 0') && body.markdown.includes('Message 239'));
  assert(body.markdown.includes('middle'.repeat(7000)), 'raw projection retains middle text beyond the normal display budget');
  assert.deepEqual(reads[0], { table: 'pi', condition: ['piSessionDbId', owner.id] });
  assert.deepEqual(reads[1], { order: ['sequence', 'id'] });
  controls.corrupt = true;
  assert.equal((await get(request(), context)).status, 500);
  controls.corrupt = false;
  owned = null;
  assert.equal((await get(request(), context)).status, 404);
  controls.legacy = true;
  const legacy = await get(request(), context);
  assert.equal(legacy.status, 200);
  assert((await legacy.json()).markdown.includes('Legacy output'));
  assert(reads.some((value) => JSON.stringify(value) === JSON.stringify({ table: 'legacy-sessions', condition: [['sessionId', 'chat-a'], ['userId', 'user-a']] })), 'legacy exports enforce ownership');
  console.log('[Chat Markdown Export Route Test] passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
