import assert from 'node:assert/strict';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { fetchChatAgents } from '../app/lib/chat/agent-api';
import { fetchLastActiveAgentId, saveLastActiveAgentId } from '../app/lib/chat/agent-preferences';
import { fetchEffectiveRuntime } from '../app/lib/queries/workspace-queries';
import { getNotebookQueryClient } from '../app/lib/queries/client';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  observeOpenedDocumentAuth({ data: { user: { id: 'query-user-a' }, session: { id: 'query-session-a' } } });
  const requests: string[] = [];
  let preference = 'bradley';
  let failAgents = false;
  let releaseRuntime: (() => void) | undefined;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const resolution = { catalogRevision: 1, policyRevision: 2, providers: [], issues: [] };

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    assert.ok(init?.method === 'PATCH' || init?.signal instanceof AbortSignal, 'reads must forward query cancellation');
    if (url.startsWith('/api/agents?')) {
      if (failAgents) return Response.json({ success: false }, { status: 503 });
      return Response.json({ success: true, data: { agents: [{ agentId: 'bradley' }] } });
    }
    if (url === '/api/user-preferences') {
      if (init?.method === 'PATCH') preference = JSON.parse(String(init.body)).lastActiveAgentId;
      return Response.json({ success: true, data: { lastActiveAgentId: preference } });
    }
    if (url.startsWith('/api/agent-runtime/effective?')) {
      await runtimeGate;
      return Response.json({ success: true, resolution });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const [first, second] = await Promise.all([fetchChatAgents('workspace-a'), fetchChatAgents('workspace-a')]);
    assert.deepEqual(first, second);
    await fetchChatAgents('workspace-a');
    assert.equal(requests.length, 1, 'parallel and fresh reads share an agent query');
    await fetchChatAgents('workspace-b');
    assert.equal(requests.length, 2, 'workspace data is isolated');

    observeOpenedDocumentAuth({ data: { user: { id: 'query-user-b' }, session: { id: 'query-session-b' } } });
    await fetchChatAgents('workspace-a');
    assert.equal(requests.length, 3, 'new authenticated user cannot reuse the previous agent result');
    failAgents = true;
    await assert.rejects(fetchChatAgents('workspace-error'), /Failed to load chat agents/);
    failAgents = false;
    await fetchChatAgents('workspace-error');
    assert.equal(requests.length, 5, 'failed queries are retried on the next explicit request');

    assert.equal(await fetchLastActiveAgentId(), 'bradley');
    assert.equal(await fetchLastActiveAgentId(), 'bradley');
    assert.equal(requests.filter((request) => request === 'GET /api/user-preferences').length, 1);
    await saveLastActiveAgentId('writer');
    assert.equal(await fetchLastActiveAgentId(), 'writer', 'successful mutation invalidates the shared preference');

    const controller = new AbortController();
    const context = { workspaceId: 'workspace-a', agentId: 'writer', sessionId: null };
    const cancelled = fetchEffectiveRuntime(context, controller.signal);
    const remaining = fetchEffectiveRuntime(context);
    controller.abort();
    await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
    releaseRuntime?.();
    assert.deepEqual(await remaining, resolution, 'leaving one panel must not cancel another panel shared read');
    await fetchEffectiveRuntime(context);
    assert.equal(requests.filter((request) => request.includes('/api/agent-runtime/effective?')).length, 1);
    console.log('workspace-query-test: ok');
  } finally {
    getNotebookQueryClient().clear();
    globalThis.fetch = originalFetch;
    observeOpenedDocumentAuth(null);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
