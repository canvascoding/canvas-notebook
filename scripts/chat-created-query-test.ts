import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { createChatSession, fetchChatSessionBootstrap, fetchChatSessionMessages } from '../app/lib/chat/session-api';

async function main() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'user1' }, session: { id: 'auth1' } } });
  let created = true;
  let requests = 0;
  let switchAuth = false;
  globalThis.fetch = async (_url, init) => {
    requests += 1;
    if (init?.method === 'POST') {
      if (switchAuth) observeOpenedDocumentAuth({ data: { user: { id: 'user2' }, session: { id: 'auth2' } } });
      return Response.json({ success: true, created, session: {
        id: 1, sessionId: 's1', agentId: 'writer', createdAt: new Date().toISOString(), workspace: { workspaceId: 'w1' },
      } });
    }
    return Response.json({ success: true, messages: [{ id: 1, role: 'user', content: 'persisted' }] });
  };
  await createChatSession({ agentId: 'writer', workspaceId: 'w1', clientRequestId: 'draft1' });
  await fetchChatSessionBootstrap({ sessionId: 's1', workspaceId: 'w1' });
  assert.deepEqual((await fetchChatSessionMessages({ sessionId: 's1', agentId: 'writer', workspaceId: 'w1' }))?.messages, []);
  assert.equal(requests, 1, 'fresh creation supplies bootstrap and first empty page');
  getNotebookQueryClient().clear();
  created = false;
  await createChatSession({ agentId: 'writer', workspaceId: 'w1', clientRequestId: 'draft1' });
  assert.equal((await fetchChatSessionMessages({ sessionId: 's1', agentId: 'writer', workspaceId: 'w1' }))?.messages?.length, 1);
  assert.equal(requests, 3, 'replay must not invent an empty history');
  created = true;
  switchAuth = true;
  await createChatSession({ agentId: 'writer', workspaceId: 'w1', clientRequestId: 'draft2' });
  assert.equal(getNotebookQueryClient().getQueryCache().getAll().length, 0, 'late creation cannot seed another account cache');
  getNotebookQueryClient().clear();
  console.log('chat-created-query-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
