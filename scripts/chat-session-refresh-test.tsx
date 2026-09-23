import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChatSessionMessages } from '../app/components/canvas-agent-chat/useChatSessionMessages';
import { mapPersistedChatMessages } from '../app/components/canvas-agent-chat/chatMessageMapping';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { ChatMessage, PersistedChatMessage, AISession } from '../app/lib/chat/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
globalThis.requestAnimationFrame = () => 0;
const raw = (sequence: number, text = `message ${sequence}`) => ({ id: sequence, sequence, role: 'user', content: text, timestamp: sequence }) as PersistedChatMessage;
const mapped = (...sequences: number[]) => mapPersistedChatMessages(sequences.map((n) => raw(n)), 'Stopped');
const session = (id: string, workspaceId = 'workspace-a'): AISession => ({ id: 1, sessionId: id, agentId: 'main', title: id, model: '', createdAt: '', workspace: { workspaceId, workspaceName: workspaceId, workspaceType: 'personal' } });
const noop = () => {};
const translate = ((key: string) => key) as Parameters<typeof useChatSessionMessages>[0]['t'];
let controller: ReturnType<typeof useChatSessionMessages>;
let state: { messages: ChatMessage[]; hasMoreBefore: boolean; oldestSequence: number | null; isLoadingOlder: boolean; isLoadingMessages: boolean };
let setLive: (messages: ChatMessage[]) => void;
let live = false;
const pending: { url: URL; signal?: AbortSignal | null; resolve: (value: Response) => void }[] = [];
globalThis.fetch = (input, init) => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname !== '/api/sessions/messages') return Promise.resolve(Response.json({ success: true }));
  return new Promise((resolve) => { pending.push({ url, signal: init?.signal, resolve }); });
};

function Harness({ scope = 'session-a', workspaceId = 'workspace-a', initial = mapped(1, 2, 3) }: { scope?: string; workspaceId?: string; initial?: ChatMessage[] }) {
  const [messages, setMessages] = useState(initial);
  const [sessionId, setSessionId] = useState<string | null>(scope);
  const [hasMoreBefore, setHasMoreBefore] = useState(true);
  const [oldestSequence, setOldestSequence] = useState<number | null>(1);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(1);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(1);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const messagesRef = useRef(messages);
  const sessionIdRef = useRef<string | null>(scope);
  const sessionWorkspaceIdRef = useRef<string | null>(workspaceId);
  const sessionAgentIdRef = useRef('main');
  useLayoutEffect(() => { sessionIdRef.current = scope; sessionWorkspaceIdRef.current = workspaceId; }, [scope, workspaceId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const hydrate = useCallback((next: ChatMessage[]) => { messagesRef.current = next; }, []);
  const stable = useMemo(() => ({
    activeModel: '', activeProvider: '', activeThinkingLevel: 'off' as const,
    deferredSavedMessageRefreshSessionRef: { current: null as string | null },
    ensureSessionSubscribed: async () => {}, hasLiveMessagesInProgress: () => live,
    historyRef: { current: [] as AISession[] }, isAtBottomRef: { current: false },
    refreshSavedMessagesRef: { current: null as ((id: string) => void) | null },
    resetRuntimeMessageRefs: noop, resetStreamConnection: noop,
    resolveSessionTitle: (_id: string, title: string | null | undefined) => title || null,
    runtimeStatus: null, scrollContainerRef: { current: null }, scrollToBottom: noop,
    selectedAgentId: 'main', sessionTitle: null, isMobile: false,
    setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop,
    setExpandedRunKeys: noop, setHasUnreadInCurrentSession: noop, setHistory: noop,
    setInput: noop, setRuntimeStatus: noop, setRuntimeStatusWithReconciliation: noop,
    setLastCompactionMarker: noop, setSelectedAgentId: noop, setSessionTitle: noop,
    setShowHistory: noop, setShowMobileDetails: noop, setShowUnreadBanner: noop,
    setTotalUnreadCount: noop, shouldShowHistoryAsOverlay: false,
    skipNextSessionStatusRefreshRef: { current: null as string | null },
    t: translate, userStartedNewChatRef: { current: false },
    wsRequest: async <T extends Record<string, unknown>>() => ({ success: false }) as unknown as T,
  }), []);
  const api = useChatSessionMessages({ ...stable, activeWorkspaceId: workspaceId,
    messages, messagesRef, setMessages, sessionId, setSessionId, sessionIdRef, sessionWorkspaceIdRef, sessionAgentIdRef,
    hasMoreBefore, setHasMoreBefore, oldestSequence, setOldestSequence, oldestMessageId, setOldestMessageId,
    oldestTimestamp, setOldestTimestamp, isLoadingOlder, setIsLoadingOlder, hydrateRuntimeMessageRefs: hydrate,
  });
  useEffect(() => { controller = api; state = { messages, hasMoreBefore, oldestSequence, isLoadingOlder, isLoadingMessages: api.isLoadingMessages }; setLive = setMessages; }, [api, messages, hasMoreBefore, oldestSequence, isLoadingOlder]);
  return <span>{messages.map((m) => m.content).join('|')}</span>;
}

async function respondWithMessages(index: number, messages: PersistedChatMessage[]) {
  await act(async () => {
    const first = messages[0];
    pending[index].resolve(Response.json({ success: true, messages, hasMoreBefore: (first?.sequence ?? 1) > 1,
      oldestSequence: first?.sequence ?? null, oldestMessageId: Number(first?.id ?? 0) || null,
      oldestTimestamp: first && 'timestamp' in first ? first.timestamp : null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function respond(index: number, sequences: number[]) {
  await respondWithMessages(index, sequences.map((n) => raw(n)));
}
const ids = () => state.messages.map((m) => m.id);

async function main() {
  const { render, cleanup } = await import('@testing-library/react');

  render(<Harness />);
  await act(async () => { controller.refreshSavedMessages('session-a'); controller.refreshSavedMessages('session-a'); controller.refreshSavedMessages('session-a'); });
  assert.equal(pending.length, 1, 'same-scope notifications share one active fetch');
  await respond(0, [2, 3]);
  assert.equal(pending.length, 2, 'notifications during a request cause exactly one trailing fetch');
  await respond(1, [3, 4]);
  assert.deepEqual(ids(), ['1', '2', '3', '4'], 'refresh retains loaded earlier history');
  assert.equal(state.oldestSequence, 1, 'retained history keeps its earlier cursor');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  await act(async () => {
    live = true;
    setLive([...mapped(1, 2, 3), { id: 'live', role: 'assistant', status: 'sending', content: 'new live content', piMessage: { role: 'assistant', timestamp: 4 } as ChatMessage['piMessage'] }]);
    pending[0].resolve(Response.json({ success: true, messages: [raw(1), raw(2)] }));
  });
  assert.ok(ids().includes('live'), 'same-tick live updates survive an older response');
  assert.equal(pending.length, 1, 'snapshot reconciliation preserves live content without redundant reads');
  await act(async () => { live = false; setLive([...state.messages.slice(0, -1), { id: 'live', role: 'assistant', status: 'sent', content: 'complete', piMessage: { role: 'assistant', timestamp: 4 } as ChatMessage['piMessage'] }]); });
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  assert.equal(pending.length, 2);
  await respondWithMessages(1, [raw(1), raw(2), raw(3), { ...raw(4), role: 'assistant', content: [{ type: 'text', text: 'complete' }] } as PersistedChatMessage]);
  assert.deepEqual(ids(), ['1', '2', '3', '4']);
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  await act(async () => {
    setLive([...mapped(1, 2, 3), { id: 'new', role: 'assistant', status: 'sent', content: 'completed same tick' }]);
    pending[0].resolve(Response.json({ success: true, messages: [raw(1), raw(2)] }));
  });
  assert.ok(ids().includes('new'), 'functional updater fences a same-tick update even when runtime already reports idle');
  assert.equal(pending.length, 1, 'safe incoming history merges without rejecting the entire snapshot');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  let view = render(<Harness />);
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  // CanvasAgentChat cancels the consumer when handling workspace navigation.
  await act(async () => { controller.cancelSessionLoad(); });
  view.rerender(<Harness workspaceId="workspace-b" />);
  await respond(0, [80, 81]);
  assert.deepEqual(ids(), ['1', '2', '3'], 'same session id in another workspace rejects old refresh');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  view = render(<Harness />);
  await act(async () => { void controller.loadOlderMessages(); void controller.loadOlderMessages(); });
  assert.equal(pending.length, 1, 'same-tick older-page requests are deduplicated');
  view.rerender(<Harness scope="session-b" />);
  await respond(0, [80, 81]);
  assert.deepEqual(ids(), ['1', '2', '3'], 'older pages cannot leak into another session');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { void controller.loadSession(session('session-load')); });
  await act(async () => { live = true; setLive([{ id: 'live', role: 'assistant', content: 'stream', status: 'sending' }]); });
  await respond(0, [1, 2]);
  assert.deepEqual(ids(), ['1', '2', 'live'], 'initial history merges without overwriting a newly started live turn');
  assert.equal(state.messages.at(-1)?.content, 'stream');
  assert.equal(state.isLoadingMessages, false);
  live = false; cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { void controller.loadSession(session('load-status-reconciled')); });
  await act(async () => { setLive([...state.messages]); });
  await respond(0, [1, 2]);
  assert.deepEqual(ids(), ['1', '2'], 'status reconciliation that only copies the message array still accepts history');
  assert.equal(pending.length, 1, 'empty initial state accepts history without another fetch');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { void controller.loadSession(session('load-noop')); });
  await act(async () => { setLive([{ id: 'live-complete', role: 'assistant', status: 'sent', content: 'completed response' }]); });
  await respond(0, [1, 2]);
  assert.equal(pending.length, 1, 'completed live content and initial history reconcile in one read');
  assert.deepEqual(ids(), ['1', '2', 'live-complete'], 'initial load retains completed live content');
  assert.equal(state.isLoadingMessages, false, 'initial loading state always finishes');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { void controller.loadSession(session('first')); });
  await act(async () => { void controller.loadSession(session('second')); });
  // The query network request can remain alive for another consumer; this
  // hook's cancelled consumer must nevertheless reject its eventual response.
  await respond(1, [20, 21]);
  await respond(0, [10, 11]);
  assert.deepEqual(ids(), ['20', '21'], 'late initial-load response cannot overwrite a newer session');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  const toolResult = { id: 5, sequence: 5, role: 'toolResult', toolName: 'write', toolCallId: 'tool-metadata',
    content: [{ type: 'text', text: 'Saved document' }], timestamp: 5, isError: false } as PersistedChatMessage;
  const receipt = { version: 1, references: [{ workspaceId: 'workspace-a', path: 'reports/result.odt', kind: 'created', toolCallId: 'tool-metadata' }] };
  render(<Harness initial={mapPersistedChatMessages([toolResult], 'Stopped')} />);
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  await respondWithMessages(0, [{ ...toolResult, details: { chatFileReferences: receipt } } as PersistedChatMessage]);
  assert.deepEqual((state.messages[0].piMessage as { details?: unknown }).details, { chatFileReferences: receipt },
    'metadata-only saved tool receipts must hydrate even when visible text and status are unchanged');
  cleanup(); getNotebookQueryClient().clear(); pending.length = 0;

  render(<Harness />);
  await act(async () => { controller.refreshSavedMessages('session-a'); });
  cleanup();
  const beforeUnmount = state.messages;
  await respond(0, [70]);
  assert.equal(state.messages, beforeUnmount, 'unmounted consumer cannot apply the shared query response');
  getNotebookQueryClient().clear();
  pending.length = 0;
  console.log('chat-session-refresh-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
