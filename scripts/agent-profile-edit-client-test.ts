import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentProfile } from '../app/lib/chat/types';
import type { AgentExtensionEditorProps } from '../app/components/agents/AgentExtensionEditor';
import { updateCompleteAgentConfigurationSchema } from '../app/lib/agents/workflow-api-contracts';
import { agentProfileEditUrl, agentProfileModelFields, buildAgentProfileEditPatch, resolveAgentFormToolDraft,
  sameAgentProfileModelFields, toggleAgentFormToolDraft } from '../app/components/agents/agent-profile-edit-client';
import { readAgentFormDraft, writeAgentFormDraft } from '../app/components/agents/agent-form-draft-storage';
import { resolveEnabledToolNames } from '../app/lib/pi/enabled-tools';

// Real dialog, draft storage and public PATCH codec. Only unrelated presentation,
// shared-editor validation and HTTP DTO transport are controlled. No server
// authorization, browser E2E or external-provider evidence is claimed here.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true, url: 'https://agent-edit.fixture.invalid/settings',
});
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLSelectElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

const context = { actorId: 'edit-user', workspaceId: 'workspace-a', organizationId: 'organization-a', projectId: 'project-a' };
const configuration = { version: 1 as const, origin: 'agent_configuration' as const, mode: 'fixed' as const,
  selections: [], workflow: null, standalone: [{ mode: 'fixed' as const, entry: { requirement: 'optional' as const, toolCap: ['fixture_read'],
    selection: { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'personal' as const, connectionRef: 'mcp-personal:00000000-0000-4000-8000-000000000001' } } } }] };
const initialAgent: AgentProfile = { agentId: 'actual-dialog-agent', name: 'Historical agent', iconId: 'bot', type: 'special', removable: false,
  scopeType: 'user', revision: 4, workflowVersion: 2, workflowRevision: 7, enabledTools: ['legacy_external_tool'],
  defaultProviderInstallationId: null, defaultProvider: 'google', defaultModel: 'historical-model', defaultThinking: null,
  relevantSkills: ['legacy-name'], relevantConnections: ['legacy-connection'], access: { canUse: true, canEdit: true, canManage: false } };
const scope = { ...context, target: { kind: 'existing' as const, agentId: initialAgent.agentId, expectedRevision: 4, expectedWorkflowRevision: 7 } };

async function main() {
  assert.deepEqual([...resolveAgentFormToolDraft(['read', 'write', 'browser'], ['__none__'])], []);
  assert.deepEqual([...resolveAgentFormToolDraft(['read', 'write', 'browser'], [])], ['read', 'write']);
  assert.deepEqual(toggleAgentFormToolDraft('write', true, ['__none__'], ['read', 'write']), ['write']);
  assert.deepEqual(toggleAgentFormToolDraft('read', true, ['write'], ['read', 'write']), []);
  const unchanged = buildAgentProfileEditPatch({ agent: initialAgent, name: initialAgent.name, iconId: 'bot',
    extensions: { intent: 'keep', configuration }, workflowRevision: 7 });
  assert.deepEqual(unchanged, { agentId: initialAgent.agentId, expectedRevision: 4 });
  const nameOnly = buildAgentProfileEditPatch({ agent: initialAgent, name: 'Only name', iconId: 'bot',
    extensions: { intent: 'keep', configuration: null }, workflowRevision: null });
  assert.deepEqual(nameOnly, { agentId: initialAgent.agentId, expectedRevision: 4, name: 'Only name' });
  assert(updateCompleteAgentConfigurationSchema.safeParse(nameOnly).success);
  const replacement = buildAgentProfileEditPatch({ agent: initialAgent, name: initialAgent.name, iconId: 'bot',
    extensions: { intent: 'replace', configuration }, workflowRevision: 7, enabledTools: ['__none__'] });
  assert(updateCompleteAgentConfigurationSchema.safeParse(replacement).success);
  assert.equal(replacement.expectedWorkflowRevision, 7);
  assert.deepEqual(replacement.extensions, configuration);
  for (const field of ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections', 'defaultProvider']) assert(!Object.hasOwn(replacement, field));
  assert.throws(() => buildAgentProfileEditPatch({ agent: initialAgent, name: initialAgent.name, iconId: 'bot',
    extensions: { intent: 'replace', configuration: null }, workflowRevision: 7 }));
  assert.throws(() => buildAgentProfileEditPatch({ agent: initialAgent, name: initialAgent.name, iconId: 'bot',
    extensions: { intent: 'replace', configuration }, workflowRevision: null }));
  assert(sameAgentProfileModelFields(agentProfileModelFields(initialAgent), {
    defaultProviderInstallationId: null, defaultProvider: 'google', defaultModel: 'historical-model', defaultThinking: null }));
  assert(!sameAgentProfileModelFields(agentProfileModelFields(initialAgent), { defaultProvider: null }));
  const clearModel = buildAgentProfileEditPatch({ agent: initialAgent, name: initialAgent.name, iconId: 'bot',
    extensions: { intent: 'keep', configuration }, workflowRevision: 7,
    model: { defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null } });
  assert.equal(clearModel.defaultProvider, null);
  const scoped = new URL(agentProfileEditUrl('/api/agents', context, { agentId: initialAgent.agentId }), dom.window.location.origin);
  assert.equal(scoped.searchParams.get('workspaceId'), context.workspaceId);
  assert.equal(scoped.searchParams.get('organizationId'), context.organizationId);
  assert.equal(scoped.searchParams.get('projectId'), context.projectId);
  assert.equal(scoped.searchParams.has('actorId'), false);
  assert.throws(() => agentProfileEditUrl('https://foreign.invalid/api/agents', context));
  assert(writeAgentFormDraft(scope, { modelOverrideEnabled: true, modelDraft: {
    providerInstallationId: 'actual-installation', providerId: 'openai', modelId: 'actual-model', thinkingLevel: 'max',
  } }));
  const maxDraft = readAgentFormDraft(scope);
  assert.equal(maxDraft.state, 'ready');
  assert.equal(maxDraft.state === 'ready' ? maxDraft.fields.modelDraft?.thinkingLevel : undefined, 'max');
  dom.window.localStorage.clear();

  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  let editor: AgentExtensionEditorProps | undefined, autoValidate = true;
  const clearedEditorTargets: AgentExtensionEditorProps['target'][] = [];
  function ControlledEditor(props: AgentExtensionEditorProps) {
    editor = props;
    const onValidationChange = props.onValidationChange;
    React.useEffect(() => {
      if (autoValidate) onValidationChange?.({ pending: false, blocked: false, preview: null, error: null });
    }, [onValidationChange]);
    return React.createElement('button', { type: 'button', disabled: props.disabled,
      onClick: () => props.onChange({ intent: 'replace', configuration: structuredClone(configuration) }) }, 'Replace exact extensions');
  }
  loader._load = (name, parent, isMain) => {
    if (name.endsWith('/AgentExtensionEditor')) return { AgentExtensionEditor: ControlledEditor,
      clearAgentExtensionEditorDraft: (_context: unknown, target: AgentExtensionEditorProps['target']) => {
        clearedEditorTargets.push(structuredClone(target));
      } };
    if (name.endsWith('/AgentManagedFilesCard')) return { AgentManagedFilesEditor: (props: {
      fileDrafts: Record<string, string>; onDraftChange: (file: string, value: string) => void;
    }) => React.createElement('div', null, ...['AGENTS.md', 'MEMORY.md'].map(file => React.createElement('textarea', {
      key: file, 'aria-label': file, value: props.fileDrafts[file],
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onDraftChange(file, event.target.value),
    }))) };
    if (name.endsWith('/AgentToolsCard')) return { AgentToolsEditor: (props: {
      onToolToggle: (name: string, enabled: boolean) => void; isToolEnabled: (name: string) => boolean;
    }) => React.createElement('div', null,
      React.createElement('output', { 'data-testid': 'native-read-state' }, String(props.isToolEnabled('read'))),
      React.createElement('output', { 'data-testid': 'native-write-state' }, String(props.isToolEnabled('write'))),
      React.createElement('button', { type: 'button', onClick: () => props.onToolToggle('write', true) }, 'Enable actual native write')) };
    if (name.endsWith('/ai-runtime/catalog-client')) return { readAdminRuntimeCatalog: async () => { throw new Error('Catalogue temporarily unavailable'); } };
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { EditAgentProfileDialog } = await import('../app/components/agents/EditAgentProfileDialog');
  const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  let serverAgent = structuredClone(initialAgent), serverConfiguration = structuredClone(configuration), failMemory = false;
  let closeCount = 0, refreshCount = 0, rejectRefresh = false;
  let holdNextInspection = false;
  let releaseInspection: (() => void) | undefined;
  const serverFiles: Record<string, string> = { 'AGENTS.md': 'Original agents', 'MEMORY.md': 'Original memory', 'SOUL.md': '', 'TOOLS.md': '' };
  const inspection = () => ({ agent: serverAgent, access: serverAgent.access,
    // Unrelated legacy bindings must never seed the complete extension editor.
    bindings: [{ resourceType: 'plugin', resourceId: 'old-plugin', name: 'Not a canonical source', scopeType: 'user' }],
    files: serverFiles, extensions: { agentId: serverAgent.agentId, revision: serverAgent.revision,
      workflowRevision: serverAgent.workflowRevision, configuration: serverConfiguration,
      configurationState: 'available', readiness: [] } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, method, body });
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: 'File write failed' }),
      { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/agents/tools' && method === 'GET') return response({ tools: ['read', 'write'].map(name => ({ name,
      label: name, description: name, group: 'Files' })), config: { enabledTools: serverAgent.enabledTools } });
    if (url.pathname === '/api/agents' && method === 'GET') {
      if (holdNextInspection) {
        holdNextInspection = false;
        const held = structuredClone(inspection());
        return new Promise<Response>(resolve => { releaseInspection = () => resolve(response(held)); });
      }
      return response(inspection());
    }
    if (url.pathname === '/api/agents' && method === 'PATCH') {
      assert(updateCompleteAgentConfigurationSchema.safeParse(body).success, 'The actual dialog must send the strict public update contract.');
      assert.equal(body.expectedRevision, serverAgent.revision);
      if (body.extensions) {
        assert.equal(body.expectedWorkflowRevision, serverAgent.workflowRevision);
        serverConfiguration = structuredClone(body.extensions) as typeof configuration;
        serverAgent.workflowRevision = (serverAgent.workflowRevision ?? 0) + 1;
      }
      for (const field of ['name', 'iconId', 'enabledTools', 'defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking']) {
        if (Object.hasOwn(body, field)) Object.assign(serverAgent, { [field]: body[field] });
      }
      serverAgent.revision = (serverAgent.revision ?? 0) + 1;
      return response(inspection());
    }
    if (url.pathname === '/api/agents/files' && method === 'PUT') {
      assert.equal(body.expectedRevision, serverAgent.revision);
      if (body.fileName === 'MEMORY.md' && failMemory) { failMemory = false; return response(null, 500); }
      serverFiles[String(body.fileName)] = String(body.content);
      serverAgent.revision = (serverAgent.revision ?? 0) + 1;
      return response({ agent: serverAgent });
    }
    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
  };
  const props = { open: true, agent: initialAgent, canManageAgentDefaults: true, context,
    onOpenChange: (open: boolean) => { if (!open) closeCount++; }, onDeleted: async () => {},
    onChanged: async () => { refreshCount++; if (rejectRefresh) throw new Error('Refresh unavailable'); } };
  // use-intl requires children in its props type; createElement's variadic child is not inferred there.
  // eslint-disable-next-line react/no-children-prop
  const view = (changes: Partial<typeof props> = {}) => React.createElement(NextIntlClientProvider,
    { locale: 'en', timeZone: 'UTC', messages, children: React.createElement(EditAgentProfileDialog, { ...props, ...changes }) });
  const save = () => screen.getByTestId('edit-agent-save') as HTMLButtonElement;
  const ready = async () => waitFor(() => { assert(editor); assert.equal(save().disabled, false); });
  const patchRequests = () => requests.filter(request => request.method === 'PATCH');
  const enterName = (value: string) => fireEvent.change(screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel), { target: { value } });
  const reset = () => {
    cleanup(); dom.window.localStorage.clear(); requests.length = 0; serverAgent = structuredClone(initialAgent);
    serverConfiguration = structuredClone(configuration); serverFiles['AGENTS.md'] = 'Original agents'; serverFiles['MEMORY.md'] = 'Original memory';
    closeCount = 0; refreshCount = 0; rejectRefresh = false; failMemory = false; autoValidate = true;
    holdNextInspection = false; releaseInspection = undefined; clearedEditorTargets.length = 0;
  };
  let cases = 0;
  try {
    render(view()); await ready();
    assert.deepEqual(editor?.value, { intent: 'keep', configuration });
    assert.deepEqual(editor?.context, context); assert.equal(editor?.model, undefined); assert.equal(editor?.enabledTools, undefined);
    enterName('Only the name changed'); fireEvent.click(save()); await waitFor(() => assert.equal(closeCount, 1));
    assert.deepEqual(patchRequests()[0].body, { agentId: initialAgent.agentId, expectedRevision: 4, name: 'Only the name changed' });
    assert.deepEqual(serverAgent.enabledTools, ['legacy_external_tool']); assert.equal(serverAgent.defaultModel, 'historical-model'); cases++;

    reset(); render(view()); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Replace exact extensions' })); await ready();
    assert.deepEqual(editor?.value.configuration, configuration);
    fireEvent.click(save()); await waitFor(() => assert.equal(closeCount, 1));
    assert.deepEqual(patchRequests()[0].body.extensions, configuration); assert.equal(patchRequests()[0].body.expectedWorkflowRevision, 7);
    for (const field of ['enabledTools', 'defaultProvider', 'capabilities', 'relevantSkills', 'relevantConnections']) assert(!Object.hasOwn(patchRequests()[0].body, field)); cases++;

    reset(); render(view()); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Enable actual native write' })); await ready();
    fireEvent.click(save()); await waitFor(() => assert.equal(closeCount, 1));
    assert(resolveEnabledToolNames(['read', 'write'], patchRequests()[0].body.enabledTools as string[]).has('write'));
    assert(!Object.hasOwn(patchRequests()[0].body, 'extensions')); cases++;

    reset(); serverAgent.enabledTools = ['__none__']; render(view()); await ready();
    assert.equal(screen.getByTestId('native-read-state').textContent, 'false');
    assert.equal(screen.getByTestId('native-write-state').textContent, 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Enable actual native write' })); await ready();
    assert.equal(screen.getByTestId('native-read-state').textContent, 'false');
    assert.equal(screen.getByTestId('native-write-state').textContent, 'true');
    fireEvent.click(save()); await waitFor(() => assert.equal(closeCount, 1));
    assert.deepEqual(patchRequests()[0].body.enabledTools, ['write']); cases++;

    reset(); render(view()); await ready(); failMemory = true;
    fireEvent.click(screen.getByRole('button', { name: 'Replace exact extensions' }));
    fireEvent.change(screen.getByLabelText('AGENTS.md'), { target: { value: 'Saved first file' } });
    fireEvent.change(screen.getByLabelText('MEMORY.md'), { target: { value: 'Retry this file' } });
    await ready(); fireEvent.click(save()); await screen.findByText('File write failed');
    assert.equal(patchRequests().length, 1); assert.equal(serverAgent.revision, 6); assert.equal(serverAgent.workflowRevision, 8);
    assert(clearedEditorTargets.some(target => target.kind === 'existing'
      && target.expectedRevision === 4 && target.expectedWorkflowRevision === 7), 'A confirmed replacement clears its original revision draft before a later file failure.');
    assert.equal(readAgentFormDraft({ ...scope, target: { ...scope.target, expectedRevision: 6, expectedWorkflowRevision: 8 } }).state, 'ready');
    await ready(); fireEvent.click(save()); await waitFor(() => assert.equal(closeCount, 1));
    assert.equal(patchRequests().length, 1, 'Retry never repeats an acknowledged complete configuration replacement.');
    assert.equal(requests.filter(request => request.method === 'PUT' && request.body.fileName === 'AGENTS.md').length, 1);
    assert.equal(requests.filter(request => request.method === 'PUT' && request.body.fileName === 'MEMORY.md').length, 2);
    assert.equal(serverAgent.revision, 7); assert.equal(readAgentFormDraft(scope).state, 'none'); cases++;

    reset(); rejectRefresh = true; render(view()); await ready(); enterName('Saved despite refresh outage'); fireEvent.click(save());
    await screen.findByTestId('edit-agent-saved-refresh-error'); assert.equal(save().disabled, true); assert.equal(patchRequests().length, 1);
    assert.equal(readAgentFormDraft(scope).state, 'none'); rejectRefresh = false;
    fireEvent.click(screen.getByTestId('edit-agent-refresh')); await waitFor(() => assert.equal(closeCount, 1));
    assert.equal(patchRequests().length, 1); assert.equal(refreshCount, 2); cases++;

    reset(); assert(writeAgentFormDraft(scope, { name: 'OAuth preserved draft', fileDrafts: { 'MEMORY.md': 'Preserved file' } }));
    render(view()); await ready();
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'OAuth preserved draft');
    assert.equal((screen.getByLabelText('MEMORY.md') as HTMLTextAreaElement).value, 'Preserved file');
    assert.equal(editor?.model, undefined); assert.equal(editor?.enabledTools, undefined); cases++;

    reset(); assert(writeAgentFormDraft({ ...scope, target: { ...scope.target, expectedRevision: 3 } }, { name: 'Stale draft must not win' }));
    render(view()); await screen.findByTestId('edit-agent-draft-conflict'); assert.equal(save().disabled, true);
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, initialAgent.name);
    assert.equal(readAgentFormDraft(scope).state, 'conflict');
    fireEvent.click(screen.getByRole('button', { name: 'Discard the old draft and use the current configuration' })); await ready();
    assert.equal(readAgentFormDraft(scope).state, 'none'); cases++;

    reset(); autoValidate = false; render(view()); await ready(); assert(editor);
    const oldValidation = editor.onValidationChange;
    fireEvent.click(screen.getByRole('button', { name: 'Replace exact extensions' })); assert.equal(save().disabled, true);
    await act(async () => oldValidation?.({ pending: false, blocked: false, preview: null, error: null })); assert.equal(save().disabled, true);
    await act(async () => editor?.onValidationChange?.({ pending: false, blocked: false, preview: null, error: null })); await ready(); cases++;

    reset(); holdNextInspection = true;
    const heldView = render(view());
    await waitFor(() => assert(releaseInspection));
    serverAgent.name = 'Current workspace Agent';
    heldView.rerender(view({ context: { ...context, workspaceId: 'workspace-b' } }));
    await ready();
    assert.equal(editor?.context.workspaceId, 'workspace-b');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'Current workspace Agent');
    await act(async () => releaseInspection?.());
    assert.equal(editor?.context.workspaceId, 'workspace-b');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'Current workspace Agent');
    assert.equal(patchRequests().length, 0); cases++;
    for (const request of requests) {
      assert(['workspace-a', 'workspace-b'].includes(request.url.searchParams.get('workspaceId') ?? ''));
      assert.equal(request.url.searchParams.get('organizationId'), context.organizationId);
      assert.equal(request.url.searchParams.get('projectId'), context.projectId);
      assert.equal(request.url.searchParams.has('actorId'), false);
    }
    console.log(`PASS ${cases} actual EditAgentProfileDialog React/HTTP-contract cases plus strict patch/model/scope helpers: canonical keep versus replacement, untouched legacy state, explicit no-tools versus defaults, partial ACK revision and retry, save versus refresh failure, max-thinking draft, exact draft restore/conflict, stale validation and late previous-workspace response. Controlled shared-editor/HTTP boundary; no browser or server authority claim.`);
  } finally { cleanup(); globalThis.fetch = originalFetch; loader._load = originalLoad; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
