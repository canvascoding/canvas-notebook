import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatControlActions } from '../app/components/canvas-agent-chat/useChatControlActions';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { readChatSendHandoff, resolveChatCreation, type ChatCreationDraft } from '../app/lib/chat/send-transaction';
import type { CreateChatSessionResponse } from '../app/lib/chat/session-api';
import type { ChatMessage, ChatRequestContext } from '../app/lib/chat/types';

type Params = Parameters<typeof useChatControlActions>[0];
const noop = () => undefined;
const ref = <T,>(current: T) => ({ current });
const sessionIdRef = ref<string | null>(null);
const sessionWorkspaceIdRef = ref<string | null>(null);
const sessionAgentIdRef = ref('bradley');
const runtimeSelection = { providerInstallationId: 'provider-install', providerId: 'openai', modelId: 'model-a', thinkingLevel: 'off' as const };
const context: ChatRequestContext = { activeFilePath: 'original.md', workspace: {
  workspaceId: 'workspace-a', workspaceType: 'personal', workspaceName: 'A', organizationId: 'org-a',
  canWrite: true, canDelete: true, canShare: true,
} };
const pendingCreates: Array<{ payload: Record<string, unknown>; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
const pendingSends: Array<{ type: string; payload: Record<string, unknown>; resolve: (payload: Record<string, unknown>) => void; reject: (error: Error) => void }> = [];
let createCount = 0;
let sendCount = 0;
let exposed!: ReturnType<typeof useChatControlActions> & { sessionId: string | null; messages: ChatMessage[] };
let optimisticId = 0;
const base = {
  activeModel: 'model-a', activeProvider: 'openai', activeThinkingLevel: 'off', runtimeSelection,
  hasLocalRuntimeSelection: true, runtimeCatalogRevision: 1, runtimePolicyRevision: 1,
  refreshRuntimeSelection: noop, addSessionToHistory: noop, appendCompactionBreak: noop,
  appendSystemMessage: noop, attachments: [], buildRequestContext: () => context,
  chatRequestTimeoutMs: 1000, clearCurrentAssistant: noop, ensureSessionSubscribed: async () => undefined,
  fetchHistory: async () => undefined, input: 'hello', isMobile: false, isUploading: false,
  resetHistoryState: noop, resetInputHistoryNavigation: noop, resetRuntimeMessageRefs: noop,
  resetStreamConnection: noop, runtimePhase: 'idle', selectedAgentId: 'bradley',
  sessionAgentIdRef, sessionIdRef, sessionWorkspaceIdRef,
  setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop, setAttachments: noop,
  setExpandedRunKeys: noop, setHasMoreBefore: noop, setHistoryAgentFilter: noop,
  setInput: noop, setIsLoadingOlder: noop, setIsResolvingInitialChatState: noop,
  setOldestSequence: noop, setOldestTimestamp: noop, setOpenQueueItemPopoverId: noop,
  setOptimisticRuntimePhase: noop, setRuntimeStatus: noop, setRuntimeStatusWithReconciliation: noop,
  setSelectedAgentId: noop, setSessionTitle: noop, setShowHistory: noop, touchSessionActivity: noop,
  setShowMobileDetails: noop, shouldShowHistoryAsOverlay: false, showHistory: false,
  skipNextSessionStatusRefreshRef: ref(null), t: (key: string) => key, textareaRef: ref(null),
  userStartedNewChatRef: ref(false),
  wsRequest: (type: string, payload: Record<string, unknown>) => {
    sendCount++;
    return new Promise<Record<string, unknown>>((resolve, reject) => { pendingSends.push({ type, payload, resolve, reject }); });
  },
};
function Harness({ busy = false }: { busy?: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const hook = useChatControlActions({ ...(base as unknown as Params), sessionId, setSessionId, messages, setMessages,
    activeWorkspaceId: 'workspace-a', currentFilePath: context.activeFilePath ?? null,
    runtimePhase: busy ? 'streaming' : 'idle',
    appendOptimisticUserMessage: (content, attachments, status, queueKind, piMessage) => {
      const id = `optimistic-${++optimisticId}`;
      setMessages((current) => [...current, { id, role: 'user', content, attachments, status, queueKind, piMessage }]);
      return id;
    },
    createAssistantBubble: () => {
      const id = `assistant-${++optimisticId}`;
      setMessages((current) => [...current, { id, role: 'assistant', content: '', status: 'sending' }]);
      return id;
    },
  });
  useLayoutEffect(() => { exposed = { ...hook, sessionId, messages }; });
  return <div>{sessionId}</div>;
}
function creation(sessionId: string) {
  return Response.json({ success: true, created: true, session: {
    id: 1, sessionId, title: 'Created', agentId: 'bradley', model: 'model-a', provider: 'openai', thinkingLevel: 'off',
    workspace: { workspaceId: 'workspace-a', workspaceType: 'personal', workspaceName: 'A', organizationId: 'org-a', rootRelativePath: null, legacy: false },
  } });
}
async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true });
  observeOpenedDocumentAuth({ data: { user: { id: 'send-user' }, session: { id: 'send-auth' } } });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/sessions');
    assert.equal(init?.method, 'POST');
    createCount++;
    return new Promise<Response>((resolve, reject) => {
      pendingCreates.push({ payload: JSON.parse(String(init.body)), resolve, reject });
    });
  };
  let root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(<Harness />); });
  const request = { text: 'hello', attachments: [] };
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = exposed.handleControlAction('send', request);
    second = exposed.handleControlAction('send', request);
  });
  assert.equal(createCount, 1, 'double submit before creation shares one transaction');
  const firstSettled = Promise.allSettled([first, second]);
  await act(async () => { exposed.startNewChat(); });
  await act(async () => { pendingCreates.shift()!.resolve(creation('detached-session')); await firstSettled; });
  const detached = await firstSettled;
  assert.ok(detached.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(sendCount, 0, 'a detached creation is cancelled explicitly before dispatch');
  assert.equal(exposed.sessionId, null);
  assert.equal(exposed.messages.length, 0, 'late creation leaves the new draft untouched');

  await act(async () => { first = exposed.handleControlAction('send', request); });
  const frozenCreation = pendingCreates.shift()!;
  await act(async () => { frozenCreation.resolve(creation('retry-session')); });
  assert.equal(sendCount, 1);
  const initialSend = pendingSends.shift()!;
  await act(async () => { second = exposed.handleControlAction('send', request); });
  assert.equal(createCount, 2);
  assert.equal(sendCount, 1, 'draft-to-session transition still deduplicates until acknowledgement');
  const uncertain = Promise.allSettled([first, second]);
  await act(async () => { initialSend.reject(new Error('Connection interrupted')); await uncertain; });
  assert.equal(exposed.canRetrySend, true);
  context.activeFilePath = 'different.md';
  await act(async () => { root.render(<Harness />); });
  let retry!: Promise<void>;
  await act(async () => { retry = exposed.retryFailedSend(); });
  const repeatedSend = pendingSends.shift()!;
  assert.deepEqual(repeatedSend.payload, initialSend.payload, 'retry keeps original message ID, timestamp, content and document context');
  assert.equal((repeatedSend.payload.context as ChatRequestContext).activeFilePath, 'original.md');
  assert.equal(repeatedSend.payload.clientMessageId, (repeatedSend.payload.message as { clientMessageId: string }).clientMessageId);
  await act(async () => { repeatedSend.resolve({ success: true }); await retry; });
  assert.equal(exposed.isSending, false);
  assert.equal(exposed.canRetrySend, false);

  await act(async () => { exposed.startNewChat(); first = exposed.handleControlAction('send', request); });
  const lateFailure = first.catch((error: Error) => error);
  const failingCreation = pendingCreates.shift()!;
  await act(async () => { exposed.startNewChat(); });
  await act(async () => { failingCreation.reject(new Error('Server failure')); await lateFailure; });
  assert.equal((await lateFailure as Error).name, 'AbortError', 'late failure is scoped to the abandoned chat');
  assert.equal(exposed.sendError, null);

  await act(async () => { first = exposed.handleControlAction('send', request); });
  const changedAuth = first.catch((error: Error) => error);
  const authCreation = pendingCreates.shift()!;
  observeOpenedDocumentAuth({ data: { user: { id: 'different-user' }, session: { id: 'different-auth' } } });
  const beforeAuthSendCount = sendCount;
  await act(async () => { authCreation.resolve(creation('old-auth-session')); await changedAuth; });
  assert.equal((await changedAuth as Error).name, 'AbortError');
  assert.equal(sendCount, beforeAuthSendCount, 'auth invalidation blocks dispatch of captured old-user messages');
  assert.equal(exposed.sessionId, null);
  observeOpenedDocumentAuth({ data: { user: { id: 'send-user' }, session: { id: 'send-auth' } } });

  await act(async () => { exposed.startNewChat(); });
  const handoff = { ...request, handoffId: 'handoff-test', workspaceId: 'workspace-a' };
  await act(async () => { first = exposed.handleControlAction('send', handoff); });
  await act(async () => { pendingCreates.shift()!.resolve(creation('handoff-session')); });
  const handoffSend = pendingSends.shift()!;
  const failedHandoff = first.catch((error: Error) => error);
  await act(async () => { handoffSend.reject(new Error('Ack lost')); await failedHandoff; });
  assert.ok(readChatSendHandoff('handoff-test', 'workspace-a'));
  await act(async () => { root.unmount(); });
  sessionIdRef.current = null;
  root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(<Harness />); });
  const beforeReplayCreates = createCount;
  await act(async () => { first = exposed.handleControlAction('send', handoff); });
  const replay = pendingSends.shift()!;
  assert.equal(createCount, beforeReplayCreates, 'reloaded handoff reuses its established session');
  assert.deepEqual(replay.payload, handoffSend.payload, 'reload retry reuses the frozen execution receipt');
  await act(async () => { replay.resolve({ success: true }); await first; });
  assert.equal(readChatSendHandoff('handoff-test', 'workspace-a'), null);

  await act(async () => { root.render(<Harness busy />); });
  await act(async () => { first = exposed.handleControlAction('send', { text: 'queued', attachments: [] }); });
  const queued = pendingSends.shift()!;
  assert.equal(queued.type, 'send_message', 'ordinary send uses receipt-protected transport even while the runtime is busy');
  await act(async () => { queued.resolve({ success: true }); await first; root.unmount(); });
  getNotebookQueryClient().clear();
  dom.window.close();

  const draft: ChatCreationDraft = { id: 'creation-id' };
  let resolve!: (response: CreateChatSessionResponse) => void;
  let calls = 0;
  const create = async () => { calls++; return new Promise<CreateChatSessionResponse>((done) => { resolve = done; }); };
  const createRequest = { agentId: 'bradley', clientRequestId: draft.id };
  const one = resolveChatCreation(draft, createRequest, create);
  const two = resolveChatCreation(draft, createRequest, create);
  assert.equal(one, two, 'distinct messages in one draft share session creation too');
  resolve({ success: true, session: { sessionId: 'single-flight' } });
  await Promise.all([one, two]);
  assert.equal(calls, 1);
  console.log('chat-send-transaction-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
