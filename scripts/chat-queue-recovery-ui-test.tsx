import assert from 'node:assert/strict';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { useChatQueueRecovery } from '../app/components/canvas-agent-chat/useChatQueueRecovery';
import { useChatControlActions } from '../app/components/canvas-agent-chat/useChatControlActions';
import { projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { createTextChatBody } from '../app/lib/chat/body-state';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import type { ChatQueueRecoveryStatus } from '../app/lib/chat/queue-recovery';
import type { RuntimeQueueItem, RuntimeStatus } from '../app/lib/chat/runtime-status';
import type { Attachment, ChatMessage, ChatRequestContext } from '../app/lib/chat/types';
import type { ChatInlineEditorHandle } from '../app/components/canvas-agent-chat/ChatInlineEditor';

// Actual recovery Hook/Panel, existing RAM panel, editor and send Hook. Only
// HTTP/WS transport is controlled; this fixture creates no SQL/source authority.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://queue-recovery.fixture.invalid', pretendToBeVisual: true });
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [], configurable: true });
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(), configurable: true });
const domErrors: unknown[] = [];
dom.window.addEventListener('error', event => domErrors.push(event.error ?? event.message));
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'KeyboardEvent', 'MouseEvent', 'DOMParser', 'DOMRect', 'DocumentFragment', 'Text', 'requestAnimationFrame', 'cancelAnimationFrame'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const noop = () => {};
const item = (id: string, ordinal: number | null, disposition: 'ready' | 'suspended' = 'ready', lane: 'prompt' | 'follow_up' | 'steer' = 'prompt'): RuntimeQueueItem => ({
  id, clientMessageId: `client-${id}`, text: `Original ${id}`, attachmentCount: 0, executionRevision: 1,
  queue: ordinal === null ? null : { ordinal, disposition, lane }, body: createTextChatBody(`Original ${id}`),
});
const status = (sessionId: string): RuntimeStatus => ({ sessionId, phase: 'streaming', activeTool: null, pendingToolCalls: 0,
  followUpQueue: [], steeringQueue: [], canAbort: true, contextWindow: 1000, estimatedHistoryTokens: 0,
  availableHistoryTokens: 1000, contextUsagePercent: 0, includedSummary: false, omittedMessageCount: 0,
  summaryUpdatedAt: null, lastCompactionAt: null, lastCompactionKind: null, lastCompactionOmittedCount: 0 });
type Request = { method: string; sessionId: string; workspaceId: string | null; body?: Record<string, unknown> };

async function main() {
  const { render, act, waitFor, screen, within, fireEvent, cleanup } = await import('@testing-library/react');
  const { ChatInlineEditor } = await import('../app/components/canvas-agent-chat/ChatInlineEditor');
  const { ChatQueueRecoveryPanel } = await import('../app/components/canvas-agent-chat/ChatQueueRecoveryPanel');
  const { ChatQueuePanel } = await import('../app/components/canvas-agent-chat/ChatQueuePanel');
  type Controls = Parameters<typeof useChatControlActions>[0];
  let data: ChatQueueRecoveryStatus, authSequence = 0, cases = 0, newChats = 0, wsCalls = 0;
  const requests: Request[] = [], appliedStatuses: RuntimeStatus[] = [];
  const websocketRequests: { type: string; payload: Record<string, unknown> }[] = [], systemMessages: string[] = [];
  const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout;
  let readResponse: (request: Request) => Promise<Response>, postResponse: (request: Request) => Promise<Response>;
  let websocketResponse: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  let current!: ReturnType<typeof useChatQueueRecovery> & { controls: ReturnType<typeof useChatControlActions>; body: ChatBodyV1;
    attachments: Attachment[]; setBody: React.Dispatch<React.SetStateAction<ChatBodyV1>>;
    setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>; editor: React.RefObject<ChatInlineEditorHandle | null> };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.href); assert.equal(url.pathname, '/api/chat/queue');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.cache, 'no-store');
    const method = init?.method ?? 'GET', body = method === 'POST' ? JSON.parse(String(init?.body)) as Record<string, unknown> : undefined;
    const request: Request = { method, sessionId: String(body?.sessionId ?? url.searchParams.get('sessionId')),
      workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'), ...(body ? { body } : {}) };
    requests.push(request); return method === 'POST' ? postResponse(request) : readResponse(request);
  };
  function Harness({ sessionId = 'session-a', workspaceId = 'workspace-a', runtime = null }:
    { sessionId?: string; workspaceId?: string; runtime?: RuntimeStatus | null }) {
    const [body, setBody] = useState(() => createTextChatBody('Editable original draft')), [messages, setMessages] = useState<ChatMessage[]>([]);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const editor = useRef<ChatInlineEditorHandle | null>(null), id = useRef<string | null>(sessionId), agent = useRef('specialist'), workspace = useRef<string | null>(workspaceId);
    const skip = useRef<string | null>(null), userNewChat = useRef(false);
    useLayoutEffect(() => { id.current = sessionId; workspace.current = workspaceId; }, [sessionId, workspaceId]);
    const recovery = useChatQueueRecovery({ sessionId, workspaceId, connected: true, runtimeStatus: runtime, onRuntimeStatus: value => appliedStatuses.push(value) });
    const context: ChatRequestContext = { currentPage: '/chat', workspace: { workspaceId, workspaceType: 'personal', workspaceName: 'A', canWrite: true, canDelete: true, canShare: true } };
    const controls = useChatControlActions({ activeModel: 'model', activeProvider: 'openai', activeThinkingLevel: 'off',
      runtimeSelection: { providerInstallationId: 'installation', providerId: 'openai', modelId: 'model', thinkingLevel: 'off' },
      hasLocalRuntimeSelection: true, runtimeCatalogRevision: 1, runtimePolicyRevision: 1, refreshRuntimeSelection: noop,
      activeWorkspaceId: workspaceId, actualSessionAgentId: 'specialist', queueSendBlockedError: recovery.sendBlocked ? 'Queue check required' : null,
      addSessionToHistory: noop, appendCompactionBreak: noop, appendSystemMessage: message => systemMessages.push(message), attachments, buildRequestContext: () => context,
      chatRequestTimeoutMs: 1000, clearCurrentAssistant: noop, createAssistantBubble: () => 'assistant', currentFilePath: null,
      ensureSessionSubscribed: async () => {}, fetchHistory: async () => {}, input: projectChatBodyText(body), inputBody: body,
      isMobile: false, isUploading: false, messages, resetHistoryState: noop, resetInputHistoryNavigation: noop, resetRuntimeMessageRefs: noop,
      resetStreamConnection: noop, runtimePhase: runtime?.phase, selectedAgentId: 'specialist', sessionId, sessionIdRef: id,
      sessionAgentIdRef: agent, sessionWorkspaceIdRef: workspace, setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop,
      setAttachments, setExpandedRunKeys: noop, setHasMoreBefore: noop, setHistoryAgentFilter: noop,
      setInput: value => setBody(previous => createTextChatBody(typeof value === 'function' ? value(projectChatBodyText(previous)) : value)), setInputBody: setBody,
      setIsLoadingOlder: noop, setIsResolvingInitialChatState: noop, setMessages, setOldestSequence: noop, setOldestTimestamp: noop,
      setOpenQueueItemPopoverId: noop, setOptimisticRuntimePhase: noop, setRuntimeStatus: noop, setRuntimeStatusWithReconciliation: noop,
      setSelectedAgentId: noop, setSessionId: noop, setSessionTitle: noop, setShowHistory: noop, setShowMobileDetails: noop,
      shouldShowHistoryAsOverlay: false, showHistory: false, skipNextSessionStatusRefreshRef: skip, touchSessionActivity: noop,
      t: ((key: string, values?: { message?: string }) => values?.message ?? key) as Controls['t'], editorRef: editor, userStartedNewChatRef: userNewChat,
      appendOptimisticUserMessage: () => 'optimistic-user',
      wsRequest: (async (type: string, payload: Record<string, unknown>) => { wsCalls++; websocketRequests.push({ type, payload });
        return websocketResponse(payload); }) as Controls['wsRequest'] });
    current = { ...recovery, controls, body, attachments, setBody, setAttachments, editor };
    return <><ChatInlineEditor ref={editor} body={body} onBodyChange={setBody} aria-label="Actual draft" />
      <ChatQueueRecoveryPanel queue={recovery.queue} loading={recovery.loading} error={recovery.error} pendingId={recovery.pendingId}
        runtimeBusy={Boolean(recovery.runtimeBusy)} actionsDisabled={recovery.actionsDisabled} onRefresh={() => { void recovery.refresh(); }}
        onPromote={entry => { void recovery.runExistingAction(entry, () => controls.handlePromoteQueuedMessage(entry.id)).catch(() => {}); }}
        onEdit={entry => { void recovery.runExistingAction(entry, () => controls.handleEditQueuedMessage({ ...entry, kind: 'follow_up' })).catch(() => {}); }}
        onControl={(entry, action) => { void recovery.control(entry, action).catch(() => {}); }} onNewChat={() => { newChats++; }} />
      <ChatQueuePanel items={[{ id: 'ram-queue', text: 'Existing RAM item', attachmentCount: 0, kind: 'follow_up' }]}
        isMobile={false} isWebSocketUnavailable={false} openItemId={null} onOpenItemChange={noop} onPromote={noop} onRemove={noop} onEdit={noop} /></>;
  }
  const wrap = (props: React.ComponentProps<typeof Harness> = {}, locale = 'en') => <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'en' ? en : de}><Harness {...props} /></NextIntlClientProvider>;
  const mount = async (items: RuntimeQueueItem[] = [], blocked: ChatQueueRecoveryStatus['blocked'] = [], locale = 'en') => {
    cleanup(); requests.length = 0; appliedStatuses.length = 0; websocketRequests.length = 0; systemMessages.length = 0; newChats = 0; wsCalls = 0;
    data = { sessionId: 'session-a', items, blocked }; readResponse = async request => Response.json({ success: true, queue: { ...data, sessionId: request.sessionId } });
    postResponse = async request => { data = { ...data, items: data.items.filter(entry => entry.id !== request.body!.queueItemId), blocked: [] };
      return Response.json({ success: true, queue: data }); };
    websocketResponse = async () => { throw new Error('The recovery flow must not send a new user message.'); };
    observeOpenedDocumentAuth({ data: { user: { id: `queue-user-${++authSequence}` }, session: { id: `queue-auth-${authSequence}` } } });
    const view = render(wrap({}, locale)); await waitFor(() => assert.equal(current.loading, false)); return view;
  };
  const openDetails = () => { const summary = document.querySelector('[data-testid="chat-queue-recovery"] summary'); if (summary) fireEvent.click(summary); };
  const postCount = () => requests.filter(request => request.method === 'POST').length;
  try {
    await mount([item('unpositioned', null), item('steer-two', 2, 'ready', 'steer'), item('paused-one', 1, 'suspended', 'follow_up')],
      [{ clientMessageId: 'client-unpositioned', reason: 'unknown_queue_position' }]);
    assert.equal(postCount(), 0); assert.equal(current.sendBlocked, true); openDetails();
    assert.deepEqual([...document.querySelectorAll('[data-testid="chat-queue-recovery-item"]')].map(row => row.getAttribute('data-queue-id')), ['paused-one', 'steer-two', 'unpositioned']);
    assert(screen.getByText(en.chat.queueRecoverySuspended)); assert(screen.getByText('Existing RAM item'));
    const originalDraft = current.body;
    const row = document.querySelector('[data-queue-id="unpositioned"]')!;
    await act(async () => fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Continue' })));
    await waitFor(() => assert.equal(current.loading, false));
    assert.deepEqual(requests.find(request => request.method === 'POST')!.body, { sessionId: 'session-a', action: 'resume', queueItemId: 'unpositioned', executionRevision: 1 });
    assert(requests.every(request => request.workspaceId === 'workspace-a'));
    assert.deepEqual(current.body, originalDraft); assert.deepEqual(appliedStatuses, [], 'A status-less control result must never fabricate idle.');
    cases++; console.log('PASS cold SQL queue uses ordinal/null-last order, shows paused state, retains RAM items and resumes only the exact selected revision');

    await mount([item('paused', 1, 'suspended')]); assert.equal(current.sendBlocked, false, 'Suspended alone does not block a new independent message.');
    const idleView = await mount([item('ready', 1)]); assert.equal(current.sendBlocked, true, 'Idle-ready requires explicit recovery.');
    idleView.rerender(wrap({ runtime: status('session-a') })); await waitFor(() => assert.equal(current.loading, false));
    assert.equal(current.sendBlocked, false, 'An active own runtime may still receive follow-ups.');
    cases++; console.log('PASS idle-ready is explicit, suspended alone permits a new request, and a running own runtime permits follow-ups');

    for (const reason of ['legacy', 'outcome_unknown', 'execution_in_progress'] as const) {
      await mount([item('safe-paused', 1, 'suspended')], [{ clientMessageId: 'earlier-request', reason }]); openDetails();
      assert.equal(screen.queryAllByRole('button', { name: 'Continue' }).length, 0);
      assert.equal(screen.queryAllByRole('button', { name: en.chat.queueRecoveryMore }).length, 0);
      assert.equal(document.querySelectorAll('[data-testid="chat-queue-blocker"] button').length, 0);
      await act(async () => { await assert.rejects(current.control(current.queue!.items[0], 'resume')); });
      for (const action of ['send', 'steer', 'follow_up', 'replace'] as const) await assert.rejects(current.controls.handleControlAction(action), /Queue check required/u);
      assert.equal(postCount(), 0); assert.equal(wsCalls, 0);
      await act(async () => current.editor.current!.replaceText('Still editable'));
      assert(projectChatBodyText(current.body).includes('Still editable'));
      fireEvent.click(screen.getByRole('button', { name: 'New chat' })); assert.equal(newChats, 1);
      assert.equal(postCount(), 0);
      await act(async () => { await current.control(current.queue!.items[0], 'cancel'); });
      assert.equal(postCount(), 1, 'An unrelated safe queued row can still be explicitly cancelled.');
    }
    cases++; console.log('PASS session-wide legacy/unknown/inflight blockers offer no resume; keyboard controls are guarded, editing/new-chat remain available, safe cancellation stays explicit');

    const originalBody: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: '🙂 Use ' },
      { type: 'extension_reference', occurrenceId: 'original-occurrence', bundleId: 'original-bundle' }],
    bundles: [{ id: 'original-bundle', caption: 'Original exact account', primary: { selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
      target: { kind: 'personal', profileId: 'original-profile', accountBinding: 'account', accountId: 'account-B',
        connectionRef: 'composio-personal:original-profile:account-B' } }, requirement: 'optional', toolCap: ['CREATE'] }, supporting: [], packageConnections: [] }] };
    const originalAttachments: Attachment[] = [{ id: 'original-attachment', name: 'Original.pdf', contentKind: 'document',
      mimeType: 'application/pdf', filePath: '/original/Original.pdf', size: 42 }];
    await mount([{ ...item('edit-original', 1, 'suspended', 'follow_up'), text: projectChatBodyText(originalBody), body: originalBody,
      attachments: originalAttachments, attachmentCount: 1 }, item('no-position', null)]); openDetails();
    assert.equal(within(document.querySelector('[data-queue-id="no-position"]') as HTMLElement)
      .queryByRole('button', { name: en.chat.queueRecoveryMore }), null);
    websocketResponse = async payload => { assert.equal(payload.action, 'remove_queued_item');
      data = { ...data, items: data.items.filter(entry => entry.id !== payload.queueItemId) }; return { success: true }; };
    await act(async () => fireEvent.click(within(document.querySelector('[data-queue-id="edit-original"]') as HTMLElement)
      .getByRole('button', { name: en.chat.queueRecoveryMore })));
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.chat.editQueuedMessage })));
    await waitFor(() => assert.deepEqual(current.body, originalBody)); await waitFor(() => assert.equal(current.loading, false));
    assert.deepEqual(current.attachments, originalAttachments); assert.equal(document.querySelector('[data-queue-id="edit-original"]'), null);
    assert.deepEqual(websocketRequests, [{ type: 'control', payload: { sessionId: 'session-a', action: 'remove_queued_item', queueItemId: 'edit-original' } }]);
    assert.equal(postCount(), 0); assert.deepEqual(systemMessages, []);
    cases++; console.log('PASS the durable More/Edit action uses the existing remove handler and restores the exact original inline body and attachments');

    await mount([{ ...item('edit-claimed', 1, 'suspended', 'follow_up'), text: projectChatBodyText(originalBody), body: originalBody,
      attachments: originalAttachments, attachmentCount: 1 }]); openDetails();
    const draftBody: ChatBodyV1 = { ...structuredClone(originalBody),
      parts: [{ type: 'text', text: 'Keep my own draft 🙂 ' }, originalBody.parts[1]] };
    const draftAttachments: Attachment[] = [{ ...originalAttachments[0], id: 'draft-attachment', name: 'Draft.pdf' }];
    await act(async () => { current.setBody(draftBody); current.setAttachments(draftAttachments); });
    const targetBeforeClaim = structuredClone(current.queue!.items[0]);
    let rejectRemoval!: (error: Error) => void;
    websocketResponse = () => new Promise((_, reject) => { rejectRemoval = reject; });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: en.chat.queueRecoveryMore })));
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.chat.editQueuedMessage })));
    assert.equal(current.pendingId, 'edit-claimed');
    assert.deepEqual(current.body, draftBody); assert.deepEqual(current.attachments, draftAttachments);
    // A genuine remove/claim race is rejected by WS. The fresh GET may report
    // the newly claimed row as blocked; it must never copy that payload to the draft.
    data = { sessionId: 'session-a', items: [], blocked: [{ clientMessageId: 'client-edit-claimed', reason: 'execution_in_progress' }] };
    await act(async () => rejectRemoval(new Error('The queued request has already started.')));
    await waitFor(() => assert.equal(current.pendingId, null)); await waitFor(() => assert.equal(current.loading, false));
    assert.deepEqual(current.body, draftBody); assert.deepEqual(current.attachments, draftAttachments);
    assert.deepEqual(systemMessages, ['The queued request has already started.']);
    assert.deepEqual(websocketRequests, [{ type: 'control', payload: { sessionId: 'session-a', action: 'remove_queued_item', queueItemId: 'edit-claimed' } }]);
    assert.equal(wsCalls, 1); assert.equal(postCount(), 0); assert.equal(newChats, 0); assert.deepEqual(appliedStatuses, []);
    assert.deepEqual(targetBeforeClaim.body, originalBody); assert.deepEqual(targetBeforeClaim.attachments, originalAttachments);
    assert.equal(current.queue?.sessionId, 'session-a'); assert.equal(current.queue?.blocked[0].reason, 'execution_in_progress');
    cases++; console.log('PASS More/Edit followed by a rejected remove/claim race keeps the exact existing draft/body/attachments and target, with GET-only reconciliation and no extra send');

    await mount([item('promote-original', 1, 'suspended', 'prompt')]); openDetails();
    websocketResponse = async payload => { assert.equal(payload.action, 'promote_queued_to_steer');
      data = { ...data, items: [{ ...data.items[0], executionRevision: 2, queue: { ordinal: 2, lane: 'steer', disposition: 'ready' } }] };
      return { success: true }; };
    const beforePromoteReads = requests.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: en.chat.queueRecoveryMore })));
    await act(async () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.chat.steerAction })));
    await waitFor(() => assert.equal(current.queue?.items[0].executionRevision, 2));
    assert.equal(requests.length, beforePromoteReads + 1); assert.equal(postCount(), 0);
    assert.deepEqual(websocketRequests, [{ type: 'control', payload: { sessionId: 'session-a', action: 'promote_queued_to_steer', queueItemId: 'promote-original' } }]);
    assert.equal(document.querySelectorAll('[data-testid="chat-queue-recovery-item"]').length, 1);
    assert.equal(screen.queryByRole('button', { name: en.chat.queueRecoveryMore }), null);
    cases++; console.log('PASS durable More/Steer uses the existing exact-ID handler and refreshes one authoritative queue row');

    const promoteView = await mount([item('promote-late', 1, 'suspended')]);
    let rejectPromote!: (error: Error) => void;
    websocketResponse = () => new Promise((_, reject) => { rejectPromote = reject; });
    let promotePending!: Promise<void>;
    const oldExistingAction = current.runExistingAction, oldExistingItem = current.queue!.items[0];
    await act(async () => { promotePending = current.runExistingAction(oldExistingItem,
      () => current.controls.handlePromoteQueuedMessage(oldExistingItem.id)); });
    promoteView.rerender(wrap({ sessionId: 'session-b' })); await waitFor(() => assert.equal(current.loading, false));
    await act(async () => { rejectPromote(new Error('Old A rejection')); await promotePending; });
    assert.deepEqual(systemMessages, []); assert.equal(current.error, null); assert.equal(current.queue?.sessionId, 'session-b');
    let staleCallbackCalls = 0;
    await assert.rejects(oldExistingAction(oldExistingItem, async () => { staleCallbackCalls++; })); assert.equal(staleCallbackCalls, 0);
    cases++; console.log('PASS late rejected promotion cannot append errors in a new chat and a captured old action cannot run');

    await mount([item('paused', 1, 'suspended')]);
    readResponse = async () => Response.json({ success: false, error: 'Queue temporarily unavailable' }, { status: 503 });
    await act(async () => { await current.refresh(); }); assert.equal(current.sendBlocked, true); openDetails();
    assert(screen.getByText(/Queue temporarily unavailable/u));
    for (const button of within(document.querySelector('[data-queue-id="paused"]') as HTMLElement).getAllByRole('button')) assert.equal((button as HTMLButtonElement).disabled, true);
    assert(screen.getByText('Existing RAM item')); assert.equal(postCount(), 0);
    readResponse = async () => Response.json({ success: true, queue: { sessionId: 'session-a', items: [], blocked: [] } });
    await act(async () => { await current.refresh(); }); assert.equal(current.sendBlocked, false); assert(screen.getByText('Existing RAM item'));
    cases++; console.log('PASS a failed read blocks sending/actions and keeps draft/RAM state until an explicit fresh read succeeds');

    const view = await mount([item('scope-A', 1, 'suspended')]);
    const oldControl = current.control, oldItem = current.queue!.items[0];
    let releaseRead!: (response: Response) => void; readResponse = () => new Promise(resolve => { releaseRead = resolve; });
    await act(async () => { void current.refresh(); });
    readResponse = async request => Response.json({ success: true, queue: { sessionId: request.sessionId, items: [], blocked: [] } });
    view.rerender(wrap({ sessionId: 'session-b', workspaceId: 'workspace-b' })); await waitFor(() => assert.equal(current.loading, false));
    await act(async () => releaseRead(Response.json({ success: true, queue: { sessionId: 'session-a', items: [], blocked: [{ clientMessageId: 'stale-A', reason: 'legacy' }] } })));
    assert.equal(current.queue?.sessionId, 'session-b'); assert.equal(current.sendBlocked, false);
    view.rerender(wrap()); await waitFor(() => assert.equal(current.loading, false)); await assert.rejects(oldControl(oldItem, 'resume'));
    assert.equal(postCount(), 0);
    await act(async () => invalidateOpenedDocumentAuth()); await waitFor(() => assert.equal(current.loading, false));
    await assert.rejects(oldControl(oldItem, 'cancel')); assert.equal(postCount(), 0);
    cases++; console.log('PASS late reads and original action callbacks are fenced across workspace/session A→B→A and actual auth-epoch changes');

    const postView = await mount([item('held-post', 1, 'suspended')]);
    let releasePost!: (response: Response) => void; postResponse = () => new Promise(resolve => { releasePost = resolve; });
    let heldPost!: Promise<void>; await act(async () => { heldPost = current.control(current.queue!.items[0], 'resume'); });
    readResponse = async request => Response.json({ success: true, queue: { sessionId: request.sessionId, items: [], blocked: [] } });
    postView.rerender(wrap({ sessionId: 'session-b' })); await waitFor(() => assert.equal(current.loading, false));
    await act(async () => { releasePost(Response.json({ success: true, queue: { sessionId: 'session-a', items: [], blocked: [] }, status: status('session-a') })); await heldPost; });
    assert.equal(current.queue?.sessionId, 'session-b'); assert.deepEqual(appliedStatuses, []); assert.equal(postCount(), 1);
    cases++; console.log('PASS a late successful POST cannot install an old queue or runtime status after navigation');

    await mount([item('conflict', 1, 'suspended')]);
    postResponse = async () => { data = { ...data, items: [{ ...data.items[0], executionRevision: 2 }] };
      return Response.json({ success: false, error: 'The queue changed. Refresh its current state.' }, { status: 409 }); };
    await act(async () => { await assert.rejects(current.control(current.queue!.items[0], 'resume')); });
    await waitFor(() => assert.equal(current.loading, false)); assert.equal(current.queue!.items[0].executionRevision, 2);
    assert.equal(postCount(), 1); assert.match(String(current.error), /queue changed/u);
    postResponse = async () => Response.json({ success: true, queue: { sessionId: 'session-a', items: [], blocked: [] }, status: status('session-a') });
    await act(async () => { await current.control(current.queue!.items[0], 'resume'); });
    assert.equal(postCount(), 2); assert.equal(requests.filter(request => request.method === 'POST')[1].body!.executionRevision, 2);
    assert.deepEqual(appliedStatuses, [status('session-a')]);
    cases++; console.log('PASS a failed mutation triggers only GET reconciliation; the next POST needs a separate click and the refreshed revision');

    const polls: Array<() => void> = [];
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (new Error().stack?.includes('useChatQueueRecovery.ts') && delay && delay >= 1000) {
        const timer = originalSetTimeout(noop, 2_147_483_647); polls.push(() => { clearTimeout(timer); callback(...args); }); return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    await mount([], [{ clientMessageId: 'poll-unknown', reason: 'outcome_unknown' }], 'de');
    for (let index = 0; index < 6; index++) { assert.equal(polls.length, 1); await act(async () => { polls.shift()!(); }); }
    assert.equal(polls.length, 0); assert.equal(requests.filter(request => request.method === 'GET').length, 7); assert.equal(postCount(), 0);
    assert(within(screen.getByRole('alert')).getByText(de.chat.queueRecoveryUnknown));
    cases++; console.log('PASS unresolved-state polling is bounded, read-only and localized in German');
    assert.deepEqual(domErrors, []);
    console.log(JSON.stringify({ status: 'PASS', cases, database: false, browser: false, provider: false, authority: false }));
  } finally { cleanup(); globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; observeOpenedDocumentAuth(null); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
