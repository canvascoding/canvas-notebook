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
  source: 'mcp', mcp: { transport: 'http', template: false, connectionRef: mcp(index).target.connectionRef }, connections: [] }, eligibility: { action: 'select' }, selection: mcp(index) });
const metadataMcp: AgentExtensionSearchItem = { item: { ...mcpOption(9).item, id: 'mcp-metadata-row' }, eligibility: { action: 'select' } };
const integration: AgentExtensionSearchItem = { item: { ...commonItem, id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva',
  source: 'composio', toolkit: { slug: 'canva', noAuth: false }, connections: [] }, eligibility: { action: 'choose_connection' } };
const plugin: AgentExtensionSearchItem = { item: { ...commonItem, id: pin.resourceRef, kind: 'plugin', name: 'design', displayName: 'Design plugin', source: 'local' },
  eligibility: { action: 'select' }, selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } } };
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
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), scopeNumber = 0, cases = 0;
  const rows = [mcpOption(1), mcpOption(2), metadataMcp, integration, plugin];
  let current: Frame | undefined, requests: ChatExtensionOptionsRequest[] = [], pending: Pending[] = [], holdPreview = false;
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
    assert.equal(String(input), '/api/chat/extension-options', 'The actual chat metadata client never uses Agent configuration authority.');
    const request = chatExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body))); requests.push(request);
    const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 1 };
    if (request.operation === 'search') return Response.json({ success: true, data: { ...header(request), query: request,
      items: rows.filter(row => request.types.includes(row.item.kind)), selectedItem: null, scopes: { choices: ['all'], teams: [] }, pagination, recents: [] } });
    if (request.operation === 'package_version') {
      assert.deepEqual({ resourceRef: request.resourceRef, publishedRevisionRef: request.publishedRevisionRef, checksum: request.checksum }, pin);
      return Response.json({ success: true, data: { ...header(request), package: packageMetadata } });
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
    return <><ChatInlineEditor ref={editor} body={body} onBodyChange={controller.handleInputChange} onSelectionChange={controller.handleSelectionChange} />
      <div>{controller.referencePickerItems.map(item => <button type="button" key={item.id} data-item-id={item.id} onClick={() => controller.handleReferenceSelect(item)}>{item.label}</button>)}</div>
      {controller.pendingReference ? <ChatExtensionReferenceDialog request={controller.pendingReference} onClose={controller.closeReferenceDialog} onSelect={controller.acceptReference} /> : null}</>;
  }
  const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>{node}</NextIntlClientProvider>;
  const mount = async (initial = plain()) => {
    cleanup(); requests = []; pending = []; holdPreview = false; receiptCounter = 0; expiry = new Date(now + 60_000).toISOString();
    observeOpenedDocumentAuth({ data: { user: { id: `composer-user-${++scopeNumber}` }, session: { id: `auth-session-${scopeNumber}` } } });
    const view = render(wrap(<Harness initial={initial} />));
    await waitFor(() => assert(screen.getByRole('textbox')));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); return view;
  };
  const open = async (id: string) => {
    await act(async () => { frame().editor.current!.focusEnd();
      frame().controller.openReferencePicker(); });
    await waitFor(() => assert(frame().controller.referencePickerItems.some(item => item.id === id), JSON.stringify({ id,
      body: frame().body, match: frame().controller.activeReferenceMatch, error: frame().controller.referencePickerError })));
    await act(async () => { fireEvent.click(document.querySelector(`[data-item-id="${id}"]`)!); });
    await screen.findByTestId('chat-extension-reference-dialog');
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
  try {
    await mount(plain('hello world'));
    await act(async () => { frame().editor.current!.setSelection(0, 5); frame().controller.openReferencePicker(); });
    assert.equal(projectChatBodyText(frame().body), 'hello / world', 'Opening after a marked word inserts at its end, without deleting it.');
    await waitFor(() => assert(frame().controller.referencePickerItems.length));
    await act(async () => { frame().editor.current!.replaceText('can'); });
    await waitFor(() => assert(requests.some(request => request.operation === 'search' && request.q === 'can')));
    assert.equal(frame().controller.activeReferenceMatch?.query, 'can');
    check('manual toolbar opening preserves marked text and subsequent actual editor typing filters the same slash search');

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
