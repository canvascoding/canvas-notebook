import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatControlActions } from '../app/components/canvas-agent-chat/useChatControlActions';
import { useChatComposerDraft } from '../app/components/canvas-agent-chat/useChatComposerDraft';
import { useChatSessionBootstrap } from '../app/components/canvas-agent-chat/useChatSessionBootstrap';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { composerDraftScope, loadComposerDraft, loadComposerDraftBody, saveComposerDraft, removeComposerDraftIfUnchanged } from '../app/lib/chat/draft-storage';
import { createPromptHandoff, persistPromptHandoff, readPromptHandoff } from '../app/lib/chat/prompt-handoff';
import { persistChatSendHandoff, readChatSendHandoff, type ChatSendSnapshot } from '../app/lib/chat/send-transaction';
import { deriveChatBodySelection, projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ChatExtensionSelectionInput } from '../app/lib/capabilities/extensions/contracts';
import type { ChatMessage, ChatRequestContext } from '../app/lib/chat/types';
import type { ChatInlineEditorHandle } from '../app/components/canvas-agent-chat/ChatInlineEditor';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import { useWorkspaceStore } from '../app/store/workspace-store';

// Actual persistence and React hooks. Only session HTTP/WS and explicit account
// confirmation are controlled boundaries; this test issues no source/SQL grant.
const noop = () => undefined;
const ref = <T,>(current: T) => ({ current });
const runtimeSelection = { providerInstallationId: 'provider-install', providerId: 'openai', modelId: 'model-a', thinkingLevel: 'off' as const };
const context: ChatRequestContext = { currentPage: '/chat', workspace: { workspaceId: 'workspace-a', workspaceType: 'personal',
  workspaceName: 'A', canWrite: true, canDelete: true, canShare: true } };
const makeBody = (accountId: string): ChatBodyV1 => ({ version: 1, parts: [{ type: 'text', text: '  🙂 Mit ' },
  { type: 'extension_reference', occurrenceId: `occurrence-${accountId}`, bundleId: `bundle-${accountId}` }, { type: 'text', text: '\n' }],
bundles: [{ id: `bundle-${accountId}`, caption: 'Gleiches Konto-Label', primary: { selection: { kind: 'composio', source: 'composio',
  toolkit: 'canva', target: { kind: 'personal', profileId: 'profile-alice', accountBinding: 'account', accountId,
    connectionRef: `composio-personal:profile-alice:${accountId}` } }, requirement: 'optional', toolCap: ['CREATE'] }, supporting: [], packageConnections: [] }] });
const bodyA = makeBody('account-A'), bodyB = makeBody('account-B'), bodyC = makeBody('account-C');
const receipt = (body: ChatBodyV1, character: string): ChatExtensionSelectionInput => {
  const selection = deriveChatBodySelection(body); assert(selection);
  return { ...selection, selections: selection.selections.map(entry => ({ ...entry, accountSelectionRef: `cmp_personal_account_${character.repeat(40)}` })) };
};
const confirmations: { body: ChatBodyV1; resolve: (value: ChatExtensionSelectionInput | null) => void }[] = [];
const sends: { type: string; payload: Record<string, unknown>; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
const errors: string[] = [];
let focusCount = 0, optimisticId = 0;
const sessionIdRef = ref<string | null>('existing-session'), agentRef = ref('bradley'), workspaceRef = ref<string | null>('workspace-a');
let exposed!: ReturnType<typeof useChatControlActions> & ReturnType<typeof useChatComposerDraft> & {
  body: ChatBodyV1; attachments: Parameters<typeof useChatControlActions>[0]['attachments'];
  setBody: Dispatch<SetStateAction<ChatBodyV1>>; setHistory: Dispatch<SetStateAction<ChatMessage[]>>;
};
type Params = Parameters<typeof useChatControlActions>[0];
const base = {
  activeModel: 'model-a', activeProvider: 'openai', activeThinkingLevel: 'off', runtimeSelection,
  hasLocalRuntimeSelection: true, runtimeCatalogRevision: 1, runtimePolicyRevision: 1, activeWorkspaceId: 'workspace-a',
  refreshRuntimeSelection: noop, addSessionToHistory: noop, appendCompactionBreak: noop,
  appendSystemMessage: (message: string) => { errors.push(message); }, buildRequestContext: () => context,
  chatRequestTimeoutMs: 1000, clearCurrentAssistant: noop, ensureSessionSubscribed: async () => undefined,
  fetchHistory: async () => undefined, isMobile: false, isUploading: false, currentFilePath: null,
  resetHistoryState: noop, resetRuntimeMessageRefs: noop, resetStreamConnection: noop, runtimePhase: 'idle', selectedAgentId: 'bradley',
  sessionAgentIdRef: agentRef, sessionIdRef, sessionWorkspaceIdRef: workspaceRef,
  setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop, setExpandedRunKeys: noop,
  setHasMoreBefore: noop, setHistoryAgentFilter: noop, setIsLoadingOlder: noop, setIsResolvingInitialChatState: noop,
  setOldestSequence: noop, setOldestTimestamp: noop, setOpenQueueItemPopoverId: noop,
  setOptimisticRuntimePhase: noop, setRuntimeStatus: noop, setRuntimeStatusWithReconciliation: noop,
  setSelectedAgentId: noop, setSessionTitle: noop, setShowHistory: noop, touchSessionActivity: noop,
  setShowMobileDetails: noop, shouldShowHistoryAsOverlay: false, showHistory: false,
  skipNextSessionStatusRefreshRef: ref(null), t: (_key: string, values?: { message?: string }) => values?.message ?? _key,
  editorRef: ref({ focusEnd: () => { focusCount++; } } as ChatInlineEditorHandle), userStartedNewChatRef: ref(false),
  prepareIntakeSelection: (body: ChatBodyV1) => new Promise<ChatExtensionSelectionInput | null>(resolve => confirmations.push({ body, resolve })),
  wsRequest: (type: string, payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => sends.push({ type, payload, resolve, reject })),
};
function Harness({ confirm = true }: { confirm?: boolean }) {
  const [body, setBody] = useState<ChatBodyV1>(bodyA), [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<Params['attachments']>([]), [sessionId, setSessionId] = useState<string | null>('existing-session');
  const input = projectChatBodyText(body);
  const setInput: Dispatch<SetStateAction<string>> = value => setBody(previous => ({ version: 1,
    parts: [{ type: 'text', text: typeof value === 'function' ? value(projectChatBodyText(previous)) : value }], bundles: [] }));
  const history = useChatComposerDraft({ input, inputBody: body, messages, sessionId, setInput, setInputBody: setBody, editorRef: base.editorRef });
  const hook = useChatControlActions({ ...(base as unknown as Params), sessionId, setSessionId, messages, setMessages,
    prepareIntakeSelection: confirm ? base.prepareIntakeSelection : undefined,
    input, inputBody: body, setInput, setInputBody: setBody, attachments, setAttachments,
    resetInputHistoryNavigation: history.resetInputHistoryNavigation,
    appendOptimisticUserMessage: (content, values, status, queueKind, piMessage) => {
      const id = `optimistic-${++optimisticId}`;
      setMessages(current => [...current, { id, role: 'user', content, attachments: values, status, queueKind, piMessage }]); return id;
    }, createAssistantBubble: () => 'assistant',
  });
  useLayoutEffect(() => { exposed = { ...hook, ...history, body, attachments, setBody, setHistory: setMessages }; }, [attachments, body, history, hook]);
  return null;
}
let handoffExposed!: ReturnType<typeof useChatControlActions> & ReturnType<typeof useChatSessionBootstrap> & {
  sessionId: string | null; runtimeStatus: RuntimeStatus | null; messages: ChatMessage[]; body: ChatBodyV1; newChat: boolean;
  setRuntimeStatus: Dispatch<SetStateAction<RuntimeStatus | null>>; setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};
const readHandoffRuntimeStatus = (): RuntimeStatus | null => handoffExposed.runtimeStatus;
function HandoffFailureHarness() {
  const [body, setBody] = useState<ChatBodyV1>({ version: 1, parts: [], bundles: [] });
  const [sessionId, setSessionId] = useState<string | null>(null), [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null), [resolving, setResolving] = useState(true);
  const id = useRef<string | null>(null), agent = useRef('bradley'), workspace = useRef<string | null>(null);
  const newChat = useRef(false), consumed = useRef(false), cleanup = useRef<string | null>(null), loaded = useRef(true);
  useEffect(() => { id.current = sessionId; }, [sessionId]);
  const controls = useChatControlActions({ ...(base as unknown as Params), input: projectChatBodyText(body), inputBody: body,
    setInput: value => setBody(previous => ({ version: 1, parts: [{ type: 'text', text: typeof value === 'function' ? value(projectChatBodyText(previous)) : value }], bundles: [] })),
    setInputBody: setBody, setAttachments: noop, attachments: [], sessionId, setSessionId, messages, setMessages,
    resetInputHistoryNavigation: noop,
    sessionIdRef: id, sessionAgentIdRef: agent, sessionWorkspaceIdRef: workspace, userStartedNewChatRef: newChat,
    runtimePhase: runtimeStatus?.phase, setOptimisticRuntimePhase: (phase, target) => setRuntimeStatus(previous => ({ ...previous,
      sessionId: target, phase, optimistic: true } as RuntimeStatus)), setRuntimeStatus,
    setRuntimeStatusWithReconciliation: value => setRuntimeStatus(value), setIsResolvingInitialChatState: setResolving,
    prepareIntakeSelection: async value => receipt(value, 'h'),
    appendOptimisticUserMessage: (content, values, status, queueKind, piMessage) => {
      const key = `handoff-user-${++optimisticId}`;
      setMessages(current => [...current, { id: key, role: 'user', content, attachments: values, status, queueKind, piMessage }]); return key;
    }, createAssistantBubble: () => {
      const key = `handoff-assistant-${++optimisticId}`;
      setMessages(current => [...current, { id: key, role: 'assistant', content: '', status: 'sending' }]); return key;
    } });
  const bootstrap = useChatSessionBootstrap({ activeWorkspaceId: 'workspace-a', addSessionToHistory: noop,
    appendSystemMessage: noop, clearSessionParamFromUrl: noop, fetchHistory: async () => {},
    handleControlAction: controls.handleControlAction, initialPromptStorageKey: 'actual-handoff-failure',
    isAuthReady: true, hasLoadedSessionListRef: loaded, historyLength: 0, initialPromptConsumedRef: consumed,
    isLoadingHistory: false, isResolvingInitialChatState: resolving, isRuntimeSelectionLoading: false,
    isWorkspaceNavigationPending: false, loadSession: async () => { throw new Error('A handoff must not load another session.'); },
    loadSessionList: async () => [], requestedSessionCleanupRef: cleanup, resolvedRequestedSessionId: null,
    selectedAgentId: 'bradley', sessionAgentIdRef: agent, sessionId, sessionIdRef: id, setHistoryAgentFilter: noop,
    setHistoryAndLatest: noop, setIsResolvingInitialChatState: setResolving, setSelectedAgentId: noop,
    showHistory: false, t: base.t as Params['t'], userStartedNewChatRef: newChat });
  useLayoutEffect(() => { handoffExposed = { ...controls, ...bootstrap, sessionId, runtimeStatus, setRuntimeStatus, setMessages,
    messages, body, newChat: newChat.current }; }, [controls, bootstrap, sessionId, runtimeStatus, messages, body]);
  return null;
}
async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  observeOpenedDocumentAuth({ data: { user: { id: 'inline-user' }, session: { id: 'inline-auth' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  globalThis.fetch = async () => { throw new Error('An established-session inline send must not create a session.'); };
  const root = createRoot(document.getElementById('root')!);
  try {
    saveComposerDraft('draft', projectChatBodyText(bodyA), composerDraftScope(), bodyA);
    assert.equal(loadComposerDraft('draft'), projectChatBodyText(bodyA)); assert.deepEqual(loadComposerDraftBody('draft'), bodyA);
    saveComposerDraft('draft', projectChatBodyText(bodyB), composerDraftScope(), bodyB);
    removeComposerDraftIfUnchanged('draft', { text: projectChatBodyText(bodyA), body: bodyA });
    assert.deepEqual(loadComposerDraftBody('draft'), bodyB, 'An old ACK cannot erase a newer same-caption stored draft');
    assert.throws(() => saveComposerDraft('draft', 'different text', composerDraftScope(), bodyA));
    assert.throws(() => saveComposerDraft('draft', projectChatBodyText(bodyA), composerDraftScope(), {
      ...bodyA, bundles: [{ ...bodyA.bundles[0], primary: { ...bodyA.bundles[0].primary, accountSelectionRef: 'forbidden' } }],
    } as unknown as ChatBodyV1));
    const handoff = createPromptHandoff({ prompt: projectChatBodyText(bodyA), body: bodyA, attachments: [], agentId: 'bradley', workspaceId: 'workspace-a' });
    persistPromptHandoff(window.sessionStorage, 'prompt', handoff);
    assert.deepEqual(readPromptHandoff(window.sessionStorage, 'prompt', { workspaceId: 'workspace-a' })?.body, bodyA);
    const snapshot: ChatSendSnapshot = { version: 1, handoffId: 'inline-handoff', workspaceId: 'workspace-a', agentId: 'bradley', action: 'send',
      text: projectChatBodyText(bodyA), body: bodyA, attachments: [], context, message: { role: 'user', content: projectChatBodyText(bodyA), timestamp: 10, clientMessageId: 'original-cid' },
      creationRequest: { clientRequestId: 'original-create', agentId: 'bradley' }, runtimeSelection, targetSessionId: 'existing-session' };
    persistChatSendHandoff(snapshot);
    const restored = readChatSendHandoff('inline-handoff', 'workspace-a'); assert(restored);
    assert.deepEqual(restored.body, bodyA); assert(Object.isFrozen(restored.body)); assert(Object.isFrozen(restored.message));
    const transactionKey = Object.keys(window.sessionStorage).find(key => key.startsWith('canvas.chat.sendTransaction.v1:'))!;
    const originalTransaction = window.sessionStorage.getItem(transactionKey)!;
    window.sessionStorage.setItem(transactionKey, JSON.stringify({ ...snapshot, body: { ...bodyA, bundles: [] } }));
    assert.throws(() => readChatSendHandoff('inline-handoff', 'workspace-a'), /original saved send cannot be restored/u,
      'A damaged existing retry cannot be mistaken for absence and mint another CID');
    window.sessionStorage.setItem(transactionKey, originalTransaction);
    assert.doesNotMatch(JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }), /accountSelectionRef|cmp_personal_account_/u);
    await act(async () => { root.render(<Harness confirm={false} />); });

    let first!: Promise<void>;
    await act(async () => { await assert.rejects(exposed.handleControlAction('send'), /Confirm the same selected account/u); });
    assert.equal(exposed.canRetrySend, true); assert.equal(sends.length, 0); assert.deepEqual(exposed.body, bodyA);
    await act(async () => { root.render(<Harness />); });
    await act(async () => { first = exposed.retryFailedSend(); });
    const firstResult = Promise.allSettled([first]), firstConfirmation = confirmations.shift()!;
    assert(Object.isFrozen(firstConfirmation.body)); assert.deepEqual(firstConfirmation.body, bodyA);
    assert.deepEqual(exposed.body, bodyA, 'Sending cannot clear a draft before admission ACK');
    await act(async () => { exposed.setBody(bodyB); firstConfirmation.resolve(receipt(bodyA, 'a')); });
    const originalSend = sends.shift()!;
    assert.deepEqual(originalSend.payload.body, bodyA); assert.equal((originalSend.payload.message as { content: string }).content, projectChatBodyText(bodyA));
    assert.equal(originalSend.payload.clientMessageId, (originalSend.payload.message as { clientMessageId: string }).clientMessageId);
    assert.equal(Object.hasOwn(originalSend.payload.message as object, 'body'), false, 'Body travels outside the SDK message');
    await act(async () => { originalSend.reject(new Error('Admission denied or ACK lost')); await firstResult; });
    assert.deepEqual(exposed.body, bodyB); assert.equal(exposed.canRetrySend, true);
    let retry!: Promise<void>;
    await act(async () => { retry = exposed.retryFailedSend(); });
    const retryConfirmation = confirmations.shift()!; assert.deepEqual(retryConfirmation.body, bodyA);
    await act(async () => { retryConfirmation.resolve(receipt(bodyA, 'b')); });
    const repeated = sends.shift()!;
    assert.deepEqual({ ...repeated.payload, selection: null }, { ...originalSend.payload, selection: null }, 'Retry preserves exact captured body, IDs, text, attachments and context');
    assert.notDeepEqual(repeated.payload.selection, originalSend.payload.selection, 'Only the ephemeral account receipt is renewed');
    await act(async () => { repeated.resolve({ success: true, status: null }); await retry; });
    assert.deepEqual(exposed.body, bodyB, 'An old accepted send cannot erase the newer draft');

    await act(async () => { first = exposed.handleControlAction('send'); });
    const wrongAccountResult = Promise.allSettled([first]);
    await act(async () => { confirmations.shift()!.resolve(receipt(bodyA, 'c')); await wrongAccountResult; });
    assert.equal((await wrongAccountResult)[0].status, 'rejected'); assert.equal(sends.length, 0);
    assert.deepEqual(exposed.body, bodyB, 'Same caption cannot substitute another account');
    await act(async () => { first = exposed.handleControlAction('send'); });
    await act(async () => { confirmations.shift()!.resolve(receipt(bodyB, 'd')); });
    const accepted = sends.shift()!;
    saveComposerDraft('existing-session', projectChatBodyText(bodyC), composerDraftScope(), bodyC);
    await act(async () => { accepted.resolve({ success: true, status: null }); await first; });
    assert.equal(projectChatBodyText(exposed.body), ''); assert.deepEqual(exposed.body.bundles, []);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    assert.deepEqual(loadComposerDraftBody('existing-session'), bodyC, 'ACK and the empty-draft debounce preserve another saved exact body');

    const historyMessage = (body: ChatBodyV1, id: string): ChatMessage => ({ id, role: 'user', content: projectChatBodyText(body),
      piMessage: { role: 'user', content: projectChatBodyText(body), timestamp: 1, clientMessageId: id, body } as ChatMessage['piMessage'] });
    await act(async () => { exposed.setHistory([historyMessage(bodyA, 'history-a'), historyMessage(bodyB, 'history-b')]); exposed.setBody(bodyC); });
    await act(async () => { assert.equal(exposed.navigateInputHistory('older'), true); }); assert.deepEqual(exposed.body, bodyB);
    await act(async () => { exposed.navigateInputHistory('older'); }); assert.deepEqual(exposed.body, bodyA);
    await act(async () => { exposed.navigateInputHistory('newer'); exposed.navigateInputHistory('newer'); }); assert.deepEqual(exposed.body, bodyC);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert(focusCount >= 4);
    let editing!: Promise<void>;
    await act(async () => { editing = exposed.handleEditQueuedMessage({ id: 'server-b', clientMessageId: 'queue-b', kind: 'follow_up',
      text: projectChatBodyText(bodyB), body: bodyB, attachmentCount: 0, attachments: [] }); });
    const remove = sends.shift()!; assert.equal(remove.payload.queueItemId, 'server-b');
    await act(async () => { remove.resolve({ success: true, status: null }); await editing; });
    assert.deepEqual(exposed.body, bodyB, 'Queue editing uses its actual body even when history has the same caption');
    await act(async () => { await exposed.handleEditQueuedMessage({ id: 'binary-queue', kind: 'follow_up', text: 'Binary', attachmentCount: 1 }); });
    assert.equal(sends.length, 0); assert(errors.some(message => message.includes('kept in the queue')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    assert.deepEqual(loadComposerDraftBody('existing-session'), bodyB);
    assert.doesNotMatch(JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }), /accountSelectionRef|cmp_personal_account_/u);
    console.log('PASS inline transactions: receipt-free exact draft/handoff/history/queue bodies; immutable send+CID before await, fresh exact-account receipts, denial editable, ACK clears only unchanged draft, same-caption substitution rejected.');

    await act(async () => { root.render(null); });
    const home = createPromptHandoff({ prompt: projectChatBodyText(bodyA), body: bodyA, attachments: [], agentId: 'bradley', workspaceId: 'workspace-a' });
    persistPromptHandoff(window.sessionStorage, 'actual-handoff-failure', home);
    window.history.replaceState(null, '', `?workspaceId=workspace-a&chat=open&handoff=${home.handoffId}`);
    let resolveCreation!: (value: Response) => void;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), '/api/sessions'); assert.equal(init?.method, 'POST');
      return new Promise<Response>(resolve => { resolveCreation = resolve; });
    };
    await act(async () => { root.render(<HandoffFailureHarness />); });
    assert(resolveCreation, 'The genuine Home bootstrap invokes actual session creation.');
    await act(async () => { resolveCreation(Response.json({ success: true, created: true, session: { id: 2,
      sessionId: 'handoff-admission-session', title: 'Home chat', agentId: 'bradley', model: 'model-a', provider: 'openai', thinkingLevel: 'off',
      workspace: { workspaceId: 'workspace-a', workspaceType: 'personal', workspaceName: 'A' } } })); });
    assert.equal(handoffExposed.sessionId, 'handoff-admission-session');
    const failedSend = sends.shift()!; assert.equal(failedSend.type, 'send_message');
    const admissionError = 'The selected extension identities exceed the shared 8 KiB context budget. Reduce this selection.';
    await act(async () => { failedSend.reject(new Error(admissionError)); });
    assert.equal(handoffExposed.sendError, admissionError, 'Creation attachment does not invalidate its own active transaction.');
    assert.equal(handoffExposed.messages.filter(message => message.role === 'assistant').length, 0, 'A rejected send removes its optimistic assistant.');
    assert.equal(handoffExposed.initialSessionError, admissionError, 'Home rejection remains visible through the actual bootstrap error path.');
    assert.equal(handoffExposed.runtimeStatus, null, 'Rejection removes only its optimistic presentation, without fabricating an idle runtime.');
    assert.equal(handoffExposed.newChat, false, 'The bootstrap handoff is not a deliberate user navigation.');
    assert(window.sessionStorage.getItem('actual-handoff-failure'));
    await act(async () => { handoffExposed.retryInitialSession(); });
    const homeRetry = sends.shift()!; assert.equal(homeRetry.type, 'send_message');
    assert.deepEqual(homeRetry.payload, failedSend.payload, 'Explicit bootstrap Retry keeps its exact original CID, body and created session.');
    await act(async () => { homeRetry.resolve({ success: true, status: null }); });
    assert.equal(handoffExposed.initialSessionError, null); assert.equal(handoffExposed.runtimeStatus, null);
    assert.equal(handoffExposed.messages.filter(message => message.role === 'assistant').length, 0);
    assert.equal(window.sessionStorage.getItem('actual-handoff-failure'), null, 'Only the confirmed explicit retry consumes its handoff.');
    console.log('PASS actual Home bootstrap + session attachment + rejected WS Promise: visible error, no ghost assistant/optimistic run, original immutable explicit retry and cold replay.');

    let observedAttempt!: Promise<void>;
    await act(async () => { observedAttempt = handoffExposed.handleControlAction('send', {
      text: projectChatBodyText(bodyB), body: bodyB, attachments: [], workspaceId: 'workspace-a' }); });
    const observedResult = Promise.allSettled([observedAttempt]), observedSend = sends.shift()!;
    const actualStatus = { ...handoffExposed.runtimeStatus!, phase: 'running_tool' as const,
      activeTool: { toolCallId: 'observed-tool', name: 'Observed tool' }, pendingToolCalls: 1 };
    delete actualStatus.optimistic;
    await act(async () => {
      handoffExposed.setRuntimeStatus(actualStatus);
      handoffExposed.setMessages(current => current.map(message => message.role === 'assistant' ? { ...message,
        content: 'Observed real stream', piMessage: { role: 'assistant', content: [{ type: 'text', text: 'Observed real stream' }], timestamp: 1 } as ChatMessage['piMessage'] } : message));
    });
    await act(async () => { observedSend.reject(new Error('Acknowledgement lost after observed runtime event')); await observedResult; });
    assert.equal(handoffExposed.runtimeStatus, actualStatus, 'A newer genuine runtime status survives an uncertain send acknowledgement.');
    assert.equal(handoffExposed.messages.filter(message => message.role === 'assistant' && message.content === 'Observed real stream').length, 1,
      'A real SDK message is not removed as if it were an empty optimistic placeholder.');
    assert.equal(handoffExposed.canRetrySend, true); assert.equal(sends.length, 0, 'An uncertain acknowledgement never automatically resends.');
    console.log('PASS uncertain acknowledgement preserves a newer actual runtime status and observed assistant, with no automatic retry.');

    const override = (account: string) => { const body = makeBody(account); return { text: projectChatBodyText(body), body, attachments: [], workspaceId: 'workspace-a' }; };
    await act(async () => { handoffExposed.setRuntimeStatus(null); });
    let waitingA!: Promise<void>, queuedB!: Promise<void>;
    await act(async () => { waitingA = handoffExposed.handleControlAction('send', override('waiting-A')); });
    const waitingAResult = Promise.allSettled([waitingA]), pendingA = sends.shift()!, aStatus = readHandoffRuntimeStatus();
    assert.equal(aStatus?.optimistic, true);
    await act(async () => { queuedB = handoffExposed.handleControlAction('send', override('queued-B')); });
    const queuedBResult = Promise.allSettled([queuedB]), pendingB = sends.shift()!;
    await act(async () => { pendingB.reject(new Error('Queued B rejected')); await queuedBResult; });
    assert.equal(handoffExposed.runtimeStatus, aStatus, 'Queued B never owns or clears A\'s pending optimistic phase.');
    await act(async () => { pendingA.reject(new Error('A rejected')); await waitingAResult; });
    assert.equal(handoffExposed.runtimeStatus, null);

    let beforeRenderA!: Promise<void>, beforeRenderC!: Promise<void>;
    await act(async () => {
      beforeRenderA = handoffExposed.handleControlAction('send', override('before-render-A'));
      beforeRenderC = handoffExposed.handleControlAction('send', override('before-render-C'));
    });
    const beforeAResult = Promise.allSettled([beforeRenderA]), beforeCResult = Promise.allSettled([beforeRenderC]);
    const pendingBeforeA = sends.shift()!, pendingBeforeC = sends.shift()!, cStatus = handoffExposed.runtimeStatus;
    await act(async () => { pendingBeforeA.reject(new Error('Older A rejected')); await beforeAResult; });
    assert.equal(handoffExposed.runtimeStatus, cStatus, 'Two nonqueued sends before render still retain exact ownership of the newer C status.');
    await act(async () => { pendingBeforeC.resolve({ success: true, status: null }); await beforeCResult; });
    assert.equal(handoffExposed.runtimeStatus, null, 'Only the current owning C acknowledgement removes its optimistic phase.');

    let beforeStop!: Promise<void>;
    await act(async () => { beforeStop = handoffExposed.handleControlAction('send', override('before-stop')); });
    const beforeStopResult = Promise.allSettled([beforeStop]), pendingBeforeStop = sends.shift()!;
    let stopping!: Promise<void>;
    await act(async () => { stopping = handoffExposed.handleStop(); });
    const stop = sends.shift()!; assert.equal(stop.payload.action, 'abort');
    await act(async () => { stop.reject(new Error('Abort acknowledgement lost')); await stopping; });
    const stopFailureStatus = handoffExposed.runtimeStatus;
    await act(async () => { pendingBeforeStop.reject(new Error('Original send acknowledgement lost')); await beforeStopResult; });
    assert.equal(handoffExposed.runtimeStatus, stopFailureStatus, 'Stop and its failure restoration both revoke the original send\'s optimistic ownership.');
    assert.equal(sends.length, 0);
    console.log('PASS queued B, two nonqueued sends before render and Stop-failure races preserve exact private optimistic ownership.');
  } finally {
    await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; observeOpenedDocumentAuth(null); dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
