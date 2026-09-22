import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatSessionMessages } from '../app/components/canvas-agent-chat/useChatSessionMessages';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { AISession, ChatMessage } from '../app/lib/chat/types';

type Params = Parameters<typeof useChatSessionMessages>[0];
const noop = () => undefined;
const ref = <T,>(current: T) => ({ current });
const sessionIdRef = ref<string | null>(null);
const agentRef = ref('bradley');
const workspaceRef = ref<string | null>('workspace-a');
const messagesRef = ref<ChatMessage[]>([]);
let exposed!: ReturnType<typeof useChatSessionMessages> & { messages: ChatMessage[]; loadingOlder: boolean; injectLive: () => void };
const base = {
  activeModel: '', activeProvider: '', activeThinkingLevel: 'off',
  deferredSavedMessageRefreshSessionRef: ref<string | null>(null),
  ensureSessionSubscribed: async () => undefined,
  hasLiveMessagesInProgress: () => false,
  historyRef: ref<AISession[]>([]),
  hydrateRuntimeMessageRefs: (messages: ChatMessage[]) => { messagesRef.current = messages; },
  isAtBottomRef: ref(true), isMobile: false,
  messagesRef, refreshSavedMessagesRef: ref<((sessionId: string) => void) | null>(null),
  resetRuntimeMessageRefs: noop, resetStreamConnection: noop,
  resolveSessionTitle: (_id: string, title: string | null) => title,
  runtimeStatus: null, scrollContainerRef: ref(null), scrollToBottom: noop,
  selectedAgentId: 'bradley', sessionAgentIdRef: agentRef, sessionIdRef,
  sessionWorkspaceIdRef: workspaceRef, sessionTitle: null,
  setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop,
  setExpandedRunKeys: noop, setHasUnreadInCurrentSession: noop,
  setHistory: noop, setInput: noop, setRuntimeStatus: noop,
  setRuntimeStatusWithReconciliation: noop, setLastCompactionMarker: noop,
  setSelectedAgentId: noop, setSessionTitle: noop, setShowHistory: noop,
  setShowMobileDetails: noop, setShowUnreadBanner: noop, setTotalUnreadCount: noop,
  shouldShowHistoryAsOverlay: false, skipNextSessionStatusRefreshRef: ref(null),
  t: (key: string) => key, userStartedNewChatRef: ref(false),
  wsRequest: async () => ({ success: true }),
};
function Harness({ workspaceId }: { workspaceId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const [oldestSequence, setOldestSequence] = useState<number | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const hooks = useChatSessionMessages({ ...base, activeWorkspaceId: workspaceId,
    messages, setMessages, sessionId, setSessionId, hasMoreBefore, setHasMoreBefore,
    oldestTimestamp, setOldestTimestamp, oldestMessageId, setOldestMessageId,
    oldestSequence, setOldestSequence, isLoadingOlder, setIsLoadingOlder,
  } as unknown as Params);
  useLayoutEffect(() => { exposed = { ...hooks, messages, loadingOlder: isLoadingOlder,
    injectLive: () => setMessages((current) => [...current, {
      id: 'live-assistant', role: 'assistant', status: 'sending', content: 'Newest streaming content',
      piMessage: { role: 'assistant', timestamp: 10100, content: [] } as unknown as ChatMessage['piMessage'],
    }]),
  }; });
  return <div>{messages.map((message) => message.content).join('|')}</div>;
}
function session(sessionId: string): AISession {
  return { id: 1, sessionId, agentId: 'bradley', model: '', title: sessionId,
    createdAt: new Date().toISOString(), engine: 'pi',
    workspace: { workspaceId: 'workspace-a', workspaceType: 'personal', workspaceName: 'A', organizationId: null, rootRelativePath: null, legacy: false },
  };
}
function page(id: number, content: string, hasMoreBefore = false) {
  return Response.json({ success: true, hasMoreBefore, oldestSequence: id,
    oldestMessageId: id, oldestTimestamp: id * 100,
    messages: [{ id, sequence: id, role: 'user', content, timestamp: id * 100 }],
  });
}
async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  });
  observeOpenedDocumentAuth({ data: { user: { id: 'race-user' }, session: { id: 'race-auth' } } });
  const pending: Array<{ url: URL; resolve: (response: Response) => void }> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/user-preferences') return Response.json({ success: true });
    if (url.pathname === '/api/sessions/messages') {
      return new Promise<Response>((resolve) => { pending.push({ url, resolve }); });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(<Harness workspaceId="workspace-a" />); });
  const take = (sessionId: string, older = false) => {
    const index = pending.findIndex(({ url }) => url.searchParams.get('sessionId') === sessionId
      && url.searchParams.has('beforeSequence') === older);
    assert.ok(index >= 0, `Expected ${older ? 'older' : 'current'} request for ${sessionId}`);
    return pending.splice(index, 1)[0];
  };
  let load!: Promise<void>;
  await act(async () => { load = exposed.loadSession(session('race-a')); });
  assert.equal(exposed.isLoadingMessages, true);
  assert.equal(exposed.messages.length, 0, 'initial load is real state, not a synthetic chat message');
  await act(async () => { take('race-a').resolve(page(50, 'A', true)); await load; });
  assert.equal(exposed.isLoadingMessages, false);
  let older!: Promise<void>;
  await act(async () => { older = exposed.loadOlderMessages(); });
  assert.equal(exposed.loadingOlder, true);
  const staleOlder = take('race-a', true);
  await act(async () => { load = exposed.loadSession(session('race-b')); });
  await act(async () => { take('race-b').resolve(page(100, 'B')); await load; });
  await act(async () => { staleOlder.resolve(page(1, 'OLD A')); await older; });
  assert.deepEqual(exposed.messages.map((message) => message.content), ['B'], 'late A pagination cannot enter B');
  assert.equal(exposed.loadingOlder, false);

  await act(async () => { exposed.refreshSavedMessages('race-b'); exposed.refreshSavedMessages('race-b'); });
  assert.equal(pending.length, 1, 'refresh events share one in-flight request');
  await act(async () => { exposed.injectLive(); });
  await act(async () => {
    take('race-b').resolve(Response.json({ success: true, hasMoreBefore: false,
      oldestSequence: 100, oldestMessageId: 100, oldestTimestamp: 10000,
      messages: [
        { id: 100, sequence: 100, role: 'user', content: 'B', timestamp: 10000 },
        { id: 101, sequence: 101, role: 'assistant', content: [{ type: 'text', text: 'Stale partial content' }], timestamp: 10100 },
      ],
    }));
  });
  assert.equal(exposed.messages.length, 2, 'persisted and live version of the same message are not duplicated');
  assert.equal(exposed.messages[1].content, 'Newest streaming content', 'HTTP response cannot overwrite live event received while request was pending');
  assert.equal(pending.length, 1, 'events during a refresh coalesce into one follow-up');
  const staleRefresh = take('race-b');
  await act(async () => { root.render(<Harness workspaceId="workspace-b" />); });
  await act(async () => { staleRefresh.resolve(page(102, 'WRONG WORKSPACE')); });
  assert.ok(!exposed.messages.some((message) => message.content === 'WRONG WORKSPACE'), 'same session ID in another workspace rejects old response');

  await act(async () => { exposed.cancelSessionLoad(); root.unmount(); });
  getNotebookQueryClient().clear();
  dom.window.close();
  console.log('chat-message-request-race-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
