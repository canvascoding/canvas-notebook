import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentProfile } from '../app/lib/chat/types';
import { EXTENSION_SELECTION_LIMITS, type AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { agentExtensionOptionsRequestSchema } from '../app/lib/agents/extension-options-contracts';
import { rebaseAgentExtensionRetentions } from '../app/components/agents/agent-extension-retention-rebase';

// Actual profile dialog, grants editor and shared extension editor. Only HTTP,
// native-tool/file presentation and unrelated model transport are controlled.
// Real grants, retention issuance and writer authority have a separate SQL test.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true, url: 'https://grant-retention.fixture.invalid/settings',
});
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLSelectElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });
const context = { actorId: 'grant-owner', workspaceId: 'grant-workspace', organizationId: 'grant-organization' };
const initial: AgentProfile = { agentId: 'grant-retention-agent', name: 'Saved grant agent', iconId: 'bot', type: 'special', removable: false, scopeType: 'organization',
  organizationId: context.organizationId, revision: 4, workflowVersion: 2, workflowRevision: 3, enabledTools: ['read'],
  defaultProvider: 'google', defaultModel: 'untouched-model', access: { canUse: true, canEdit: true, canManage: true } };
const hint = (revision: number) => `agent-extension-retain:v1:${revision.toString(16).padStart(64, '0')}`;
function configuration(revision: number): AgentExtensionConfigurationInput {
  return { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [{ mode: 'fixed',
    configurationId: 'saved-source', entry: { requirement: 'optional', toolCap: ['READ', 'WRITE'], retainedBindingRef: hint(revision),
      selection: { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
        connectionRef: 'canvas-connection:11111111-1111-4111-8111-111111111111', bindingRevision: 2 } } } }] };
}
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  loader._load = (name, parent, isMain) => {
    if (name.endsWith('/AgentManagedFilesCard')) return { AgentManagedFilesEditor: (props: {
      fileDrafts: Record<string, string>; onDraftChange: (file: string, value: string) => void;
    }) => <div>{['AGENTS.md', 'MEMORY.md'].map(file => <textarea key={file} aria-label={file} value={props.fileDrafts[file]}
      onChange={event => props.onDraftChange(file, event.target.value)} />)}</div> };
    if (name.endsWith('/AgentToolsCard')) return { AgentToolsEditor: (props: { onToolToggle: (name: string, enabled: boolean) => void }) =>
      <button type="button" onClick={() => props.onToolToggle('write', true)}>Enable native write</button> };
    if (name.endsWith('/ai-runtime/catalog-client')) return { readAdminRuntimeCatalog: async () => { throw new Error('Controlled unavailable model transport'); } };
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { EditAgentProfileDialog } = await import('../app/components/agents/EditAgentProfileDialog');
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let agent = structuredClone(initial), saved = configuration(4), files = { 'AGENTS.md': 'Original agents', 'MEMORY.md': 'Original memory' };
  let holdFresh = false, failFresh = false, foreignWorkflow = false, denyFresh = false, failMemory = false, failParentRefresh = false;
  let releaseFresh: (() => void) | undefined, closed = 0, grantWrites = 0, grantReads = 0, configureReads = 0;
  const inspect = () => ({ agent, access: agent.access, files,
    extensions: { agentId: agent.agentId, revision: agent.revision, workflowRevision: agent.workflowRevision,
      configurationState: 'available', configuration: saved, readiness: [] } });
  const json = (data: unknown, status = 200) => Response.json(status === 200 ? { success: true, data }
    : { success: false, error: status === 403 ? 'Access denied' : 'Fixture read or file failure' }, { status });
  const reissue = () => {
    assert(saved.mode === 'fixed');
    for (const slot of saved.standalone) if (slot.mode === 'fixed') slot.entry.retainedBindingRef = hint(agent.revision!);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== 'GET' && url.pathname !== '/api/agents/extension-options') writes.push({ path: url.pathname, body });
    if (url.pathname === '/api/agents/extension-options') {
      const request = agentExtensionOptionsRequestSchema.parse(body);
      const head = { schemaVersion: 1, operation: request.operation, target: request.target, contextKey: JSON.stringify(request.target), coverage: [], limits: EXTENSION_SELECTION_LIMITS };
      if (request.operation === 'search') return json({ ...head, items: [], selectedItem: null, scopes: { choices: ['all'], teams: [] },
        pagination: { loadedItems: 0, nextCursor: null, hasNextPage: false } });
      assert.equal(request.operation, 'preview');
      return json({ ...head, preview: { configurationReadiness: 'valid', contextValidation: 'complete', personalSetupRequired: false,
        runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true, issues: [], requirements: [],
        effectiveToolCaps: [], toolConflicts: [], budget: { usedBytes: 20, maxBytes: 8192, detailStatus: 'complete', omittedDetails: 0 }, contextPreview: 'Actual editor fixture preview.' } });
    }
    if (url.pathname === '/api/agents/tools') return json({ tools: ['read', 'write'].map(name => ({ name, label: name, description: name, group: 'Files' })), config: { enabledTools: agent.enabledTools } });
    if (url.pathname === '/api/agents' && method === 'GET') {
      if (url.searchParams.get('purpose') === 'configure') {
        configureReads++;
        if (failFresh) return json(null, 503);
        if (denyFresh) return json(null, 403);
        const result = structuredClone(inspect());
        if (foreignWorkflow) { result.agent.workflowRevision!++; result.extensions.workflowRevision!++; }
        if (holdFresh) { holdFresh = false; return new Promise<Response>(resolve => { releaseFresh = () => resolve(json(result)); }); }
        return json(result);
      }
      return json(inspect());
    }
    if (url.pathname === '/api/agents/grants' && method === 'GET') {
      grantReads++; return json({ agent, grants: [], targets: { users: [], workspaces: [], projects: [] } });
    }
    if (url.pathname === '/api/agents/grants' && method === 'PUT') {
      assert.equal(body.expectedRevision, agent.revision); grantWrites++; agent.revision!++; reissue();
      return json({ agent: { agentId: agent.agentId, revision: agent.revision, organizationId: agent.organizationId },
        grant: { id: 'actual-http-grant', targetType: body.targetType, targetId: body.targetId, canUse: true, canEdit: false, canManage: false, revision: 1 } });
    }
    if (url.pathname === '/api/agents' && method === 'PATCH') {
      assert.equal(body.expectedRevision, agent.revision);
      if (body.extensions) {
        assert.equal(body.expectedWorkflowRevision, agent.workflowRevision);
        const next = body.extensions as AgentExtensionConfigurationInput;
        assert(next.mode === 'fixed'); assert(next.standalone[0].mode === 'fixed');
        assert.equal(next.standalone[0].entry.retainedBindingRef, hint(agent.revision!), 'Actual shared editor must send freshly reissued hints.');
        saved = structuredClone(next); agent.workflowRevision!++;
      }
      for (const field of ['name', 'enabledTools', 'defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking'])
        if (Object.hasOwn(body, field)) Object.assign(agent, { [field]: body[field] });
      agent.revision!++; reissue(); return json(inspect());
    }
    if (url.pathname === '/api/agents/files' && method === 'PUT') {
      assert.equal(body.expectedRevision, agent.revision);
      if (body.fileName === 'MEMORY.md' && failMemory) { failMemory = false; return json(null, 503); }
      files = { ...files, [String(body.fileName)]: String(body.content) }; agent.revision!++; reissue(); return json({ agent });
    }
    throw new Error(`Unexpected HTTP ${method} ${url.pathname}`);
  };
  const props = { open: true, agent: initial, context, canManageAgentDefaults: true, onOpenChange: (open: boolean) => { if (!open) closed++; },
    onChanged: async () => { if (failParentRefresh) throw new Error('List refresh failed'); }, onDeleted: async () => {} };
  const view = (scope = context) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <EditAgentProfileDialog {...props} context={scope} /></NextIntlClientProvider>;
  const save = () => screen.getByTestId('edit-agent-save') as HTMLButtonElement;
  const ready = () => waitFor(() => assert.equal(save().disabled, false));
  const cap = () => screen.getByLabelText('One exact tool name per line') as HTMLTextAreaElement;
  const changeCap = async (value: string) => { fireEvent.change(cap(), { target: { value } }); await ready(); };
  const grant = async () => {
    const type = await screen.findByLabelText(messages.settings.agentPanel.grants.targetTypeLabel);
    await waitFor(() => assert.equal((screen.getByRole('button', { name: messages.settings.agentPanel.grants.add }) as HTMLButtonElement).disabled, true));
    fireEvent.change(type, { target: { value: 'organization' } });
    const add = screen.getByRole('button', { name: messages.settings.agentPanel.grants.add });
    await waitFor(() => assert.equal((add as HTMLButtonElement).disabled, false)); fireEvent.click(add);
  };
  const reset = () => {
    cleanup(); dom.window.localStorage.clear(); writes.length = 0; agent = structuredClone(initial); saved = configuration(4);
    files = { 'AGENTS.md': 'Original agents', 'MEMORY.md': 'Original memory' };
    holdFresh = failFresh = foreignWorkflow = denyFresh = failMemory = failParentRefresh = false;
    releaseFresh = undefined; closed = grantWrites = grantReads = configureReads = 0;
  };
  let cases = 0;
  try {
    render(view()); await ready();
    fireEvent.change(screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel), { target: { value: 'Unsaved local name' } });
    fireEvent.change(screen.getByLabelText('MEMORY.md'), { target: { value: 'Unsaved memory draft' } });
    fireEvent.click(screen.getByRole('switch', { name: messages.settings.agentPanel.createDialog.model.title }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable native write' }));
    await changeCap('READ'); holdFresh = true; await grant();
    await screen.findByTestId('edit-agent-retention-pending'); assert(save().disabled); assert.equal(grantWrites, 1);
    await act(async () => releaseFresh!()); await ready();
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'Unsaved local name');
    assert.equal((screen.getByLabelText('MEMORY.md') as HTMLTextAreaElement).value, 'Unsaved memory draft'); assert.equal(cap().value, 'READ');
    fireEvent.click(save()); await waitFor(() => assert.equal(closed, 1));
    const patch = writes.find(write => write.path === '/api/agents')!.body;
    assert.equal(patch.name, 'Unsaved local name'); assert.equal(patch.expectedRevision, 5);
    assert.equal(patch.defaultModel, null); assert.equal(patch.defaultProvider, null);
    assert.deepEqual(patch.enabledTools, []); assert.deepEqual(agent.enabledTools, []); cases++;

    reset(); render(view()); await ready(); await changeCap('READ'); failFresh = true; failParentRefresh = true; await grant();
    await screen.findByTestId('edit-agent-retention-error'); assert(save().disabled); assert.equal(grantWrites, 1);
    assert.equal(cap().value, 'READ'); failFresh = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection metadata' })); await ready();
    assert.equal(grantWrites, 1); assert.equal(configureReads, 2); assert.equal(cap().value, 'READ');
    failParentRefresh = false; fireEvent.click(save()); await waitFor(() => assert.equal(closed, 1)); cases++;

    for (const mode of ['workflow', 'denied'] as const) {
      reset(); render(view()); await ready(); await changeCap('READ'); foreignWorkflow = mode === 'workflow'; denyFresh = mode === 'denied'; await grant();
      await screen.findByTestId('edit-agent-retention-error'); assert(save().disabled); assert.equal(cap().value, 'READ');
      fireEvent.click(screen.getByRole('button', { name: 'Retry connection metadata' }));
      await waitFor(() => assert.equal(configureReads, 2)); assert(save().disabled); assert.equal(grantWrites, 1); cases++;
    }

    reset(); render(view()); await ready(); await changeCap('READ');
    const pendingName = 'Keep my unsaved name';
    fireEvent.change(screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel), { target: { value: pendingName } });
    agent.name = 'Foreign rename'; agent.revision = 5; reissue();
    const reloadGrants = within(screen.getByTestId('agent-grants-editor')).getByRole('button', { name: messages.settings.agentPanel.grants.reload });
    fireEvent.click(reloadGrants);
    await waitFor(() => { assert.equal(grantReads, 2); assert.equal((reloadGrants as HTMLButtonElement).disabled, false); });
    await grant(); await screen.findByTestId('edit-agent-retention-error');
    assert.equal(agent.revision, 6); assert.equal(grantWrites, 1); assert.equal(configureReads, 0);
    assert(save().disabled); assert.equal(cap().value, 'READ');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, pendingName);
    assert.equal((screen.getByRole('button', { name: 'Retry connection metadata' }) as HTMLButtonElement).disabled, true);
    assert.equal(writes.filter(write => write.path === '/api/agents').length, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved configuration' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: messages.settings.agentPanel.createDialog.cancel }));
    assert.equal(cap().value, 'READ'); assert(save().disabled);
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved configuration' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reload saved configuration' }));
    await ready(); assert.equal(cap().value, 'READ\nWRITE');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'Foreign rename'); cases++;

    reset(); const scopedView = render(view()); await ready(); await changeCap('READ'); holdFresh = true; await grant();
    await screen.findByTestId('edit-agent-retention-pending');
    scopedView.rerender(view({ ...context, actorId: 'different-actor', workspaceId: 'different-workspace' }));
    await waitFor(() => assert.equal(cap().value, 'READ\nWRITE')); await act(async () => releaseFresh!()); await ready();
    assert.equal(cap().value, 'READ\nWRITE'); assert.equal(screen.queryByTestId('edit-agent-retention-error'), null); cases++;

    reset(); render(view()); await ready(); await changeCap('READ');
    fireEvent.change(screen.getByLabelText('AGENTS.md'), { target: { value: 'Acknowledged first file' } });
    fireEvent.change(screen.getByLabelText('MEMORY.md'), { target: { value: 'Retry only second file' } });
    failMemory = true; fireEvent.click(save()); await screen.findByText('Fixture read or file failure'); await ready();
    assert.equal(agent.workflowRevision, 4); assert.equal(agent.revision, 6); assert.equal(configureReads, 1);
    assert.equal(writes.filter(write => write.path === '/api/agents').length, 1);
    await changeCap('READ\nEXECUTE'); fireEvent.click(save()); await waitFor(() => assert.equal(closed, 1));
    const patches = writes.filter(write => write.path === '/api/agents'); assert.equal(patches.length, 2);
    assert.equal(patches[1].body.expectedRevision, 6); assert.equal(patches[1].body.expectedWorkflowRevision, 4);
    assert.equal(writes.filter(write => write.path === '/api/agents/files' && write.body.fileName === 'AGENTS.md').length, 1);
    assert.equal(writes.filter(write => write.path === '/api/agents/files' && write.body.fileName === 'MEMORY.md').length, 2); cases++;

    const before = configuration(4), fresh = configuration(5); assert(before.mode === 'fixed');
    const wrongSlot = structuredClone(before); wrongSlot.standalone[0].configurationId = 'foreign-slot';
    assert.throws(() => rebaseAgentExtensionRetentions({ draft: { intent: 'replace', configuration: wrongSlot }, before, current: fresh }), /changed/u);
    const wrongRef = configuration(6);
    assert.throws(() => rebaseAgentExtensionRetentions({ draft: { intent: 'replace', configuration: wrongRef }, before, current: fresh }), /changed/u);
    assert.deepEqual(rebaseAgentExtensionRetentions({ draft: { intent: 'keep', configuration: before }, before, current: fresh }), { intent: 'keep', configuration: fresh }); cases++;
    console.log(`PASS ${cases} actual Edit→Grants→shared Editor retention cases: held grant metadata, preserved name/file/model/native/extension drafts, exact hint/CAS rebase, metadata-only recovery, WF/rights fences, foreign rename and child-reload revision conflict, explicit discard/reload, scope race, own replacement plus partial-file ACK, exact slot/reference denial. Controlled HTTP, separate genuine SQL authority fixture.`);
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.localStorage.clear(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
