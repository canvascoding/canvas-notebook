import assert from 'node:assert/strict';
import React, { useRef } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '../messages/en.json';
import { useChatSessionHistory } from '../app/components/canvas-agent-chat/useChatSessionHistory';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { AISession } from '../app/lib/chat/types';

// Actual History hook and query client, with only the bounded history HTTP read
// controlled. Retention is UI identity, never SQL/source/runtime authorization.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://current-history.fixture.invalid' });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const noop = () => {};
const session = (id: string, workspaceId = 'workspace-a', timestamp = '2026-01-01T00:00:00.000Z'): AISession => ({
  id: id === 'old-A' ? 1 : 2, sessionId: id, agentId: 'actual-specialist', title: id, model: 'model-a', engine: 'pi', createdAt: timestamp,
  workspace: { workspaceId, workspaceType: 'personal', workspaceName: workspaceId }, hasUnread: false,
});
const oldA = session('old-A'), oldB = session('old-B');
const page = (workspaceId = 'workspace-a') => Array.from({ length: 100 }, (_, index) => session(`recent-${index}`, workspaceId, '2026-10-14T00:00:00.000Z'));

async function main() {
  const { render, act, cleanup, waitFor } = await import('@testing-library/react');
  let current!: ReturnType<typeof useChatSessionHistory>;
  let activeId!: React.RefObject<string | null>, activeAgent!: React.RefObject<string>;
  let respond = async () => Response.json({ success: true, sessions: page() }), reads = 0, cases = 0, authNumber = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input), dom.window.location.href);
    assert.equal(url.pathname, '/api/sessions'); assert.equal(url.searchParams.get('agentId'), 'all'); reads++;
    return respond();
  };
  function Harness({ workspaceId }: { workspaceId: string }) {
    const id = useRef<string | null>(oldA.sessionId), agent = useRef(oldA.agentId!);
    const optimistic = useRef({}), refresh = useRef(null), visible = useRef(true);
    const t = useTranslations('chat');
    const history = useChatSessionHistory({ activeWorkspaceId: workspaceId, availableAgents: [], optimisticSessionTitlesRef: optimistic,
      requestSavedMessageRefreshRef: refresh, selectedAgentId: 'bradley', sessionAgentIdRef: agent, sessionIdRef: id,
      setHasUnreadInCurrentSession: noop, setSessionTitle: noop, setShowUnreadBanner: noop, surfaceVisibleRef: visible, t });
    current = history; activeId = id; activeAgent = agent;
    return null;
  }
  const wrap = (workspaceId = 'workspace-a') => <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><Harness workspaceId={workspaceId} /></NextIntlClientProvider>;
  const mount = async () => {
    cleanup(); getNotebookQueryClient().clear(); reads = 0; respond = async () => Response.json({ success: true, sessions: page() });
    observeOpenedDocumentAuth({ data: { user: { id: `history-user-${++authNumber}` }, session: { id: `history-auth-${authNumber}` } } });
    const view = render(wrap()); await act(async () => current.addSessionToHistory(oldA)); return view;
  };
  const fetchPage = async () => { getNotebookQueryClient().clear(); await act(async () => current.fetchHistory()); };
  try {
    await mount(); await fetchPage();
    assert.equal(reads, 1); assert.equal(current.history.length, 101);
    assert.deepEqual(current.history.find(value => value.sessionId === oldA.sessionId), oldA);
    assert.equal(current.historyRef.current, current.history);
    cases++; console.log('PASS actual bounded 100-row HTTP refresh retains only the explicitly loaded current session identity');

    await mount(); const fresh = { ...oldA, title: 'Fresh server metadata', model: 'new-model', agentId: 'fresh-actual-agent' };
    respond = async () => Response.json({ success: true, sessions: [fresh, ...page().slice(0, 99)] }); await fetchPage();
    assert.deepEqual(current.history.find(value => value.sessionId === oldA.sessionId), fresh);
    assert.equal(current.history.length, 100);
    cases++; console.log('PASS a fresh server row wins completely over older loaded metadata');

    await mount(); await act(async () => current.addSessionToHistory(oldB));
    let release!: (response: Response) => void; respond = () => new Promise<Response>(resolve => { release = resolve; });
    getNotebookQueryClient().clear(); let refreshing!: Promise<void>;
    await act(async () => { refreshing = current.fetchHistory(); }); await waitFor(() => assert.equal(reads, 1));
    await act(async () => { activeId.current = oldB.sessionId; activeAgent.current = oldB.agentId!; });
    await act(async () => { release(Response.json({ success: true, sessions: page() })); await refreshing; });
    assert(current.history.some(value => value.sessionId === oldB.sessionId));
    assert(!current.history.some(value => value.sessionId === oldA.sessionId)); assert.equal(current.history.length, 101);
    cases++; console.log('PASS A→B during a held HTTP refresh retains only the now-current B, never request-start A');

    await mount(); await act(async () => current.setHistory(previous => previous.filter(value => value.sessionId !== oldA.sessionId)));
    await fetchPage(); assert(!current.history.some(value => value.sessionId === oldA.sessionId));
    assert.equal(current.history.length, 100);
    cases++; console.log('PASS explicit local deletion cannot be resurrected by the retention merge even if the current ID ref has not cleared yet');

    for (const mode of ['epoch', 'actor'] as const) {
      await mount(); await act(async () => {
        if (mode === 'epoch') invalidateOpenedDocumentAuth();
        else observeOpenedDocumentAuth({ data: { user: { id: 'foreign-history-user' }, session: { id: 'foreign-history-auth' } } });
      });
      assert.equal(current.history.length, 0, 'A new actual sign-in scope clears prior UI history before another read.');
      await fetchPage(); assert(!current.history.some(value => value.sessionId === oldA.sessionId));
    }
    cases++; console.log('PASS actor and same-session auth-epoch changes cannot retain an earlier scope identity');

    const view = await mount(); view.rerender(wrap('workspace-b'));
    await act(async () => {}); assert.equal(current.history.length, 0);
    respond = async () => Response.json({ success: true, sessions: page('workspace-b') }); await fetchPage();
    assert(!current.history.some(value => value.sessionId === oldA.sessionId)); assert.equal(current.history.length, 100);
    cases++; console.log('PASS workspace changes reset retention without manufacturing a missing current session');
    console.log(JSON.stringify({ status: 'PASS', cases, database: false, browser: false, provider: false, authority: false }));
  } finally { cleanup(); getNotebookQueryClient().clear(); globalThis.fetch = originalFetch; observeOpenedDocumentAuth(null); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
