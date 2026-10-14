import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import { createCompleteAgentConfigurationSchema, updateCompleteAgentConfigurationSchema } from '../app/lib/agents/workflow-api-contracts';
import type { AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import type { AgentExtensionEditorProps } from '../app/components/agents/AgentExtensionEditor';
import type { CreateAgentInput, CreatedAgent } from '../app/components/settings/CreateAgentDialog';
import type { AgentProfileItem } from '../app/components/settings/AgentSelectorCard';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import { readAgentFormDraft, writeAgentFormDraft } from '../app/components/agents/agent-form-draft-storage';
import { saveAgentExtensionDraft, readAgentExtensionDraft } from '../app/components/agents/agent-extension-editor-draft';
import { agentExtensionEditorContextKey } from '../app/components/agents/agent-extension-options-client';
import { resolveAgentFormToolDraft, toggleAgentFormToolDraft, toggleAgentFormToolsDraft } from '../app/components/agents/agent-profile-edit-client';

// Actual CreateDialog, SettingsPanel, SelectorCard and public mutation contract.
// The shared Editor content and HTTP DTO boundary are controlled here; this is a React
// state/transport regression, not server authorization or browser E2E evidence.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true,
  url: 'https://agent-create.fixture.invalid/settings?tab=agent-settings' });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLSelectElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: dom.window.sessionStorage, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

const pin = { resourceRef: 'canvas-resource:00000000-0000-4000-8000-000000000001',
  publishedRevisionRef: 'canvas-package-revision:00000000-0000-4000-8000-000000000002', checksum: 'a'.repeat(64) };
const selected: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed',
  selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'subset', relativeRoots: [] } }, requirement: 'required', toolCap: ['fixture_read'] }],
  workflow: { version: 1, packages: [{ ...pin, skillSelection: { kind: 'plugin' }, declarations: [] }] },
  standalone: [{ mode: 'fixed', entry: { selection: { kind: 'mcp', source: 'mcp',
    target: { kind: 'personal', connectionRef: 'mcp-personal:00000000-0000-4000-8000-000000000003' } }, requirement: 'optional', toolCap: ['fixture_read'] } }] };
const context = { actorId: 'fixture-user', workspaceId: 'workspace-a', organizationId: 'fixture-org', projectId: 'project-a' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

async function main(): Promise<void> {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const searchParams = new URLSearchParams({ tab: 'agent-settings', workspaceId: context.workspaceId,
    organizationId: context.organizationId, projectId: context.projectId });
  let editor: AgentExtensionEditorProps | undefined, autoValidate = true;
  function ControlledEditor(props: AgentExtensionEditorProps) {
    editor = props;
    const onValidationChange = props.onValidationChange;
    React.useEffect(() => {
      if (autoValidate) onValidationChange?.({ pending: false, blocked: false, preview: null, error: null });
    }, [onValidationChange]);
    return <div data-testid="controlled-extension-editor">
      <button type="button" disabled={props.disabled} onClick={() => props.onChange({ intent: 'replace', configuration: structuredClone(selected) })}>Select exact fixture sources</button>
    </div>;
  }
  const unrelatedPanel = new Set(['MemoryReviewAgentCard', 'AgentRuntimePreferenceCard', 'AgentCatalogModelOverrideEditor',
    'AgentManagedFilesCard', 'AgentSessionsCard', 'AgentDoctorCard']);
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === 'next/link') return { __esModule: true, default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
      function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    if (name.endsWith('/AgentExtensionEditorContent')) return { AgentExtensionEditorContent: ControlledEditor };
    // File-editor DOM is unrelated to native tool selection. The actual Edit
    // dialog, AgentFormSection and AgentToolsEditor remain mounted below.
    if (parent?.filename.endsWith('/EditAgentProfileDialog.tsx') && name.endsWith('/AgentManagedFilesCard')) {
      return { AgentManagedFilesEditor: () => null };
    }
    if (parent?.filename.endsWith('/AgentSettingsPanel.tsx')) {
      const basename = name.split('/').at(-1)?.replace(/\.tsx$/u, '');
      if (basename && unrelatedPanel.has(basename)) return {
        [basename === 'AgentCatalogModelOverrideEditor' ? 'AgentCatalogModelOverrideCard' : basename]: () => null };
    }
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { CreateAgentDialog } = await import('../app/components/settings/CreateAgentDialog');
  const { AgentSettingsPanel } = await import('../app/components/settings/AgentSettingsPanel');
  const { EditAgentProfileDialog } = await import('../app/components/agents/EditAgentProfileDialog');
  const resetFixture = () => { cleanup(); dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); };
  const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{child}</NextIntlClientProvider>;
  const createButton = () => screen.getByRole<HTMLButtonElement>('button', { name: messages.settings.agentPanel.createDialog.create });
  const enterName = (value: string) => fireEvent.change(screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel), { target: { value } });
  const ready = async () => waitFor(() => assert.equal(createButton().disabled, false));
  const fixedEmpty = () => {
    assert(editor?.value.configuration?.mode === 'fixed');
    assert.deepEqual(editor.value.configuration.selections, []); assert.deepEqual(editor.value.configuration.standalone, []);
  };
  const created: CreatedAgent = { agentId: 'created-once', name: 'Exact agent', scopeType: 'user', revision: 2 };
  const directInputs: CreateAgentInput[] = [];
  let cases = 0;
  try {
    globalThis.fetch = async input => { throw new Error(`Unexpected direct dialog request: ${String(input)}`); };
    const held = deferred<CreatedAgent | null>();
    render(wrap(<CreateAgentDialog open creating={false} error={null} canManageAgentDefaults={false} context={context}
      onOpenChange={() => {}} onCreate={async input => { directInputs.push(input); return held.promise; }} />));
    fixedEmpty(); enterName('Exact agent'); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Select exact fixture sources' })); await ready();
    assert.deepEqual(editor?.context, context);
    const userTarget = { kind: 'prospective' as const, scopeType: 'user' as const };
    const userScope = { ...context, target: userTarget }, userEditorKey = agentExtensionEditorContextKey(context, userTarget);
    saveAgentExtensionDraft(userEditorKey, { intent: 'replace', configuration: selected });
    fireEvent.click(createButton()); fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.createDialog.creating }));
    assert.equal(directInputs.length, 1, 'A synchronous double activation must not create a second Agent.');
    assert.deepEqual(directInputs[0].extensions, selected);
    assert(createCompleteAgentConfigurationSchema.safeParse(directInputs[0]).success);
    for (const field of ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections']) assert.equal(Object.hasOwn(directInputs[0], field), false);
    await act(async () => held.resolve(created)); await screen.findByTestId('personal-agent-created');
    assert.equal(readAgentFormDraft(userScope).state, 'none', 'Acknowledged creation deletes the exact parent form draft.');
    assert.equal(readAgentExtensionDraft(userEditorKey), null, 'Acknowledged creation clears the exact Editor draft too.');
    assert.equal(screen.queryByRole('button', { name: messages.settings.agentPanel.createDialog.create }), null); cases++;

    resetFixture(); autoValidate = false;
    render(wrap(<CreateAgentDialog open creating={false} error={null} canManageAgentDefaults={false} context={context}
      onOpenChange={() => {}} onCreate={async () => created} />));
    enterName('Validation states'); assert(createButton().disabled); assert(editor);
    await act(async () => editor!.onValidationChange?.({ pending: true, blocked: false, preview: null, error: null })); assert(createButton().disabled);
    await act(async () => editor!.onValidationChange?.({ pending: false, blocked: true, preview: null, error: 'Source denied' })); assert(createButton().disabled);
    await act(async () => editor!.onValidationChange?.({ pending: false, blocked: false, preview: null, error: null })); await ready();
    const previousValidation = editor.onValidationChange;
    fireEvent.click(screen.getByRole('button', { name: 'Select exact fixture sources' })); assert(createButton().disabled);
    await act(async () => previousValidation?.({ pending: false, blocked: false, preview: null, error: null })); assert(createButton().disabled,
      'A preview for the previous draft cannot unlock submission of a changed selection.'); cases++;

    resetFixture(); autoValidate = true;
    const oldCreate = deferred<CreatedAgent | null>();
    const props = { open: true, creating: false, error: null, canManageAgentDefaults: true, onOpenChange: () => {}, onCreate: async () => oldCreate.promise };
    const session = render(wrap(<CreateAgentDialog {...props} context={context} />));
    enterName('Old workspace draft'); fireEvent.click(screen.getByRole('button', { name: 'Select exact fixture sources' })); await ready();
    fireEvent.click(createButton());
    session.rerender(wrap(<CreateAgentDialog {...props} context={{ ...context, actorId: 'other-user', workspaceId: 'workspace-b' }} />));
    fixedEmpty(); assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, '');
    await act(async () => oldCreate.resolve(created)); assert.equal(screen.queryByTestId('personal-agent-created'), null);
    assert.equal(editor?.context.actorId, 'other-user'); assert.equal(editor?.context.workspaceId, 'workspace-b'); cases++;

    resetFixture();
    render(wrap(<CreateAgentDialog {...props} context={context} />));
    enterName('Scope draft'); fireEvent.click(screen.getByRole('button', { name: 'Select exact fixture sources' })); await ready();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${messages.settings.agentPanel.createDialog.scope.organization}`, 'u') }));
    fixedEmpty(); assert.equal(editor?.target.kind === 'prospective' ? editor.target.scopeType : null, 'organization');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'Scope draft'); cases++;

    resetFixture();
    const mainAgent: AgentProfileItem = { ...created, agentId: DEFAULT_AGENT_ID, name: 'Bradley', iconId: 'bot', type: 'main', removable: false,
      defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null, enabledTools: ['read'],
      relevantSkills: null, relevantConnections: null, scopeType: 'system', organizationId: context.organizationId,
      ownerUserId: null, createdByUserId: null, access: { canUse: true, canEdit: true, canManage: true } };
    const createdProfile: AgentProfileItem = { ...mainAgent, ...created, type: 'special', removable: true, ownerUserId: context.actorId };
    let postCount = 0, postRequest: { url: URL; body: unknown } | undefined;
    const listRefresh = deferred<Response>();
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
      if (url.pathname === '/api/agents' && method === 'POST') {
        postCount++; postRequest = { url, body: JSON.parse(String(init?.body)) };
        return Response.json({ success: true, data: { agent: createdProfile } });
      }
      if (url.pathname === '/api/agents' && method === 'GET') return postCount
        ? listRefresh.promise
        : Response.json({ success: true, data: { agents: [mainAgent] } });
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: { tools: [], config: { agentId: url.searchParams.get('agentId'), enabledTools: ['read'] } } });
      if (url.pathname === '/api/agents/files') return Response.json({ success: true, data: { files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) } });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected Panel fixture request: ${method} ${url}`);
    };
    render(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    await screen.findByRole('button', { name: /Bradley/u });
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.selector.create }));
    assert.deepEqual(editor?.context, context, 'The actual SettingsPanel -> SelectorCard -> CreateDialog chain retains every source-scope field.');
    enterName(created.name); fireEvent.click(screen.getByRole('button', { name: 'Select exact fixture sources' })); await ready();
    fireEvent.click(createButton()); await screen.findByTestId('personal-agent-created');
    await act(async () => listRefresh.resolve(Response.json({ success: false, error: 'Read-only list refresh failed after commit.' }, { status: 503 })));
    assert.equal(postCount, 1); assert(postRequest);
    for (const key of ['workspaceId', 'organizationId', 'projectId'] as const) assert.equal(postRequest.url.searchParams.get(key), context[key]);
    const posted = createCompleteAgentConfigurationSchema.parse(postRequest.body);
    assert.deepEqual(posted.extensions, selected);
    assert.equal(screen.queryByRole('button', { name: messages.settings.agentPanel.createDialog.create }), null,
      'An acknowledged POST followed by a failed refresh must stay on the successful created view.');
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.createDialog.done }));
    const beforeReloadFetch = globalThis.fetch;
    let refreshRetries = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin);
      if (url.pathname === '/api/agents' && (init?.method ?? 'GET') === 'GET') {
        refreshRetries++; return Response.json({ success: true, data: { agents: [mainAgent, createdProfile] } });
      }
      return beforeReloadFetch(input, init);
    };
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.selector.reload }));
    await waitFor(() => assert.equal(refreshRetries, 1));
    assert.equal(postCount, 1, 'Retrying the failed list refresh performs only GET after acknowledged creation.');
    assert.equal(postCount, 1); cases++;

    resetFixture();
    globalThis.fetch = async input => {
      const url = new URL(String(input), dom.window.location.origin);
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: {
        tools: [{ name: 'read', label: 'Read files', description: 'Read exact source.', group: 'Core', planningModeAllowed: true }], config: { enabledTools: ['read'] } } });
      throw new Error(`Unexpected restored form fixture request: ${url}`);
    };
    const restoredFields = { name: 'Before OAuth', iconId: 'code', selectedTemplateId: 'coding', modelOverrideEnabled: false,
      modelDraft: { providerInstallationId: 'aip_fixture', providerId: 'google', modelId: 'fixture-model', thinkingLevel: 'high' as const },
      toolsOverrideEnabled: true, customEnabledTools: ['read'], fileDrafts: { 'AGENTS.md': 'Exact unsaved instructions',
        'MEMORY.md': 'Unsaved memory draft', 'SOUL.md': 'Unsaved personality draft', 'TOOLS.md': 'Unsaved tools draft' } };
    assert(writeAgentFormDraft(userScope, restoredFields));
    saveAgentExtensionDraft(userEditorKey, { intent: 'replace', configuration: selected });
    let formOpen = true;
    const restoredProps = { creating: false, error: null, canManageAgentDefaults: false, context,
      onCreate: async () => created, onOpenChange: (next: boolean) => { formOpen = next; redraw(); } };
    const redraw = () => restoredView.rerender(wrap(<CreateAgentDialog {...restoredProps} open={formOpen} />));
    const restoredView = render(wrap(<CreateAgentDialog {...restoredProps} open />));
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, restoredFields.name);
    fixedEmpty();
    assert(readAgentExtensionDraft(userEditorKey), 'The saved extension intent remains available for explicit Editor restoration; the Parent does not apply it silently.');
    assert.equal(editor?.enabledTools?.[0], 'read');
    assert.equal(editor?.suggestedSkillNames?.join(','), 'context7-mcp,code-structure', 'Templates supply hints, not implicit exact selections.');
    enterName('After OAuth without losing edits'); await ready();
    const autosaved = readAgentFormDraft(userScope); assert(autosaved.state === 'ready');
    assert.deepEqual(autosaved.fields, { ...restoredFields, name: 'After OAuth without losing edits' }, 'Autosave includes every restored profile/model/native-tool/file field.');
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.createDialog.cancel }));
    assert.equal(readAgentFormDraft(userScope).state, 'ready', 'Ordinary close retains the scoped parent draft.');
    assert(readAgentExtensionDraft(userEditorKey), 'Ordinary close retains the scoped extension draft.');
    formOpen = true; await act(async () => redraw());
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'After OAuth without losing edits');
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.createDialog.discardDraft }));
    assert.equal(readAgentFormDraft(userScope).state, 'none'); assert.equal(readAgentExtensionDraft(userEditorKey), null);
    formOpen = true; await act(async () => redraw());
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, ''); cases++;

    resetFixture();
    render(wrap(<CreateAgentDialog open creating={false} error={null} canManageAgentDefaults={false}
      context={{ workspaceId: context.workspaceId }} onOpenChange={() => {}} onCreate={async () => created} />));
    enterName('No authenticated identity in the presentation context'); await ready();
    assert.equal(dom.window.localStorage.length, 0, 'Absent Actor identity must not create a globally shared form draft.'); cases++;

    resetFixture();
    const oldPost = deferred<Response>(); postCount = 0;
    const scopedPosts: URL[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
      if (url.pathname === '/api/agents' && method === 'POST') { postCount++; scopedPosts.push(url); return oldPost.promise; }
      if (url.pathname === '/api/agents') return Response.json({ success: true, data: { agents: [mainAgent] } });
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: { tools: [], config: { agentId: url.searchParams.get('agentId'), enabledTools: ['read'] } } });
      if (url.pathname === '/api/agents/files') return Response.json({ success: true, data: { files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) } });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected scope-race fixture request: ${method} ${url}`);
    };
    const panel = render(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    await screen.findByRole('button', { name: /Bradley/u });
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.selector.create }));
    enterName('Old workspace request'); await ready(); fireEvent.click(createButton());
    await waitFor(() => assert.equal(postCount, 1));
    searchParams.set('workspaceId', 'workspace-b');
    panel.rerender(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    enterName('New workspace draft');
    await act(async () => oldPost.resolve(Response.json({ success: true, data: { agent: createdProfile } })));
    assert.equal(editor?.context.workspaceId, 'workspace-b');
    assert.equal((screen.getByLabelText(messages.settings.agentPanel.createDialog.nameLabel) as HTMLInputElement).value, 'New workspace draft');
    assert.equal(screen.queryByTestId('personal-agent-created'), null, 'A successful old-scope POST cannot replace the new workspace form.');
    assert.equal(scopedPosts[0]?.searchParams.get('workspaceId'), context.workspaceId); assert.equal(postCount, 1);
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.createDialog.cancel }));
    const scopedFetch = globalThis.fetch, currentScopeReads: URL[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin);
      if (url.pathname === '/api/agents' && (init?.method ?? 'GET') === 'GET') currentScopeReads.push(url);
      return scopedFetch(input, init);
    };
    await waitFor(() => assert.equal(screen.getByRole<HTMLButtonElement>('button', { name: messages.settings.agentPanel.selector.reload }).disabled, false));
    fireEvent.click(screen.getByRole('button', { name: messages.settings.agentPanel.selector.reload }));
    await waitFor(() => assert.equal(currentScopeReads.length, 1));
    assert.equal(currentScopeReads[0].searchParams.get('workspaceId'), 'workspace-b');
    assert.equal(postCount, 1, 'A post-scope-change refresh cannot replay the old create request.'); cases++;

    resetFixture(); searchParams.set('workspaceId', context.workspaceId);
    const useOnlyAgent = { ...createdProfile, agentId: 'v2-shared-agent', name: 'Shared V2 Agent', scopeType: 'organization' as const,
      ownerUserId: null, workflowVersion: 2, workflowRevision: 1, access: { canUse: true, canEdit: false, canManage: false } };
    let workflow: AgentWorkflowDescriptor = { agentId: useOnlyAgent.agentId, revision: useOnlyAgent.revision, workflowVersion: 2,
      workflowRevision: 1, preferenceRevision: 0, access: useOnlyAgent.access, packages: [{ ...pin, name: 'Exact existing package',
        declarations: [{ declarationPath: '.canvas-plugin/plugin.json', capabilities: [{ capabilityKey: `agent-capability:${'e'.repeat(43)}`,
          capabilityId: 'read', application: 'reader', required: true, selectionMode: 'selectable', selectionOrigin: 'default',
          selectedKind: 'shared', selectedChoiceId: 'a', personalChoiceAllowed: false,
          selectedConnection: { source: 'mcp', label: 'Allowed A', availability: 'available', status: 'unknown', scopeLabel: 'organization' },
          choices: ['a', 'b'].map(choiceId => ({ choiceId, kind: 'shared' as const, source: 'mcp' as const,
            label: `Allowed ${choiceId.toUpperCase()}`, availability: 'available' as const, status: 'unknown' as const, scopeLabel: 'organization' as const })) }] }] }], standalone: [] };
    const choiceWrites: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
      if (url.pathname === '/api/agents' && method === 'GET') return Response.json({ success: true, data: { agents: [mainAgent, useOnlyAgent] } });
      if (url.pathname === '/api/agents/workflow') {
        assert.equal(url.searchParams.get('workspaceId'), context.workspaceId);
        if (method === 'PATCH') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>; choiceWrites.push(body);
          assert.deepEqual(Object.keys(body).sort(), ['agentId', 'capabilityKey', 'choiceId', 'expectedPreferenceRevision', 'expectedWorkflowRevision']);
          assert.equal(body.choiceId, 'b'); assert.equal(body.expectedPreferenceRevision, workflow.preferenceRevision);
          const next = structuredClone(workflow); next.preferenceRevision++;
          const slot = next.packages[0].declarations[0].capabilities[0];
          slot.selectedChoiceId = 'b'; slot.selectionOrigin = 'user'; slot.selectedConnection = slot.choices.find(choice => choice.choiceId === 'b');
          workflow = next;
        }
        return Response.json({ success: true, data: workflow });
      }
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: { tools: [], config: { agentId: url.searchParams.get('agentId'), enabledTools: ['read'] } } });
      if (url.pathname === '/api/agents/files') return Response.json({ success: true, data: { files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) } });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected Use-only V2 fixture request: ${method} ${url}`);
    };
    render(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    const useOnlyRow = await screen.findByRole('button', { name: /Shared V2 Agent/u }); fireEvent.click(useOnlyRow);
    assert.equal(screen.queryByTestId('agent-settings-workflow-management'), null, 'V2 Use-only does not acquire a central configuration editor.');
    assert.equal(screen.queryByRole('switch', { name: messages.settings.agentPanel.capabilities.skillsToggle }), null);
    assert.equal(screen.queryByRole('switch', { name: messages.settings.agentPanel.inheritance.toolsOverride }), null);
    const choicesCard = screen.getByTestId('agent-settings-workflow');
    fireEvent.click(within(choicesCard).getByRole('button', { name: messages.agentWorkflow.open }));
    const chooser = await screen.findByRole('combobox', { name: messages.agentWorkflow.connectionFor.replace('{application}', 'reader') });
    fireEvent.change(chooser, { target: { value: 'choice:b' } });
    fireEvent.click(within(screen.getByTestId('agent-workflow-dialog')).getByRole('button', { name: messages.agentWorkflow.save }));
    await waitFor(() => assert.equal(choiceWrites.length, 1));
    assert.deepEqual(workflow.access, { canUse: true, canEdit: false, canManage: false });
    assert.equal(workflow.packages[0].declarations[0].capabilities[0].selectedChoiceId, 'b'); cases++;

    const nativeTools = [{ name: 'read', label: 'Read files', description: 'Read exact files.', group: 'Core', planningModeAllowed: true },
      { name: 'write', label: 'Write files', description: 'Write exact files.', group: 'Core', planningModeAllowed: false }];
    for (const configuration of [['__none__'], []]) {
      resetFixture();
      globalThis.fetch = async input => {
        const url = new URL(String(input), dom.window.location.origin);
        assert.equal(url.pathname, '/api/agents/tools');
        return Response.json({ success: true, data: { tools: nativeTools, config: { agentId: DEFAULT_AGENT_ID, enabledTools: ['read', 'write'] } } });
      };
      assert(writeAgentFormDraft(userScope, { name: 'Native draft', toolsOverrideEnabled: true, customEnabledTools: configuration }));
      let captured: CreateAgentInput | undefined;
      render(wrap(<CreateAgentDialog open creating={false} error={null} canManageAgentDefaults={false} context={context}
        onOpenChange={() => {}} onCreate={async input => { captured = input; return created; }} />));
      const read = await screen.findByRole('switch', { name: 'Read files' });
      const write = screen.getByRole('switch', { name: 'Write files' });
      const none = configuration.includes('__none__');
      assert.equal(read.getAttribute('aria-checked'), none ? 'false' : 'true');
      assert.equal(write.getAttribute('aria-checked'), none ? 'false' : 'true');
      if (none) {
        fireEvent.click(write); await ready(); fireEvent.click(createButton()); await screen.findByTestId('personal-agent-created');
        assert.deepEqual(captured?.enabledTools, ['write'], 'Create toggling Write from __none__ must select only Write.');
      }
      cases++;
    }

    resetFixture();
    let noneProfile = { ...createdProfile, agentId: 'none-profile', name: 'Native None Agent', enabledTools: ['__none__'], workflowVersion: 2, workflowRevision: 1 };
    const nativeWrites: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
      if (url.pathname === '/api/agents' && method === 'GET') return Response.json({ success: true, data: { agents: [noneProfile] } });
      if (url.pathname === '/api/agents' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>; nativeWrites.push(body);
        assert.equal(body.agentId, noneProfile.agentId); assert.equal(body.expectedRevision, noneProfile.revision);
        assert(Array.isArray(body.enabledTools));
        noneProfile = { ...noneProfile, enabledTools: body.enabledTools as string[], revision: noneProfile.revision + 1 };
        return Response.json({ success: true, data: { agent: noneProfile } });
      }
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: { tools: nativeTools,
        config: { agentId: url.searchParams.get('agentId'), enabledTools: noneProfile.enabledTools } } });
      if (url.pathname === '/api/agents/files') return Response.json({ success: true, data: { files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) } });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected native-none fixture request: ${method} ${url}`);
    };
    dom.window.localStorage.setItem('canvas-settings-agent-section-open-state', JSON.stringify({ tools: true }));
    render(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    const write = await screen.findByRole('switch', { name: 'Write files' });
    const read = screen.getByRole('switch', { name: 'Read files' });
    assert.equal(write.getAttribute('aria-checked'), 'false'); assert.equal(read.getAttribute('aria-checked'), 'false');
    fireEvent.click(write); await waitFor(() => assert.equal(nativeWrites.length, 1));
    assert.deepEqual(nativeWrites[0].enabledTools, ['write'], 'Settings toggling Write from __none__ must select only Write.');
    assert.equal(Object.hasOwn(nativeWrites[0], 'extensions'), false, 'A native-tool edit retains the exact existing extension configuration.'); cases++;

    // Actual /api/agents/tools gateway ordering: plugin operations precede the
    // old complete Skill toolset. Re-resolving legacy migration between each
    // removal resurrected all six plugin operations during Disable all.
    const pluginToolNames = ['create_canvas_plugin_draft', 'inspect_canvas_plugin', 'install_canvas_plugin_from_workspace',
      'update_canvas_plugin_from_workspace', 'set_canvas_plugin_enabled', 'remove_canvas_plugin'];
    const oldSkillToolNames = ['create_canvas_skill_draft', 'inspect_canvas_skill', 'install_canvas_skill_from_workspace',
      'update_canvas_skill_from_workspace', 'discard_canvas_skill_draft'];
    const bulkTools = [...nativeTools, ...[...pluginToolNames, ...oldSkillToolNames].map(name => ({ name, label: name,
      description: 'Existing package management operation.', group: 'Skills', planningModeAllowed: false })),
    { name: 'browser', label: 'Unavailable browser', description: 'Unavailable owned fixture tool.', group: 'Browser', planningModeAllowed: false,
      availability: { available: false, reason: 'The fixture has no browser runtime.' } }];
    const bulkNames = bulkTools.map(tool => tool.name);
    const legacyMigrated = resolveAgentFormToolDraft(bulkNames, oldSkillToolNames);
    assert(pluginToolNames.every(name => legacyMigrated.has(name)), 'Existing complete old Skill selections must retain the plugin migration.');
    assert.deepEqual(toggleAgentFormToolsDraft([], true, oldSkillToolNames, bulkNames), oldSkillToolNames,
      'An Enable all action with no available filtered tools preserves the exact existing draft.');
    assert.deepEqual(toggleAgentFormToolDraft('read', true, ['__none__'], bulkNames), ['read']);
    assert.deepEqual(toggleAgentFormToolsDraft(bulkNames, false, [], bulkNames), ['__none__']);
    const bulkButton = (name: 'enableAll' | 'disableAll') => screen.getByRole<HTMLButtonElement>('button', { name: messages.settings.agentPanel.tools[name] });
    const searchTools = (query: string) => fireEvent.change(screen.getByPlaceholderText(messages.settings.agentPanel.tools.searchPlaceholder), { target: { value: query } });

    resetFixture();
    globalThis.fetch = async input => {
      const url = new URL(String(input), dom.window.location.origin);
      assert.equal(url.pathname, '/api/agents/tools');
      return Response.json({ success: true, data: { tools: bulkTools, config: { agentId: DEFAULT_AGENT_ID, enabledTools: [] } } });
    };
    assert(writeAgentFormDraft(userScope, { name: 'Atomic native Create', toolsOverrideEnabled: true, customEnabledTools: [] }));
    let bulkCreated: CreateAgentInput | undefined;
    render(wrap(<CreateAgentDialog open creating={false} error={null} canManageAgentDefaults={false} context={context}
      onOpenChange={() => {}} onCreate={async input => { bulkCreated = input; return created; }} />));
    await screen.findByRole('switch', { name: 'Read files' });
    const assertCreateTools = async (expected: string[]) => waitFor(() => {
      const draft = readAgentFormDraft(userScope); assert.equal(draft.state, 'ready');
      assert.deepEqual(draft.state === 'ready' ? draft.fields.customEnabledTools : undefined, expected);
    });
    fireEvent.click(bulkButton('disableAll')); await assertCreateTools(['__none__']);
    assert.equal(screen.getByRole('switch', { name: 'Read files' }).getAttribute('aria-checked'), 'false');
    assert(pluginToolNames.every(name => screen.getByRole('switch', { name }).getAttribute('aria-checked') === 'false'));
    searchTools('write'); fireEvent.click(bulkButton('enableAll')); await assertCreateTools(['write']);
    searchTools('read'); fireEvent.click(screen.getByRole('switch', { name: 'Read files' })); await assertCreateTools(['read', 'write']);
    fireEvent.click(bulkButton('disableAll')); await assertCreateTools(['write']);
    searchTools(''); fireEvent.click(bulkButton('disableAll')); await assertCreateTools(['__none__']);
    searchTools('read'); fireEvent.click(bulkButton('enableAll')); await assertCreateTools(['read']);
    searchTools('browser'); fireEvent.click(bulkButton('enableAll')); await assertCreateTools(['read']);
    assert.equal(screen.getByRole('switch', { name: 'Unavailable browser' }).getAttribute('aria-checked'), 'false');
    await ready(); fireEvent.click(createButton()); await screen.findByTestId('personal-agent-created');
    assert.deepEqual(bulkCreated?.enabledTools, ['read']); assert(createCompleteAgentConfigurationSchema.safeParse(bulkCreated).success); cases++;

    resetFixture();
    let bulkProfile = { ...createdProfile, agentId: 'atomic-native-profile', name: 'Atomic native profile', enabledTools: [] as string[],
      defaultThinking: null, workflowVersion: 2, workflowRevision: 1 };
    const bulkPatches: Record<string, unknown>[] = [];
    const bulkFiles = Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, '']));
    const emptyConfiguration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] };
    const bulkInspection = () => ({ agent: bulkProfile, access: bulkProfile.access, files: bulkFiles, extensions: {
      agentId: bulkProfile.agentId, revision: bulkProfile.revision, workflowRevision: bulkProfile.workflowRevision,
      configuration: emptyConfiguration, configurationState: 'available', readiness: [] } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
      if (url.pathname === '/api/agents' && method === 'GET') return Response.json({ success: true,
        data: url.searchParams.has('agentId') ? bulkInspection() : { agents: [bulkProfile] } });
      if (url.pathname === '/api/agents' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert(updateCompleteAgentConfigurationSchema.safeParse(body).success); assert.equal(body.expectedRevision, bulkProfile.revision);
        assert.equal(body.agentId, bulkProfile.agentId); assert(Array.isArray(body.enabledTools));
        assert.equal(Object.hasOwn(body, 'extensions'), false, 'Bulk tool configuration retains the complete extension configuration.');
        bulkPatches.push(body); bulkProfile = { ...bulkProfile, enabledTools: body.enabledTools as string[], revision: bulkProfile.revision + 1 };
        return Response.json({ success: true, data: bulkInspection() });
      }
      if (url.pathname === '/api/agents/tools') return Response.json({ success: true, data: { tools: bulkTools,
        config: { agentId: url.searchParams.get('agentId'), enabledTools: bulkProfile.enabledTools } } });
      if (url.pathname === '/api/agents/files') return Response.json({ success: true, data: { files: bulkFiles } });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      throw new Error(`Unexpected actual bulk tool UI request: ${method} ${url}`);
    };
    dom.window.localStorage.setItem('canvas-settings-agent-section-open-state', JSON.stringify({ tools: true }));
    render(wrap(<AgentSettingsPanel currentUserId={context.actorId} />));
    await screen.findByRole('switch', { name: 'Read files' });
    const assertSettingsPatch = async (count: number, expected: string[]) => waitFor(() => {
      assert.equal(bulkPatches.length, count); assert.deepEqual(bulkPatches[count - 1].enabledTools, expected); assert.equal(bulkButton('disableAll').disabled, false);
    });
    fireEvent.click(bulkButton('disableAll')); await assertSettingsPatch(1, ['__none__']);
    searchTools('read'); fireEvent.click(bulkButton('enableAll')); await assertSettingsPatch(2, ['read']);
    searchTools('write'); fireEvent.click(bulkButton('enableAll')); await assertSettingsPatch(3, ['read', 'write']);
    searchTools('read'); fireEvent.click(bulkButton('disableAll')); await assertSettingsPatch(4, ['write']);
    searchTools(''); fireEvent.click(bulkButton('disableAll')); await assertSettingsPatch(5, ['__none__']);
    searchTools('read'); fireEvent.click(screen.getByRole('switch', { name: 'Read files' })); await assertSettingsPatch(6, ['read']); cases++;

    resetFixture(); bulkProfile = { ...bulkProfile, enabledTools: [] }; bulkPatches.length = 0;
    let editClosed = false;
    render(wrap(<EditAgentProfileDialog open agent={bulkProfile} canManageAgentDefaults={false} context={context}
      onOpenChange={open => { if (!open) editClosed = true; }} onChanged={() => {}} onDeleted={() => {}} />));
    await screen.findByRole('switch', { name: 'Read files' });
    const editScope = { ...context, target: { kind: 'existing' as const, agentId: bulkProfile.agentId,
      expectedRevision: bulkProfile.revision, expectedWorkflowRevision: bulkProfile.workflowRevision } };
    const assertEditTools = async (expected: string[]) => waitFor(() => {
      const draft = readAgentFormDraft(editScope); assert.equal(draft.state, 'ready');
      assert.deepEqual(draft.state === 'ready' ? draft.fields.customEnabledTools : undefined, expected);
    });
    fireEvent.click(bulkButton('disableAll')); await assertEditTools(['__none__']);
    assert(pluginToolNames.every(name => screen.getByRole('switch', { name }).getAttribute('aria-checked') === 'false'));
    searchTools('write'); fireEvent.click(bulkButton('enableAll')); await assertEditTools(['write']);
    searchTools('read'); fireEvent.click(screen.getByRole('switch', { name: 'Read files' })); await assertEditTools(['read', 'write']);
    fireEvent.click(bulkButton('disableAll')); await assertEditTools(['write']);
    searchTools(''); fireEvent.click(bulkButton('disableAll')); await assertEditTools(['__none__']);
    searchTools('read'); fireEvent.click(bulkButton('enableAll')); await assertEditTools(['read']);
    await waitFor(() => assert.equal((screen.getByTestId('edit-agent-save') as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByTestId('edit-agent-save')); await waitFor(() => assert(editClosed));
    assert.equal(bulkPatches.length, 1); assert.deepEqual(bulkPatches[0].enabledTools, ['read']); cases++;
    console.log(`PASS ${cases} actual CreateAgentDialog/SettingsPanel/EditAgentProfileDialog React regressions: complete pinned extension POST without legacy fields, pending/blocked/stale preview fences, one POST, source-scope reset and late acknowledgement isolation, actual scoped Parent POST and GET-only retry before/after scope change, full scoped form reload with explicit extension restoration, close retention, discard/Ack cleanup, absent-Actor persistence denial, V2 Use-only actual choice without central Edit, __none__ versus defaults, and real native ToolsEditor bulk buttons/filters preserving exact Read drafts/Create/Edit/Settings payloads across legacy tool migration. Editor validation, unrelated Edit file presentation and HTTP DTO boundaries controlled; no server ACL or browser E2E claim.`);
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
