import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AgentProfileItem } from '../app/components/settings/AgentSelectorCard';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentExtensionManagementSnapshot } from '../app/components/agents/agent-workflow-management-client';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest, type AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import { agentExtensionConfigurationInputSchema, EXTENSION_SELECTION_LIMITS, type AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';

// Actual SettingsPanel / PackageAgentSetup -> management dialog -> shared editor,
// public parsers and mutation client. Only safe HTTP DTOs, auth session delivery
// and unrelated Settings cards are controlled. This is no server/SDK/E2E proof.
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
type Fixed = Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>;
type Profile = AgentProfileItem & AgentProfile & { workflowVersion: 1 | 2 | null; workflowRevision: number };
type RequestRecord = { url: URL; method: string; body: Record<string, unknown> | null; option?: AgentExtensionOptionsRequest };
type HeldResponse = { release(): void; promise: Promise<Response> };
function reissueRetained(value: AgentExtensionConfigurationInput | null, revision: number): void {
  if (value?.mode !== 'fixed') return;
  for (const pkg of value.workflow?.packages ?? []) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
    for (const choice of choices) if (choice.target.kind === 'retained') choice.target = retainedFor(revision);
  }
}
function configuration(): Fixed {
  return { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [{
    selection: { kind: 'skill', origin: 'plugin_child', package: { resourceRef: resource, publishedRevisionRef: oldPin, checksum }, relativeRoot: 'skills/creative' },
    requirement: 'optional', toolCap: null,
  }], standalone: [], workflow: { version: 1, packages: [{ resourceRef: resource, publishedRevisionRef: oldPin, checksum,
    skillSelection: { kind: 'skills', relativeRoots: ['skills/creative'] }, declarations: [{ declarationPath, capabilities: [
      { capabilityId: 'design', required: true, selection: { mode: 'selectable', defaultChoiceId: 'studio', allowedChoices: [
        { choiceId: 'studio', alternativeKey: 'composio:canva', target: { kind: 'shared', source: 'composio', connectionRef: firstConnection, bindingRevision: 2 }, toolCap: null },
        { choiceId: 'personal-original', alternativeKey: 'composio:canva', target: retained, toolCap: ['CANVA_LIST_DESIGNS'] },
      ], personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['CANVA_LIST_DESIGNS'] } } },
      { capabilityId: 'library', required: true, selection: { mode: 'fixed', alternativeKey: 'composio:canva',
        target: { kind: 'shared', source: 'composio', connectionRef: secondConnection, bindingRevision: 3 }, toolCap: ['CANVA_LIST_DESIGNS'] } },
    ] }] }] } };
}
function profile(agentId: string, name: string, access = { canUse: true, canEdit: true, canManage: false }): Profile {
  return { id: agentId === 'fixture-alpha' ? 1 : 2, createdAt: '2026-10-14T12:00:00.000Z', updatedAt: '2026-10-14T12:00:00.000Z', agentId, name, iconId: 'bot', type: 'special', removable: true, defaultProviderInstallationId: null,
    defaultProvider: null, defaultModel: null, defaultThinking: null, enabledTools: ['read', 'email_list_mailboxes'],
    relevantSkills: null, relevantConnections: null, scopeType: 'user', organizationId: 'fixture-org',
    ownerUserId: 'fixture-user', createdByUserId: 'fixture-user', revision: 4, workflowVersion: 2, workflowRevision: 2, access };
}
function management(current: Profile): AgentExtensionManagementSnapshot {
  assert(current.access);
  const configured = configuration(); reissueRetained(configured, current.revision);
  if (current.agentId === 'fixture-beta') {
    const capability = configured.workflow!.packages[0].declarations[0].capabilities[0]; capability.required = false;
    capability.selection = { mode: 'fixed', alternativeKey: 'composio:canva',
      target: { kind: 'shared', source: 'composio', connectionRef: secondConnection, bindingRevision: 3 }, toolCap: ['CANVA_LIST_DESIGNS'] };
  }
  return { agent: current, access: current.access, extensions: { agentId: current.agentId, revision: current.revision,
    workflowRevision: current.workflowRevision, configurationState: 'available', configuration: configured, readiness: [] } };
}
function userProjection(current: Profile): AgentWorkflowDescriptor {
  assert(current.access);
  return { agentId: current.agentId, revision: current.revision, workflowVersion: current.workflowVersion,
    workflowRevision: current.workflowRevision, preferenceRevision: 7, access: current.access, packages: [], standalone: [] };
}
function version(pin: string): AgentExtensionPackageVersion {
  const old = pin === oldPin;
  return { pin: { resourceRef: resource, publishedRevisionRef: pin, checksum: old ? checksum : 'c'.repeat(64) }, kind: 'plugin',
    name: 'creative-package', displayName: 'Creative package', description: 'Published creative package', version: old ? '1.0.0' : '2.0.0',
    children: (old ? ['creative', 'sibling'] : ['replacement']).map(name => ({ name, relativeRoot: `skills/${name}`, description: `${name} child`, origin: 'plugin_child', required: false })),
    declarations: [{ declarationPath: old ? declarationPath : 'skills/replacement/agents/canvas.yaml', workflow: {
      version: 1, integrationCapabilities: ['design', 'library'].map(id => ({ id, application: id === 'library' ? 'library' : 'canva', required: id === 'library',
        alternatives: [{ source: 'composio' as const, toolkit: 'canva', requiredTools: ['CANVA_LIST_DESIGNS'] }] })),
    } }] };
}

async function main(): Promise<void> {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const independentViews = new Set(['MemoryReviewAgentCard', 'AgentRuntimePreferenceCard', 'AgentCatalogModelOverrideEditor',
    'AgentManagedFilesCard', 'AgentSessionsCard', 'AgentDoctorCard']);
  const searchParams = new URLSearchParams('tab=agent-settings&workspaceId=fixture-workspace&organizationId=fixture-org&projectId=fixture-project');
  const session = { user: { id: 'fixture-user' }, session: { id: 'fixture-session' } };
  loader._load = (name, parent, isMain) => {
    if (name.endsWith('/auth-client')) return { authClient: { useSession: () => ({ data: session, isPending: false, error: null }), getSession: async () => ({ data: session }) } };
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
  const { PackageAgentSetup } = await import('../app/components/plugins/PackageAgentSetup');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: 'fixture-workspace' });
  let alpha = profile('fixture-alpha', 'Agent Alpha'), beta = profile('fixture-beta', 'Agent Beta');
  let snapshots = new Map<string, AgentExtensionManagementSnapshot>([[alpha.agentId, management(alpha)], [beta.agentId, management(beta)]]);
  const requests: RequestRecord[] = [], writes: Record<string, unknown>[] = [], held: HeldResponse[] = [], transportErrors: unknown[] = [];
  let intercept: ((request: RequestRecord, reply: () => Response) => Response | Promise<Response> | undefined) | undefined;
  const ok = (data: unknown) => Response.json({ success: true, data });
  const retain = (reply: Response): HeldResponse => {
    let resolve!: (value: Response) => void;
    const result = { promise: new Promise<Response>(done => { resolve = done; }), release: () => resolve(reply) }; held.push(result); return result;
  };
  const optionReply = (request: AgentExtensionOptionsRequest) => {
    const head = { schemaVersion: 1, target: request.target, contextKey: JSON.stringify(request.target), coverage: [], limits: EXTENSION_SELECTION_LIMITS };
    const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 2 };
    if (request.operation === 'search') return { ...head, operation: request.operation, items: [{ item: { id: resource, kind: 'plugin', name: 'creative-package',
      displayName: 'Creative package', description: 'Published fixture bundle', source: 'local', stock: 'installed', access: { canRead: true, canUse: true, canManage: true } },
      selection: { kind: 'plugin', package: version(oldPin).pin, skillSelection: { kind: 'all' } }, eligibility: { action: 'select' },
      publishedVersions: [oldPin, nextPin].map(pin => ({ pin: version(pin).pin, version: pin === oldPin ? '1.0.0' : '2.0.0', publishedAt: 1 })) }],
      selectedItem: null, scopes: { choices: ['all', 'user'], teams: [] }, pagination };
    if (request.operation === 'package_version') return { ...head, operation: request.operation, package: version(request.publishedRevisionRef) };
    if (request.operation === 'connection_choices') return { ...head, operation: request.operation, selector: request.selector, pagination,
      connections: [firstConnection, secondConnection].map((connectionRef, index) => ({ id: connectionRef, label: index ? 'Campaign design' : 'Studio design', scopeLabel: 'organization',
        selection: { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'shared', connectionRef, bindingRevision: index + 2 } },
        packageBinding: { alternativeKey: 'composio:canva', target: { kind: 'shared', source: 'composio', connectionRef, bindingRevision: index + 2 } },
        allowedToolNames: ['CANVA_LIST_DESIGNS'], authorization: 'authorized', health: 'unknown', mappingRequired: false, eligibility: { action: 'select' } })),
      profiles: request.profileId ? [] : [{ profileId: 'owned-profile', label: 'Design profile', status: 'unverified' }],
      accounts: request.profileId ? ['A', 'B'].map((accountId, index) => ({ selection: { kind: 'composio', source: 'composio', toolkit: 'canva',
        target: { kind: 'personal', profileId: 'owned-profile', accountBinding: 'account', accountId, connectionRef: `composio-personal:owned-profile:${accountId}` } },
        accountSelectionRef: `opaque-${accountId}`, label: index ? 'Second design account' : 'First design account', status: 'ACTIVE', selectable: true,
        packageBinding: { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio', ownerUserId: 'fixture-user', providerRef: 'opaque-own-profile', accountSelectionRef: `opaque-${accountId}` } } })) : [] };
    return { ...head, operation: 'preview', preview: { configurationReadiness: 'valid', contextValidation: 'complete', personalSetupRequired: false,
      runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true, issues: [], requirements: [], effectiveToolCaps: [], toolConflicts: [],
      budget: { usedBytes: 700, maxBytes: 8192, detailStatus: 'complete', omittedDetails: 0 }, contextPreview: 'Controlled preview DTO. No compiler authority.' } };
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const request: RequestRecord = { url, method, body }; requests.push(request);
    if (method === 'PATCH') { assert(body); writes.push(body); }
    const reply = (): Response => {
      if (['/api/agents/extension-options', '/api/agents/workflow'].includes(url.pathname) || url.pathname === '/api/agents' && (method === 'GET' || body?.extensions !== undefined)) assert.equal(url.searchParams.get('workspaceId'), 'fixture-workspace', `${method} ${url}`);
      assert(!url.searchParams.has('actorId'), 'Actor is a UI delivery fence, never a caller-controlled API authority selector.');
      if (url.pathname === '/api/agents/extension-options') {
        assert.equal(method, 'POST'); assert.equal(init?.cache, 'no-store');
        request.option = agentExtensionOptionsRequestSchema.parse(body); return ok(optionReply(request.option));
      }
      const id = url.searchParams.get('agentId') ?? String(body?.agentId ?? '');
      if (url.pathname === '/api/agents' && method === 'GET' && !id) {
        assert.equal(url.searchParams.get('purpose'), 'configure'); return ok({ agents: [alpha, beta] });
      }
      if (url.pathname === '/api/sessions') return Response.json({ success: true, sessions: [] });
      if (url.pathname === '/api/agents/files') return ok({ files: Object.fromEntries(['AGENTS.md', 'USER.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'].map(name => [name, ''])) });
      if (id === DEFAULT_AGENT_ID && url.pathname === '/api/agents/tools') return ok({ tools: [], config: { agentId: id, enabledTools: [] } });
      const current = id === alpha.agentId ? alpha : beta;
      assert.equal(id, current.agentId, `Unexpected agent-specific request: ${url}`);
      if (url.pathname === '/api/agents/tools') return ok({ tools: [
        { name: 'read', label: 'Read files', group: 'Core', planningModeAllowed: true },
        { name: 'email_list_mailboxes', label: 'List email', group: 'Email', planningModeAllowed: true },
      ], config: { agentId: id, enabledTools: current.enabledTools } });
      if (url.pathname === '/api/agents' && method === 'GET') {
        assert.equal(url.searchParams.get('purpose'), 'configure'); assert.equal(url.searchParams.get('includeFiles'), 'false'); return ok(snapshots.get(id));
      }
      if (url.pathname === '/api/agents' && method === 'PATCH') {
        assert(body); assert.equal(body.expectedRevision, current.revision);
        const extensionWrite = Object.hasOwn(body, 'extensions');
        assert(!Object.hasOwn(body, 'workflow'), 'The new editor writes the complete extension contract, never a lossy legacy reconstruction.');
        assert(!Object.hasOwn(body, 'expectedPreferenceRevision'));
        if (extensionWrite) { assert.equal(body.expectedWorkflowRevision, current.workflowRevision); assert(!Object.hasOwn(body, 'enabledTools')); }
        else assert(Array.isArray(body.enabledTools));
        const next: Profile = { ...current, revision: current.revision + 1, workflowRevision: current.workflowRevision + (extensionWrite ? 1 : 0),
          ...(extensionWrite ? { workflowVersion: (body.extensions as AgentExtensionConfigurationInput).mode === 'legacy_inherit' ? null : 2 as const } : {}),
          ...(Array.isArray(body.enabledTools) ? { enabledTools: [...body.enabledTools] as string[] } : {}) };
        if (id === alpha.agentId) alpha = next; else beta = next;
        const nextConfiguration = extensionWrite ? agentExtensionConfigurationInputSchema.parse(body.extensions) : snapshots.get(id)!.extensions.configuration;
        reissueRetained(nextConfiguration, next.revision);
        snapshots.set(id, { agent: next, access: next.access!, extensions: { agentId: id, revision: next.revision, workflowRevision: next.workflowRevision,
          configurationState: nextConfiguration?.mode === 'legacy_inherit' ? 'legacy' : 'available', configuration: nextConfiguration, readiness: [] } });
        return ok({ agent: next, workflow: userProjection(next) });
      }
      if (url.pathname === '/api/agents/workflow') return ok(userProjection(current));
      throw new Error(`Unexpected controlled request ${method} ${url}`);
    };
    try { return await (intercept?.(request, reply) ?? reply()); } catch (error) { transportErrors.push(error); throw error; }
  };
  const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{node}</NextIntlClientProvider>;
  const mount = (handler?: typeof intercept, setup?: () => void, packageParent = false) => {
    assert.equal(transportErrors.length, 0, `A controlled transport assertion cannot masquerade as a handled UI error: ${transportErrors.map(String).join('; ')}`);
    cleanup(); for (const pending of held.splice(0)) pending.release(); dom.window.localStorage.clear();
    alpha = profile('fixture-alpha', 'Agent Alpha'); beta = profile('fixture-beta', 'Agent Beta');
    snapshots = new Map([[alpha.agentId, management(alpha)], [beta.agentId, management(beta)]]);
    requests.length = 0; writes.length = 0; intercept = handler; setup?.();
    dom.window.localStorage.setItem('canvas-settings-agent-section-open-state', JSON.stringify({ tools: true }));
    return render(wrap(packageParent ? <PackageAgentSetup workspaceId="fixture-workspace" resourceRef={resource} packageName="Creative package" /> : <AgentSettingsPanel currentUserId="fixture-user" />));
  };
  const inspectRead = (request: RequestRecord, agentId = alpha.agentId) => request.method === 'GET' && request.url.pathname === '/api/agents'
    && request.url.searchParams.get('agentId') === agentId;
  const optionReads = (operation: string) => requests.filter(request => request.option?.operation === operation);
  const label = (path: string) => {
    let value: unknown = messages.agentWorkflowManagement;
    for (const part of path.split('.')) { assert(value && typeof value === 'object'); value = Reflect.get(value, part); }
    assert.equal(typeof value, 'string'); return value as string;
  };
  const dialog = () => screen.getByTestId('agent-workflow-management-dialog');
  const save = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: label('save') });
  const checked = (element: HTMLElement) => element instanceof dom.window.HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true';
  const choose = (name: 'Alpha' | 'Beta') => fireEvent.click(screen.getByRole('button', { name: new RegExp(`Agent ${name}`, 'u'), hidden: true }));
  const open = async () => { fireEvent.click(await screen.findByTestId('agent-settings-workflow-management-open')); return screen.findByTestId('agent-workflow-management-dialog'); };
  const loadBindings = async () => {
    const pkg = await screen.findByTestId('agent-extension-package');
    await within(pkg).findByText('Creative package');
    if (!(pkg as HTMLDetailsElement).open) fireEvent.click(pkg.querySelector('summary')!);
    for (const name of ['canva', 'library']) {
      const button = within(pkg).getByRole('button', { name: new RegExp(`^${name} · (Required|Optional) connection$`, 'u') });
      if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
    }
    return pkg;
  };
  const capability = (id: 'design' | 'library' = 'design') => {
    const element = screen.getAllByTestId('agent-extension-capability').find(node => within(node).queryAllByText(id).length > 0); assert(element); return within(element);
  };
  const required = (id: 'design' | 'library' = 'design') => capability(id).getByRole<HTMLInputElement>('checkbox', { name: 'Required' });
  const mode = () => capability().getByRole<HTMLSelectElement>('combobox', { name: 'Binding for canva' });
  const ready = () => waitFor(() => assert.equal(screen.getByTestId('agent-extension-preview-status').textContent?.includes('Checking configuration'), false));
  const dirtyDesign = async () => { await loadBindings(); fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); };
  const saved = async () => { await screen.findByText(label('saved')); await waitFor(() => assert.equal(save().disabled, true)); };
  const close = () => { const footer = dialog().querySelector<HTMLElement>('[data-slot="dialog-footer"]'); assert(footer); fireEvent.click(within(footer).getByRole('button', { name: label('close') })); };
  const release = (pending: HeldResponse) => act(async () => pending.release());
  const reload = () => fireEvent.click(within(dialog()).getByRole('button', { name: label('reload') }));
  const reloadDiscard = async () => { reload(); fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: label('confirm.discard') })); };
  const confirmReset = async (kind: 'inherit' | 'fixed') => {
    const control = screen.getByTestId(`agent-extension-reset-${kind}`), details = control.closest('details');
    if (details && !details.open) fireEvent.click(details.querySelector('summary')!);
    fireEvent.click(control); const apply = screen.getByTestId<HTMLButtonElement>('agent-extension-reset-apply');
    assert(apply.disabled); fireEvent.click(screen.getByTestId('agent-extension-reset-confirm')); assert(!apply.disabled); fireEvent.click(apply);
    await waitFor(() => assert.equal(save().disabled, false));
  };
  const submitted = (index = 0): Fixed => { const value = agentExtensionConfigurationInputSchema.parse(writes[index].extensions); assert.equal(value.mode, 'fixed'); if (value.mode !== 'fixed') throw new Error('Expected a fixed configuration'); return value; };
  const designOf = (value: Fixed) => value.workflow!.packages[0].declarations[0].capabilities.find(item => item.capabilityId === 'design')!;
  let cases = 0;
  try {
    mount(undefined, () => { alpha.access = { canUse: false, canEdit: true, canManage: false }; snapshots.set(alpha.agentId, management(alpha)); });
    await open(); await ready();
    assert.equal(Boolean(screen.queryByTestId('agent-settings-workflow')), false);
    assert.equal(optionReads('connection_choices').length, 0, 'Opening central configuration must not enumerate personal accounts.');
    assert(optionReads('package_version').every(row => row.option?.operation === 'package_version' && row.option.publishedRevisionRef === oldPin));
    assert.equal(writes.length, 0); cases++;

    mount(undefined, () => { alpha.access = { canUse: true, canEdit: false, canManage: false }; snapshots.set(alpha.agentId, management(alpha)); });
    await screen.findByTestId('agent-settings-workflow');
    assert.equal(Boolean(screen.queryByTestId('agent-settings-workflow-management-open')), false);
    assert.equal(requests.filter(row => inspectRead(row)).length, 0); cases++;

    mount(); await open(); const pkg = await loadBindings(); await ready();
    assert(checked(within(pkg).getByRole('checkbox', { name: /creative.*creative child/u })));
    assert(!checked(within(pkg).getByRole('checkbox', { name: /sibling.*sibling child/u })));
    assert.equal(mode().value, 'selectable'); assert.equal(required('library').disabled, true);
    assert(!optionReads('package_version').some(row => row.option?.operation === 'package_version' && row.option.publishedRevisionRef === nextPin));
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    const first = submitted(); assert.deepEqual(Object.keys(writes[0]).sort(), ['agentId', 'expectedRevision', 'expectedWorkflowRevision', 'extensions']);
    assert.equal(first.workflow!.packages[0].publishedRevisionRef, oldPin); assert.equal(first.workflow!.packages[0].checksum, checksum);
    assert.deepEqual(first.workflow!.packages[0].skillSelection, { kind: 'skills', relativeRoots: ['skills/creative'] });
    const selection = designOf(first).selection; assert.equal(selection.mode, 'selectable'); if (selection.mode !== 'selectable') throw new Error('Expected selectable');
    assert.deepEqual(selection.allowedChoices[1].target, retained); assert.equal(selection.defaultChoiceId, 'studio'); assert.equal(selection.allowedChoices[0].toolCap, null);
    assert(requests.filter(row => inspectRead(row)).length >= 2, 'Acknowledgement is followed by real configure inspection, not its user projection.');
    assert.deepEqual(alpha.enabledTools, ['read', 'email_list_mailboxes']); cases++;

    await loadBindings(); fireEvent.change(capability().getByRole('combobox', { name: 'Default' }), { target: { value: 'personal-original' } });
    fireEvent.click(capability().getByRole('checkbox', { name: 'Personal account: canva' }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    const second = designOf(submitted(1)).selection; assert.equal(second.mode, 'selectable'); if (second.mode !== 'selectable') throw new Error('Expected selectable');
    assert.equal(second.defaultChoiceId, 'personal-original'); assert.equal(second.personalPolicy, undefined); assert.deepEqual(second.allowedChoices[1].target, retainedFor(5));
    assert.equal(writes[1].expectedRevision, 5); assert.equal(writes[1].expectedWorkflowRevision, 3); cases++;

    mount(undefined, () => { alpha.ownerUserId = 'foreign-agent-owner'; snapshots.set(alpha.agentId, management(alpha)); });
    await open(); await loadBindings(); fireEvent.click(capability().getAllByRole('button', { name: 'Change connection' })[1]);
    await screen.findByRole('button', { name: /Design profile/u });
    assert.equal(optionReads('connection_choices').length, 1); assert(!optionReads('connection_choices')[0].body?.profileId);
    fireEvent.click(screen.getByRole('button', { name: /Design profile/u })); await screen.findByText('Second design account');
    assert.equal(optionReads('connection_choices').length, 2); assert.equal(optionReads('connection_choices')[1].body?.profileId, 'owned-profile');
    assert(save().disabled, 'Merely inspecting accounts cannot select the first one.');
    const account = screen.getByText('Second design account').closest('div.flex'); assert(account);
    fireEvent.click(within(account as HTMLElement).getByRole('button', { name: 'This account' }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    const personal = designOf(submitted()).selection; assert(personal.mode === 'selectable');
    assert.deepEqual(personal.allowedChoices[1].target, { kind: 'personal', source: 'composio', ownerUserId: 'fixture-user', providerRef: 'opaque-own-profile', accountSelectionRef: 'opaque-B' });
    assert.equal(writes.length, 1); cases++;

    const standaloneRef = 'canvas-connection:66666666-6666-4666-8666-666666666666';
    const standalone = { mode: 'fixed' as const, configurationId: 'knowledge-mcp', entry: { selection: { kind: 'mcp' as const, source: 'mcp' as const,
      target: { kind: 'shared' as const, connectionRef: standaloneRef, bindingRevision: 5 } }, requirement: 'required' as const, toolCap: ['lookup'] } };
    const savedSummary = { configurationId: standalone.configurationId, selection: standalone.entry.selection, label: 'Saved Knowledge MCP',
      scopeLabel: 'organization' as const, icon: { url: `/api/plugins/mcp-icons/${encodeURIComponent(standaloneRef)}?binding=${'a'.repeat(64)}`, sourceKey: 'exact-saved-mcp-logo' } };
    mount((request, reply) => {
      if (inspectRead(request)) snapshots.get(alpha.agentId)!.extensions.standaloneSummaries = [savedSummary];
      return reply();
    }, () => { const current = snapshots.get(alpha.agentId)!.extensions.configuration; assert(current?.mode === 'fixed'); current.standalone.push(structuredClone(standalone)); });
    await open();
    const standaloneHeader = () => screen.getByTestId('agent-extension-standalone').querySelector('summary')!;
    await waitFor(() => assert(standaloneHeader().textContent?.includes('Saved Knowledge MCP')));
    assert.equal(within(standaloneHeader()).getByTestId('plugin-extension-avatar').dataset.sourceKey, savedSummary.icon.sourceKey);
    await dirtyDesign(); fireEvent.click(save()); await saved();
    assert.deepEqual(submitted().standalone, [standalone], 'A package-only edit preserves complete V2 standalone settings and caps.');
    assert.equal(screen.getAllByTestId('agent-extension-standalone').length, 1);
    await waitFor(() => assert(standaloneHeader().textContent?.includes('Saved Knowledge MCP')));
    assert.equal(within(standaloneHeader()).getByTestId('plugin-extension-avatar').dataset.sourceKey, savedSummary.icon.sourceKey,
      'Settings -> genuine inspect DTO -> shared editor retains exact connection display metadata after save/reload.'); cases++;

    let firstConflict = true, failedReload = false, failedSave = false;
    mount((request, reply) => {
      if (request.method === 'PATCH' && firstConflict) { firstConflict = false; alpha = { ...alpha, revision: 5, workflowRevision: 3 }; snapshots.set(alpha.agentId, management(alpha)); return Response.json({ success: false, code: 'AGENT_WORKFLOW_REVISION_CONFLICT' }, { status: 409 }); }
      if (inspectRead(request) && failedReload) { failedReload = false; return Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: 503 }); }
      if (request.method === 'PATCH' && failedSave) { failedSave = false; return Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: 503 }); }
      return reply();
    });
    await open(); await dirtyDesign(); fireEvent.click(save()); await screen.findByText(label('errors.conflict')); assert(save().disabled); assert(!checked(required()));
    const beforeCancel = requests.filter(row => inspectRead(row)).length; reload();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: label('confirm.cancel') }));
    assert.equal(requests.filter(row => inspectRead(row)).length, beforeCancel); assert(!checked(required()));
    failedReload = true; await reloadDiscard(); await screen.findByText(label('errors.load')); assert(save().disabled); await loadBindings(); assert(!checked(required()));
    assert.equal(writes.length, 1); await reloadDiscard(); await loadBindings(); await dirtyDesign();
    failedSave = true; fireEvent.click(save()); await screen.findByText(label('errors.load'));
    assert(!checked(required())); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes.length, 3); assert.deepEqual(writes.slice(1).map(item => [item.expectedRevision, item.expectedWorkflowRevision]), [[5, 3], [5, 3]]); cases++;

    let failAcknowledgedRefresh = false;
    mount((request, reply) => {
      if (request.method === 'PATCH') { const acknowledgement = reply(); failAcknowledgedRefresh = true; return acknowledgement; }
      if (inspectRead(request) && failAcknowledgedRefresh) return Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: 503 });
    });
    await open(); await dirtyDesign(); fireEvent.click(save()); await screen.findByText(label('errors.load'));
    assert.equal(alpha.revision, 5); assert(save().disabled); fireEvent.click(save()); assert.equal(writes.length, 1,
      'An acknowledged write followed by failed Inspect cannot be submitted twice.');
    assert(dialog().textContent?.includes('The change was already accepted. Reload the saved configuration.'));
    intercept = undefined; reload(); await loadBindings(); await dirtyDesign(); fireEvent.click(save()); await saved();
    assert.equal(writes[1].expectedRevision, 5); assert.equal(writes[1].expectedWorkflowRevision, 3); cases++;

    mount(request => request.method === 'PATCH' ? Response.json({ success: false, code: 'AGENT_ACCESS_DENIED' }, { status: 403 }) : undefined);
    await open(); await dirtyDesign(); fireEvent.click(save()); await screen.findByText(label('errors.denied'));
    assert(required().disabled); assert(save().disabled); fireEvent.click(save()); assert.equal(writes.length, 1); cases++;

    mount(undefined, () => { const value = snapshots.get(alpha.agentId)!; value.extensions.configurationState = 'blocked'; value.extensions.configuration = null; });
    await open(); await screen.findByText('The saved selection is unavailable. Editing does not replace it with an empty selection.');
    assert(save().disabled); assert(!screen.queryByTestId('agent-extension-package')); assert.equal(writes.length, 0);
    await confirmReset('fixed'); fireEvent.click(save()); await saved(); assert.deepEqual(submitted().workflow?.packages, []); assert.equal(writes.length, 1); cases++;

    mount(); await open(); await loadBindings(); fireEvent.click(screen.getByRole('button', { name: 'Remove package from agent' }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(submitted().mode, 'fixed'); assert.deepEqual(submitted().workflow?.packages, []); assert.deepEqual(submitted().selections, []);
    assert.equal(alpha.workflowVersion, 2, 'Fixed empty must never silently become legacy inheritance.'); assert.deepEqual(alpha.enabledTools, ['read', 'email_list_mailboxes']);
    await confirmReset('inherit'); fireEvent.click(save()); await saved();
    assert.deepEqual(writes[1].extensions, { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' }); assert.equal(alpha.workflowVersion, null);
    assert.deepEqual(alpha.enabledTools, ['read', 'email_list_mailboxes']); cases++;

    mount(); await open(); await loadBindings(); fireEvent.click(screen.getByRole('button', { name: 'Remove package from agent' }));
    fireEvent.click(await screen.findByRole('button', { name: /Creative package · Plugin/u }));
    fireEvent.change(await screen.findByLabelText('Published version'), { target: { value: nextPin } });
    await waitFor(() => assert.equal(screen.queryByText('Checking package version…'), null));
    fireEvent.click(screen.getByRole('button', { name: 'Select for agent' }));
    const replacedPkg = await screen.findByTestId('agent-extension-package'); fireEvent.click(replacedPkg.querySelector('summary')!);
    await within(replacedPkg).findByText('replacement');
    fireEvent.click(within(replacedPkg).getByRole('button', { name: 'library · Required connection' }));
    fireEvent.change(screen.getByLabelText('Binding for library'), { target: { value: 'fixed' } });
    await screen.findByText('Campaign design'); const shared = screen.getByText('Campaign design').closest('div.rounded-md'); assert(shared);
    fireEvent.click(within(shared as HTMLElement).getByRole('button', { name: 'Choose' }));
    await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    const replaced = submitted(); assert.equal(replaced.workflow!.packages[0].publishedRevisionRef, nextPin); assert.equal(replaced.workflow!.packages[0].checksum, 'c'.repeat(64));
    assert(!JSON.stringify(replaced).includes(retained.retainedBindingRef)); assert(!JSON.stringify(replaced).includes('skills/creative')); cases++;

    let oldRead: HeldResponse | undefined;
    mount((request, reply) => { if (!inspectRead(request) || oldRead) return; oldRead = retain(reply()); return oldRead.promise; });
    await open(); await waitFor(() => assert(oldRead)); choose('Beta'); await open(); await loadBindings();
    assert.equal(mode().value, 'fixed'); assert(!checked(required())); intercept = undefined; assert(oldRead); await release(oldRead);
    assert.equal(mode().value, 'fixed'); fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes[0].agentId, beta.agentId); cases++;

    oldRead = undefined;
    mount((request, reply) => { if (!inspectRead(request) || oldRead) return; oldRead = retain(reply()); return oldRead.promise; });
    await open(); await waitFor(() => assert(oldRead)); choose('Beta'); await open(); await loadBindings();
    alpha = { ...alpha, revision: 5, workflowRevision: 3 }; const freshAlpha = management(alpha); assert(freshAlpha.extensions.configuration?.mode === 'fixed');
    designOf(freshAlpha.extensions.configuration).required = false; snapshots.set(alpha.agentId, freshAlpha); intercept = undefined;
    choose('Alpha'); await open(); await loadBindings(); assert(!checked(required())); assert(oldRead); await release(oldRead); assert(!checked(required()));
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved();
    assert.equal(writes[0].expectedRevision, 5); assert.equal(writes[0].expectedWorkflowRevision, 3); cases++;

    for (const errorStatus of [null, 503] as const) {
      let oldWrite: HeldResponse | undefined;
      mount((request, reply) => { if (request.method !== 'PATCH') return; oldWrite = retain(errorStatus === null ? reply() : Response.json({ success: false, code: 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE' }, { status: errorStatus })); return oldWrite.promise; });
      await open(); await dirtyDesign(); fireEvent.click(save()); await waitFor(() => assert(oldWrite));
      choose('Beta'); await open(); await loadBindings(); assert.equal(mode().value, 'fixed'); const reads = requests.filter(row => inspectRead(row)).length;
      intercept = undefined; assert(oldWrite); await release(oldWrite); assert.equal(mode().value, 'fixed'); assert(!checked(required()));
      assert.equal(requests.filter(row => inspectRead(row)).length, reads, 'A departed save cannot trigger an old-agent reload.');
      fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved(); assert.equal(writes[1].agentId, beta.agentId); cases++;
    }

    let pendingWrite: HeldResponse | undefined;
    mount((request, reply) => { if (request.method !== 'PATCH') return; pendingWrite = retain(reply()); return pendingWrite.promise; });
    await open(); await dirtyDesign(); fireEvent.click(save()); await waitFor(() => assert(pendingWrite));
    choose('Beta'); await open(); await loadBindings(); choose('Alpha'); await open(); const readCount = requests.filter(row => inspectRead(row)).length;
    await act(async () => {}); assert.equal(requests.filter(row => inspectRead(row)).length, readCount); assert(dialog().textContent?.includes(label('loading')));
    intercept = undefined; assert(pendingWrite); await release(pendingWrite); await loadBindings(); assert(!checked(required()));
    fireEvent.click(required()); await waitFor(() => assert.equal(save().disabled, false)); fireEvent.click(save()); await saved(); assert.equal(writes[1].expectedRevision, 5); cases++;

    let cancelledRead: HeldResponse | undefined;
    mount((request, reply) => { if (!inspectRead(request)) return; cancelledRead = retain(reply()); return cancelledRead.promise; });
    await open(); await waitFor(() => assert(cancelledRead)); close(); await waitFor(() => assert(!screen.queryByTestId('agent-workflow-management-dialog')));
    assert(document.activeElement === screen.getByTestId('agent-settings-workflow-management-open')); intercept = undefined; assert(cancelledRead); await release(cancelledRead);
    assert(!screen.queryByTestId('agent-workflow-management-dialog')); assert.equal(writes.length, 0); cases++;

    let actorRead: HeldResponse | undefined;
    const actorPanel = mount((request, reply) => { if (!inspectRead(request) || actorRead) return; actorRead = retain(reply()); return actorRead.promise; });
    await open(); await waitFor(() => assert(actorRead)); intercept = undefined;
    alpha = { ...alpha, revision: 5, workflowRevision: 3 }; const secondActor = management(alpha); assert(secondActor.extensions.configuration?.mode === 'fixed');
    designOf(secondActor.extensions.configuration).required = false; snapshots.set(alpha.agentId, secondActor);
    actorPanel.rerender(wrap(<AgentSettingsPanel currentUserId="second-actor" />)); await waitFor(() => assert(!screen.queryByTestId('agent-workflow-management-dialog')));
    await open(); await loadBindings(); assert(!checked(required())); assert(actorRead); await release(actorRead); assert(!checked(required())); assert.equal(writes.length, 0); cases++;

    mount((request, reply) => inspectRead(request) ? ok({ ...snapshots.get(alpha.agentId), extensions: { ...snapshots.get(alpha.agentId)!.extensions, agentId: beta.agentId } }) : reply());
    await open(); await screen.findByText(label('errors.conflict')); assert(save().disabled); assert(!screen.queryByTestId('agent-extension-package'));
    intercept = undefined; reload(); await loadBindings(); assert.equal(writes.length, 0); cases++;

    mount(); await open(); await dirtyDesign(); let staleList: HeldResponse | undefined;
    intercept = (request, reply) => { if (request.method !== 'GET' || request.url.pathname !== '/api/agents' || request.url.searchParams.has('agentId')) return; staleList = retain(reply()); return staleList.promise; };
    const selector = screen.getByText(messages.settings.agentPanel.selector.title).closest<HTMLElement>('[data-slot="card"]'); assert(selector);
    fireEvent.click(within(selector).getByRole('button', { name: messages.settings.agentPanel.selector.reload, hidden: true })); await waitFor(() => assert(staleList));
    fireEvent.click(save()); await saved(); intercept = undefined; assert(staleList); await release(staleList); close();
    await waitFor(() => assert(!screen.queryByTestId('agent-workflow-management-dialog')));
    const nativeRow = screen.getByText('read', { exact: true }).closest<HTMLElement>('[data-slot="collapsible"]'); assert(nativeRow);
    fireEvent.click(within(nativeRow).getByRole('switch', { name: 'Read files' }));
    await waitFor(() => assert(writes.some(item => Object.hasOwn(item, 'enabledTools'))));
    assert.equal(writes.find(item => Object.hasOwn(item, 'enabledTools'))?.expectedRevision, 5); cases++;

    mount(undefined, undefined, true); fireEvent.click(screen.getByTestId('package-agent-setup-expand'));
    const agentSelect = await screen.findByTestId('package-agent-setup-select'); fireEvent.change(agentSelect, { target: { value: alpha.agentId } });
    fireEvent.click(screen.getByTestId('package-agent-setup-open')); await dirtyDesign(); fireEvent.click(save()); await saved();
    assert.equal(writes.length, 1); assert.equal(writes[0].agentId, alpha.agentId); assert.equal(submitted().workflow!.packages[0].publishedRevisionRef, oldPin);
    assert.equal(requests.find(row => row.method === 'PATCH')?.url.searchParams.get('organizationId'), null,
      'Package parent forwards its real workspace context and does not invent the Settings organization/project.'); cases++;

    assert.equal(transportErrors.length, 0);
    console.log(`PASS ${cases} real shared-editor management React cases through Settings and PackageAgentSetup: exact pins/children/retention/accounts, CAS/recovery, held-response scopes, acknowledgement and native-tools revision. HTTP/auth-session metadata controlled; no backend/SDK/browser E2E claim.`);
  } finally {
    for (const pending of held) pending.release(); cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
