import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { JSDOM } from 'jsdom';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { projectChatBodyText } from '../app/lib/chat/chat-body-contracts';
import type { ChatMessage, ChatRequestContext } from '../app/lib/chat/types';
import type { RuntimeStatus } from '../app/lib/chat/runtime-status';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';

// Actual React AgentList/AgentConfig/Control hooks. HTTP and WS are controlled
// UI boundaries; no backend, SQL acceptance, provider or execution authority claim.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://session-agent-send.fixture.invalid' });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const observed = { user: { id: 'session-agent-send-user' }, session: { id: 'session-agent-send-auth' } };
const loader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => name.endsWith('/auth-client')
  ? { authClient: { useSession: () => ({ data: observed, isPending: false, error: null }) } }
  : originalLoad(name, parent, isMain);
const body: ChatBodyV1 = { version: 1, parts: [{ type: 'text', text: 'Exact stored ' },
  { type: 'extension_reference', occurrenceId: 'one-occurrence', bundleId: 'one-bundle' }], bundles: [{ id: 'one-bundle', caption: 'My MCP',
  primary: { selection: { kind: 'mcp', source: 'mcp', target: { kind: 'personal', connectionRef: 'mcp-personal:10000000-0000-4000-8000-000000000001' } },
    requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] };
const stored = { sessionId: 'actual-existing-session', agentId: 'actual-specialist', workspaceId: 'workspace-a' };
const runtimeSelection = { providerInstallationId: 'provider-install', providerId: 'openai', modelId: 'model-a', thinkingLevel: 'off' as const };
const context: ChatRequestContext = { currentPage: '/chat', workspace: { workspaceId: stored.workspaceId, workspaceType: 'personal',
  workspaceName: 'A', canWrite: true, canDelete: true, canShare: true } };
const noop = () => {};
type HeldSend = { payload: Record<string, unknown>; resolve: (value: { success: boolean; status: null }) => void; reject: (error: Error) => void };

async function main() {
  const { render, waitFor, act, cleanup } = await import('@testing-library/react');
  const { useChatAgentConfig } = await import('../app/components/canvas-agent-chat/useChatAgentConfig');
  const { useChatControlActions } = await import('../app/components/canvas-agent-chat/useChatControlActions');
  const { getNotebookQueryClient } = await import('../app/lib/queries/client');
  loader._load = originalLoad;
  type Params = Parameters<typeof useChatControlActions>[0];
  let resolveList!: (response: Response) => void, listReads = 0, list: Promise<Response>, sequence = 0;
  const sends: HeldSend[] = [], errors: Array<{ name: string; error: string }> = [];
  let current!: { hook: ReturnType<typeof useChatControlActions>; body: ChatBodyV1; selectedAgentId: string; messages: ChatMessage[] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input), dom.window.location.href);
    assert.equal(url.pathname, '/api/agents', 'An existing stored-session send must never create or discover another session.');
    listReads++; return list;
  };
  function Harness() {
    const config = useChatAgentConfig({ initialAgentId: 'bradley', sessionId: stored.sessionId, workspaceId: stored.workspaceId });
    const { setSelectedAgentId } = config;
    useLayoutEffect(() => setSelectedAgentId(stored.agentId), [setSelectedAgentId]);
    const [draft, setDraft] = useState(body), [messages, setMessages] = useState<ChatMessage[]>([]);
    const [status, setStatus] = useState<RuntimeStatus | null>(null);
    const sessionId = useRef<string | null>(stored.sessionId), agentId = useRef(stored.agentId), workspaceId = useRef<string | null>(stored.workspaceId);
    const skipStatus = useRef<string | null>(null), userNewChat = useRef(false), editor = useRef(null);
    const params = {
      activeModel: 'model-a', activeProvider: 'openai', activeThinkingLevel: 'off' as const, runtimeSelection,
      hasLocalRuntimeSelection: true, runtimeCatalogRevision: 1, runtimePolicyRevision: 1, refreshRuntimeSelection: noop,
      activeWorkspaceId: stored.workspaceId, actualSessionAgentId: stored.agentId,
      addSessionToHistory: noop, appendCompactionBreak: noop, appendSystemMessage: noop, buildRequestContext: () => context,
      attachments: [], chatRequestTimeoutMs: 1000, clearCurrentAssistant: noop, currentFilePath: null,
      ensureSessionSubscribed: async () => {}, fetchHistory: async () => {}, input: projectChatBodyText(draft), inputBody: draft,
      isMobile: false, isUploading: false, messages, resetHistoryState: noop, resetInputHistoryNavigation: noop,
      resetRuntimeMessageRefs: noop, resetStreamConnection: noop, runtimePhase: status?.phase,
      selectedAgentId: config.selectedAgentId, sessionId: stored.sessionId, sessionIdRef: sessionId, sessionAgentIdRef: agentId, sessionWorkspaceIdRef: workspaceId,
      setActiveModel: noop, setActiveProvider: noop, setActiveThinkingLevel: noop, setAttachments: noop, setExpandedRunKeys: noop,
      setHasMoreBefore: noop, setHistoryAgentFilter: noop, setIsLoadingOlder: noop, setIsResolvingInitialChatState: noop,
      setMessages, setOldestMessageId: noop, setOldestSequence: noop, setOldestTimestamp: noop, setOpenQueueItemPopoverId: noop,
      setOptimisticRuntimePhase: (phase: RuntimeStatus['phase'], target: string) => setStatus(previous => ({ ...previous, sessionId: target, phase, optimistic: true } as RuntimeStatus)),
      setRuntimeStatus: setStatus, setRuntimeStatusWithReconciliation: setStatus, setSelectedAgentId: noop,
      setSessionId: noop, setSessionTitle: noop, setShowHistory: noop, setShowMobileDetails: noop, shouldShowHistoryAsOverlay: false, showHistory: false,
      skipNextSessionStatusRefreshRef: skipStatus, touchSessionActivity: noop,
      setInput: (value: React.SetStateAction<string>) => setDraft(previous => ({ version: 1, parts: [{ type: 'text', text: typeof value === 'function' ? value(projectChatBodyText(previous)) : value }], bundles: [] })),
      setInputBody: setDraft, editorRef: editor, userStartedNewChatRef: userNewChat,
      t: ((_key: string, values?: { message?: string }) => values?.message ?? _key) as Params['t'],
      appendOptimisticUserMessage: (content: string, attachments: Params['attachments'], messageStatus: ChatMessage['status'], queueKind: ChatMessage['queueKind'], piMessage: ChatMessage['piMessage']) => {
        const id = `optimistic-${++sequence}`; setMessages(previous => [...previous, { id, role: 'user' as const, content, attachments, status: messageStatus, queueKind, piMessage }]); return id;
      }, createAssistantBubble: () => {
        const id = `assistant-${++sequence}`; setMessages(previous => [...previous, { id, role: 'assistant' as const, content: '', status: 'sending' as const }]); return id;
      }, wsRequest: (_type: string, payload: Record<string, unknown>) => new Promise<{ success: boolean; status: null }>((resolve, reject) => sends.push({ payload, resolve, reject })),
    };
    const hook = useChatControlActions(params as Params);
    current = { hook, body: draft, selectedAgentId: config.selectedAgentId, messages };
    return null;
  }
  const mount = async () => {
    cleanup(); getNotebookQueryClient().clear(); sends.length = 0; listReads = 0;
    list = new Promise<Response>(resolve => { resolveList = resolve; });
    render(<Harness />); await waitFor(() => assert.equal(listReads, 1));
    assert.equal(current.selectedAgentId, 'bradley');
  };
  const hydrateList = async () => {
    await act(async () => resolveList(Response.json({ success: true, data: { agents: [{ agentId: stored.agentId, name: 'Specialist', iconId: 'bot', type: 'specialist', removable: true }] } })));
    await waitFor(() => assert.equal(current.selectedAgentId, stored.agentId));
  };
  try {
    observeOpenedDocumentAuth({ data: observed }); useWorkspaceStore.setState({ activeWorkspaceId: stored.workspaceId });
    for (const mode of ['ack', 'lost-ack'] as const) {
      try {
        await mount();
        let sending!: Promise<void>;
        await act(async () => { sending = current.hook.handleControlAction('send'); });
        const settled = Promise.allSettled([sending]); await waitFor(() => assert.equal(sends.length, 1));
        const original = sends.shift()!;
        assert.equal(original.payload.agentId, stored.agentId); assert.deepEqual(original.payload.body, body);
        await hydrateList();
        await act(async () => { if (mode === 'ack') original.resolve({ success: true, status: null });
          else original.reject(new Error('Original acknowledgement lost')); await settled; });
        if (mode === 'ack') {
          assert.deepEqual(current.body, { version: 1, parts: [], bundles: [] }, 'A late list membership response must not make a genuine same-session ACK skip exact draft cleanup.');
          assert.equal(current.hook.canRetrySend, false); assert.equal(current.hook.isSending, false);
          assert.equal(current.messages.filter(message => message.role === 'user' && message.status === 'sent').length, 1);
        } else {
          assert.equal(current.hook.sendError, 'Original acknowledgement lost', 'A list response is not navigation and must preserve the original transport error.');
          assert.equal(current.hook.canRetrySend, true); assert.deepEqual(current.body, body);
          let retry!: Promise<void>; await act(async () => { retry = current.hook.retryFailedSend(); });
          await waitFor(() => assert.equal(sends.length, 1)); const repeated = sends.shift()!;
          assert.equal(repeated.payload.clientMessageId, original.payload.clientMessageId, 'Explicit retry must reuse the original immutable client ID.');
          assert.deepEqual(repeated.payload.body, original.payload.body); assert.deepEqual(repeated.payload.message, original.payload.message);
          await act(async () => { repeated.resolve({ success: true, status: null }); await retry; });
          assert.deepEqual(current.body, { version: 1, parts: [], bundles: [] });
        }
        console.log(`PASS actual pending list → specialist send → late list → ${mode}`);
      } catch (error) {
        errors.push({ name: mode, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const error of errors) console.error(`FAIL ${error.name}: ${error.error}`);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'PASS', cases: 2, database: false, browser: false, provider: false, authority: false }));
  } finally { cleanup(); getNotebookQueryClient().clear(); globalThis.fetch = originalFetch; loader._load = originalLoad; observeOpenedDocumentAuth(null); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
