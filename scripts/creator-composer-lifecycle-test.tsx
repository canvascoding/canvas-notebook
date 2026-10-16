import assert from 'node:assert/strict';
import React, { act, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import messages from '../messages/en.json';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { parseChatBody, projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { createTextChatBody } from '../app/lib/chat/body-state';
import { persistComposePromptHandoff, readNewChatComposerDraft } from '../app/lib/chat/composer-handoff';
import { composerDraftScope, loadComposerDraftBody, saveComposerDraft } from '../app/lib/chat/draft-storage';
import { createPromptHandoff, persistPromptHandoff, type PromptHandoff } from '../app/lib/chat/prompt-handoff';
import { useChatSessionBootstrap } from '../app/components/canvas-agent-chat/useChatSessionBootstrap';
import { useChatComposerDraft } from '../app/components/canvas-agent-chat/useChatComposerDraft';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'DOMException'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const noop = () => {};
let sends = 0;
const renderedBody = () => parseChatBody(JSON.parse(document.querySelector('[data-body]')!.getAttribute('data-body')!));
function Harness({ workspaceId, authReady = true, requested = null }: { workspaceId: string; authReady?: boolean; requested?: string | null }) {
  const t = useTranslations('chat');
  const [body, setBody] = useState<ChatBodyV1>(() => createTextChatBody(''));
  const [resolving, setResolving] = useState(true);
  const consumed = useRef(false), userNew = useRef(false), session = useRef<string | null>(null);
  const agent = useRef('canvas-agent'), loaded = useRef(true), cleanup = useRef<string | null>(null);
  const setInput = useCallback((next: React.SetStateAction<string>) => setBody(previous => createTextChatBody(
    typeof next === 'function' ? next(projectChatBodyText(previous)) : next)), []);
  useChatComposerDraft({ input: projectChatBodyText(body), inputBody: body, messages: [], sessionId: null, setInput, setInputBody: setBody });
  const compose = useCallback((handoff: PromptHandoff) => {
    setBody(persistComposePromptHandoff(handoff, workspaceId)); userNew.current = true; setResolving(false);
  }, [workspaceId]);
  const restore = useCallback(() => {
    const saved = readNewChatComposerDraft(workspaceId);
    if (saved) setBody(previous => projectChatBodyText(previous) ? previous : saved);
  }, [workspaceId]);
  useChatSessionBootstrap({ activeWorkspaceId: workspaceId, addSessionToHistory: noop, appendSystemMessage: noop,
    clearSessionParamFromUrl: noop, fetchHistory: async () => {}, forcedSessionId: requested,
    handleControlAction: async () => { sends++; }, hasLoadedSessionListRef: loaded, historyLength: 0,
    initialPromptConsumedRef: consumed, initialPromptStorageKey: 'creator-lifecycle', onComposeHandoff: compose,
    onRestoreNewChatDraft: restore, isLoadingHistory: false, isAuthReady: authReady, isResolvingInitialChatState: resolving,
    isRuntimeSelectionLoading: false, isWorkspaceNavigationPending: false, loadSession: async () => { session.current = requested; },
    loadSessionList: async () => [], requestedSessionCleanupRef: cleanup, resolvedRequestedSessionId: requested,
    selectedAgentId: 'canvas-agent', sessionAgentIdRef: agent, sessionId: null, sessionIdRef: session,
    setHistoryAgentFilter: noop, setHistoryAndLatest: noop, setIsResolvingInitialChatState: setResolving,
    setSelectedAgentId: noop, showHistory: false, t, userStartedNewChatRef: userNew });
  return <div data-body={JSON.stringify(body)} />;
}
async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, session: { sessionId: 'existing', agentId: 'canvas-agent', workspace: { workspaceId: 'w1' } } });
  observeOpenedDocumentAuth({ data: { user: { id: 'creator-user' }, session: { id: 'creator-auth' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'w1' });
  const body = parseChatBody({ version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'creator-occurrence', bundleId: 'creator-bundle' },
    { type: 'text', text: '\nPurpose: draft a report' }], bundles: [{ id: 'creator-bundle', caption: 'Plugin Creator',
    primary: { selection: { kind: 'core_plugin', coreSource: { resourceRef: 'canvas-capability:v1:plugin:system:core:plugin-creator',
      coreRevision: '1.0.0', checksum: 'a'.repeat(64) } }, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] });
  const handoff = createPromptHandoff({ prompt: projectChatBodyText(body), body, attachments: [], agentId: 'canvas-agent', mode: 'compose',
    workspaceId: 'w1', auth: { userId: 'creator-user', sessionId: 'creator-auth' } });
  persistPromptHandoff(window.sessionStorage, 'creator-lifecycle', handoff);
  window.history.replaceState(null, '', `?workspaceId=w1&chat=open&handoff=${handoff.handoffId}`);
  const root = createRoot(document.getElementById('root')!);
  const render = async (key: string, props: React.ComponentProps<typeof Harness>) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness key={key} {...props} /></NextIntlClientProvider>);
  });
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  try {
    await render('compose', { workspaceId: 'w1' }); await settle();
    assert.deepEqual(renderedBody(), body); assert.equal(window.sessionStorage.getItem('creator-lifecycle'), null);
    assert.deepEqual(loadComposerDraftBody('__new__', composerDraftScope('w1')), body);
    await render('reload', { workspaceId: 'w1', authReady: false });
    assert.equal(projectChatBodyText(renderedBody()), '', 'Reload waits for current authentication before restoring private bytes.');
    await render('reload', { workspaceId: 'w1', authReady: true }); await settle();
    assert.deepEqual(renderedBody(), body, 'A fresh bootstrap restores the exact inline body after handoff consumption.');
    assert.deepEqual(loadComposerDraftBody('__new__', composerDraftScope('w1')), body, 'Empty initial autosave cannot erase the restored body.');
    await render('reload-again', { workspaceId: 'w1' }); await settle(); assert.deepEqual(renderedBody(), body);
    await render('requested-session', { workspaceId: 'w1', requested: 'existing' });
    assert.equal(projectChatBodyText(renderedBody()), '', 'An explicit existing session does not inherit the new-chat draft.');
    useWorkspaceStore.setState({ activeWorkspaceId: 'w2' });
    await render('other-workspace', { workspaceId: 'w2' }); await settle(); assert.equal(projectChatBodyText(renderedBody()), '');
    observeOpenedDocumentAuth({ data: { user: { id: 'another-user' }, session: { id: 'another-auth' } } });
    useWorkspaceStore.setState({ activeWorkspaceId: 'w1' });
    await render('other-user', { workspaceId: 'w1' }); await settle(); assert.equal(projectChatBodyText(renderedBody()), '');
    saveComposerDraft('__new__', 'legacy local draft');
    await render('legacy-draft', { workspaceId: 'w1' }); await settle(); assert.equal(projectChatBodyText(renderedBody()), 'legacy local draft');
    assert.equal(sends, 0, 'Composition, reload and fallback never send a message or create a session.');
    console.log('PASS Creator composer lifecycle: actual bootstrap+autosave, consumed exact Core reference, delayed auth/repeated reload, requested-session isolation, workspace/account isolation and legacy draft fallback without send.');
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
