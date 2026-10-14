import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import type { AgentProfile } from '../app/lib/chat/types';

// Actual React hook, fetchChatAgents -> fetchWorkspaceAgents, and TanStack
// QueryClient/cache/cancellation. Only BetterAuth delivery and HTTP SafeDTOs
// are controlled. No server ACL, browser, model or provider claim.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chat-list.fixture.invalid', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const agent = (agentId: string, name = agentId): AgentProfile => ({ agentId, name, type: 'special', removable: true, scopeType: 'user',
  revision: 1, workflowVersion: 2, workflowRevision: 1, access: { canUse: true, canEdit: true, canManage: false } });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
type HttpRead = { workspaceId: string; actorId: string | null; signal: AbortSignal | undefined };

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  let actorId: string | null = 'actor-a';
  const session = () => actorId ? { data: { user: { id: actorId }, session: { id: `session-${actorId}` } } } : { data: null };
  loader._load = (name, parent, isMain) => name.endsWith('/auth-client') ? { authClient: { useSession: session } } : originalLoad(name, parent, isMain);
  const { renderHook, act, waitFor, cleanup } = await import('@testing-library/react');
  const { useChatAgentList } = await import('../app/components/canvas-agent-chat/useChatAgentList');
  const { useChatAgentConfig } = await import('../app/components/canvas-agent-chat/useChatAgentConfig');
  const { getNotebookQueryClient } = await import('../app/lib/queries/client');
  const { workspaceQueryKeys } = await import('../app/lib/queries/workspace-queries');
  const { observeOpenedDocumentAuth } = await import('../app/lib/collaboration/opened-document-registry');
  // Disable only garbage-collection timers in this observer-less harness. The
  // actual 30s stale cache, fetchQuery deduplication and cancellation stay intact.
  const client = getNotebookQueryClient();
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, gcTime: Infinity } });
  let preferenceHandler: () => Response | Promise<Response> = () => Response.json({ success: true, data: { lastActiveAgentId: DEFAULT_AGENT_ID } });
  const requests: HttpRead[] = [], responses: Array<ReturnType<typeof deferred<Response>>> = [];
  const ok = (agents: AgentProfile[]) => Response.json({ success: true, data: { agents } });
  let handler: (request: HttpRead) => Response | Promise<Response> = () => ok([agent('existing')]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    if (url.pathname === '/api/user-preferences') { assert.equal(init?.method ?? 'GET', 'GET'); return preferenceHandler(); }
    assert.equal(url.pathname, '/api/agents'); assert.equal(init?.cache, 'no-store');
    const workspaceId = url.searchParams.get('workspaceId'); assert(workspaceId);
    assert.equal(url.searchParams.has('actorId'), false, 'The server authenticates the caller; actor IDs only fence local delivery.');
    const request: HttpRead = { workspaceId, actorId, signal: init?.signal ?? undefined }; requests.push(request);
    return handler(request);
  };
  const hold = () => { const response = deferred<Response>(); responses.push(response); return response; };
  const observe = (next: string | null) => { actorId = next; observeOpenedDocumentAuth(session()); };
  const mount = (workspaceId: string | null = 'workspace-a', nextHandler?: typeof handler, nextActor: string | null = 'actor-a') => {
    cleanup(); getNotebookQueryClient().clear(); requests.length = 0;
    observe(nextActor); handler = nextHandler ?? (() => ok([agent('existing')]));
    return renderHook(({ workspaceId: current }: { workspaceId: string | null }) => useChatAgentList(current), { initialProps: { workspaceId } });
  };
  const ids = (value: ReturnType<typeof useChatAgentList>) => value.availableAgents.map(row => row.agentId);
  let cases = 0;
  try {
    const unavailable = mount('workspace-a', undefined, null);
    assert.deepEqual(ids(unavailable.result.current), []); assert.equal(unavailable.result.current.scopeKey, JSON.stringify([null, 'workspace-a']));
    await act(async () => { await unavailable.result.current.refreshAgents(); assert.equal(unavailable.result.current.acceptCreatedAgent(agent('unexpected')), false); });
    assert.equal(requests.length, 0); await act(async () => { observe('actor-a'); unavailable.rerender({ workspaceId: null }); });
    await act(async () => { await unavailable.result.current.refreshAgents(); assert.equal(unavailable.result.current.acceptCreatedAgent(agent('unexpected')), false); });
    assert.deepEqual(ids(unavailable.result.current), []); assert.equal(requests.length, 0); cases++;

    const initial = mount(); await waitFor(() => assert.deepEqual(ids(initial.result.current), ['existing']));
    assert.equal(requests.length, 1); assert.equal(initial.result.current.scopeKey, JSON.stringify(['actor-a', 'workspace-a']));
    // Real fresh initial data remains reusable on a non-forced refresh.
    await act(async () => { await initial.result.current.refreshAgents(false); }); assert.equal(requests.length, 1);
    assert.equal(getNotebookQueryClient().getQueryState(workspaceQueryKeys.agents('workspace-a'))?.isInvalidated, false);
    await act(async () => { await initial.result.current.refreshAgents(); }); assert.equal(requests.length, 2, 'Default refresh invalidates the actual 30s cache.'); cases++;

    const oldGet = hold(); const acknowledged = agent('created', 'Confirmed creation');
    const exactCache = mount('workspace-a', () => oldGet.promise);
    await waitFor(() => assert.equal(requests.length, 1)); const oldSignal = requests[0].signal; assert(oldSignal);
    assert.equal(getNotebookQueryClient().getQueryState(workspaceQueryKeys.agents('workspace-a'))?.fetchStatus, 'fetching');
    await act(async () => { assert.equal(exactCache.result.current.acceptCreatedAgent(acknowledged), true); });
    assert.deepEqual(ids(exactCache.result.current), ['created']);
    handler = () => Response.json({ success: false, error: 'Controlled refresh outage' }, { status: 503 });
    await act(async () => { await assert.rejects(exactCache.result.current.refreshAgents(), /Failed to load chat agents/u); });
    assert.equal(requests.length, 2, 'Post-ack refresh starts a genuine second HTTP request instead of deduplicating onto the old fetchQuery.');
    assert(oldSignal.aborted, 'The exact earlier TanStack query was cancelled before the new fetch.');
    assert.deepEqual(ids(exactCache.result.current), ['created'], 'An acknowledged identity stays selectable when refresh fails.');
    await act(async () => { oldGet.resolve(ok([agent('obsolete')])); });
    assert.deepEqual(ids(exactCache.result.current), ['created']);
    handler = () => ok([agent('created', 'Current renamed agent'), agent('later')]);
    await act(async () => { await exactCache.result.current.refreshAgents(); });
    assert.deepEqual(ids(exactCache.result.current), ['created', 'later']); assert.equal(exactCache.result.current.availableAgents[0].name, 'Current renamed agent');
    handler = () => ok([agent('later')]); await act(async () => { await exactCache.result.current.refreshAgents(); });
    assert.deepEqual(ids(exactCache.result.current), ['later'], 'A genuinely later current list may remove a revoked/unavailable agent.'); cases++;

    const sharedRead = hold();
    const leaving = mount('workspace-a', () => sharedRead.promise);
    const remaining = renderHook(() => useChatAgentList('workspace-a'));
    await waitFor(() => assert.equal(requests.length, 1));
    assert.equal(getNotebookQueryClient().getQueryCache().find({ queryKey: workspaceQueryKeys.agents('workspace-a'), exact: true })?.getObserversCount(), 2);
    const sharedSignal = requests[0].signal; leaving.unmount(); assert.equal(sharedSignal?.aborted, false,
      'Leaving one surface cannot cancel the read still observed by Home/ChatDock.');
    await act(async () => { sharedRead.resolve(ok([agent('shared-current')])); });
    await waitFor(() => assert.deepEqual(ids(remaining.result.current), ['shared-current'])); assert.equal(requests.length, 1); cases++;

    const sharedOldRead = hold();
    const creator = mount('workspace-a', () => sharedOldRead.promise);
    const peer = renderHook(() => useChatAgentList('workspace-a'));
    await waitFor(() => assert.equal(requests.length, 1));
    await act(async () => { assert(creator.result.current.acceptCreatedAgent(agent('shared-ack'))); });
    assert.deepEqual(ids(creator.result.current), ['shared-ack']); assert.deepEqual(ids(peer.result.current), ['shared-ack'],
      'Acknowledgement is seeded in the common actual cache, not one consumer’s private list.');
    handler = () => Response.json({ success: false }, { status: 503 });
    await act(async () => { await assert.rejects(creator.result.current.refreshAgents(), /Failed to load chat agents/u); });
    assert.equal(requests.length, 2); assert.deepEqual(ids(peer.result.current), ['shared-ack']);
    await act(async () => { sharedOldRead.resolve(ok([agent('obsolete-shared')])); });
    assert.deepEqual(ids(creator.result.current), ['shared-ack']); assert.deepEqual(ids(peer.result.current), ['shared-ack']);
    handler = () => ok([agent('shared-ack', 'Genuine current rename'), agent('shared-peer')]);
    await act(async () => { await creator.result.current.refreshAgents(); });
    assert.equal(peer.result.current.availableAgents[0].name, 'Genuine current rename');
    handler = () => ok([agent('shared-peer')]);
    await act(async () => { await creator.result.current.refreshAgents(); });
    assert.deepEqual(ids(creator.result.current), ['shared-peer']); assert.deepEqual(ids(peer.result.current), ['shared-peer'],
      'A later genuine list also revokes membership in a silent already-loaded peer.'); cases++;

    const upsert = mount(); await waitFor(() => assert.deepEqual(ids(upsert.result.current), ['existing']));
    await act(async () => { assert(upsert.result.current.acceptCreatedAgent(agent('created'))); });
    await act(async () => { assert(upsert.result.current.acceptCreatedAgent(agent('created', 'Updated ack'))); });
    assert.deepEqual(ids(upsert.result.current), ['existing', 'created']); assert.equal(upsert.result.current.availableAgents[1].name, 'Updated ack'); cases++;

    const workspaceA = hold(), workspaceB = hold(), returnA = hold(); let aReads = 0;
    const switched = mount('workspace-a', request => request.workspaceId === 'workspace-b' ? workspaceB.promise : ++aReads === 1 ? workspaceA.promise : returnA.promise);
    await waitFor(() => assert.equal(requests.length, 1)); const staleRefresh = switched.result.current.refreshAgents, staleAccept = switched.result.current.acceptCreatedAgent;
    const oldScopeKey = switched.result.current.scopeKey;
    await act(async () => { switched.rerender({ workspaceId: 'workspace-b' }); });
    assert.deepEqual(ids(switched.result.current), []); await waitFor(() => assert.equal(requests.length, 2));
    const beforeStale = requests.length;
    await act(async () => { await staleRefresh(); assert.equal(staleAccept(agent('late-created')), false); });
    assert.equal(requests.length, beforeStale, 'An old closure cannot even start I/O in another workspace.');
    await act(async () => { workspaceB.resolve(ok([agent('workspace-b-agent')])); });
    assert.deepEqual(ids(switched.result.current), ['workspace-b-agent']);
    await act(async () => { switched.rerender({ workspaceId: 'workspace-a' }); });
    assert.deepEqual(ids(switched.result.current), []); assert.equal(switched.result.current.scopeKey, oldScopeKey);
    await waitFor(() => assert.equal(requests.length, 3));
    await act(async () => { workspaceA.resolve(ok([agent('stale-first-a')])); });
    assert.deepEqual(ids(switched.result.current), []); assert.equal(staleAccept(agent('old-a-closure')), false, 'A -> B -> A cannot reactivate the original closure.');
    await act(async () => { returnA.resolve(ok([agent('fresh-return-a')])); });
    assert.deepEqual(ids(switched.result.current), ['fresh-return-a']); cases++;

    const actorA = hold(), actorB = hold();
    const actorView = mount('workspace-a', request => request.actorId === 'actor-a' ? actorA.promise : actorB.promise);
    await waitFor(() => assert.equal(requests.length, 1)); const previous = actorView.result.current;
    await act(async () => { observe('actor-b'); actorView.rerender({ workspaceId: 'workspace-a' }); });
    assert.deepEqual(ids(actorView.result.current), []); assert.notEqual(actorView.result.current.scopeKey, previous.scopeKey);
    await waitFor(() => assert.equal(requests.length, 2));
    await act(async () => { await previous.refreshAgents(); assert.equal(previous.acceptCreatedAgent(agent('foreign-ack')), false); actorA.resolve(ok([agent('actor-a-only')])); });
    assert.deepEqual(ids(actorView.result.current), []);
    await act(async () => { actorB.resolve(ok([agent('actor-b-only')])); }); assert.deepEqual(ids(actorView.result.current), ['actor-b-only']); cases++;

    // Keep the actual QueryClient cancellation/invalidation, delaying its boundary
    // completion only, to verify fences after each async stage.
    for (const stage of ['cancelQueries', 'invalidateQueries'] as const) {
      const view = mount(); await waitFor(() => assert.deepEqual(ids(view.result.current), ['existing']));
      const client = getNotebookQueryClient(), cancel = client.cancelQueries.bind(client), invalidate = client.invalidateQueries.bind(client);
      const gate = deferred<void>(); let heldOnce = false;
      const delayCompletion = async (operation: () => Promise<void>) => {
        await operation(); if (!heldOnce) { heldOnce = true; await gate.promise; }
      };
      if (stage === 'cancelQueries') client.cancelQueries = (filters, options) => delayCompletion(() => cancel(filters, options));
      else client.invalidateQueries = (filters, options) => delayCompletion(() => invalidate(filters, options));
      let pending!: Promise<void>;
      try {
        await act(async () => { pending = view.result.current.refreshAgents(); }); await waitFor(() => assert(heldOnce));
        const readsBeforeSwitch = requests.length; await act(async () => { view.rerender({ workspaceId: 'workspace-b' }); });
        await waitFor(() => assert.equal(requests.length, readsBeforeSwitch + 1));
        await act(async () => { gate.resolve(); await pending; });
        assert.equal(requests.filter(request => request.workspaceId === 'workspace-a').length, 1, `Late ${stage} completion must not initiate old-scope fetch.`);
        assert.deepEqual(ids(view.result.current), ['existing']); cases++;
      } finally { gate.resolve(); client.cancelQueries = cancel; client.invalidateQueries = invalidate; }
    }

    cleanup(); getNotebookQueryClient().clear(); requests.length = 0; observe('actor-a');
    const latePreference = hold(); preferenceHandler = () => latePreference.promise;
    handler = () => ok([agent(DEFAULT_AGENT_ID), agent('preferred-old')]);
    const config = renderHook(() => useChatAgentConfig({ initialAgentId: DEFAULT_AGENT_ID, sessionId: null, workspaceId: 'workspace-a' }));
    await waitFor(() => assert.equal(config.result.current.availableAgents.length, 2));
    await act(async () => {
      assert(config.result.current.acceptCreatedAgent(agent('created-for-chat')));
      config.result.current.setSelectedAgentId('created-for-chat');
    });
    assert.equal(config.result.current.selectedAgentId, 'created-for-chat', 'The real selectedAgentId membership check sees the acknowledgement before selection.');
    handler = () => Response.json({ success: false }, { status: 503 });
    await act(async () => { await assert.rejects(config.result.current.refreshAgents(), /Failed to load chat agents/u); });
    assert.equal(config.result.current.selectedAgentId, 'created-for-chat');
    assert(config.result.current.availableAgents.some(row => row.agentId === 'created-for-chat'));
    await act(async () => { latePreference.resolve(Response.json({ success: true, data: { lastActiveAgentId: 'preferred-old' } })); });
    assert.equal(config.result.current.selectedAgentId, 'created-for-chat', 'Late genuine preference HTTP cannot override the explicit Create selection.'); cases++;

    const pendingUnmount = hold(); const unmounted = mount('workspace-a', () => pendingUnmount.promise);
    await waitFor(() => assert.equal(requests.length, 1)); const departed = unmounted.result.current, signal = requests[0].signal;
    unmounted.unmount(); assert(signal?.aborted);
    await act(async () => { await departed.refreshAgents(); assert.equal(departed.acceptCreatedAgent(agent('after-unmount')), false); pendingUnmount.resolve(ok([agent('late')])); });
    assert.equal(requests.length, 1); cases++;

    console.log(`PASS ${cases} actual React agent-list/cache regressions: acknowledged membership before selection, real fetchQuery cancellation and simultaneous shared consumers, refresh failure/current revocation, actor/workspace/A-B-A/late-closure/unmount fences. BetterAuth and HTTP DTOs controlled; real TanStack QueryClient, no backend/authority/browser claim.`);
  } finally {
    for (const response of responses) response.resolve(ok([])); cleanup(); getNotebookQueryClient().clear();
    observeOpenedDocumentAuth(null); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
