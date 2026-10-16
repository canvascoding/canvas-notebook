import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { chatInlineReferenceIconKey, type ChatInlineReferenceIcons } from '../app/lib/chat/inline-editor';
import { chatExtensionOptionsRequestSchema, type ChatExtensionOptionsRequest } from '../app/lib/chat/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import type { ChatInlineEditorHandle } from '../app/components/canvas-agent-chat/ChatInlineEditor';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

// Genuine list/config/reference/presentation hooks and editor. Only their HTTP
// and observed sign-in UI boundaries are controlled; no SQL/source grant is issued.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://reference-session.fixture.invalid', pretendToBeVisual: true });
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [], configurable: true });
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(), configurable: true });
const domErrors: unknown[] = [];
dom.window.addEventListener('error', event => domErrors.push(event.error ?? event.message));
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'KeyboardEvent', 'MouseEvent', 'DOMParser', 'DOMRect', 'DocumentFragment', 'Text', 'requestAnimationFrame', 'cancelAnimationFrame'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const auth = { user: { id: 'session-reference-user' }, session: { id: 'session-reference-auth' } };
const loader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => name.endsWith('/auth-client')
  ? { authClient: { useSession: () => ({ data: auth, isPending: false, error: null }) } }
  : originalLoad(name, parent, isMain);

const selection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'personal' as const,
  connectionRef: 'mcp-personal:10000000-0000-4000-8000-000000000001' } };
const initialBody: ChatBodyV1 = { version: 1, parts: [{ type: 'extension_reference', occurrenceId: 'saved-occurrence', bundleId: 'saved-bundle' },
  { type: 'text', text: ' /' }], bundles: [{ id: 'saved-bundle', caption: 'Saved exact MCP',
  primary: { selection, requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }] };
const actualSession = { sessionId: 'stored-specialist-session', agentId: 'stored-specialist' };
const exactTarget = { kind: 'turn', sessionId: actualSession.sessionId, expectedAgentId: actualSession.agentId, expectedWorkspaceId: 'workspace-a' };
type Controller = ReturnType<(typeof import('../app/components/canvas-agent-chat/useComposerReferences'))['useComposerReferences']>;
type Held = { request: ChatExtensionOptionsRequest; resolve: (response: Response) => void };

async function main() {
  const { render, screen, fireEvent, within, waitFor, act, cleanup } = await import('@testing-library/react');
  const { useChatAgentConfig } = await import('../app/components/canvas-agent-chat/useChatAgentConfig');
  const { useChatRuntimeSelection } = await import('../app/components/canvas-agent-chat/useChatRuntimeSelection');
  const { useComposerReferences } = await import('../app/components/canvas-agent-chat/useComposerReferences');
  const { useChatReferencePresentation } = await import('../app/components/canvas-agent-chat/useChatReferencePresentation');
  const { ChatInlineEditor } = await import('../app/components/canvas-agent-chat/ChatInlineEditor');
  const { ChatExtensionReferenceDialog } = await import('../app/components/canvas-agent-chat/ChatExtensionReferenceDialog');
  loader._load = originalLoad;
  const originalFetch = globalThis.fetch;
  let resolveAgentList!: (response: Response) => void, listReads = 0, holdDefaultMetadata = false, cases = 0;
  const agentList = new Promise<Response>(resolve => { resolveAgentList = resolve; });
  const requests: ChatExtensionOptionsRequest[] = [], held: Held[] = [];
  const runtimeRequests: Array<{ workspaceId: string | null; agentId: string | null; sessionId: string | null }> = [];
  const runtimeSelection = { providerInstallationId: 'approved-provider', providerId: 'openai', modelId: 'approved-model', thinkingLevel: 'off' as const };
  const publicIcon = { url: 'https://reference-session.fixture.invalid/source-icon.png', sourceKey: 'fresh-specialist-icon' };
  const header = (request: ChatExtensionOptionsRequest) => ({ schemaVersion: 1, operation: request.operation, target: request.target,
    contextKey: JSON.stringify(request.target), coverage: [], limits: EXTENSION_SELECTION_LIMITS, agentRevision: 1, workflowRevision: 0,
    preferenceRevision: 0, finalSendValidationRequired: true });
  const response = (request: ChatExtensionOptionsRequest, stale = false) => {
    const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 1 };
    const common = header(request);
    if (request.operation === 'search') return Response.json({ success: true, data: { ...common, query: request,
      items: [{ item: { id: stale ? 'stale-default-row' : 'exact-mcp-row', kind: 'mcp', name: 'MCP', displayName: 'MCP', description: 'Local metadata',
        source: 'mcp', stock: 'installed', access: { canRead: true, canUse: true, canManage: false }, connections: [],
        mcp: { transport: 'http', template: false, connectionRef: selection.target.connectionRef } }, eligibility: { action: 'select' }, selection }],
      recents: [], selectedItem: null, scopes: {}, pagination } });
    if (request.operation === 'presentation') return Response.json({ success: true, data: { ...common,
      entries: request.selections.map(value => ({ selection: value, publicIcon: stale ? { ...publicIcon, sourceKey: 'stale-default-icon' } : publicIcon })) } });
    if (request.operation === 'connection_choices') return Response.json({ success: true, data: { ...common, selector: request.selector,
      connections: [{ id: 'actual-choice', label: 'Exact account', selection, scopeLabel: 'personal', allowedToolNames: null,
        eligibility: { action: 'select' }, authorization: 'unknown', health: 'unknown', mappingRequired: false }], profiles: [], accounts: [], pagination } });
    if (request.operation === 'preview') return Response.json({ success: true, data: { ...common, preview: { configurationReadiness: 'unknown',
      contextValidation: 'unknown', personalSetupRequired: false, runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSendValidationRequired: true,
      budget: null, issues: [], requirements: [], effectiveToolCaps: [], toolConflicts: [] } } });
    throw new Error(`Unexpected metadata operation ${request.operation}`);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.href);
    if (url.pathname === '/api/agents') { listReads++; return agentList; }
    if (url.pathname === '/api/user-preferences') return Response.json({ success: true, data: { lastActiveAgentId: 'bradley' } });
    if (url.pathname === '/api/agent-runtime/effective') {
      runtimeRequests.push({ workspaceId: url.searchParams.get('workspaceId'), agentId: url.searchParams.get('agentId'), sessionId: url.searchParams.get('sessionId') });
      return Response.json({ success: true, resolution: { catalogRevision: 1, policyRevision: 1, providers: [], issues: [],
        effectiveSelection: { selection: runtimeSelection }, source: 'session' } });
    }
    assert.equal(url.pathname, '/api/chat/extension-options');
    const request = chatExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body))); requests.push(request);
    if (holdDefaultMetadata && request.target.kind === 'draft_turn' && ['search', 'presentation'].includes(request.operation))
      return new Promise<Response>(resolve => held.push({ request, resolve }));
    return response(request);
  };
  let current!: { controller: Controller; editor: React.RefObject<ChatInlineEditorHandle | null>; selectedAgentId: string; icons: ChatInlineReferenceIcons;
    runtime: ReturnType<typeof useChatRuntimeSelection> };
  function Harness({ sessionId, session }: { sessionId: string | null; session: typeof actualSession | null }) {
    const config = useChatAgentConfig({ initialAgentId: 'bradley', sessionId, workspaceId: 'workspace-a' });
    const { setSelectedAgentId } = config;
    useLayoutEffect(() => { setSelectedAgentId(actualSession.agentId); }, [setSelectedAgentId]);
    const [body, setBody] = useState(initialBody), editor = useRef<ChatInlineEditorHandle | null>(null);
    const composerAgentId = sessionId ? session?.agentId ?? null : config.selectedAgentId;
    const runtime = useChatRuntimeSelection({ workspaceId: 'workspace-a', sessionId, agentId: composerAgentId ?? '' });
    const controller = useComposerReferences({ agentId: composerAgentId,
      sessionId, inputBody: body, workspaceId: 'workspace-a', setInputBody: setBody, editorRef: editor, resetInputHistoryNavigation: () => {} });
    const icons = useChatReferencePresentation(controller.target, [body]);
    current = { controller, editor, selectedAgentId: config.selectedAgentId, icons, runtime };
    return <><ChatInlineEditor ref={editor} body={body} onBodyChange={controller.handleInputChange} onSelectionChange={controller.handleSelectionChange} icons={icons} />
      {controller.pendingReference ? <ChatExtensionReferenceDialog request={controller.pendingReference}
        onClose={controller.closeReferenceDialog} onSelect={controller.acceptReference} /> : null}</>;
  }
  const wrap = (sessionId: string | null, session: typeof actualSession | null) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <Harness sessionId={sessionId} session={session} /></NextIntlClientProvider>;
  const search = async () => { await act(async () => { current.editor.current!.focusEnd();
    current.controller.handleSelectionChange(current.editor.current!.getSelection()); }); };
  try {
    observeOpenedDocumentAuth({ data: auth });
    const view = render(wrap(actualSession.sessionId, null));
    await waitFor(() => assert.equal(listReads, 1)); await search();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(current.selectedAgentId, 'bradley', 'The genuine pending agent list still projects the default list selection.');
    assert.equal(current.controller.target, null); assert.equal(requests.length, 0); assert.equal(runtimeRequests.length, 0);
    cases++; console.log('PASS unresolved stored session never substitutes the default agent or starts search/presentation/runtime reads');

    view.rerender(wrap(actualSession.sessionId, actualSession)); await search();
    await waitFor(() => assert(current.controller.referencePickerItems.some(item => item.id === 'exact-mcp-row')));
    await waitFor(() => assert.deepEqual(current.icons[chatInlineReferenceIconKey(selection)], publicIcon));
    await waitFor(() => assert.deepEqual(current.runtime.selection, runtimeSelection));
    assert.deepEqual(runtimeRequests, [{ workspaceId: 'workspace-a', agentId: actualSession.agentId, sessionId: actualSession.sessionId }]);
    assert.equal(current.selectedAgentId, 'bradley', 'No list response was delivered to make this test pass.');
    assert(requests.length >= 2); assert(requests.every(request => JSON.stringify(request.target) === JSON.stringify(exactTarget)));
    const row = current.controller.referencePickerItems.find(item => item.id === 'exact-mcp-row')!;
    await act(async () => { current.controller.configureReference(row); });
    assert.deepEqual(current.controller.pendingReference?.target, exactTarget);
    const label = await screen.findByText('Exact account');
    await act(async () => { fireEvent.click(within(label.closest('.rounded-md') as HTMLElement).getByRole('button', { name: 'Choose' })); });
    const insert = screen.getByRole('button', { name: 'Insert into text' });
    await waitFor(() => assert.equal((insert as HTMLButtonElement).disabled, false));
    await act(async () => { fireEvent.click(insert); });
    await waitFor(() => assert(requests.some(request => request.operation === 'preview')));
    assert(requests.every(request => JSON.stringify(request.target) === JSON.stringify(exactTarget)));
    cases++; console.log('PASS existing session uses its stored specialist for search, icons, chooser, preview and approved runtime while the actual agent list is pending');

    holdDefaultMetadata = true;
    view.rerender(wrap(null, null)); await act(async () => { current.editor.current!.replaceText(' /'); }); await search();
    await waitFor(() => assert(held.some(value => value.request.operation === 'search') && held.some(value => value.request.operation === 'presentation')));
    const oldController = current.controller;
    view.rerender(wrap(actualSession.sessionId, actualSession)); await search();
    await waitFor(() => assert(current.controller.referencePickerItems.some(item => item.id === 'exact-mcp-row')));
    await waitFor(() => assert.deepEqual(current.icons[chatInlineReferenceIconKey(selection)], publicIcon));
    await act(async () => { for (const pending of held) pending.resolve(response(pending.request, true)); });
    assert(current.controller.referencePickerItems.every(item => item.id !== 'stale-default-row'));
    assert.deepEqual(current.icons[chatInlineReferenceIconKey(selection)], publicIcon);
    await act(async () => oldController.handleReferenceSelect(row));
    assert.equal(current.controller.pendingReference, null);
    const targetBeforeList = current.controller.target;
    await act(async () => resolveAgentList(Response.json({ success: true, data: { agents: [{ agentId: actualSession.agentId,
      name: 'Stored specialist', iconId: 'bot', type: 'specialist', removable: true }] } })));
    await waitFor(() => assert.equal(current.selectedAgentId, actualSession.agentId));
    assert.deepEqual(current.controller.target, targetBeforeList);
    cases++; console.log('PASS late default-scope metadata and callbacks cannot replace stored-session results; later agent-list hydration preserves the same exact target');
    assert.deepEqual(domErrors, []);
    console.log(JSON.stringify({ status: 'PASS', cases, database: false, browser: false, provider: false, authority: false }));
  } finally {
    cleanup(); globalThis.fetch = originalFetch; loader._load = originalLoad; observeOpenedDocumentAuth(null); dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
