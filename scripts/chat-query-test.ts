import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { fetchChatSessionBootstrap, fetchChatSessionMessages, fetchChatSessions, patchChatSessions } from '../app/lib/chat/session-api';

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'user1' }, session: { id: 'auth1' } } });
  const calls: string[] = [];
  let failHistory = false;
  globalThis.fetch = async (url, init) => {
    const path = String(url); calls.push(path);
    if (init?.method === 'PATCH') return Response.json({ success: true });
    assert.ok(init?.signal);
    if (path.includes('/bootstrap?')) return Response.json({ success: true,
      session: { sessionId: 's1', agentId: 'writer', workspace: { workspaceId: 'w1' } },
      messages: { success: true, messages: [{ id: 1, role: 'user', content: 'hello' }] } });
    if (path.startsWith('/api/sessions/messages')) return Response.json({ success: true, messages: [] });
    if (failHistory) return Response.json({ success: false }, { status: 503 });
    return Response.json({ success: true, sessions: [] });
  };
  const bootstrap = await fetchChatSessionBootstrap({ sessionId: 's1', workspaceId: 'w1' });
  assert.equal(bootstrap.session.sessionId, 's1');
  const page = await fetchChatSessionMessages({ sessionId: 's1', agentId: 'writer', workspaceId: 'w1' });
  assert.equal(page?.messages?.length, 1);
  assert.equal(calls.length, 1, 'bootstrap seeds first page without a second request or full history');
  await fetchChatSessionMessages({ sessionId: 's1', agentId: 'writer', workspaceId: 'w1', cache: 'no-store' });
  assert.equal(calls.length, 2, 'live refresh bypasses freshness');
  await fetchChatSessionMessages({ sessionId: 's1', agentId: 'writer', workspaceId: 'w2' });
  assert.equal(calls.length, 3, 'same session cannot cross workspace cache');
  await Promise.all([fetchChatSessions('all', { workspaceId: 'w1' }), fetchChatSessions('all', { workspaceId: 'w1' })]);
  assert.equal(calls.length, 4);
  await patchChatSessions({ sessionId: 's1', workspaceId: 'w1', markAsRead: true });
  await fetchChatSessions('all', { workspaceId: 'w1' });
  assert.equal(calls.length, 6, 'mutation invalidates list');
  failHistory = true;
  await assert.rejects(fetchChatSessions('all', { workspaceId: 'error' }), /history/);
  getNotebookQueryClient().clear();
  console.log('chat-query-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
