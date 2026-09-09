import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-output-route-'));
  const oldData = process.env.CANVAS_DATA_ROOT; process.env.CANVAS_DATA_ROOT = data;
  const identity = { userId: 'owner', organizationId: 'org', sessionId: 'session', workspaceId: 'workspace' };
  let authenticated = true, agentAllowed = true, workspaceAllowed = true;
  const modules = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = modules._load;
  modules._load = function(request, parent, isMain) {
    if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => authenticated ? { user: { id: 'owner' } } : null } } };
    if (request === '@/app/lib/agents/registry') return { normalizeManagedAgentId: (value: string) => value };
    if (request === '@/app/lib/agents/access') return { requireAgentAccess: async () => { if (!agentAllowed) throw new Error('denied'); } };
    if (request === '@/app/lib/pi/session-runtime-access') return {
      findOwnedPiSessionForRuntime: async (input: { sessionId: string; userId: string; agentId: string }) => input.sessionId === 'session' && input.userId === 'owner' && input.agentId === 'agent' ? identity : null,
      isPiSessionInWorkspace: (row: typeof identity, workspace: { workspaceId: string }) => row.workspaceId === workspace.workspaceId,
    };
    if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async (input: { workspaceId: string }) => {
      if (!workspaceAllowed) throw new Error('denied'); return { workspaceId: input.workspaceId, organizationId: 'org' };
    } };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { storeToolOutput } = await import('../app/lib/pi/tool-output-store');
    const { GET } = await import('../app/api/sessions/[sessionId]/tool-output/route');
    const content = 'a'.repeat(6000) + '😀MIDDLE' + 'z'.repeat(15000);
    const stored = await storeToolOutput({ identity, toolCallId: 'call', content, format: 'text' });
    if (!stored.ok) throw new Error(stored.error);
    const get = (params: Record<string, string> = {}, sessionId = 'session') => GET(new NextRequest(`https://notebook.test/api/sessions/${sessionId}/tool-output?${new URLSearchParams({ reference: stored.reference, agentId: 'agent', workspaceId: 'workspace', ...params })}`), { params: Promise.resolve({ sessionId }) });
    const first = await get(); assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'private, no-store');
    assert.equal((await first.json()).content.length, 6000);
    const middle = await (await get({ offset: '6001', maxChars: '1000000' })).json();
    assert.equal(middle.offset, 6000); assert.equal(middle.content.length, 10000); assert.ok(middle.content.startsWith('😀MIDDLE'));
    assert.equal(middle.sha256, stored.sha256);
    assert.equal((await get({ offset: '-1' })).status, 400);
    assert.equal((await get({ reference: '/etc/passwd' })).status, 400);
    assert.equal((await get({}, 'foreign')).status, 404);
    assert.equal((await get({ agentId: 'foreign' })).status, 404);
    assert.equal((await get({ workspaceId: 'foreign' })).status, 403);
    agentAllowed = false; assert.equal((await get()).status, 403); agentAllowed = true;
    workspaceAllowed = false; assert.equal((await get()).status, 403); workspaceAllowed = true;
    authenticated = false; assert.equal((await get()).status, 401); authenticated = true;
    const foreign = await storeToolOutput({ identity: { ...identity, sessionId: 'foreign' }, toolCallId: 'foreign', content: 'private', format: 'text' });
    if (!foreign.ok) throw new Error(foreign.error);
    assert.equal((await get({ reference: foreign.reference })).status, 404);
    console.log('tool-output-route-test: ok (real private files, bounded Unicode windows, auth/agent/workspace/session isolation)');
  } finally {
    modules._load = originalLoad;
    if (oldData === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = oldData;
    await fs.rm(data, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
