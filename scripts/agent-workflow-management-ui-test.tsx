import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentProfileItem } from '../app/components/settings/AgentSelectorCard';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagement, AgentWorkflowManagementOptions, AgentWorkflowManagementPackageVersion } from '../app/lib/agents/workflow-management-contracts';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true, url: 'https://agent-management.fixture.invalid/settings?tab=agent-settings',
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

const resource = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const oldPin = 'canvas-package-revision:22222222-2222-4222-8222-222222222222';
const nextPin = 'canvas-package-revision:33333333-3333-4333-8333-333333333333';
const declarationPath = 'skills/creative/agents/canvas.yaml';
const firstConnection = 'canvas-connection:44444444-4444-4444-8444-444444444444';
const secondConnection = 'canvas-connection:55555555-5555-4555-8555-555555555555';
const retained = { kind: 'retained' as const, retainedBindingRef: `agent-workflow-retain:v1:${'a'.repeat(64)}` };
const retainedFor = (revision: number) => revision === 4 ? retained : { kind: 'retained' as const,
  retainedBindingRef: `agent-workflow-retain:v1:${revision.toString(16).padStart(64, '0')}` };
const checksum = 'b'.repeat(64);
type Profile = AgentProfileItem & { workflowVersion: 1 | null; workflowRevision: number };
type RequestRecord = { url: URL; method: string; body: Record<string, unknown> | null };
type HeldResponse = { release(): void; promise: Promise<Response> };
function reissueRetained(value: AgentWorkflowConfiguration | null, revision: number): void {
  for (const pkg of value?.packages ?? []) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
    for (const choice of choices) if (choice.target.kind === 'retained') choice.target = retainedFor(revision);
  }
}

function configuration(): AgentWorkflowConfiguration {
  return { version: 1, packages: [{ resourceRef: resource, publishedRevisionRef: oldPin, checksum,
    skillSelection: { kind: 'skills', relativeRoots: ['skills/creative'] }, declarations: [{ declarationPath, capabilities: [
      { capabilityId: 'design', required: true, selection: { mode: 'selectable', defaultChoiceId: 'studio', allowedChoices: [
        { choiceId: 'studio', alternativeKey: 'composio:canva', target: { kind: 'shared', source: 'composio', connectionRef: firstConnection, bindingRevision: 2 }, toolCap: null },
        { choiceId: 'personal-original', alternativeKey: 'composio:canva', target: retained, toolCap: ['CANVA_LIST_DESIGNS'] },
      ], personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['CANVA_LIST_DESIGNS'] } } },
      { capabilityId: 'library', required: true, selection: { mode: 'fixed', alternativeKey: 'composio:canva',
        target: { kind: 'shared', source: 'composio', connectionRef: secondConnection, bindingRevision: 3 }, toolCap: ['CANVA_LIST_DESIGNS'] } },
    ] }] }] };
}
function profile(agentId: string, name: string, access = { canUse: true, canEdit: true, canManage: false }): Profile {
  return { agentId, name, iconId: 'bot', type: 'special', removable: true, defaultProviderInstallationId: null,
    defaultProvider: null, defaultModel: null, defaultThinking: null, enabledTools: ['read', 'email_list_mailboxes'],
    relevantSkills: null, relevantConnections: null, scopeType: 'user', organizationId: 'fixture-org',
    ownerUserId: 'fixture-user', createdByUserId: 'fixture-user', revision: 4, workflowVersion: 1, workflowRevision: 2, access };
}
function management(current: Profile): AgentWorkflowManagement {
  assert(current.access);
  const configured = configuration();
  reissueRetained(configured, current.revision);
  if (current.agentId === 'fixture-beta') {
    const capability = configured.packages[0].declarations[0].capabilities[0];
    capability.required = false;
    capability.selection = { mode: 'fixed', alternativeKey: 'composio:canva',
      target: { kind: 'shared', source: 'composio', connectionRef: secondConnection, bindingRevision: 3 }, toolCap: ['CANVA_LIST_DESIGNS'] };
  }
  return { schemaVersion: 1, view: 'management', agentId: current.agentId, revision: current.revision,
    workflowRevision: current.workflowRevision, workflowVersion: current.workflowVersion, access: current.access,
    profile: { agentId: current.agentId, name: current.name, iconId: current.iconId, scopeType: current.scopeType,
      enabledTools: current.enabledTools }, configurationState: 'available', configuration: configured,
    unavailablePackageCount: 0, unavailableConnectionCount: 0, bindingSummaries: [...(current.agentId === 'fixture-beta' ? [
      { resourceRef: resource, publishedRevisionRef: oldPin, declarationPath, capabilityId: 'design', alternativeKey: 'composio:canva',
        source: 'composio' as const, label: 'Campaign design', scopeLabel: 'team' as const, status: 'setup_required' as const },
    ] : [
      { resourceRef: resource, publishedRevisionRef: oldPin, declarationPath, capabilityId: 'design', alternativeKey: 'composio:canva',
        choiceId: 'studio', source: 'composio' as const, label: 'Studio design', scopeLabel: 'organization' as const, status: 'unknown' as const },
      { resourceRef: resource, publishedRevisionRef: oldPin, declarationPath, capabilityId: 'design', alternativeKey: 'composio:canva',
        choiceId: 'personal-original', source: 'composio' as const, label: 'Original personal design', scopeLabel: 'personal' as const, status: 'unknown' as const },
    ]),
      { resourceRef: resource, publishedRevisionRef: oldPin, declarationPath, capabilityId: 'library', alternativeKey: 'composio:canva',
        source: 'composio', label: 'Campaign design', scopeLabel: 'team', status: 'setup_required' },
    ] };
}
function userProjection(current: Profile): AgentWorkflowDescriptor {
  assert(current.access);
  return { agentId: current.agentId, revision: current.revision, workflowVersion: current.workflowVersion,
    workflowRevision: current.workflowRevision, preferenceRevision: 7, access: current.access, packages: [] };
}
function version(current: Profile, pin: string): AgentWorkflowManagementPackageVersion {
  const old = pin === oldPin;
  return { schemaVersion: 1, view: 'package-version', agentId: current.agentId, revision: current.revision,
    workflowRevision: current.workflowRevision, resourceRef: resource, publishedRevisionRef: pin,
    checksum: old ? checksum : 'c'.repeat(64), kind: 'plugin', name: 'Creative package', version: old ? '1.0.0' : '2.0.0',
    skillRoots: old ? [{ name: 'creative', relativeRoot: 'skills/creative' }, { name: 'sibling', relativeRoot: 'skills/sibling' }]
      : [{ name: 'replacement', relativeRoot: 'skills/replacement' }],
    declarations: [{ declarationPath: old ? declarationPath : 'skills/replacement/agents/canvas.yaml', workflow: {
      version: 1, integrationCapabilities: ['design', 'library'].map(id => ({ id, application: 'canva', required: id === 'library',
        alternatives: [{ source: 'composio' as const, toolkit: 'canva', requiredTools: ['CANVA_LIST_DESIGNS'] }] })),
    } }] };
}

/** Actual React UI/client/builder; only SafeDTO HTTP and independent settings renderers are controlled. No backend/SDK authority claim. */
async function main(): Promise<void> {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const independentViews = new Set(['MemoryReviewAgentCard', 'AgentRuntimePreferenceCard', 'AgentCatalogModelOverrideEditor',
    'AgentManagedFilesCard', 'AgentSessionsCard', 'AgentDoctorCard']);
  const searchParams = new URLSearchParams('tab=agent-settings&workspaceId=fixture-workspace&organizationId=fixture-org&projectId=fixture-project');
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => searchParams };
    if (name === 'next/link') return { __esModule: true, default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    if (parent?.filename.endsWith('/AgentSettingsPanel.tsx')) {
      const basename = name.split('/').at(-1)?.replace(/\.tsx$/u, '');
      if (basename && independentViews.has(basename)) return { [basename === 'AgentCatalogModelOverrideEditor' ? 'AgentCatalogModelOverrideCard' : basename]: () => null };
    }
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { AgentSettingsPanel } = await import('../app/components/settings/AgentSettingsPanel');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: 'fixture-workspace' });
  let alpha = profile('fixture-alpha', 'Agent Alpha'), beta = profile('fixture-beta', 'Agent Beta');
  let snapshots = new Map<string, AgentWorkflowManagement>([[alpha.agentId, management(alpha)], [beta.agentId, management(beta)]]);
  const requests: RequestRecord[] = [], writes: Record<string, unknown>[] = [], held: HeldResponse[] = [];
  const transportErrors: unknown[] = [];
  let intercept: ((request: RequestRecord, reply: () => Response) => Response | Promise<Response> | undefined) | undefined;
  const ok = (data: unknown) => Response.json({ success: true, data });
  const retain = (reply: Response): HeldResponse => {
    let resolve!: (value: Response) => void;
    const result = { promise: new Promise<Response>(done => { resolve = done; }), release: () => resolve(reply) };
    held.push(result); return result;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
    const request = { url, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    requests.push(request); if (method === 'PATCH') { assert(request.body); writes.push(request.body); }
    const reply = (): Response => {
      if (url.pathname === '/api/agents' && method === 'GET') {
        assert.equal(url.searchParams.get('purpose'), 'configure', 'The actual Panel requests the configure-authorized discovery projection.');
        assert.equal(url.searchParams.get('workspaceId'), 'fixture-workspace'); assert.equal(url.searchParams.get('organizationId'), 'fixture-org');
        assert.equal(url.searchParams.get('projectId'), 'fixture-project'); return ok({ agents: [alpha, beta] });
      }
      if (url.pathname === `/api/capabilities/packages/${encodeURIComponent(resource)}/versions`) return ok({ versions:
        [nextPin, oldPin].map(pin => ({ resourceRef: resource, revisionRef: pin, kind: 'plugin', name: 'Creative package',
          version: pin === oldPin ? '1.0.0' : '2.0.0', checksum: pin === oldPin ? checksum : 'c'.repeat(64),
          publishedByUserId: 'fixture-user', publishedAt: pin === oldPin ? 1 : 2, baseRevisionRef: pin === oldPin ? null : oldPin,
          fileCount: 3, totalBytes: 48 })) });
      const id = url.searchParams.get('agentId') ?? String(request.body?.agentId ?? '');
      if (id === DEFAULT_AGENT_ID && method === 'GET') {
        // The actual Panel initially requests default-Agent metadata before its first /agents reply selects Alpha.
        if (url.pathname === '/api/agents/tools') return ok({ tools: [], config: { agentId: id, enabledTools: [] } });
        if (url.pathname === '/api/agents/files') return ok({ files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) });
        if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      }
      const current = id === alpha.agentId ? alpha : beta;
      assert.equal(id, current.agentId, 'Every agent-specific request must target a known controlled agent.');
      if (url.pathname === '/api/agents/tools') return ok({ tools: [
        { name: 'read', label: 'Read files', group: 'Core', planningModeAllowed: true },
        { name: 'email_list_mailboxes', label: 'List email', group: 'Email', planningModeAllowed: true },
      ], config: { agentId: id, enabledTools: current.enabledTools } });
      if (url.pathname === '/api/agents/files') return ok({ files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) });
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      if (url.pathname === '/api/agents' && method === 'PATCH') {
        assert(request.body); const input = request.body;
        assert.equal(input.expectedRevision, current.revision);
        if (Object.hasOwn(input, 'workflow')) {
          assert.equal(input.expectedWorkflowRevision, current.workflowRevision);
          assert(!Object.hasOwn(input, 'enabledTools'), 'Workflow Save must not change native tools.');
        } else {
          assert(Array.isArray(input.enabledTools), 'Only the actual native ToolsCard may send a tools-only write in this fixture.');
        }
        assert(!Object.hasOwn(input, 'expectedPreferenceRevision'), 'Central Save must not use Own-Choice CAS.');
        const next = { ...current, revision: current.revision + 1, workflowRevision: current.workflowRevision + (Object.hasOwn(input, 'workflow') ? 1 : 0),
          ...(Object.hasOwn(input, 'workflow') ? { workflowVersion: input.workflow === null ? null : 1 as const } : {}),
          ...(Array.isArray(input.enabledTools) ? { enabledTools: [...input.enabledTools] as string[] } : {}) };
        if (id === alpha.agentId) alpha = next; else beta = next;
        const nextSnapshot = { ...snapshots.get(id)!, revision: next.revision, workflowRevision: next.workflowRevision,
          profile: { ...snapshots.get(id)!.profile, enabledTools: next.enabledTools },
          ...(Object.hasOwn(input, 'workflow') ? { configuration: structuredClone(input.workflow) as AgentWorkflowConfiguration | null,
            configurationState: input.workflow === null ? 'legacy' as const : 'available' as const, workflowVersion: input.workflow === null ? null : 1 as const } : {}) };
        reissueRetained(nextSnapshot.configuration, next.revision);
        snapshots.set(id, nextSnapshot);
        return ok({ agent: next, workflow: userProjection(next) });
      }
      assert.equal(url.pathname, '/api/agents/workflow'); assert.equal(init?.credentials, 'include');
      assert.equal(url.searchParams.get('workspaceId'), 'fixture-workspace');
      const header = { schemaVersion: 1 as const, agentId: id, revision: current.revision, workflowRevision: current.workflowRevision };
      const view = url.searchParams.get('view');
      if (view === 'management') return ok(snapshots.get(id));
      assert.equal(Number(url.searchParams.get('expectedRevision')), current.revision);
      assert.equal(Number(url.searchParams.get('expectedWorkflowRevision')), current.workflowRevision);
      let result: AgentWorkflowManagementOptions;
      if (view === 'packages') result = { ...header, view, packages: [{ resourceRef: resource, name: 'Creative package', displayName: 'Creative package',
        kind: 'plugin', scopeLabel: 'team', versions: [
          { revisionRef: nextPin, version: '2.0.0', checksum: 'c'.repeat(64), publishedAt: 2 },
          { revisionRef: oldPin, version: '1.0.0', checksum, publishedAt: 1 },
        ] }], pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 } };
      else if (view === 'package-version') result = version(current, url.searchParams.get('publishedRevisionRef')!);
      else if (view === 'connections') result = { ...header, view, connections: [
        { connectionRef: firstConnection, bindingRevision: 2, source: 'composio', label: 'Studio design', scopeLabel: 'organization',
          application: 'canva', allowedToolNames: ['CANVA_LIST_DESIGNS'], status: 'unknown', mappingRequired: false },
        { connectionRef: secondConnection, bindingRevision: 3, source: 'composio', label: 'Campaign design', scopeLabel: 'team',
          application: 'canva', allowedToolNames: ['CANVA_LIST_DESIGNS'], status: 'setup_required', mappingRequired: false },
      ], pagination: { page: 1, limit: 20, totalItems: 2, totalPages: 1 } };
      else if (view === 'personal-connections') {
        const providerRef = url.searchParams.get('providerRef');
        result = { ...header, view, alternatives: [{ alternativeKey: 'composio:canva', source: 'composio', providers: [
          { providerRef: 'opaque-own-profile', label: 'Canva', profileLabel: 'Design profile', origin: 'personal', status: providerRef ? 'available' : 'unverified',
            ...(providerRef ? { noAuth: false, accounts: [
              { accountSelectionRef: 'opaque-first-account', label: 'First design account', status: 'ACTIVE', selectable: true },
              { accountSelectionRef: 'opaque-second-account', label: 'Second design account', status: 'ACTIVE', selectable: true },
            ] } : {}) },
        ] }] };
      } else if (view === 'personal-mcp-definitions') result = { ...header, view, definitions: [] };
      else throw new Error(`Unexpected controlled workflow view: ${String(view)}`);
      return ok(result);
    };
    try { return await (intercept?.(request, reply) ?? reply()); }
    catch (error) { transportErrors.push(error); throw error; }
  };
  const mount = (handler?: typeof intercept, setup?: () => void) => {
    assert.equal(transportErrors.length, 0, 'A transport/assertion failure must never masquerade as a handled UI failure.');
    cleanup(); for (const pending of held.splice(0)) pending.release();
    alpha = profile('fixture-alpha', 'Agent Alpha'); beta = profile('fixture-beta', 'Agent Beta');
    snapshots = new Map([[alpha.agentId, management(alpha)], [beta.agentId, management(beta)]]);
    requests.length = 0; writes.length = 0; intercept = handler;
    setup?.();
    dom.window.localStorage.setItem('canvas-settings-agent-section-open-state', JSON.stringify({ tools: true }));
    return render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><AgentSettingsPanel currentUserId="fixture-user" /></NextIntlClientProvider>);
  };
  const release = (pending: HeldResponse) => act(async () => pending.release());
  const workflowRead = (request: RequestRecord, agentId: string, view = 'management') => request.method === 'GET'
    && request.url.pathname === '/api/agents/workflow' && request.url.searchParams.get('agentId') === agentId
    && request.url.searchParams.get('view') === view;
  const reads = (view: string) => requests.filter(request => request.method === 'GET' && request.url.pathname === '/api/agents/workflow'
    && request.url.searchParams.get('view') === view);
  const choose = (name: 'Alpha' | 'Beta') => fireEvent.click(screen.getByRole('button', { name: new RegExp(`Agent ${name}`, 'u'), hidden: true }));
  const open = async () => {
    fireEvent.click(await screen.findByTestId('agent-settings-workflow-management-open'));
    return screen.findByTestId('agent-workflow-management-dialog');
  };
  const save = () => screen.getByTestId('workflow-management-save') as HTMLButtonElement;
  const label = (path: string, values: Record<string, string> = {}) => {
    let value: unknown = Reflect.get(messages, 'agentWorkflowManagement');
    for (const part of path.split('.')) { assert(value && typeof value === 'object'); value = Reflect.get(value, part); }
    assert.equal(typeof value, 'string');
    return String(value).replace(/\{([A-Za-z]+)\}/gu, (token, key: string) => values[key] ?? token);
  };
  const capability = (id: string) => {
    const element = within(screen.getByTestId('workflow-management-bindings')).getByText(id, { exact: true })
      .closest<HTMLElement>('[data-testid="workflow-management-capability"]');
    assert(element); return within(element);
  };
  const required = (id = 'design') => capability(id).getByRole('checkbox', { name: label('bindings.requiredFor', { application: 'canva' }) });
  const checked = (element: HTMLElement) => element instanceof dom.window.HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true';
  const mode = (id = 'design') => capability(id).getByRole('combobox', { name: label('bindings.modeFor', { application: 'canva' }) }) as HTMLSelectElement;
  const section = async (name: 'packages' | 'bindings' | 'operations') => {
    const toggle = await screen.findByTestId(`workflow-management-${name}-toggle`);
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    return screen.findByTestId(`workflow-management-${name}`);
  };
  const loadBindings = async () => {
    const node = await section('bindings');
    if (!within(node).queryAllByTestId('workflow-management-capability').length) {
      fireEvent.click(within(node).getByRole('button', { name: label('bindings.load') }));
    }
    await waitFor(() => assert(['fixed', 'selectable'].includes(mode().value)));
  };
  const dirtyDesign = async () => { await loadBindings(); fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); };
  const saved = async () => { await screen.findByText(label('saved')); await waitFor(() => assert.equal(save().disabled, true)); };
  const close = () => fireEvent.click(within(screen.getByTestId('agent-workflow-management-dialog')).getByRole('button', { name: label('close') }));
  const reloadDiscard = async () => {
    fireEvent.click(screen.getByTestId('workflow-management-reload'));
    const confirmation = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmation).getByRole('button', { name: label('confirm.discard') }));
  };
  const nativeRead = () => {
    const row = screen.getByText('read', { exact: true }).closest<HTMLElement>('[data-slot="collapsible"]'); assert(row);
    return within(row).getByRole('switch', { name: 'Read files' });
  };
  const staleListCase = async () => {
    mount(); await open(); await dirtyDesign();
    let oldList: HeldResponse | undefined;
    intercept = (request, reply) => {
      if (request.method !== 'GET' || request.url.pathname !== '/api/agents') return;
      oldList = retain(reply()); return oldList.promise;
    };
    // Controlled event to the actual Selector handler; Radix correctly makes this background inert in a native browser.
    const selectorCard = screen.getByText(messages.settings.agentPanel.selector.title, { exact: true }).closest<HTMLElement>('[data-slot="card"]'); assert(selectorCard);
    fireEvent.click(within(selectorCard).getByRole('button', { name: messages.settings.agentPanel.selector.reload, hidden: true }));
    await waitFor(() => assert(oldList));
    fireEvent.click(save()); await saved(); assert.equal(alpha.revision, 5);
    intercept = undefined; assert(oldList); await release(oldList);
    close(); await waitFor(() => assert.equal(Boolean(screen.queryByTestId('agent-workflow-management-dialog')), false));
    await waitFor(() => assert.equal(nativeRead().getAttribute('aria-checked'), 'true'));
    fireEvent.click(nativeRead());
    await waitFor(() => assert(writes.some(input => Object.hasOwn(input, 'enabledTools'))));
    const written = writes.find(input => Object.hasOwn(input, 'enabledTools')); assert(written);
    console.log('OBSERVED stale-agent-list native PATCH', JSON.stringify({ expectedRevision: written.expectedRevision, expected: 5 }));
    assert.equal(written.agentId, alpha.agentId); assert.equal(written.expectedRevision, 5,
      'A pre-save Agent-list response must not replace the acknowledged profile revision used by the actual native ToolsCard.');
    await waitFor(() => assert.equal(alpha.revision, 6));
    assert.equal(transportErrors.length, 0); cases += 1;
  };
  let cases = 0;
  try {
    if (process.argv.includes('--stale-agent-list')) { await staleListCase(); console.log('PASS central Workflow ACK / stale Agent-list / native ToolsCard CAS.'); return; }
    if (!process.argv.includes('--recovery-only')) {
    mount(undefined, () => {
      alpha.access = { canUse: false, canEdit: true, canManage: false }; snapshots.set(alpha.agentId, management(alpha));
    });
    await open();
    await waitFor(() => assert(requests.some(request => workflowRead(request, alpha.agentId))));
    assert.equal(Boolean(screen.queryByTestId('agent-settings-workflow')), false, 'AgentUse-only personal choice must remain separate from AgentEdit configuration.');
    assert.equal(reads('packages').length, 0, 'Opening configuration must not eagerly enumerate all packages.');
    assert.equal(reads('connections').length, 0, 'Connection options must remain lazy.');
    assert.equal(reads('personal-connections').length, 0, 'Opening configuration must not enumerate personal profiles or probe accounts.');
    assert.equal(writes.length, 0); cases += 1;

    mount(undefined, () => {
      alpha.access = { canUse: true, canEdit: false, canManage: false }; snapshots.set(alpha.agentId, management(alpha));
    });
    await screen.findByTestId('agent-settings-workflow');
    assert.equal(Boolean(screen.queryByTestId('agent-settings-workflow-management-open')), false, 'Use-only is not Configure authority.');
    assert.equal(reads('management').length, 0); cases += 1;

    mount(); await open();
    const packages = await section('packages');
    fireEvent.click(within(packages).getByRole('button', { name: new RegExp(label('packages.configured'), 'u') }));
    const selectedSkill = await screen.findByRole('checkbox', { name: label('packages.skill', { name: 'creative' }) });
    assert.equal(checked(selectedSkill), true);
    assert.equal(checked(screen.getByRole('checkbox', { name: label('packages.skill', { name: 'sibling' }) })), false);
    assert.equal(reads('package-version').at(-1)?.url.searchParams.get('publishedRevisionRef'), oldPin);
    assert.equal(reads('package-version').filter(request => request.url.searchParams.get('publishedRevisionRef') === nextPin).length, 0,
      'Opening an exact old pin must not substitute the current HEAD.');
    await loadBindings(); assert.equal(mode().value, 'selectable'); assert.equal(mode('library').value, 'fixed');
    assert.equal(required('library').getAttribute('disabled'), '');
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false));
    fireEvent.click(save()); await saved();
    const firstWrite = writes[0]; assert(firstWrite);
    assert.deepEqual(Object.keys(firstWrite).sort(), ['agentId', 'expectedRevision', 'expectedWorkflowRevision', 'workflow']);
    const submitted = firstWrite.workflow as AgentWorkflowConfiguration;
    assert.deepEqual(submitted.packages[0].skillSelection, { kind: 'skills', relativeRoots: ['skills/creative'] });
    assert.equal(submitted.packages[0].publishedRevisionRef, oldPin); assert.equal(submitted.packages[0].checksum, checksum);
    const designSelection = submitted.packages[0].declarations[0].capabilities[0].selection; assert.equal(designSelection.mode, 'selectable');
    if (designSelection.mode !== 'selectable') throw new Error('The actual submitted selection must remain selectable.');
    assert.deepEqual(designSelection.allowedChoices[1].target, retained, 'Unrelated edits preserve the original opaque personal approval exactly.');
    assert.equal(designSelection.allowedChoices[0].toolCap, null); assert.equal(designSelection.defaultChoiceId, 'studio');
    assert(requests.filter(request => workflowRead(request, alpha.agentId)).length >= 2,
      'A save acknowledgement must be followed by fresh central management, rather than adopting its User projection.');
    const nativeSummary = await section('operations'); assert(nativeSummary.textContent?.includes('email_list_mailboxes'));
    assert.equal(Boolean(within(nativeSummary).queryByRole('switch')), false); assert.equal(Boolean(within(nativeSummary).queryByRole('checkbox')), false);
    assert.deepEqual(alpha.enabledTools, ['read', 'email_list_mailboxes']); cases += 1;

    await loadBindings();
    fireEvent.change(capability('design').getByRole('combobox', { name: label('bindings.default') }), { target: { value: 'personal-original' } });
    const personalPolicy = capability('design').getByTestId('workflow-management-personal-policy');
    fireEvent.click(within(personalPolicy).getByRole('checkbox', { name: label('bindings.allowPersonal') }));
    fireEvent.click(save()); await saved();
    const secondWrite = writes[1]; assert(secondWrite); assert.equal(secondWrite.expectedRevision, 5); assert.equal(secondWrite.expectedWorkflowRevision, 3);
    const updated = (secondWrite.workflow as AgentWorkflowConfiguration).packages[0].declarations[0].capabilities[0].selection;
    assert.equal(updated.mode, 'selectable'); if (updated.mode !== 'selectable') throw new Error('Selectable binding required.');
    assert.equal(updated.defaultChoiceId, 'personal-original'); assert.equal(updated.personalPolicy, undefined);
    assert.deepEqual(updated.allowedChoices[1].target, retainedFor(5), 'The second Save uses refreshed opaque handles from management, not pre-save retention handles.'); cases += 1;

    mount(undefined, () => { alpha.ownerUserId = 'foreign-agent-owner'; }); await open(); await loadBindings();
    const originalChoice = capability('design').getAllByTestId('workflow-management-choice')[1];
    fireEvent.click(within(originalChoice).getByRole('button', { name: label('target.personal') }));
    const providerSelect = await within(originalChoice).findByRole('combobox', { name: label('target.provider') });
    assert.equal(reads('personal-connections').length, 1);
    assert.equal(reads('personal-connections')[0].url.searchParams.has('providerRef'), false,
      'Opening own profiles is metadata-only; an explicit profile selection is a separate account-discovery request.');
    fireEvent.change(providerSelect, { target: { value: 'opaque-own-profile' } });
    const accountSelect = await within(originalChoice).findByRole('combobox', { name: label('target.account') }) as HTMLSelectElement;
    assert.equal(reads('personal-connections').length, 2); assert.equal(reads('personal-connections')[1].url.searchParams.get('providerRef'), 'opaque-own-profile');
    assert.equal(accountSelect.value, '', 'Multiple ACTIVE accounts must not implicitly select the first account.');
    assert((within(originalChoice).getByRole('button', { name: label('target.use') }) as HTMLButtonElement).disabled);
    fireEvent.change(accountSelect, { target: { value: 'opaque-second-account' } });
    fireEvent.click(within(originalChoice).getByRole('button', { name: label('target.use') }));
    fireEvent.click(save()); await saved();
    const personalInput = (writes[0].workflow as AgentWorkflowConfiguration).packages[0].declarations[0].capabilities[0].selection;
    assert.equal(personalInput.mode, 'selectable'); if (personalInput.mode !== 'selectable') throw new Error('Selectable binding required.');
    assert.deepEqual(personalInput.allowedChoices[1].target, { kind: 'personal', source: 'composio', ownerUserId: 'fixture-user',
      providerRef: 'opaque-own-profile', accountSelectionRef: 'opaque-second-account' },
    'A new own personal choice binds the current actor, never the foreign owner of an edit-authorized Agent.');
    assert(!JSON.stringify(writes[0]).includes('profileId')); assert(!JSON.stringify(writes[0]).includes('connectedAccountId'));
    assert.equal(writes.length, 1); cases += 1;
    }

    let firstConflict = true, failedReload = false, failedSave = false;
    mount((request, reply) => {
      if (request.method === 'PATCH' && firstConflict) {
        firstConflict = false; alpha = { ...alpha, revision: 5, workflowRevision: 3 };
        snapshots.set(alpha.agentId, management(alpha));
        return Response.json({ success: false, code: 'AGENT_WORKFLOW_REVISION_CONFLICT' }, { status: 409 });
      }
      if (workflowRead(request, alpha.agentId) && failedReload) {
        failedReload = false; return Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: 503 });
      }
      if (request.method === 'PATCH' && failedSave) {
        failedSave = false; return Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: 503 });
      }
      return reply();
    });
    await open(); await dirtyDesign(); fireEvent.click(save());
    await screen.findByText(label('errors.conflict')); assert.equal(checked(required()), false); assert.equal(save().disabled, true);
    const beforeCancel = reads('management').length;
    fireEvent.click(screen.getByTestId('workflow-management-reload'));
    const cancelled = await screen.findByRole('alertdialog');
    fireEvent.click(within(cancelled).getByRole('button', { name: label('confirm.cancel') }));
    assert.equal(reads('management').length, beforeCancel); assert.equal(checked(required()), false);
    failedReload = true; await reloadDiscard(); await screen.findByText(label('errors.load'));
    assert.equal(checked(required()), false); assert.equal(save().disabled, true,
      'A failed refresh after 409 cannot refresh the draft CAS or reopen Save.');
    assert.equal(writes.length, 1);
    await reloadDiscard(); await waitFor(() => assert.equal(Boolean(screen.queryByTestId('workflow-management-error')), false));
    await dirtyDesign(); failedSave = true; fireEvent.click(save()); await screen.findByText(label('errors.load'));
    assert.equal(checked(required()), false); await waitFor(() => assert.equal(save().disabled, false,
      'An ordinary failed Save503 retains the same draft and allows an explicit retry without adopting revisions.'));
    fireEvent.click(save()); await saved();
    assert.equal(writes.length, 3); assert.equal(writes[1].expectedRevision, 5); assert.equal(writes[2].expectedRevision, 5);
    assert.equal(writes[1].expectedWorkflowRevision, 3); assert.equal(writes[2].expectedWorkflowRevision, 3); cases += 1;
    if (process.argv.includes('--recovery-only')) { assert.equal(transportErrors.length, 0); console.log('PASS isolated dirty recovery.'); return; }

    mount((request, reply) => request.method === 'PATCH'
      ? Response.json({ success: false, code: 'AGENT_ACCESS_DENIED' }, { status: 403 }) : reply());
    await open(); await dirtyDesign(); fireEvent.click(save()); await screen.findByText(label('errors.denied'));
    assert.equal(checked(required()), false); assert((required() as HTMLInputElement).disabled); assert(save().disabled);
    fireEvent.click(save()); assert.equal(writes.length, 1, 'A denial never causes a fallback configuration or a second write.'); cases += 1;

    mount(undefined, () => {
      const original = snapshots.get(alpha.agentId)!;
      snapshots.set(alpha.agentId, { ...original, configurationState: 'blocked', configuration: null, unavailablePackageCount: 1 });
    });
    await open(); await screen.findByTestId('workflow-management-blocked'); assert(save().disabled);
    assert.equal(writes.length, 0); assert.equal(Boolean(screen.queryByTestId('workflow-management-packages')), false,
      'An inaccessible central configuration must not silently become an editable empty package list.');
    fireEvent.click(screen.getByRole('button', { name: label('blocked.rebuild') }));
    const rebuild = await screen.findByRole('alertdialog'); fireEvent.click(within(rebuild).getByRole('button', { name: label('confirm.rebuild') }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.deepEqual(writes[0].workflow, { version: 1, packages: [] }); assert.equal(writes.length, 1); cases += 1;

    mount(); await open();
    const oldPackage = await section('packages');
    fireEvent.click(within(oldPackage).getByRole('button', { name: new RegExp(label('packages.configured'), 'u') }));
    await screen.findByRole('checkbox', { name: label('packages.skill', { name: 'creative' }) });
    fireEvent.click(within(oldPackage).getByRole('button', { name: label('packages.versions') }));
    const versionSelect = await screen.findByRole('combobox', { name: label('packages.publishedVersion') });
    fireEvent.change(versionSelect, { target: { value: nextPin } });
    fireEvent.click(screen.getByRole('button', { name: label('packages.useVersion') }));
    await waitFor(() => assert(reads('package-version').some(request => request.url.searchParams.get('publishedRevisionRef') === nextPin)));
    const changedPackages = await section('packages');
    fireEvent.click(within(changedPackages).getByRole('button', { name: /Creative package/u }));
    const rootMode = await screen.findByRole('combobox', { name: label('packages.selection') }) as HTMLSelectElement;
    assert.equal(rootMode.value, 'skills', 'A removed Child root cannot silently turn into whole-Plugin selection.');
    const replacement = screen.getByRole('checkbox', { name: label('packages.skill', { name: 'replacement' }) });
    assert.equal(checked(replacement), false); assert(save().disabled);
    fireEvent.click(replacement);
    await section('bindings'); await screen.findByText('skills/replacement/agents/canvas.yaml', { exact: true });
    await waitFor(() => assert.equal(mode('library').value, 'none'));
    assert.equal(Boolean(screen.queryByText(label('target.retained'))), false, 'An explicit pin replacement cannot carry a prior personal/MCP approval into a new slot.');
    assert(save().disabled); assert.equal(writes.length, 0);
    fireEvent.change(mode('library'), { target: { value: 'fixed' } });
    fireEvent.click(capability('library').getByRole('button', { name: label('target.shared') }));
    const sharedSelect = await capability('library').findByRole('combobox', { name: label('target.shared') });
    fireEvent.change(sharedSelect, { target: { value: secondConnection } });
    fireEvent.click(capability('library').getByRole('button', { name: label('target.use') }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    const replaced = writes[0].workflow as AgentWorkflowConfiguration;
    assert.equal(replaced.packages[0].publishedRevisionRef, nextPin); assert.equal(replaced.packages[0].checksum, 'c'.repeat(64));
    assert.deepEqual(replaced.packages[0].skillSelection, { kind: 'skills', relativeRoots: ['skills/replacement'] });
    assert(!JSON.stringify(replaced).includes(retained.retainedBindingRef));
    fireEvent.click(screen.getByRole('button', { name: label('clear') }));
    const reset = await screen.findByRole('alertdialog'); fireEvent.click(within(reset).getByRole('button', { name: label('confirm.clear') }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes[1].workflow, null); assert.deepEqual(alpha.enabledTools, ['read', 'email_list_mailboxes']); cases += 1;

    let oldAlphaRead: HeldResponse | undefined;
    mount((request, reply) => {
      if (!workflowRead(request, alpha.agentId) || oldAlphaRead) return;
      oldAlphaRead = retain(reply()); return oldAlphaRead.promise;
    });
    await open(); await waitFor(() => assert(oldAlphaRead));
    // Real Selector event handlers; these deterministic epoch tests do not claim a native click through Radix's inert background.
    choose('Beta'); await open(); await loadBindings();
    assert.equal(mode().value, 'fixed'); assert.equal(checked(required()), false);
    intercept = undefined; assert(oldAlphaRead); await release(oldAlphaRead);
    assert.equal(mode().value, 'fixed'); assert.equal(checked(required()), false);
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes.length, 1); assert.equal(writes[0].agentId, beta.agentId);
    const betaConfig = writes[0].workflow as AgentWorkflowConfiguration;
    assert.equal(betaConfig.packages[0].declarations[0].capabilities[0].selection.mode, 'fixed'); cases += 1;

    oldAlphaRead = undefined;
    mount((request, reply) => {
      if (!workflowRead(request, alpha.agentId) || oldAlphaRead) return;
      oldAlphaRead = retain(reply()); return oldAlphaRead.promise;
    });
    await open(); await waitFor(() => assert(oldAlphaRead)); choose('Beta'); await open(); await loadBindings();
    alpha = { ...alpha, revision: 5, workflowRevision: 3 };
    const freshAlpha = management(alpha); assert(freshAlpha.configuration);
    freshAlpha.configuration.packages[0].declarations[0].capabilities[0].required = false;
    snapshots.set(alpha.agentId, freshAlpha); intercept = undefined;
    choose('Alpha'); await open(); await loadBindings(); assert.equal(checked(required()), false);
    assert(oldAlphaRead); await release(oldAlphaRead); assert.equal(checked(required()), false);
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes[0].agentId, alpha.agentId); assert.equal(writes[0].expectedRevision, 5); assert.equal(writes[0].expectedWorkflowRevision, 3); cases += 1;

    for (const errorStatus of [null, 503] as const) {
      let oldWrite: HeldResponse | undefined;
      mount((request, reply) => {
        if (request.method !== 'PATCH') return;
        oldWrite = retain(errorStatus === null ? reply() : Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: errorStatus }));
        return oldWrite.promise;
      });
      await open(); await dirtyDesign(); fireEvent.click(save()); await waitFor(() => assert(oldWrite));
      choose('Beta'); await open(); await loadBindings(); assert.equal(mode().value, 'fixed');
      const beforeReads = requests.filter(request => workflowRead(request, alpha.agentId)).length;
      intercept = undefined; assert(oldWrite); await release(oldWrite);
      await waitFor(() => assert.equal(Boolean(screen.queryByTestId('workflow-management-error')), false));
      assert.equal(mode().value, 'fixed'); assert.equal(checked(required()), false);
      assert.equal(requests.filter(request => workflowRead(request, alpha.agentId)).length, beforeReads,
        'A departed Agent save ACK/error must not trigger an old Agent reload into the active dialog.');
      fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
      assert.equal(writes[1].agentId, beta.agentId); assert.equal(writes[1].expectedRevision, 4); cases += 1;
    }

    let pendingWrite: HeldResponse | undefined;
    mount((request, reply) => {
      if (request.method !== 'PATCH') return;
      pendingWrite = retain(reply()); return pendingWrite.promise;
    });
    await open(); await dirtyDesign(); fireEvent.click(save()); await waitFor(() => assert(pendingWrite));
    choose('Beta'); await open(); await loadBindings(); choose('Alpha'); await open();
    const readCount = requests.filter(request => workflowRead(request, alpha.agentId)).length;
    await act(async () => {}); assert.equal(requests.filter(request => workflowRead(request, alpha.agentId)).length, readCount);
    assert(screen.getByTestId('agent-workflow-management-dialog').textContent?.includes(label('loading')),
      'Returning to an Agent with a sent write waits for its acknowledgement before reading a new management snapshot.');
    intercept = undefined; assert(pendingWrite); await release(pendingWrite);
    await loadBindings(); assert.equal(checked(required()), false);
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes[1].agentId, alpha.agentId); assert.equal(writes[1].expectedRevision, 5); assert.equal(writes[1].expectedWorkflowRevision, 3); cases += 1;

    let cancelledRead: HeldResponse | undefined;
    mount((request, reply) => {
      if (!workflowRead(request, alpha.agentId)) return;
      cancelledRead = retain(reply()); return cancelledRead.promise;
    });
    await open(); await waitFor(() => assert(cancelledRead));
    const closeWhileReading = within(screen.getByTestId('agent-workflow-management-dialog')).getByRole('button', { name: label('close') }) as HTMLButtonElement;
    assert.equal(closeWhileReading.disabled, false, 'A pending metadata read must remain cancellable.');
    fireEvent.click(closeWhileReading); await waitFor(() => assert.equal(Boolean(screen.queryByTestId('agent-workflow-management-dialog')), false));
    assert(document.activeElement === screen.getByTestId('agent-settings-workflow-management-open'), 'Close restores focus to the persistent management trigger.');
    intercept = undefined; assert(cancelledRead); await release(cancelledRead);
    assert.equal(Boolean(screen.queryByTestId('agent-workflow-management-dialog')), false); assert.equal(writes.length, 0);
    alpha = { ...alpha, revision: 5, workflowRevision: 3 };
    const reopened = management(alpha); assert(reopened.configuration); reopened.configuration.packages[0].declarations[0].capabilities[0].required = false;
    snapshots.set(alpha.agentId, reopened); await open(); await loadBindings(); assert.equal(checked(required()), false); cases += 1;

    let actorRead: HeldResponse | undefined;
    const actorPanel = mount((request, reply) => {
      if (!workflowRead(request, alpha.agentId) || actorRead) return;
      actorRead = retain(reply()); return actorRead.promise;
    });
    await open(); await waitFor(() => assert(actorRead)); intercept = undefined;
    alpha = { ...alpha, revision: 5, workflowRevision: 3 };
    const secondActorSnapshot = management(alpha); assert(secondActorSnapshot.configuration);
    secondActorSnapshot.configuration.packages[0].declarations[0].capabilities[0].required = false;
    snapshots.set(alpha.agentId, secondActorSnapshot);
    actorPanel.rerender(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><AgentSettingsPanel currentUserId="second-actor" /></NextIntlClientProvider>);
    await waitFor(() => assert.equal(Boolean(screen.queryByTestId('agent-workflow-management-dialog')), false));
    await open(); await loadBindings(); assert.equal(checked(required()), false);
    assert(actorRead); await release(actorRead); assert.equal(checked(required()), false);
    assert.equal(writes.length, 0); assert(requests.every(request => !request.url.searchParams.has('actorId')),
      'The UI actor identity fences delivery but is never a caller-controlled API authority filter.'); cases += 1;

    mount((request, reply) => workflowRead(request, alpha.agentId)
      ? ok({ ...snapshots.get(alpha.agentId), agentId: beta.agentId }) : reply());
    await open(); await screen.findByText(label('errors.conflict'));
    assert(save().disabled); assert.equal(Boolean(screen.queryByTestId('workflow-management-packages')), false); assert.equal(writes.length, 0);
    intercept = undefined; fireEvent.click(screen.getByTestId('workflow-management-reload'));
    await section('packages'); assert.equal(Boolean(screen.queryByTestId('workflow-management-error')), false); cases += 1;

    await staleListCase();
    assert.equal(transportErrors.length, 0);
    console.log(`PASS agent workflow management UI: ${cases} controlled-HTTP cases (no backend/SDK authority claim).`);
  } finally {
    for (const pending of held) pending.release(); cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
