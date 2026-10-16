import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatSessionMessages } from '../app/components/canvas-agent-chat/useChatSessionMessages';
import { useChatRuntimeEvents } from '../app/components/canvas-agent-chat/useChatRuntimeEvents';
import { mapPersistedChatMessages } from '../app/components/canvas-agent-chat/chatMessageMapping';
import { buildCachedChatSessionEntry, rememberChatSessionCacheEntry } from '../app/lib/chat/session-cache';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import type { AISession, ChatEvent, ChatMessage, PersistedChatMessage } from '../app/lib/chat/types';

// Real cache, mapper, session reader and runtime-event hooks. HTTP history and
// WebSocket events are controlled UI boundaries; no SQL/model authority is issued.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://cache-placeholder.fixture.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent'] as const)
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
const noop = () => {};
const t = ((key: string) => key) as Parameters<typeof useChatSessionMessages>[0]['t'];
const session = (id: string): AISession => ({ id: 1, sessionId: id, agentId: 'bradley', title: 'Actual cached chat',
  model: 'fixture-model', provider: 'fixture-provider', engine: 'pi', createdAt: new Date().toISOString(),
  workspace: { workspaceId: 'workspace-a', workspaceName: 'A', workspaceType: 'personal' } });
const status = (id: string, phase: RuntimeStatus['phase'] = 'idle'): RuntimeStatus => ({ sessionId: id, revision: phase === 'idle' ? 1 : 2,
  phase, activeTool: null, pendingToolCalls: 0, followUpQueue: [], steeringQueue: [], canAbort: phase !== 'idle', contextWindow: 1000,
  estimatedHistoryTokens: 10, availableHistoryTokens: 990, contextUsagePercent: 1, includedSummary: false, omittedMessageCount: 0,
  summaryUpdatedAt: null, lastCompactionAt: null, lastCompactionKind: null, lastCompactionOmittedCount: 0 });
const rawUser = { id: 1, sequence: 1, role: 'user', content: 'Original request', timestamp: 1 } as PersistedChatMessage;
const rawAssistant = { id: 2, sequence: 2, role: 'assistant', content: [{ type: 'text', text: 'Completed answer' }], timestamp: 2,
  stopReason: 'stop', api: 'fixture', provider: 'fixture-provider', model: 'fixture-model' } as Extract<PersistedChatMessage, { role: 'assistant' }>;
const pending: Array<(value: Response) => void> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(String(input), dom.window.location.href);
  if (url.pathname === '/api/user-preferences') return Response.json({ success: true });
  assert.equal(url.pathname, '/api/sessions/messages');
  return new Promise<Response>(resolve => { pending.push(resolve); });
};
let exposed!: { reader: ReturnType<typeof useChatSessionMessages>; runtime: ReturnType<typeof useChatRuntimeEvents>; messages: ChatMessage[] };
function Harness() {
  const [messages, setMessages] = useState<ChatMessage[]>([]), [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<AISession[]>([]), [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<number | null>(null), [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const [oldestSequence, setOldestSequence] = useState<number | null>(null), [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const id = useRef<string | null>(null), agent = useRef('bradley'), workspace = useRef<string | null>('workspace-a');
  const historyRef = useRef(history), messagesRef = useRef(messages), bottom = useRef(false);
  const deferred = useRef<string | null>(null), refresh = useRef<((id: string) => void) | null>(null);
  const skipRefresh = useRef<string | null>(null), newChat = useRef(false), scroll = useRef<HTMLDivElement | null>(null);
  useEffect(() => { messagesRef.current = messages; historyRef.current = history; }, [history, messages]);
  const runtime = useChatRuntimeEvents({ deferredSavedMessageRefreshSessionRef: deferred, refreshSavedMessagesRef: refresh,
    historyRef, isAtBottomRef: bottom, messages, scrollToBottom: noop, sessionIdRef: id, setHistory, setMessages, t });
  const reader = useChatSessionMessages({ activeModel: 'fixture-model', activeProvider: 'fixture-provider', activeThinkingLevel: 'off',
    activeWorkspaceId: 'workspace-a', deferredSavedMessageRefreshSessionRef: deferred, ensureSessionSubscribed: async () => {},
    hasLiveMessagesInProgress: runtime.hasLiveMessagesInProgress, hasMoreBefore, historyRef,
    hydrateRuntimeMessageRefs: runtime.hydrateRuntimeMessageRefs, isAtBottomRef: bottom, isLoadingOlder, isMobile: false,
    messages, messagesRef, oldestMessageId, oldestSequence, oldestTimestamp, refreshSavedMessagesRef: refresh,
    resetRuntimeMessageRefs: runtime.resetRuntimeMessageRefs, resetStreamConnection: runtime.resetStreamConnection,
    resolveSessionTitle: (_id, title) => title ?? null, runtimeStatus: runtime.runtimeStatus, scrollContainerRef: scroll,
    scrollToBottom: noop, selectedAgentId: 'bradley', sessionAgentIdRef: agent, sessionId, sessionIdRef: id,
    sessionWorkspaceIdRef: workspace, sessionTitle: null, setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop,
    setExpandedRunKeys: noop, setHasMoreBefore, setHasUnreadInCurrentSession: noop, setHistory, setInput: noop, setIsLoadingOlder,
    setMessages, setOldestMessageId, setOldestSequence, setOldestTimestamp, setRuntimeStatus: runtime.setRuntimeStatus,
    setRuntimeStatusWithReconciliation: runtime.setRuntimeStatusWithReconciliation, setLastCompactionMarker: runtime.setLastCompactionMarker,
    setSelectedAgentId: noop, setSessionId, setSessionTitle: noop, setShowHistory: noop, setShowMobileDetails: noop,
    setShowUnreadBanner: noop, setTotalUnreadCount: noop, shouldShowHistoryAsOverlay: false, skipNextSessionStatusRefreshRef: skipRefresh,
    t, userStartedNewChatRef: newChat, wsRequest: async <T extends Record<string, unknown>>(_type: string, payload: Record<string, unknown>) =>
      ({ success: true, status: status(String(payload.sessionId)) }) as unknown as T });
  useLayoutEffect(() => { refresh.current = reader.refreshSavedMessages; exposed = { reader, runtime, messages }; }, [messages, reader, runtime]);
  return null;
}
function cache(id: string, messages: ChatMessage[]) {
  rememberChatSessionCacheEntry(buildCachedChatSessionEntry({ session: session(id), messages, hasMoreBefore: false,
    oldestTimestamp: 1, oldestMessageId: 1, oldestSequence: 1 }));
}
function event(id: string, value: ChatEvent) {
  window.dispatchEvent(new CustomEvent('agent_event', { detail: { sessionId: id, event: value } }));
}
async function main() {
  observeOpenedDocumentAuth({ data: { user: { id: 'cache-user' }, session: { id: 'cache-auth' } } });
  const root = createRoot(document.getElementById('root')!);
  const placeholder: ChatMessage = { id: 'local-empty-assistant', role: 'assistant', content: '', status: 'sending' };
  try {
    cache('reload-finished', [...mapPersistedChatMessages([rawUser], 'Stopped'), placeholder]);
    await act(async () => { root.render(<Harness />); });
    let loaded!: Promise<void>;
    await act(async () => { loaded = exposed.reader.loadSession(session('reload-finished')); });
    assert.equal(exposed.messages.some(message => message.id === placeholder.id), false, 'A cached local empty placeholder cannot establish a current assistant.');
    await act(async () => { pending.shift()!(Response.json({ success: true, messages: [rawUser, rawAssistant], hasMoreBefore: false })); await loaded; });
    assert.equal(exposed.runtime.runtimeStatus?.phase, 'idle');
    assert.deepEqual(exposed.messages.map(message => [message.role, message.status, message.content]),
      [['user', 'sent', 'Original request'], ['assistant', 'sent', 'Completed answer']]);
    assert.equal(exposed.runtime.hasLiveMessagesInProgress(), false);
    console.log('PASS actual restored cache + session/runtime hooks + completed HTTP history/idle have one completed assistant and no cached placeholder.');

    cache('reload-active', [...mapPersistedChatMessages([rawUser], 'Stopped'), placeholder]);
    await act(async () => { loaded = exposed.reader.loadSession(session('reload-active')); });
    const liveAssistant = { ...rawAssistant, id: undefined, sequence: undefined, timestamp: 10,
      content: [{ type: 'text', text: 'New live response' }] };
    await act(async () => {
      event('reload-active', { type: 'runtime_status', status: status('reload-active', 'streaming') });
      event('reload-active', { type: 'message_start', message: liveAssistant as ChatEvent['message'] });
    });
    await act(async () => { pending.shift()!(Response.json({ success: true, messages: [rawUser, rawAssistant], hasMoreBefore: false })); await loaded; });
    assert.equal(exposed.messages.some(message => message.id === placeholder.id), false);
    assert.equal(exposed.messages.filter(message => message.role === 'assistant' && message.status === 'sending' && message.content === 'New live response').length, 1,
      'A genuine message_start after the history request began survives the older history response.');
    assert.equal(exposed.messages.filter(message => message.role === 'assistant' && message.status === 'sent').length, 1);
    assert.equal(exposed.runtime.runtimeStatus?.phase, 'streaming');
    assert.equal(exposed.runtime.hasLiveMessagesInProgress(), true);
    console.log('PASS a newer actual runtime message_start during held history read remains active and distinct from completed history.');

    const preserved: ChatMessage[] = [
      { ...placeholder, id: 'cached-content', content: 'Partial answer' },
      { ...placeholder, id: 'cached-sdk', piMessage: { ...rawAssistant, timestamp: 20 } },
      { ...placeholder, id: 'cached-media', attachments: [{ id: 'image', name: 'image.png', contentKind: 'image', mimeType: 'image/png' }] },
    ];
    cache('reload-preserved', [...mapPersistedChatMessages([rawUser], 'Stopped'), placeholder, ...preserved]);
    await act(async () => { loaded = exposed.reader.loadSession(session('reload-preserved')); });
    assert.equal(exposed.messages.some(message => message.id === placeholder.id), false);
    for (const message of preserved) assert(exposed.messages.some(value => value.id === message.id));
    await act(async () => { pending.shift()!(Response.json({ success: true, messages: [rawUser, rawAssistant], hasMoreBefore: false })); await loaded; });
    for (const message of preserved) assert(exposed.messages.some(value => value.id === message.id));
    console.log('PASS cache filtering preserves content-bearing, SDK-backed and attachment-bearing assistant rows.');
  } finally {
    await act(async () => { root.unmount(); }); getNotebookQueryClient().clear(); observeOpenedDocumentAuth(null);
    globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
