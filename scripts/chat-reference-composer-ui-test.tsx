import assert from 'node:assert/strict';
import React, { useRef, useState } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { projectChatBodyText, deriveChatBodySelection, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { chatInlineReferenceIconKey } from '../app/lib/chat/inline-editor';
import type { ChatInlineEditorHandle } from '../app/components/canvas-agent-chat/ChatInlineEditor';
import { chatExtensionOptionsRequestSchema, type ChatExtensionOptionsRequest } from '../app/lib/chat/extension-options-contracts';
import type { AgentExtensionSearchItem, AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

// Actual Hook -> Dialog -> common chooser -> Tiptap insertion. Only metadata
// HTTP is controlled; no source/account/SQL/runtime authority is manufactured.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://reference-composer.fixture.invalid', pretendToBeVisual: true });
// jsdom has no text layout; scrolling is outside this test's evidence boundary.
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [], configurable: true });
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(), configurable: true });
const domErrors: unknown[] = [];
dom.window.addEventListener('error', event => { domErrors.push(event.error ?? event.message); });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'KeyboardEvent', 'MouseEvent', 'DOMParser', 'DOMRect', 'DocumentFragment', 'Text', 'requestAnimationFrame', 'cancelAnimationFrame'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const plain = (text = ''): ChatBodyV1 => ({ version: 1, parts: text ? [{ type: 'text', text }] : [], bundles: [] });
const pin = { resourceRef: 'canvas-resource:10000000-0000-4000-8000-000000000001',
  publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000002', checksum: 'a'.repeat(64) };
const mcp = (index: number) => ({ kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'personal' as const,
  connectionRef: `mcp-personal:10000000-0000-4000-8000-${String(index).padStart(12, '0')}` } });
const account = (id: string) => ({ kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva', target: {
  kind: 'personal' as const, profileId: 'own-profile', accountBinding: 'account' as const, accountId: id, connectionRef: `composio-personal:own-profile:${id}` } });
const commonItem = { description: 'Source metadata', stock: 'installed' as const, access: { canRead: true, canUse: true, canManage: false } };
const mcpOption = (index: number): AgentExtensionSearchItem => ({ item: { ...commonItem, id: `mcp-row-${index}`, kind: 'mcp', name: 'twin', displayName: 'Twin',
  source: 'mcp', mcp: { transport: 'http', template: false, connectionRef: mcp(index).target.connectionRef }, connections: [] }, eligibility: { action: 'select' }, selection: mcp(index), chatAvailability: 'ready' });
const metadataMcp: AgentExtensionSearchItem = { item: { ...mcpOption(9).item, id: 'mcp-metadata-row' }, eligibility: { action: 'select' }, chatAvailability: 'setup' };
const integration: AgentExtensionSearchItem = { item: { ...commonItem, id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva',
  source: 'composio', toolkit: { slug: 'canva', noAuth: false }, connections: [] }, eligibility: { action: 'choose_connection' } };
const plugin: AgentExtensionSearchItem = { item: { ...commonItem, id: pin.resourceRef, kind: 'plugin', name: 'design', displayName: 'Design plugin', source: 'local' },
  eligibility: { action: 'select' }, selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } } };
const coreRows: AgentExtensionSearchItem[] = [
  { item: { ...commonItem, id: 'core-skill', kind: 'skill', name: 'skill-creator', displayName: 'Skill Creator', source: 'local' },
    eligibility: { action: 'select' }, chatAvailability: 'ready', selection: { kind: 'core_skill', coreSource: { resourceRef: 'canvas-capability:v1:skill:system:core:skill-creator', coreRevision: '1.0.0', checksum: 'b'.repeat(64) } } },
  { item: { ...commonItem, id: 'core-plugin', kind: 'plugin', name: 'plugin-creator', displayName: 'Plugin Creator', source: 'local' },
    eligibility: { action: 'select' }, chatAvailability: 'ready', selection: { kind: 'core_plugin', coreSource: { resourceRef: 'canvas-capability:v1:plugin:system:core:plugin-creator', coreRevision: '1.0.0', checksum: 'c'.repeat(64) } } },
];
const standaloneSkill: AgentExtensionSearchItem = { item: { ...commonItem, id: 'standalone-skill', kind: 'skill', name: 'root', displayName: 'Root skill', source: 'local' },
  eligibility: { action: 'select' }, selection: { kind: 'skill', origin: 'standalone', relativeRoot: '', package: pin } };
const packageMetadata: AgentExtensionPackageVersion = { pin, kind: 'plugin', name: 'design', displayName: 'Design plugin', version: '1.0.0', description: 'Exact held package',
  children: [{ name: 'root', title: 'Root skill', description: 'Required root', relativeRoot: '', origin: 'plugin_child', required: true },
    { name: 'child', title: 'Optional child', description: 'Own child declaration', relativeRoot: 'skills/child', origin: 'plugin_child', required: false }],
  declarations: [{ declarationPath: '.canvas-plugin/plugin.json', workflow: { version: 1, integrationCapabilities: [
    { id: 'knowledge', application: 'knowledge', required: true, alternatives: [{ source: 'mcp', connector: 'knowledge' }] }] } },
  { declarationPath: 'agents/canvas.yaml', workflow: { version: 1, integrationCapabilities: [] } },
  { declarationPath: 'skills/child/agents/canvas.yaml', workflow: { version: 1, integrationCapabilities: [
    { id: 'design', application: 'canva', required: true, alternatives: [{ source: 'composio', toolkit: 'canva' }] }] } }] };
type Controller = ReturnType<(typeof import('../app/components/canvas-agent-chat/useComposerReferences'))['useComposerReferences']>;
type Frame = { body: ChatBodyV1; controller: Controller; editor: React.RefObject<ChatInlineEditorHandle | null>; replace: (body: ChatBodyV1) => void };
type Pending = { request: Extract<ChatExtensionOptionsRequest, { operation: 'preview' }>; resolve: (response: Response) => void };

async function main() {
  const { render, screen, fireEvent, within, waitFor, act, cleanup } = await import('@testing-library/react');
  const { useComposerReferences } = await import('../app/components/canvas-agent-chat/useComposerReferences');
  const { ChatInlineEditor } = await import('../app/components/canvas-agent-chat/ChatInlineEditor');
  const { ChatExtensionReferenceDialog } = await import('../app/components/canvas-agent-chat/ChatExtensionReferenceDialog');
  const { ComposerReferencePicker } = await import('../app/components/canvas-agent-chat/ComposerReferencePicker');
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), scopeNumber = 0, cases = 0;
  const blocked: AgentExtensionSearchItem = { item: { ...plugin.item, id: 'blocked-plugin' }, eligibility: { action: 'unavailable', reason: { code: 'USE_DENIED', message: 'Current use is required.' } } };
  const missingSelection: AgentExtensionSearchItem = { item: { ...plugin.item, id: 'missing-selection' }, eligibility: { action: 'select' } };
  const unpublishedSkillRef = 'canvas-capability:v1:skill:user:fixture-owner:standalone:canvas-design';
  const unpublishedSkill: AgentExtensionSearchItem = { item: { ...commonItem, kind: 'skill', id: unpublishedSkillRef,
    name: 'canvas-design', displayName: 'Canvas design', source: 'local',
    package: { resourceRef: unpublishedSkillRef, legacyResourceId: unpublishedSkillRef, kind: 'skill', name: 'canvas-design',
      displayName: 'Canvas design', description: 'Unpublished personal source', version: '1.0.0', revision: 0,
      ownership: { type: 'user', ownerUserId: 'fixture-owner', organizationId: null }, access: { canRead: true, canUse: true, canEdit: false, canManage: false } } }, eligibility: { action: 'setup', reason: {
      code: 'AGENT_EXTENSION_PUBLISH_REQUIRED', message: 'Publish this package before selecting it.' } } };
  const rows = [mcpOption(1), mcpOption(2), metadataMcp, integration, plugin, ...coreRows, standaloneSkill, blocked, missingSelection, unpublishedSkill];
  let current: Frame | undefined, requests: ChatExtensionOptionsRequest[] = [], pending: Pending[] = [], holdPreview = false;
  let servedMetadata = packageMetadata, holdRemote = false, failRemote = false, failLocal = false, failConnected = false;
  let holdPhase: 'local' | 'connected' | null = null;
  let phasePending: Array<{ request: Extract<ChatExtensionOptionsRequest, { operation: 'search' }>; resolve: (response: Response) => void }> = [];
  let connectedRows: AgentExtensionSearchItem[] = [];
  let searchOverride: ((request: Extract<ChatExtensionOptionsRequest, { operation: 'search' }>) => Response | undefined | Promise<Response | undefined>) | null = null;
  let remotePending: Array<{ request: Extract<ChatExtensionOptionsRequest, { operation: 'search' }>; resolve: (response: Response) => void }> = [];
  let recentBundles: import('../app/lib/chat/extension-options-contracts').ChatExtensionRecentItem[] = [];
  let expiry: string | undefined, receiptCounter = 0;
  Date.now = () => now;
  const frame = () => { assert(current); return current; };
  const header = (request: ChatExtensionOptionsRequest) => ({ schemaVersion: 1 as const, operation: request.operation, target: request.target,
    contextKey: JSON.stringify(request.target), coverage: [], limits: EXTENSION_SELECTION_LIMITS, agentRevision: 1, workflowRevision: 0,
    preferenceRevision: 0, finalSendValidationRequired: true as const });
  const validPreview = (request: Extract<ChatExtensionOptionsRequest, { operation: 'preview' }>) => Response.json({ success: true,
    data: { ...header(request), preview: { configurationReadiness: 'unknown', contextValidation: 'unknown', personalSetupRequired: false,
      runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSendValidationRequired: true, budget: null,
      issues: [], requirements: [], effectiveToolCaps: [], toolConflicts: [] } } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.href);
    if (url.pathname === '/api/files/list') {
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId'));
      assert.equal(url.searchParams.get('limit'), '30');
      return Response.json({ success: true, files: [{ name: 'canva-notes.md', path: 'notes/canva-notes.md', type: 'file', isImage: false }], total: 1 });
    }
    assert.equal(String(input), '/api/chat/extension-options', 'The actual chat metadata client never uses Agent configuration authority.');
    const request = chatExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body))); requests.push(request);
    const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 1 };
    if (request.operation === 'search') {
      const overridden = await searchOverride?.(request);
      if (overridden) return overridden;
      if (request.phase === 'local' && failLocal) throw new Error('Local unavailable');
      if (request.phase === 'connected' && failConnected) throw new Error('Connected unavailable');
      if (request.phase === holdPhase) return new Promise<Response>(resolve => phasePending.push({ request, resolve }));
      if (request.phase === 'remote' && failRemote) throw new Error('Remote unavailable');
      if (request.phase === 'remote' && holdRemote) return new Promise<Response>(resolve => remotePending.push({ request, resolve }));
      return Response.json({ success: true, data: { ...header(request), query: request,
        items: (request.phase === 'connected' ? connectedRows : rows).filter(row => request.types.includes(row.item.kind)), selectedItem: null, scopes: { choices: ['all'], teams: [] }, pagination,
        recents: request.phase === 'remote' ? [] : recentBundles } });
    }
    if (request.operation === 'package_version') {
      assert.deepEqual({ resourceRef: request.resourceRef, publishedRevisionRef: request.publishedRevisionRef, checksum: request.checksum }, pin);
      return Response.json({ success: true, data: { ...header(request), package: servedMetadata } });
    }
    if (request.operation === 'preview') {
      if (holdPreview) return new Promise<Response>(resolve => pending.push({ request, resolve }));
      return validPreview(request);
    }
    if (request.operation === 'connection_choices') {
      const source = request.selector.kind === 'standalone' ? request.selector.source : request.selector.alternativeKey.startsWith('mcp:') ? 'mcp' : 'composio';
      const connections = source === 'mcp' ? [1, 2, 9].map(index => ({ id: `choice-${index}`, label: `MCP account ${index}`, selection: mcp(index),
        scopeLabel: 'personal', allowedToolNames: null, eligibility: { action: 'select' }, authorization: 'unknown', health: 'unknown', mappingRequired: false })) : [];
      const accounts = source === 'composio' && request.profileId ? ['account-a', 'account-b'].map((id, index) => ({ selection: account(id), label: `Exact account ${id}`,
        status: 'ACTIVE', selectable: true, accountSelectionRef: `cmp_personal_account_${String.fromCharCode(97 + receiptCounter + index).repeat(43)}`,
        ...(expiry ? { expiresAt: expiry } : {}) })) : [];
      if (accounts.length) receiptCounter += 2;
      return Response.json({ success: true, data: { ...header(request), selector: request.selector, connections, accounts,
        profiles: source === 'composio' && !request.profileId ? [{ profileId: 'own-profile', label: 'Own profile', status: 'unverified' }] : [], pagination } });
    }
    throw new Error(`Unexpected actual operation ${request.operation}`);
  };
  function Harness({ workspaceId = 'workspace-a', agentId = 'agent-a', sessionId = null, initial = plain() }:
    { workspaceId?: string; agentId?: string; sessionId?: string | null; initial?: ChatBodyV1 }) {
    const [body, setBody] = useState(initial), editor = useRef<ChatInlineEditorHandle | null>(null);
    const controller = useComposerReferences({ agentId, sessionId, inputBody: body, workspaceId, setInputBody: setBody, editorRef: editor,
      resetInputHistoryNavigation: () => {} });
    current = { body, controller, editor, replace: setBody };
    return <><ChatInlineEditor ref={editor} body={body} onBodyChange={controller.handleInputChange} onSelectionChange={controller.handleSelectionChange}
      onKeyDown={event => { if (!controller.activeReferenceMatch) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); controller.selectNextReference(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); controller.selectPreviousReference(); }
        else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); const item = controller.referencePickerItems[controller.selectedReferenceIndex]; if (item) controller.handleReferenceSelect(item); }
        else if (event.key === 'Escape') { event.preventDefault(); controller.closeReferencePicker(); }
      }} />
      {controller.activeReferenceMatch ? <ComposerReferencePicker header="References" emptyState="No results" items={controller.referencePickerItems}
        selectedIndex={controller.selectedReferenceIndex} onSelect={controller.handleReferenceSelect} onConfigure={controller.configureReference}
        isLoading={controller.isLoadingReferenceItems} sourceStatuses={controller.referenceSourceStatuses} onRetrySource={controller.retryReferenceSource} /> : null}
      {controller.pendingReference ? <ChatExtensionReferenceDialog request={controller.pendingReference} onClose={controller.closeReferenceDialog} onSelect={controller.acceptReference} /> : null}</>;
  }
  const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>{node}</NextIntlClientProvider>;
  const mount = async (initial = plain(), strict = false) => {
    cleanup(); requests = []; pending = []; holdPreview = false; receiptCounter = 0; expiry = new Date(now + 60_000).toISOString();
    servedMetadata = packageMetadata; holdRemote = false; failRemote = false; remotePending = []; recentBundles = [];
    holdPhase = null; failLocal = false; failConnected = false; phasePending = []; connectedRows = rows;
    searchOverride = null;
    observeOpenedDocumentAuth({ data: { user: { id: `composer-user-${++scopeNumber}` }, session: { id: `auth-session-${scopeNumber}` } } });
    const view = render(wrap(strict ? <React.StrictMode><Harness initial={initial} /></React.StrictMode> : <Harness initial={initial} />));
    await waitFor(() => assert(screen.getByRole('textbox')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); return view;
  };
  const open = async (id: string, configure = true) => {
    await act(async () => { frame().editor.current!.focusEnd();
      frame().controller.openReferencePicker(); });
    assert.equal(frame().controller.activeReferenceMatch?.trigger, '@');
    assert.equal(frame().controller.activeReferenceMatch?.kind, 'all');
    await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === id), JSON.stringify({ id,
      body: frame().body, match: frame().controller.activeReferenceMatch, error: frame().controller.referencePickerError })));
    await act(async () => {
      if (configure) frame().controller.configureReference(frame().controller.referencePickerItems.find(item => item.id === id)!);
      else fireEvent.click([...document.querySelectorAll('[data-reference-id]')].find(element => element.getAttribute('data-reference-id') === id)!);
    });
    if (configure) await screen.findByTestId('chat-extension-reference-dialog');
  };
  const chooseMcp = async (index = 1) => {
    const label = await screen.findByText(`MCP account ${index}`), row = label.closest('.rounded-md')!;
    const button = within(row as HTMLElement).getByRole('button', { name: 'Choose' });
    await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false)); await act(async () => { fireEvent.click(button); });
  };
  const chooseAccount = async (id = 'account-a') => {
    const profile = await screen.findByRole('button', { name: /Own profile/u });
    await act(async () => { fireEvent.click(profile); });
    const row = (await screen.findByText(`Exact account ${id}`)).closest('.rounded-md')!;
    await act(async () => { fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'This account' })); });
  };
  const insert = async () => { const button = screen.getByRole('button', { name: 'Insert into text' });
    await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false)); await act(async () => { fireEvent.click(button); }); };
  const resolvePreview = async (index = 0) => { await act(async () => pending[index].resolve(validPreview(pending[index].request))); };
  const check = (name: string) => { cases++; console.log(`PASS ${name}`); };
  const searchReply = (request: Extract<ChatExtensionOptionsRequest, { operation: 'search' }>, items: AgentExtensionSearchItem[], nextCursor: string | null = null) =>
    Response.json({ success: true, data: { ...header(request), query: request, items, recents: [], selectedItem: null, scopes: {},
      pagination: { hasNextPage: nextCursor !== null, nextCursor, loadedItems: items.length } } });
  try {
    await mount(plain(), true); await open('core-skill', false);
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.equal(requests.filter(request => request.operation === 'preview').length, 1);
    check('React StrictMode setup replay still inserts directly and starts exactly one preview');

    for (const [id, key] of [['core-skill', 'Enter'], ['core-plugin', 'Tab']] as const) {
      await mount();
      await act(async () => { frame().editor.current!.focusEnd(); frame().editor.current!.replaceText('@'); });
      assert.equal(frame().controller.activeReferenceMatch?.trigger, '@');
      assert.equal(frame().controller.activeReferenceMatch?.kind, 'all');
      await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === id)));
      await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === 'file:notes/canva-notes.md')));
      while (frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex]?.id !== id)
        await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' }); });
      await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key }); });
      await waitFor(() => assert.equal(frame().body.bundles.length, 1));
      assert.equal(screen.queryByTestId('chat-extension-reference-dialog'), null);
      assert.equal(requests.filter(request => request.operation === 'preview').length, 1);
      assert(!requests.some(request => request.operation === 'package_version' || request.operation === 'connection_choices'));
      assert(requests.every(request => request.target.kind === 'draft_turn'));
      assert.equal(document.querySelectorAll('[data-type="extension-reference"]').length, 1);
    }
    check('actual editor ArrowDown plus Enter/Tab inserts a Core skill/plugin exactly once after one fresh preview without dialog, package reads, connection reads, send or Session');

    await mount(); servedMetadata = { ...packageMetadata, declarations: [] };
    await open(pin.resourceRef, false);
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.equal(screen.queryByTestId('chat-extension-reference-dialog'), null);
    assert.equal(requests.filter(request => request.operation === 'package_version').length, 1);
    assert.equal(requests.filter(request => request.operation === 'preview').length, 1);
    assert.equal(frame().body.bundles[0].primary.selection.kind, 'plugin');
    check('published plugin without open requirements uses its exact metadata pin and one fresh preview before direct insertion');

    await mount(); servedMetadata = { ...packageMetadata, kind: 'skill', children: [{ ...packageMetadata.children[0], origin: 'standalone' }], declarations: [] };
    await open('standalone-skill', false);
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.deepEqual(frame().body.bundles[0].primary.selection, standaloneSkill.selection);
    assert.equal(screen.queryByTestId('chat-extension-reference-dialog'), null);
    assert.equal(requests.filter(request => request.operation === 'preview').length, 1);
    check('published standalone skill inserts directly with its exact root and immutable parent pin');

    await mount(); servedMetadata = { ...packageMetadata, declarations: packageMetadata.declarations.map(declaration => ({ ...declaration,
      workflow: { ...declaration.workflow, integrationCapabilities: declaration.workflow.integrationCapabilities.map(capability => ({ ...capability, required: false })) } })) };
    await open(pin.resourceRef, false);
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.equal(frame().body.bundles[0].packageConnections.length, 0);
    assert(!requests.some(request => request.operation === 'connection_choices'));
    check('optional connections do not block direct selection or enumerate personal profiles in the background');

    await mount(); await open(pin.resourceRef, false);
    await screen.findByTestId('chat-extension-reference-dialog');
    assert.equal(requests.some(request => request.operation === 'preview'), false);
    assert.equal(screen.queryByRole('button', { name: 'Insert into text' }), null);
    await chooseMcp(9); assert.equal(frame().body.bundles.length, 0);
    await chooseAccount();
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.equal(frame().body.bundles[0].packageConnections.length, 2);
    assert.equal(requests.filter(request => request.operation === 'preview').length, 1);
    check('a direct plugin opens only its genuine missing connection choices; the final explicit account choice inserts without another confirmation');

    const completed = structuredClone(frame().body.bundles[0]);
    const completeWithCaps = { ...completed, supporting: completed.supporting.map((entry, index) => index === 0 ? { ...entry, toolCap: ['bounded_tool'] } : entry) };
    recentBundles = [{ bodyBundle: completeWithCaps, lastAcceptedAt: now, eligibility: { action: 'select' }, chatAvailability: 'ready' }];
    const beforeRecent = requests.length;
    await act(async () => frame().replace(plain()));
    await open(`recent:${chatInlineReferenceIconKey(completed.primary.selection)}`, false);
    await waitFor(() => assert.equal(frame().body.bundles.length, 1, document.body.textContent ?? 'No DOM'));
    const restored = frame().body.bundles[0];
    assert.deepEqual(restored.packageConnections, completed.packageConnections);
    assert.deepEqual(restored.supporting, completeWithCaps.supporting);
    assert.equal(screen.queryByTestId('chat-extension-reference-dialog'), null);
    assert(!requests.slice(beforeRecent).some(request => request.operation === 'connection_choices'));
    assert.equal(requests.slice(beforeRecent).filter(request => request.operation === 'preview').length, 1);
    assert((await frame().controller.prepareIntakeSelection(frame().body))?.selections.some(entry => entry.accountSelectionRef));
    check('a fully bound Recent retains mappings, supporting selections and tool caps and uses its still valid tab-memory receipt without re-enumerating accounts');

    await mount(); holdPreview = true; await open('core-skill', false);
    await waitFor(() => assert.equal(pending.length, 1));
    await screen.findByTestId('chat-reference-resolution');
    await assert.rejects(frame().controller.prepareIntakeSelection(frame().body), /Loading/u, 'A repeated send cannot admit the unresolved @ query as plain text.');
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); });
    await resolvePreview(); assert.equal(frame().body.bundles.length, 0); assert.equal(frame().controller.pendingReference, null);
    check('Escape cancels a real pending direct preview and a late response cannot insert');

    await mount(); holdPreview = true; await open('core-skill', false);
    await waitFor(() => assert.equal(pending.length, 1));
    await act(async () => { frame().editor.current!.replaceText(' newer text'); });
    const changedBody = structuredClone(frame().body);
    await resolvePreview(); assert.deepEqual(frame().body, changedBody); assert.equal(frame().body.bundles.length, 0);
    check('actual typing cancels an in-flight direct reference while preserving the newer draft');

    await mount(); holdPhase = 'connected';
    recentBundles = [{ bodyBundle: { id: 'stale-support', caption: 'Old account binding', primary: { selection: coreRows[0].selection!, requirement: 'optional', toolCap: null },
      supporting: [{ selection: mcp(8), requirement: 'optional', toolCap: null }], packageConnections: [] }, lastAcceptedAt: now,
      eligibility: { action: 'choose_connection' }, chatAvailability: 'setup' }];
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill' && item.section === 'ready'));
    assert(!frame().controller.referencePickerItems.some(item => item.id.startsWith('recent:')));
    check('an old MRU with unavailable supporting account cannot suppress the current usable row with the same primary selection');

    await mount(); holdPhase = 'connected';
    searchOverride = request => request.phase !== 'local' ? undefined : request.cursor === null
      ? searchReply(request, [coreRows[0], ...Array.from({ length: 49 }, (_, index) => ({ ...blocked, item: { ...blocked.item, id: `setup-page-one-${index}` } }))], 'local-page-two')
      : new Promise<Response>(resolve => phasePending.push({ request, resolve }));
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill' && item.section === 'ready'));
    assert.equal(requests.filter(row => row.operation === 'search' && row.phase === 'connected').length, 0);
    await act(async () => phasePending[0].resolve(searchReply(phasePending[0].request, [coreRows[1]])));
    await waitFor(() => assert.equal(phasePending.length, 2));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-plugin' && item.section === 'ready'));
    assert.deepEqual(requests.filter((row): row is Extract<ChatExtensionOptionsRequest, { operation: 'search' }> => row.operation === 'search' && row.phase === 'local').map(row => row.cursor), [null, 'local-page-two']);
    assert(requests.filter(row => row.operation === 'search').every(row => row.limit === 50));
    assert.equal(requests.filter(row => row.operation === 'search' && row.phase === 'remote').length, 0);
    check('first-page ready rows display immediately while priority cursor pages drain; a usable result beyond the first 50 appears before connected or remote catalog');

    await mount(); holdRemote = true;
    let failPage = true;
    searchOverride = request => {
      if (request.phase !== 'local') return undefined;
      if (request.cursor === null) return searchReply(request, [coreRows[0]], 'retry-page-two');
      if (failPage) throw new Error('Page two unavailable');
      return searchReply(request, [coreRows[1]]);
    };
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill' && item.section === 'ready'));
    failPage = false;
    await act(async () => frame().controller.retryReferenceSource('local'));
    await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === 'core-plugin' && item.section === 'ready')));
    assert.deepEqual(requests.filter((row): row is Extract<ChatExtensionOptionsRequest, { operation: 'search' }> => row.operation === 'search' && row.phase === 'local').map(row => row.cursor), [null, 'retry-page-two', 'retry-page-two']);
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill' && item.section === 'ready'));
    check('a failed priority page retains previous valid rows, advances independent sources and retries only the failing cursor');

    await mount(); holdRemote = true;
    searchOverride = request => request.phase !== 'connected' ? undefined : request.cursor === null
      ? searchReply(request, [mcpOption(1)], 'connected-page-two')
      : new Promise<Response>(resolve => phasePending.push({ request, resolve }));
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-2' && item.section === 'ready'), 'A partial page cannot prove omission.');
    await act(async () => phasePending[0].resolve(searchReply(phasePending[0].request, [])));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-2'));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-1' && item.section === 'ready'));
    check('connected snapshot omission withdraws cached rows only after every connected cursor page is complete');

    await mount();
    searchOverride = request => {
      if (request.phase !== 'local') return undefined;
      const page = request.cursor === null ? 0 : Number(request.cursor.slice('pause-'.length));
      return searchReply(request, page === 0 ? [coreRows[0]] : page === 20 ? [coreRows[1]] : [], page < 20 ? `pause-${page + 1}` : null);
    };
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'local' && row.status === 'paused')));
    assert.equal(requests.filter(row => row.operation === 'search').length, 20);
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill' && item.section === 'ready'));
    assert.equal(requests.filter(row => row.operation === 'search' && row.phase === 'connected').length, 0);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue loading' })));
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.every(row => row.status === 'complete')));
    assert.equal(requests.filter(row => row.operation === 'search' && row.phase === 'local').length, 21);
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-plugin' && item.section === 'ready'));
    check('twenty priority pages pause explicitly without dropping rows; Continue resumes the next cursor before later stages');

    await mount(); holdRemote = true;
    let repeatCursor = true;
    searchOverride = request => request.phase !== 'local' ? undefined : repeatCursor
      ? searchReply(request, [coreRows[0]], 'repeated-cursor') : searchReply(request, [coreRows[1]]);
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert.equal(requests.filter(row => row.operation === 'search' && row.phase === 'local').length, 2);
    assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'local' && row.status === 'unavailable' && row.message?.includes('cursor repeated')));
    repeatCursor = false;
    await act(async () => frame().controller.retryReferenceSource('local'));
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'local' && row.status === 'complete')));
    assert.deepEqual(requests.filter((row): row is Extract<ChatExtensionOptionsRequest, { operation: 'search' }> => row.operation === 'search' && row.phase === 'local').map(row => row.cursor), [null, 'repeated-cursor', null]);
    check('a repeated cursor stops after bounded requests with an explicit error; Retry starts a fresh source snapshot');

    await mount(); holdRemote = true; failConnected = true;
    let invalidateCursor = true;
    searchOverride = request => {
      if (request.phase !== 'local') return undefined;
      if (!invalidateCursor) return searchReply(request, [coreRows[1]]);
      if (request.cursor === null) return searchReply(request, [coreRows[0]], 'obsolete-page');
      return Response.json({ success: false, code: 'CHAT_EXTENSION_CURSOR_CHANGED', error: 'Current search cursor changed.' }, { status: 409 });
    };
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'core-skill'), 'Obsolete source pages must be withdrawn.');
    assert(frame().controller.referencePickerItems.some(item => item.kind === 'file'), 'Other sources stay available.');
    invalidateCursor = false;
    await act(async () => frame().controller.retryReferenceSource('local'));
    await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === 'core-plugin' && item.section === 'ready')));
    assert.deepEqual(requests.filter((row): row is Extract<ChatExtensionOptionsRequest, { operation: 'search' }> => row.operation === 'search' && row.phase === 'local').map(row => row.cursor), [null, 'obsolete-page', null]);
    check('a 409 cursor change withdraws obsolete source pages, preserves independent rows and retries from a fresh cursor');

    await mount(); holdRemote = true;
    searchOverride = request => request.phase === 'connected' ? new Promise<Response>(resolve => phasePending.push({ request, resolve })) : undefined;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    while (frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex]?.id !== 'core-skill')
      await act(async () => {
        const { referencePickerItems, selectedReferenceIndex } = frame().controller;
        if (selectedReferenceIndex > referencePickerItems.findIndex(item => item.id === 'core-skill')) frame().controller.selectPreviousReference();
        else frame().controller.selectNextReference();
      });
    const readyBeforePromotion = frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id);
    const promotedPlugin = { ...plugin, chatAvailability: 'ready' as const };
    await act(async () => phasePending[0].resolve(searchReply(phasePending[0].request, [promotedPlugin], 'connected-after-promotion')));
    await waitFor(() => assert.equal(phasePending.length, 2));
    assert.deepEqual(frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id), [...readyBeforePromotion, pin.resourceRef]);
    assert.equal(frame().controller.referencePickerItems.filter(item => item.id === pin.resourceRef).length, 1);
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, 'core-skill');
    await act(async () => phasePending[1].resolve(searchReply(phasePending[1].request, rows.filter(row => row.item.id !== pin.resourceRef))));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert.equal(frame().controller.referencePickerItems.filter(item => item.id === pin.resourceRef && item.section === 'ready').length, 1);
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, 'core-skill');
    check('a late connected package refresh promotes the same exact setup package once, before all pages finish, while preserving ready order and focused identity');

    await mount(); holdRemote = true;
    const refreshedPin = { ...pin, publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000003', checksum: 'd'.repeat(64) };
    const refreshedPlugin: AgentExtensionSearchItem = { ...promotedPlugin, selection: { kind: 'plugin', package: refreshedPin, skillSelection: { kind: 'all' } } };
    searchOverride = request => request.phase === 'local' ? searchReply(request, [promotedPlugin, { ...standaloneSkill, chatAvailability: 'ready' }, ...coreRows])
      : request.phase === 'connected' ? new Promise<Response>(resolve => phasePending.push({ request, resolve })) : undefined;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    while (frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex]?.id !== 'core-skill')
      await act(async () => {
        const { referencePickerItems, selectedReferenceIndex } = frame().controller;
        if (selectedReferenceIndex > referencePickerItems.findIndex(item => item.id === 'core-skill')) frame().controller.selectPreviousReference();
        else frame().controller.selectNextReference();
      });
    await act(async () => phasePending[0].resolve(searchReply(phasePending[0].request, [refreshedPlugin], 'fresh-package-next-page')));
    await waitFor(() => assert.equal(phasePending.length, 2));
    const freshRows = frame().controller.referencePickerItems.filter(item => item.id === pin.resourceRef);
    assert.equal(freshRows.length, 1);
    assert(freshRows[0].payload.type === 'extension');
    assert.deepEqual(freshRows[0].payload.option.selection, refreshedPlugin.selection);
    assert(frame().controller.referencePickerItems.some(item => item.id === 'standalone-skill' && item.section === 'ready'), 'A partial refreshed page cannot prove a package was removed.');
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, 'core-skill');
    await act(async () => phasePending[1].resolve(searchReply(phasePending[1].request, [coreRows[0]])));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'standalone-skill' || item.id === 'core-plugin'));
    assert.equal(frame().controller.referencePickerItems.filter(item => item.id === pin.resourceRef).length, 1);
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, 'core-skill');
    check('connected refresh immediately replaces a changed package pin and removes omitted packages only after the complete snapshot, without duplicate rows or focus changes');

    await mount(); holdPhase = 'local'; holdRemote = true;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    assert.deepEqual(requests.filter(row => row.operation === 'search').map(row => row.phase), ['local']);
    const localRequest = phasePending[0].request;
    const recentCore = { bodyBundle: { id: 'recent-core', caption: 'Most recent Core', primary: { selection: coreRows[0].selection!, requirement: 'optional' as const, toolCap: null },
      supporting: [], packageConnections: [] }, lastAcceptedAt: now, eligibility: { action: 'select' as const }, chatAvailability: 'ready' as const };
    holdPhase = 'connected';
    await act(async () => phasePending[0].resolve(Response.json({ success: true, data: { ...header(localRequest), query: localRequest,
      items: [coreRows[1], coreRows[0], blocked, integration], recents: [recentCore], selectedItem: null, scopes: {},
      pagination: { hasNextPage: false, nextCursor: null, loadedItems: 4 } } })));
    await waitFor(() => assert.equal(phasePending.length, 2));
    assert.deepEqual(requests.filter(row => row.operation === 'search').map(row => row.phase), ['local', 'connected']);
    assert.deepEqual(frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id),
      [`recent:${chatInlineReferenceIconKey(coreRows[0].selection!)}`, 'core-plugin']);
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'blocked-plugin' || item.id === 'composio:canva'), 'Setup catalog is held behind connected results.');
    assert(screen.getByTestId('chat-reference-section-ready'));
    assert.equal(screen.queryByTestId('chat-reference-section-catalog'), null);
    while (frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex]?.id !== 'core-plugin')
      await act(async () => {
        const { referencePickerItems, selectedReferenceIndex } = frame().controller;
        if (selectedReferenceIndex > referencePickerItems.findIndex(item => item.id === 'core-plugin')) frame().controller.selectPreviousReference();
        else frame().controller.selectNextReference();
      });
    const priorityIds = frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id);
    const connectedRequest = phasePending[1].request;
    await act(async () => phasePending[1].resolve(Response.json({ success: true, data: { ...header(connectedRequest), query: connectedRequest,
      items: [mcpOption(8), integration, coreRows[1], blocked], recents: [recentCore], selectedItem: null, scopes: {}, pagination: { hasNextPage: false, nextCursor: null, loadedItems: 4 } } })));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert.deepEqual(frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id), [...priorityIds, 'mcp-row-8']);
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, 'core-plugin');
    const firstCatalog = frame().controller.referencePickerItems.findIndex(item => item.section === 'catalog');
    assert(firstCatalog > frame().controller.referencePickerItems.map(item => item.section).lastIndexOf('ready'));
    assert.equal(frame().controller.referencePickerItems.find(item => item.id === 'composio:canva')?.catalogAction, 'connect');
    assert(screen.getByTestId('chat-reference-section-catalog'));
    check('local usable and MRU results publish before connected refresh; setup catalog and remote search wait, then stay below without reordering priority or changing keyboard focus');

    await mount(); holdPhase = 'connected'; holdRemote = true;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(phasePending.length, 1));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-1' && item.section === 'ready'));
    const beforeRefresh = frame().controller.referencePickerItems.filter(item => item.section === 'ready' && item.kind !== 'mcp').map(item => item.id);
    const initialFocused = frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex];
    const refreshed = phasePending[0].request;
    const newlyRecent = { ...recentCore, bodyBundle: { ...recentCore.bodyBundle, id: 'connected-recent', caption: 'Recently used connected MCP',
      primary: { selection: mcp(7), requirement: 'optional' as const, toolCap: null } } };
    const olderRecent = { ...newlyRecent, lastAcceptedAt: now - 100, bodyBundle: { ...newlyRecent.bodyBundle, id: 'older-connected-recent',
      primary: { selection: mcp(6), requirement: 'optional' as const, toolCap: null } } };
    await act(async () => phasePending[0].resolve(Response.json({ success: true, data: { ...header(refreshed), query: refreshed,
      items: coreRows, recents: [olderRecent, newlyRecent], selectedItem: null, scopes: {}, pagination: { hasNextPage: false, nextCursor: null, loadedItems: 2 } } })));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-1'), 'An omitted old connection cannot remain in Available now.');
    assert.deepEqual(frame().controller.referencePickerItems.filter(item => item.section === 'ready').map(item => item.id),
      [`recent:${chatInlineReferenceIconKey(mcp(7))}`, `recent:${chatInlineReferenceIconKey(mcp(6))}`, ...beforeRefresh]);
    if (initialFocused.kind !== 'mcp') assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, initialFocused.id);
    check('fresh connected omission removes stale usable connections and a newly confirmed Recent stays ahead of non-recent ready rows');

    await mount(); failLocal = true; failConnected = true; holdRemote = true;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert.deepEqual(requests.filter(row => row.operation === 'search').map(row => row.phase), ['local', 'connected', 'remote']);
    assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'local' && row.status === 'unavailable'));
    assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'connected' && row.status === 'unavailable'));
    assert(frame().controller.referencePickerItems.some(item => item.kind === 'file'));
    check('failed priority and connected sources do not indefinitely block the final catalog or independently loaded files');
    failConnected = false;
    await act(async () => { fireEvent.click(within(screen.getByText(/Connected integrations: Connected unavailable/u).parentElement!).getByRole('button', { name: 'Try again' })); });
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'connected' && row.status === 'complete')));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'mcp-row-1' && item.section === 'ready'));
    assert.deepEqual(requests.filter(row => row.operation === 'search').map(row => row.phase), ['local', 'connected', 'remote', 'connected']);
    check('retrying connected observations refreshes only that source and retains the already running catalog request');

    await mount(); holdRemote = true;
    await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill')));
    await waitFor(() => assert.equal(remotePending.length, 1));
    assert(frame().controller.isLoadingReferenceItems);
    assert.equal(screen.queryByText('No results'), null);
    await act(async () => frame().controller.selectNextReference());
    const focused = frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id;
    const remoteRequest = remotePending[0].request;
    await act(async () => remotePending[0].resolve(Response.json({ success: true, data: { ...header(remoteRequest), query: remoteRequest,
      items: [{ ...coreRows[0], item: { ...coreRows[0].item, id: 'remote-skill', displayName: 'Remote skill' } }], recents: [], selectedItem: null,
      scopes: {}, pagination: { hasNextPage: false, nextCursor: null, loadedItems: 1 } } })));
    await waitFor(() => assert.equal(frame().controller.isLoadingReferenceItems, false));
    assert.equal(frame().controller.referencePickerItems[frame().controller.selectedReferenceIndex].id, focused);
    check('local results stay usable while remote search waits; append preserves the exact keyboard focus and does not show a false empty state');

    await mount(); holdRemote = true; await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert.equal(remotePending.length, 1));
    await act(async () => { frame().editor.current!.replaceText('changed'); });
    assert.equal(frame().controller.referencePickerItems.length, 0, 'A different query must immediately hide the previous selectable list.');
    const stale = remotePending[0];
    await act(async () => stale.resolve(Response.json({ success: true, data: { ...header(stale.request), query: stale.request, items: [coreRows[0]],
      recents: [], selectedItem: null, scopes: {}, pagination: { hasNextPage: false, nextCursor: null, loadedItems: 1 } } })));
    assert(!frame().controller.referencePickerItems.some(item => item.id === 'core-skill'));
    check('new query immediately fences old visible rows and ignores an old remote reply');

    await mount(); failRemote = true; await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.some(row => row.source === 'remote' && row.status === 'unavailable')));
    assert(frame().controller.referencePickerItems.some(item => item.id === 'core-skill'));
    assert.equal(requests.filter(request => request.operation === 'search' && request.phase === 'local').length, 1);
    failRemote = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    await waitFor(() => assert(frame().controller.referenceSourceStatuses.every(row => row.status === 'complete')));
    assert.equal(requests.filter(request => request.operation === 'search' && request.phase === 'local').length, 1);
    assert.equal(requests.filter(request => request.operation === 'search' && request.phase === 'remote').length, 2);
    check('a failed remote source leaves local rows usable and Retry reloads only that source');

    for (const id of ['blocked-plugin', 'missing-selection', unpublishedSkillRef]) {
      await mount(plain('Keep this text ')); await open(id, false);
      await screen.findByTestId('chat-extension-reference-dialog');
      assert.equal(screen.queryByRole('button', { name: 'Insert into text' }), null);
      const setup = screen.getByRole('link', { name: 'Open plugins' });
      assert.equal(setup.getAttribute('target'), '_blank');
      assert.equal(new URL(setup.getAttribute('href')!, 'https://fixture.invalid').searchParams.get('workspaceId'), 'workspace-a');
      assert(screen.getByText('Set up this source on the Plugins page, then select it again in chat.'));
      assert.equal(screen.queryByText('Choose its components and connection when needed. The reference is then inserted into your text.'), null);
      if (id === unpublishedSkillRef) {
        const setupUrl = new URL(setup.getAttribute('href')!, 'https://fixture.invalid');
        assert.equal(setupUrl.searchParams.get('resourceRef'), unpublishedSkillRef);
        assert.equal(setupUrl.searchParams.get('area'), 'skills');
        assert(screen.getByText('Publish this package before selecting it.'));
      }
      assert(projectChatBodyText(frame().body).startsWith('Keep this text '));
      assert(!requests.some(request => request.operation === 'preview'));
    }
    check('blocked or malformed metadata offers an explained setup action in a separate tab and preserves text without a dead Insert button');

    const directTransition = await mount(); holdPreview = true; await open('core-skill', false);
    await waitFor(() => assert.equal(pending.length, 1));
    directTransition.rerender(wrap(<Harness sessionId="newly-created-session" />));
    await resolvePreview(); assert.equal(frame().body.bundles.length, 0); assert.equal(frame().controller.pendingReference, null);
    check('a late draft_turn direct preview cannot insert after the actual draft-to-session target transition');

    await mount(plain('hello world'));
    await act(async () => { frame().editor.current!.setSelection(0, 5); frame().controller.openReferencePicker(); });
    assert.equal(projectChatBodyText(frame().body), 'hello @ world', 'Opening after a marked word inserts at its end, without deleting it.');
    await waitFor(() => assert(frame().controller.referencePickerItems.length));
    await act(async () => { frame().editor.current!.replaceText('can'); });
    await waitFor(() => assert(requests.some(request => request.operation === 'search' && request.q === 'can')));
    assert.equal(frame().controller.activeReferenceMatch?.query, 'can');
    check('manual toolbar opening preserves marked text and subsequent actual editor typing filters the same @ search');

    await mount(); await open('mcp-metadata-row');
    await screen.findByTestId('agent-extension-connection-chooser');
    await screen.findByText('MCP account 2');
    assert.deepEqual(requests.filter(request => request.operation === 'connection_choices').map(request => request.selector),
      [{ kind: 'standalone', source: 'mcp' }]);
    assert.equal((screen.getByRole('button', { name: 'Insert into text' }) as HTMLButtonElement).disabled, true);
    assert.equal(frame().body.bundles.length, 0);
    assert(!requests.some(request => request.operation === 'preview'), 'A metadata offering is never an automatic connection choice.');
    await chooseMcp(2); await insert();
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    assert.deepEqual(frame().body.bundles[0].primary.selection, mcp(2));
    assert.deepEqual(deriveChatBodySelection(frame().body)?.selections.map(entry => entry.selection), [mcp(2)]);
    check('an MCP metadata offering opens the genuine chooser without a preselected identity and inserts only the explicitly chosen second connection');

    await mount();
    await open('mcp-row-1'); await chooseMcp(1); await insert();
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    const first = structuredClone(frame().body);
    await open('mcp-row-2'); await chooseMcp(2); await insert();
    await waitFor(() => assert.equal(frame().body.bundles.length, 2));
    assert.equal(first.bundles[0].caption, frame().body.bundles[1].caption.replace('MCP account 2', 'MCP account 1'));
    assert.notEqual(chatInlineReferenceIconKey(frame().body.bundles[0].primary.selection), chatInlineReferenceIconKey(frame().body.bundles[1].primary.selection));
    assert.equal(deriveChatBodySelection(frame().body)?.selections.length, 2);
    assert(requests.filter(row => row.operation === 'search').every(row => row.types.join(',') === 'plugin,skill,integration,mcp'));
    check('actual shared search handles identical catalogue names using exact connection identities and inserts real atomic Tiptap bodies');

    await mount(); await open('mcp-row-1'); await chooseMcp(); holdPreview = true; await insert();
    await waitFor(() => assert.equal(pending.length, 1));
    await act(async () => frame().replace(plain('Changed while preview was pending')));
    await resolvePreview(); await screen.findByRole('alert');
    assert.equal(projectChatBodyText(frame().body), 'Changed while preview was pending'); assert.equal(frame().body.bundles.length, 0);
    check('body changed during real dialog preview rejects insertion and preserves the newer draft');

    for (const transition of ['workspace', 'agent', 'auth', 'epoch'] as const) {
      const view = await mount(); await open('mcp-row-1'); await chooseMcp(); holdPreview = true; await insert();
      await waitFor(() => assert.equal(pending.length, 1));
      await act(async () => {
        if (transition === 'workspace') view.rerender(wrap(<Harness workspaceId="workspace-b" />));
        else if (transition === 'agent') view.rerender(wrap(<Harness agentId="agent-b" />));
        else if (transition === 'auth') observeOpenedDocumentAuth({ data: { user: { id: 'different-user' }, session: { id: 'different-auth-session' } } });
        else invalidateOpenedDocumentAuth();
      });
      assert.equal(frame().controller.pendingReference, null);
      await resolvePreview(); assert.equal(frame().body.bundles.length, 0); assert.equal(screen.queryByTestId('chat-extension-reference-dialog'), null);
    }
    check('workspace, agent, signed-in identity and same-session auth epoch changes fence late previews before any insertion');

    await mount(); await act(async () => frame().controller.openReferencePicker());
    await waitFor(() => assert(frame().controller.referencePickerItems.length));
    const old = frame().controller, oldItem = old.referencePickerItems[0];
    await act(async () => { invalidateOpenedDocumentAuth(); old.handleReferenceSelect(oldItem); });
    assert.equal(frame().controller.pendingReference, null); assert.equal(frame().controller.referencePickerItems.length, 0);
    check('a genuine old item plus captured callback cannot reopen a dialog after synchronous auth invalidation');

    const start: ChatBodyV1 = { version: 1, parts: [], bundles: [] };
    for (let index = 10; index < 15; index++) { const id = `existing-${index}`;
      start.parts.push({ type: 'extension_reference', occurrenceId: `occurrence-${index}`, bundleId: id });
      start.bundles.push({ id, caption: `Existing ${index}`, primary: { selection: mcp(index), requirement: 'optional', toolCap: null }, supporting: [], packageConnections: [] }); }
    await mount(start); await open('mcp-row-1'); await chooseMcp(); await insert(); await screen.findByRole('alert');
    assert.equal(frame().body.bundles.length, 5); assert.equal(deriveChatBodySelection(frame().body)?.selections.length, 5);
    assert(frame().body.bundles.every(value => value.id.startsWith('existing-')));
    check('a sixth distinct selection is rejected before insertion without dropping any existing reference');

    const view = await mount(); await open('composio:canva'); await chooseAccount();
    const issuedAt = now; holdPreview = true; await insert(); await waitFor(() => assert.equal(pending.length, 1));
    now += 30_000; await resolvePreview(); await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    const acceptedBody = structuredClone(frame().body);
    const intake = await frame().controller.prepareIntakeSelection(frame().body);
    assert(intake?.selections[0].accountSelectionRef); assert(!JSON.stringify(frame().body).includes('cmp_personal_account_'));
    view.rerender(wrap(<Harness sessionId="actual-created-session" />));
    await act(async () => {});
    assert.equal((await frame().controller.prepareIntakeSelection(frame().body))?.selections[0].accountSelectionRef, intake.selections[0].accountSelectionRef);
    now = issuedAt + 60_001;
    await act(async () => { await assert.rejects(frame().controller.prepareIntakeSelection(frame().body)); });
    assert.deepEqual(frame().controller.pendingReference?.confirmSelection, account('account-a'));
    assert.deepEqual(frame().body, acceptedBody);
    await chooseAccount('account-a');
    assert.equal((screen.getByRole('button', { name: 'Confirm account' }) as HTMLButtonElement).disabled, true, 'Old server expiry cannot be renewed by confirming later.');
    check('separate receipt survives real draft-to-session transition, expires at original server deadline and requests the identical account again');

    await mount(); await open('composio:canva'); await chooseAccount(); holdPreview = true; await insert();
    await waitFor(() => assert.equal(pending.length, 1)); now += 60_001; await resolvePreview();
    assert.equal(frame().body.bundles.length, 0); assert((await screen.findByRole('alert')).textContent?.includes('expired'));
    check('receipt expiry during a delayed preview is checked again and never creates a newly valid confirmation window');

    await mount(); expiry = undefined; await open('composio:canva'); await chooseAccount();
    assert.equal((screen.getByRole('button', { name: 'Insert into text' }) as HTMLButtonElement).disabled, true);
    assert.equal(requests.some(request => request.operation === 'preview'), false);
    check('account metadata without genuine expiry cannot enable insertion or grant transient receipt cache');

    await mount(); await open('composio:canva'); await chooseAccount(); await insert();
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    const beforeEpoch = structuredClone(frame().body), oldPrepare = frame().controller.prepareIntakeSelection;
    assert((await oldPrepare(beforeEpoch))?.selections[0].accountSelectionRef);
    await act(async () => { invalidateOpenedDocumentAuth(); await assert.rejects(oldPrepare(beforeEpoch)); });
    await act(async () => { await assert.rejects(frame().controller.prepareIntakeSelection(beforeEpoch)); });
    assert.deepEqual(frame().body, beforeEpoch); assert.deepEqual(frame().controller.pendingReference?.confirmSelection, account('account-a'));
    assert.equal(requests.filter(request => request.operation === 'connection_choices' && request.profileId).length, 1, 'Receipt loss never silently enumerates or chooses a new account.');
    check('confirmed receipt cache is partitioned by actual auth epoch and a captured old intake callback cannot reuse it');

    await mount(); await open(pin.resourceRef); await chooseMcp(9); await chooseAccount(); await insert();
    await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    const included = frame().body.bundles[0];
    assert.equal(included.supporting.length, 2); assert.equal(included.packageConnections.length, 2);
    assert.deepEqual(included.packageConnections.map(mapping => mapping.declarationPath), ['.canvas-plugin/plugin.json', 'skills/child/agents/canvas.yaml']);
    assert(included.packageConnections.every(mapping => JSON.stringify(mapping.package) === JSON.stringify(pin)));
    assert.equal(deriveChatBodySelection(frame().body)?.selections.length, 3);
    assert(!JSON.stringify(included).includes('cmp_personal_account_'));
    assert((await frame().controller.prepareIntakeSelection(frame().body))?.selections.some(entry => entry.accountSelectionRef));
    check('included child contributes its exact declaration/account mapping and transient receipt, while public package body stays receipt-free');

    await mount(); await open(pin.resourceRef);
    fireEvent.click(await screen.findByText(/Included skills/u));
    const root = await screen.findByRole('checkbox', { name: /Root skill/u }); assert.equal((root as HTMLInputElement).disabled, true);
    await chooseMcp(9); await chooseAccount();
    fireEvent.click(screen.getByRole('checkbox', { name: /Optional child/u }));
    await insert(); await waitFor(() => assert.equal(frame().body.bundles.length, 1));
    const selected = frame().body.bundles[0];
    assert(selected.primary.selection.kind === 'plugin'); assert.deepEqual(selected.primary.selection.package, pin);
    assert.deepEqual(selected.primary.selection.skillSelection, { kind: 'subset', relativeRoots: [''] });
    assert.equal(selected.supporting.length, 1); assert.deepEqual(selected.supporting[0].selection, mcp(9));
    assert.equal(selected.packageConnections.length, 1);
    assert.equal(selected.packageConnections[0].declarationPath, '.canvas-plugin/plugin.json');
    assert.deepEqual(selected.packageConnections[0].package, pin);
    const preview = requests.findLast(request => request.operation === 'preview'); assert(preview?.operation === 'preview');
    assert.deepEqual(preview.body.bundles[0], selected);
    assert(!preview.intakeSelection?.selections.some(entry => entry.selection.kind === 'composio'));
    check('exact published package, required root and explicit dependency mapping survive; excluded child drops its owned support and receipt');

    assert.deepEqual(domErrors, [], 'Asynchronous DOM errors must fail the test, even if individual assertions passed.');
    console.log(JSON.stringify({ status: 'PASS', cases, domErrors: domErrors.length, database: false, browser: false, provider: false, authority: false }));
  } finally { cleanup(); globalThis.fetch = originalFetch; Date.now = originalNow; observeOpenedDocumentAuth(null); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
