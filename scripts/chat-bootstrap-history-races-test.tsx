import assert from 'node:assert/strict';
import React, { act, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import messages from '../messages/en.json';
import { useChatSessionBootstrap } from '../app/components/canvas-agent-chat/useChatSessionBootstrap';
import { useChatSessionHistory } from '../app/components/canvas-agent-chat/useChatSessionHistory';
import { writeCanvasChatActiveSessionStorage } from '../app/lib/chat/constants';
import { createPromptHandoff, persistPromptHandoff } from '../app/lib/chat/prompt-handoff';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import type { AISession } from '../app/lib/chat/types';

const reportError = console.error;
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'DOMException'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
observeOpenedDocumentAuth({ data: { user: { id: 'test-user' }, session: { id: 'test-session' } } });
const root = createRoot(document.getElementById('root')!);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const session = (id: string, workspaceId: string): AISession => ({ id: 1, sessionId: id,
  title: id, agentId: 'canvas-agent', model: 'test', engine: 'pi', createdAt: new Date().toISOString(),
  workspace: { workspaceId } as AISession['workspace'] });
const finishLoad = deferred<void>();
const loads: string[] = [];
const noop = () => {};
type Send = Parameters<typeof useChatSessionBootstrap>[0]['handleControlAction'];
let sendHandler: Send = async () => {};
const send: Send = async (...args) => { await sendHandler(...args); };
let historyState!: ReturnType<typeof useChatSessionHistory>;
let bootstrapState!: ReturnType<typeof useChatSessionBootstrap>;

function Harness({ workspaceId, requested = null, restore = false, showHistory = false, initialPromptStorageKey, isAuthReady = true }: {
  workspaceId: string; requested?: string | null; restore?: boolean; showHistory?: boolean; initialPromptStorageKey?: string; isAuthReady?: boolean;
}) {
  const t = useTranslations('chat');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(Boolean(requested || restore));
  const idRef = useRef(sessionId);
  useEffect(() => { idRef.current = sessionId; }, [sessionId]);
  const agentRef = useRef('canvas-agent');
  const optimistic = useRef({});
  const refresh = useRef(null);
  const visible = useRef(true);
  const history = useChatSessionHistory({ activeWorkspaceId: workspaceId, availableAgents: [],
    optimisticSessionTitlesRef: optimistic, requestSavedMessageRefreshRef: refresh,
    selectedAgentId: 'canvas-agent', sessionAgentIdRef: agentRef, sessionIdRef: idRef,
    setHasUnreadInCurrentSession: noop, setSessionTitle: noop, setShowUnreadBanner: noop,
    surfaceVisibleRef: visible, t });
  useEffect(() => { historyState = history; });
  const consumed = useRef(false);
  const cleanup = useRef<string | null>(null);
  const newChat = useRef(false);
  const loadSession = useCallback(async (value: AISession) => {
    loads.push(value.sessionId);
    idRef.current = value.sessionId;
    setSessionId(value.sessionId);
    await finishLoad.promise;
  }, []);
  const bootstrap = useChatSessionBootstrap({ activeWorkspaceId: workspaceId, addSessionToHistory: history.addSessionToHistory,
    appendSystemMessage: noop, clearSessionParamFromUrl: noop, fetchHistory: history.fetchHistory,
    handleControlAction: send, initialPromptStorageKey, isAuthReady, hasLoadedSessionListRef: history.hasLoadedSessionListRef,
    historyLength: history.history.length, initialPromptConsumedRef: consumed,
    isLoadingHistory: history.isLoadingHistory, isResolvingInitialChatState: resolving,
    isRuntimeSelectionLoading: false, isWorkspaceNavigationPending: false, loadSession,
    loadSessionList: history.loadSessionList, requestedSessionCleanupRef: cleanup,
    resolvedRequestedSessionId: requested, selectedAgentId: 'canvas-agent', sessionAgentIdRef: agentRef,
    sessionId, sessionIdRef: idRef, setHistoryAgentFilter: history.setHistoryAgentFilter,
    setHistoryAndLatest: history.setHistoryAndLatest, setIsResolvingInitialChatState: setResolving,
    setSelectedAgentId: noop, showHistory, t, userStartedNewChatRef: newChat });
  useEffect(() => { bootstrapState = bootstrap; });
  return <div data-resolving={resolving}>{history.history.map((value) => value.sessionId).join(',')}</div>;
}
async function render(props: React.ComponentProps<typeof Harness>, key = 'default') {
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <Harness {...props} key={key} />
  </NextIntlClientProvider>); });
}
async function tick() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

async function main() {
  let bootstrapCalls = 0;
  let listCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/bootstrap?')) {
      bootstrapCalls++;
      return Response.json({ success: true, session: session('saved', 'w1'), messages: { success: true, messages: [] } });
    }
    listCalls++;
    return Response.json({ success: true, sessions: [] });
  };
  writeCanvasChatActiveSessionStorage('w1', 'saved');
  await render({ workspaceId: 'w1', restore: true });
  await tick();
  assert.deepEqual(loads, ['saved']);
  assert.equal(bootstrapCalls, 1);
  assert.equal(listCalls, 0, 'restoring a chat does not wait for session history');
  assert.equal(document.querySelector('[data-resolving]')?.getAttribute('data-resolving'), 'true');
  await act(async () => { finishLoad.resolve(); });
  await tick();
  assert.equal(document.querySelector('[data-resolving]')?.getAttribute('data-resolving'), 'false',
    'setting sessionId while restoring must not cancel the final loading transition');

  // A delayed requested A must not replace newer explicit B.
  dom.window.sessionStorage.clear();
  const requestedA = deferred<Response>();
  globalThis.fetch = async (input) => String(input).includes('/request-A/') ? requestedA.promise
    : Response.json({ success: true, session: session('request-B', 'w1'), messages: { success: true, messages: [] } });
  loads.length = 0;
  await render({ workspaceId: 'w1', requested: 'request-A' }, 'requested');
  await render({ workspaceId: 'w1', requested: 'request-B' }, 'requested');
  await tick();
  await act(async () => { requestedA.resolve(Response.json({ success: true,
    session: session('request-A', 'w1'), messages: { success: true, messages: [] } })); });
  await tick();
  assert.deepEqual(loads, ['request-B']);
  globalThis.fetch = async () => { listCalls++; return Response.json({ success: true, sessions: [] }); };

  // The authorized targeted endpoint can return legacy personal metadata.
  globalThis.fetch = async () => Response.json({ success: true,
    session: { ...session('legacy', 'w1'), workspace: null }, messages: { success: true, messages: [] } });
  loads.length = 0;
  await render({ workspaceId: 'w1', requested: 'legacy' }, 'legacy');
  await tick();
  assert.deepEqual(loads, ['legacy']);

  globalThis.fetch = async () => Response.json({ success: false, error: 'Session temporarily unavailable' }, { status: 503 });
  await render({ workspaceId: 'w1', requested: 'retry' }, 'retry');
  await tick();
  assert.match(bootstrapState.initialSessionError ?? '', /temporarily unavailable/);
  globalThis.fetch = async () => Response.json({ success: true, session: session('retry', 'w1'),
    messages: { success: true, messages: [] } });
  await act(async () => { bootstrapState.retryInitialSession(); });
  await tick();
  assert.equal(bootstrapState.initialSessionError, null);
  assert.equal(loads.at(-1), 'retry');
  globalThis.fetch = async () => { listCalls++; return Response.json({ success: true, sessions: [] }); };

  // Empty history is a completed result, not a reason to request it indefinitely.
  dom.window.sessionStorage.clear();
  getNotebookQueryClient().clear();
  listCalls = 0;
  await render({ workspaceId: 'empty', showHistory: true }, 'empty');
  await tick(); await tick();
  assert.equal(listCalls, 1);
  assert.equal(historyState.isLoadingHistory, false);

  // A failed result also waits for explicit retry.
  globalThis.fetch = async () => { listCalls++; return Response.json({ success: false }, { status: 503 }); };
  const originalError = console.error;
  console.error = noop;
  listCalls = 0;
  await render({ workspaceId: 'failure', showHistory: true }, 'failure');
  await tick(); await tick();
  assert.equal(listCalls, 1);
  assert.match(historyState.historyError ?? '', /Failed to load/);
  globalThis.fetch = async () => { listCalls++; return Response.json({ success: true, sessions: [] }); };
  await act(async () => { await historyState.fetchHistory(); });
  assert.equal(listCalls, 2);
  assert.equal(historyState.historyError, null);

  // Response A may arrive after workspace B finished; it cannot replace B.
  const old = deferred<Response>();
  globalThis.fetch = async (input) => String(input).includes('workspaceId=A') ? old.promise
    : Response.json({ success: true, sessions: [session('B-chat', 'B')] });
  await render({ workspaceId: 'A', showHistory: true }, 'workspace');
  await render({ workspaceId: 'B', showHistory: true }, 'workspace');
  await tick();
  await act(async () => { old.resolve(Response.json({ success: true, sessions: [session('A-chat', 'A')] })); });
  await tick();
  assert.deepEqual(historyState.history.map((value) => value.sessionId), ['B-chat']);
  assert.equal(historyState.isLoadingHistory, false);
  // Source handoff waits for auth, survives failure, and retries only explicitly with the same ID.
  globalThis.fetch = async () => Response.json({ success: true, sessions: [] });
  const source = createPromptHandoff({ prompt: 'Start the review', attachments: [], agentId: 'canvas-agent',
    workspaceId: 'handoff-workspace', auth: { userId: 'test-user', sessionId: 'test-session' } });
  persistPromptHandoff(window.sessionStorage, 'handoff-test', source);
  window.history.replaceState(null, '', `?workspaceId=handoff-workspace&chat=open&handoff=${source.handoffId}`);
  let sendAttempt = deferred<void>();
  const attempts: Array<Parameters<Send>[1]> = [];
  sendHandler = async (_action, override) => { attempts.push(override); await sendAttempt.promise; };
  await render({ workspaceId: 'handoff-workspace', initialPromptStorageKey: 'handoff-test', isAuthReady: false }, 'handoff');
  await tick();
  assert.equal(attempts.length, 0);
  await render({ workspaceId: 'handoff-workspace', initialPromptStorageKey: 'handoff-test', isAuthReady: true }, 'handoff');
  await tick();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.handoffId, source.handoffId);
  assert.equal(attempts[0]?.workspaceId, source.workspaceId);
  await act(async () => { sendAttempt.reject(new Error('Send was not acknowledged')); });
  await tick();
  assert.match(bootstrapState.initialSessionError ?? '', /not acknowledged/);
  assert.ok(window.sessionStorage.getItem('handoff-test'));
  await render({ workspaceId: 'handoff-workspace', initialPromptStorageKey: 'handoff-test', showHistory: true }, 'handoff');
  await tick();
  assert.equal(attempts.length, 1, 'ordinary rerenders never retry a failed send');
  sendAttempt = deferred<void>();
  await act(async () => { bootstrapState.retryInitialSession(); });
  await tick();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.handoffId, source.handoffId);
  await act(async () => { sendAttempt.resolve(); });
  await tick();
  assert.equal(window.sessionStorage.getItem('handoff-test'), null, 'consume only after acknowledged send');
  console.error = originalError;
  await act(async () => root.unmount());
  getNotebookQueryClient().clear();
  console.log('chat bootstrap/history race tests passed');
}
void main().catch((error) => { reportError(error); process.exit(1); });
