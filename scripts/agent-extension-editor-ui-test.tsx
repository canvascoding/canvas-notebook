import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { build } from 'esbuild';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest,
  type AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import { agentExtensionConfigurationInputSchema, EXTENSION_SELECTION_LIMITS,
  type AgentExtensionConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import type { AgentExtensionEditorDraft, AgentExtensionEditorProps, AgentExtensionEditorValidation } from '../app/components/agents/AgentExtensionEditor';
import type { AgentWorkflowPackageConfiguration } from '../app/lib/agents/workflow-public-contracts';

// Real shared React editor and canonical public schemas. Only HTTP catalogue,
// profile/account and preview DTOs are controlled. This proves UI/transport
// state, not server authorization, provider readiness or browser E2E.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://editor.fixture.invalid/settings', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const pin = { resourceRef: 'canvas-resource:10000000-0000-4000-8000-000000000001',
  publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000002', checksum: 'a'.repeat(64) };
const secondPin = { ...pin, publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000003', checksum: 'b'.repeat(64) };
const packageMetadata: AgentExtensionPackageVersion = { pin, kind: 'plugin', name: 'fixture-plugin', displayName: 'Fixture plugin', description: 'Published fixture package', version: '1.0.0',
  icon: { url: 'https://logos.fixture.invalid/plugin.svg', sourceKey: 'fixture-published-icon' },
  children: [{ name: 'root-skill', title: 'Root skill', relativeRoot: '', description: 'Root SKILL.md', origin: 'plugin_child', required: true },
    { name: 'optional-skill', title: 'Optional skill', relativeRoot: 'skills/optional', description: 'Optional child', origin: 'plugin_child', required: false }],
  declarations: [{ declarationPath: '.canvas-plugin/plugin.json', workflow: { version: 1, integrationCapabilities: [
    { id: 'canva', application: 'canva', required: true, alternatives: [{ source: 'composio', toolkit: 'canva' }] }] } },
  { declarationPath: 'agents/canvas.yaml', workflow: { version: 1, integrationCapabilities: [] } }] };
const mcpSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'personal' as const, connectionRef: 'mcp-personal:10000000-0000-4000-8000-000000000004' } };
const accountSelection = { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva', target: { kind: 'personal' as const,
  profileId: 'profile-b', accountBinding: 'account' as const, accountId: 'account-b', connectionRef: 'composio-personal:profile-b:account-b' } };
const receipt = `cmp_personal_account_${'x'.repeat(48)}`;
const context = { actorId: 'editor-user', workspaceId: 'workspace-a', organizationId: 'organization-a', projectId: 'project-a' };
const prospective = { kind: 'prospective' as const, scopeType: 'user' as const };
const existing = { kind: 'existing' as const, agentId: 'real-existing-agent', expectedRevision: 2, expectedWorkflowRevision: 1 };
const base = (): AgentExtensionConfigurationInput => ({ version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: { version: 1, packages: [] }, standalone: [] });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }

async function main() {
  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { AgentExtensionEditor, clearAgentExtensionEditorDraft } = await import('../app/components/agents/AgentExtensionEditor');
  const { AgentExtensionConnectionChooser } = await import('../app/components/agents/AgentExtensionConnectionChooser');
  const { AgentExtensionCapabilityEditor } = await import('../app/components/agents/AgentExtensionCapabilityEditor');
  const { agentExtensionEditorContextKey } = await import('../app/components/agents/agent-extension-options-client');
  const { addExtensionPackage, readAgentExtensionDraft, saveAgentExtensionDraft, sanitizeAgentExtensionDraft } = await import('../app/components/agents/agent-extension-editor-draft');
  const requests: Array<{ request: AgentExtensionOptionsRequest; url: URL }> = [];
  let latest: AgentExtensionEditorDraft = { intent: 'replace', configuration: base() }, validation: AgentExtensionEditorValidation | undefined;
  const currentValidation = (): AgentExtensionEditorValidation | undefined => validation;
  let cases = 0;
  const originalFetch = globalThis.fetch;
  const header = (request: AgentExtensionOptionsRequest, workspace: string | null) => ({ schemaVersion: 1 as const, target: request.target,
    contextKey: `fixture:${workspace}:${JSON.stringify(request.target)}`, coverage: [{ source: 'packages' as const, status: 'complete' as const }], limits: EXTENSION_SELECTION_LIMITS });
  const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 1 };
  const searchRows = [
    { item: { id: pin.resourceRef, kind: 'plugin' as const, name: 'fixture-plugin', displayName: 'Fixture plugin', description: 'Bundle', source: 'local' as const, stock: 'installed' as const,
      access: { canRead: true, canUse: true, canManage: true }, icon: packageMetadata.icon }, eligibility: { action: 'select' as const },
      selection: { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'all' as const } }, publishedVersions: [{ pin, version: '1.0.0', publishedAt: 1 }, { pin: secondPin, version: '2.0.0', publishedAt: 2 }] },
    { item: { id: 'fixture-skill', kind: 'skill' as const, name: 'single-skill', displayName: 'Single skill', description: 'Single', source: 'local' as const, stock: 'installed' as const, access: { canRead: true, canUse: true, canManage: true } }, eligibility: { action: 'select' as const },
      selection: { kind: 'skill' as const, package: pin, origin: 'plugin_child' as const, relativeRoot: '' }, publishedVersions: [{ pin, version: '1.0.0', publishedAt: 1 }] },
    { item: { id: 'composio:canva', kind: 'integration' as const, name: 'canva', displayName: 'Canva', description: 'Design', toolkit: { slug: 'canva', noAuth: false }, connections: [], source: 'composio' as const, stock: 'installed' as const,
      access: { canRead: true, canUse: true, canManage: true }, icon: { url: 'https://logos.fixture.invalid/canva.svg', sourceKey: 'composio-canva' } }, eligibility: { action: 'choose_connection' as const } },
    { item: { id: mcpSelection.target.connectionRef, kind: 'mcp' as const, name: 'fixture-mcp', displayName: 'Fixture MCP', description: 'Direct MCP', mcp: { transport: 'http' as const, template: false, connectionRef: mcpSelection.target.connectionRef }, connections: [], source: 'mcp' as const, stock: 'installed' as const,
      access: { canRead: true, canUse: true, canManage: true } }, eligibility: { action: 'choose_connection' as const } },
  ];
  const defaultReply = (request: AgentExtensionOptionsRequest, workspace: string | null): unknown => {
    const head = header(request, workspace);
    if (request.operation === 'search') return { ...head, operation: request.operation, query: request,
      items: request.cursor ? [searchRows[3]] : searchRows.filter(row => request.types.includes(row.item.kind) && (!request.q || row.item.displayName.toLowerCase().includes(request.q.toLowerCase()))), selectedItem: null,
      scopes: { choices: ['all', 'user', 'team', 'organization', 'system'], teams: [{ teamId: 'team-a', label: 'Design team' }] }, pagination: { ...pagination, hasNextPage: !request.cursor, nextCursor: request.cursor ? null : 'fixturecursor' } };
    if (request.operation === 'package_version') return { ...head, operation: request.operation,
      package: { ...packageMetadata, pin: request.publishedRevisionRef === secondPin.publishedRevisionRef ? secondPin : pin, version: request.publishedRevisionRef === secondPin.publishedRevisionRef ? '2.0.0' : '1.0.0' } };
    if (request.operation === 'connection_choices') {
      const source = request.selector.kind === 'standalone' ? request.selector.source : request.selector.kind === 'package' ? request.selector.alternativeKey.startsWith('mcp:') ? 'mcp' : 'composio' : 'mcp';
      const packageBinding = request.selector.kind === 'package' ? { alternativeKey: request.selector.alternativeKey,
        target: { kind: 'personal', source: 'composio', ownerUserId: context.actorId, providerRef: 'actual-server-public-provider-reference', accountSelectionRef: receipt } } : undefined;
      return { ...head, operation: request.operation, selector: request.selector, pagination,
        connections: source === 'mcp' ? [{ id: 'actual-connection-row', selection: mcpSelection, label: 'Knowledge MCP', scopeLabel: 'personal', allowedToolNames: null, authorization: 'authorized', health: 'unknown', mappingRequired: false,
          eligibility: { action: 'select' }, ...(request.target.kind === 'user_choice' ? { choiceId: 'finite-server-choice' } : {}) }] : [],
        profiles: source === 'composio' && request.profileId === undefined ? [{ profileId: 'profile-b', label: 'Design profile B', status: 'unverified' }] : [],
        accounts: request.profileId ? [{ selection: accountSelection, accountSelectionRef: receipt, label: 'Design account B', status: 'active', selectable: true, ...(packageBinding ? { packageBinding } : {}) }] : [] };
    }
    return { ...head, operation: 'preview', preview: { configurationReadiness: 'valid', contextValidation: 'complete', personalSetupRequired: false,
      runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true, issues: [], requirements: [], effectiveToolCaps: [], toolConflicts: [],
      budget: { usedBytes: 700, maxBytes: 8192, detailStatus: 'complete', omittedDetails: 0 }, contextPreview: 'Checked fixture context. No runtime authority.' } };
  };
  let reply: (request: AgentExtensionOptionsRequest, workspace: string | null) => unknown | Promise<unknown> = defaultReply;
  let failure: { status: number; code: string; message: string } | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://editor.fixture.invalid');
    if (url.pathname === '/api/integrations/mcp-definitions') return Response.json({ success: true, data: { organizationId: context.organizationId,
      definitions: [{ id: '10000000-0000-4000-8000-000000000099', name: 'Approved knowledge server', enabled: true }] } });
    assert.equal(url.pathname, '/api/agents/extension-options'); assert.equal(init?.method, 'POST'); assert.equal(init?.cache, 'no-store');
    const request = agentExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body))); requests.push({ request, url });
    if (failure) return Response.json({ success: false, code: failure.code, error: failure.message }, { status: failure.status });
    const data = await reply(request, url.searchParams.get('workspaceId'));
    return Response.json({ success: true, data });
  };
  const wrap = (child: React.ReactNode, locale = 'en') => <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{}}>{child}</NextIntlClientProvider>;
  function Form({ start = { intent: 'replace', configuration: base() }, ...props }: Omit<AgentExtensionEditorProps, 'value' | 'onChange'> & { start?: AgentExtensionEditorDraft }) {
    const [value, setValue] = React.useState(start); latest = value;
    return <AgentExtensionEditor {...props} value={value} onChange={setValue} onValidationChange={state => { validation = state; props.onValidationChange?.(state); }} />;
  }
  const ready = () => waitFor(() => assert.equal(currentValidation()?.pending, false));
  const chooseCanva = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Canva.*Integration/u }));
    await screen.findByRole('button', { name: /Design profile B/u });
    assert.equal(requests.filter(row => row.request.operation === 'connection_choices' && row.request.profileId !== undefined).length, 0, 'Opening integration metadata must not enumerate accounts.');
    fireEvent.click(screen.getByRole('button', { name: /Design profile B/u }));
    await screen.findByText('Design account B'); fireEvent.click(screen.getByRole('button', { name: 'This account' }));
  };
  try {
    render(wrap(<Form target={existing} context={context} start={{ intent: 'keep', configuration: base() }} />));
    await ready(); assert(requests.some(row => row.request.operation === 'preview' && !Object.hasOwn(row.request, 'configuration')));
    assert.equal(latest.intent, 'keep'); assert.deepEqual(latest.configuration, base()); cases++;
    fireEvent.click(screen.getByText('Advanced configuration changes', { selector: 'summary' }));
    fireEvent.click(screen.getByTestId('agent-extension-reset-inherit'));
    assert.equal(latest.intent, 'keep'); assert(screen.getByTestId<HTMLButtonElement>('agent-extension-reset-apply').disabled);
    fireEvent.click(screen.getByTestId('agent-extension-reset-confirm')); fireEvent.click(screen.getByTestId('agent-extension-reset-apply'));
    assert.deepEqual(latest, { intent: 'replace', configuration: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } }); cases++;

    cleanup(); requests.length = 0; validation = undefined;
    render(wrap(<Form target={prospective} context={context} />)); await ready();
    const list = screen.getByTestId('agent-extension-results'); assert.equal(within(list).getAllByRole('button').length, 5, 'Mixed four-kind results and one paging control render together.');
    assert.equal(within(list).getAllByTestId('plugin-extension-avatar').length, 4);
    fireEvent.click(screen.getByRole('button', { name: 'More results' }));
    await waitFor(() => assert(requests.some(row => row.request.operation === 'search' && row.request.cursor === 'fixturecursor')));
    await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'More results' }), null));
    assert.equal(within(list).getAllByTestId('plugin-extension-avatar').length, 4, 'Mixed cursor append deduplicates exact rows.'); cases++;
    fireEvent.click(screen.getByRole('button', { name: /Fixture plugin.*Plugin/u }));
    await screen.findByRole('button', { name: 'Select for agent' });
    fireEvent.change(screen.getByLabelText('Published version'), { target: { value: secondPin.publishedRevisionRef } });
    await waitFor(() => assert(requests.some(row => row.request.operation === 'package_version' && row.request.checksum === secondPin.checksum)));
    await waitFor(() => assert.equal(screen.queryByText('Checking package version…'), null));
    fireEvent.click(screen.getByRole('button', { name: 'Select for agent' }));
    await screen.findByTestId('agent-extension-package'); assert.equal(latest.intent, 'replace'); assert(latest.configuration?.mode === 'fixed');
    fireEvent.click(screen.getByTestId('agent-extension-package').querySelector('summary')!);
    assert.deepEqual(latest.configuration.workflow?.packages[0].publishedRevisionRef, secondPin.publishedRevisionRef);
    const rootCheckbox = screen.getByRole<HTMLInputElement>('checkbox', { name: /Root skill.*Required/u }); assert(rootCheckbox.disabled); assert(rootCheckbox.checked);
    const optional = screen.getByRole<HTMLInputElement>('checkbox', { name: /Optional skill/u }); fireEvent.click(optional);
    assert(latest.configuration?.mode === 'fixed'); assert.deepEqual(latest.configuration.selections[0].selection, { kind: 'plugin', package: secondPin, skillSelection: { kind: 'subset', relativeRoots: [''] } });
    assert(agentExtensionConfigurationInputSchema.safeParse(latest.configuration).success); cases++;

    fireEvent.click(screen.getByRole('button', { name: /canva.*Required connection/u }));
    fireEvent.change(screen.getByLabelText('Binding for canva'), { target: { value: 'selectable' } });
    fireEvent.click(screen.getByText('Allow personal connections', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Personal account: canva' }));
    assert(latest.configuration?.mode === 'fixed');
    const personalPolicy = latest.configuration.workflow?.packages[0].declarations[0].capabilities[0].selection;
    assert(personalPolicy?.mode === 'selectable'); assert.deepEqual(personalPolicy.personalPolicy, { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: null });
    assert(agentExtensionConfigurationInputSchema.safeParse(latest.configuration).success); cases++;
    fireEvent.click(screen.getByRole('button', { name: 'Add allowed connection' }));
    fireEvent.click(await screen.findByRole('button', { name: /Design profile B/u }));
    await screen.findByText('Design account B'); fireEvent.click(screen.getByRole('button', { name: 'This account' }));
    assert(latest.configuration?.mode === 'fixed'); const packageChoice = latest.configuration.workflow?.packages[0].declarations[0].capabilities[0].selection;
    assert(packageChoice?.mode === 'selectable'); assert.deepEqual(packageChoice.allowedChoices[0].target, { kind: 'personal', source: 'composio', ownerUserId: context.actorId,
      providerRef: 'actual-server-public-provider-reference', accountSelectionRef: receipt });
    assert.deepEqual(packageChoice.personalPolicy, personalPolicy.personalPolicy); assert(agentExtensionConfigurationInputSchema.safeParse(latest.configuration).success); cases++;

    cleanup(); dom.window.localStorage.clear(); requests.length = 0; validation = undefined;
    render(wrap(<Form target={prospective} context={context} />)); await ready();
    fireEvent.click(screen.getByRole('button', { name: /Fixture MCP.*MCP server/u }));
    await screen.findByText('Knowledge MCP'); fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    assert(latest.configuration?.mode === 'fixed'); assert.equal(latest.configuration.workflow?.packages.length, 0); assert.deepEqual(latest.configuration.standalone[0], { mode: 'fixed', entry: { selection: mcpSelection, requirement: 'optional', toolCap: null } });
    assert.equal(requests.some(row => row.request.operation === 'connection_choices' && row.request.profileId !== undefined), false); cases++;
    fireEvent.click(screen.getByTestId('agent-extension-standalone').querySelector('summary')!);
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'selectable' } });
    assert(latest.configuration?.mode === 'fixed'); const converted = latest.configuration.standalone[0]; assert(converted.mode === 'selectable'); assert.equal(converted.allowedChoices.length, 1);
    fireEvent.click(screen.getByTestId('agent-extension-standalone').querySelector('summary')!);
    fireEvent.click(screen.getByText('Allow personal connections', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load approved definitions' })); await screen.findByLabelText('Approved knowledge server');
    fireEvent.click(screen.getByLabelText('Approved knowledge server'));
    assert(latest.configuration?.mode === 'fixed'); const policySlot = latest.configuration.standalone[0]; assert(policySlot.mode === 'selectable');
    assert.deepEqual(policySlot.personalPolicy, { source: 'mcp', serverDefinitionIds: ['10000000-0000-4000-8000-000000000099'], toolCap: null });
    assert(agentExtensionConfigurationInputSchema.safeParse(latest.configuration).success); cases++;

    cleanup(); dom.window.localStorage.clear(); requests.length = 0; validation = undefined;
    render(wrap(<Form target={prospective} context={context} />)); await ready(); await chooseCanva();
    assert(latest.configuration?.mode === 'fixed'); const accountSlot = latest.configuration.standalone[0]; assert(accountSlot.mode === 'fixed');
    assert.deepEqual(accountSlot.entry.selection, accountSelection); assert.equal(accountSlot.entry.accountSelectionRef, receipt);
    await waitFor(() => assert(dom.window.localStorage.length > 0));
    const stored = [...Array(dom.window.localStorage.length)].map((_, index) => dom.window.localStorage.getItem(dom.window.localStorage.key(index)!)).join('');
    assert(!stored.includes(receipt)); assert(!stored.includes('accountSelectionRef'));
    const draftKey = agentExtensionEditorContextKey(context, prospective), resumed = readAgentExtensionDraft(draftKey); assert(resumed?.requiresAccountReselection); cases++;
    cleanup(); requests.length = 0; validation = undefined;
    render(wrap(<Form target={prospective} context={context} />)); await screen.findByRole('button', { name: 'Resume draft' });
    fireEvent.click(screen.getByRole('button', { name: 'Resume draft' })); await ready(); assert.equal(currentValidation()?.blocked, true);
    assert.equal(requests.filter(row => row.request.operation === 'preview' && row.request.configuration?.mode === 'fixed' && row.request.configuration.standalone.length > 0).length, 0, 'A restored account without a receipt cannot become a validated mutation.');
    fireEvent.click(screen.getByTestId('agent-extension-standalone').querySelector('summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Change connection' }));
    fireEvent.click(await screen.findByRole('button', { name: /Design profile B/u })); await screen.findByText('Design account B'); fireEvent.click(screen.getByRole('button', { name: 'This account' }));
    await ready(); assert.equal(currentValidation()?.blocked, false); assert(latest.configuration?.mode === 'fixed'); const refreshed = latest.configuration.standalone[0]; assert(refreshed.mode === 'fixed'); assert.equal(refreshed.entry.accountSelectionRef, receipt);
    clearAgentExtensionEditorDraft(context, prospective); assert.equal(readAgentExtensionDraft(draftKey), null); cases++;

    cleanup(); dom.window.localStorage.clear(); requests.length = 0; validation = undefined;
    const retainedAccount: AgentExtensionConfigurationInput = { ...base() as Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>, standalone: [{ mode: 'fixed', configurationId: 'actual-existing-slot',
      entry: { selection: accountSelection, requirement: 'required', toolCap: ['read'], retainedBindingRef: `agent-extension-retain:v1:${'c'.repeat(64)}` } }] };
    render(wrap(<Form target={existing} context={context} start={{ intent: 'keep', configuration: retainedAccount }} />)); await ready();
    fireEvent.click(screen.getByTestId('agent-extension-standalone').querySelector('summary')!);
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'selectable' } }); await ready();
    assert(currentValidation()?.blocked); assert(latest.configuration?.mode === 'fixed'); const moved = latest.configuration.standalone[0]; assert(moved.mode === 'selectable');
    assert.equal(moved.configurationId, 'actual-existing-slot'); assert.equal(moved.allowedChoices[0].retainedBindingRef, undefined); assert.deepEqual(moved.allowedChoices[0].toolCap, ['read']);
    fireEvent.click(screen.getByRole('button', { name: 'Change connection' })); fireEvent.click(await screen.findByRole('button', { name: /Design profile B/u }));
    await screen.findByText('Design account B'); fireEvent.click(screen.getByRole('button', { name: 'This account' })); await ready();
    assert.equal(currentValidation()?.blocked, false); assert(latest.configuration?.mode === 'fixed'); const admitted = latest.configuration.standalone[0]; assert(admitted.mode === 'selectable');
    assert.equal(admitted.allowedChoices[0].accountSelectionRef, receipt); assert.deepEqual(admitted.allowedChoices[0].toolCap, ['read']); cases++;

    cleanup(); requests.length = 0;
    let chosenId: string | undefined;
    render(wrap(<AgentExtensionConnectionChooser target={{ kind: 'user_choice', agentId: existing.agentId, capabilityKey: `agent-extension:${'a'.repeat(43)}`, expectedWorkflowRevision: 1, expectedPreferenceRevision: 0 }}
      context={context} selector={{ kind: 'slot' }} onSelect={choice => { chosenId = choice.choiceId; }} />));
    await screen.findByText('Knowledge MCP'); fireEvent.click(screen.getByRole('button', { name: 'Choose' })); assert.equal(chosenId, 'finite-server-choice'); cases++;

    cleanup(); requests.length = 0;
    const sharedSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
      connectionRef: 'canvas-connection:10000000-0000-4000-8000-000000000005', bindingRevision: 3 } };
    const packageSelector = { kind: 'package' as const, package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'knowledge', alternativeKey: 'mcp:knowledge' };
    let chosenBinding: unknown;
    reply = (request, workspace) => request.operation === 'connection_choices' ? { ...header(request, workspace), operation: request.operation, selector: request.selector, pagination,
      connections: [{ id: 'real-shared-row', selection: sharedSelection, label: 'Organization knowledge', scopeLabel: 'organization', allowedToolNames: ['read'], eligibility: { action: 'select' },
        authorization: 'unknown', health: 'unknown', mappingRequired: true, packageBinding: { alternativeKey: 'mcp:knowledge', target: { ...sharedSelection.target, source: 'mcp' } } }], profiles: [], accounts: [] } : defaultReply(request, workspace);
    render(wrap(<AgentExtensionConnectionChooser target={existing} context={context} selector={packageSelector} onSelect={choice => { chosenBinding = choice.packageBinding; }} />));
    await screen.findByText('Organization knowledge'); assert(screen.getByRole<HTMLButtonElement>('button', { name: 'Choose' }).disabled);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm that this MCP connection matches the requested connector.' })); fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    assert.deepEqual(chosenBinding, { alternativeKey: 'mcp:knowledge', target: { ...sharedSelection.target, source: 'mcp', mcpMapping: { kind: 'manager_confirmation' } } }); cases++;

    cleanup(); requests.length = 0; reply = defaultReply; failure = { status: 409, code: 'AGENT_WORKFLOW_CHANGED', message: 'Saved source changed.' };
    render(wrap(<AgentExtensionConnectionChooser target={existing} context={context} selector={{ kind: 'standalone', source: 'mcp' }} onSelect={() => { throw new Error('Unavailable selection must not be submitted.'); }} />));
    await screen.findByText('Saved source changed.'); assert(screen.getByText(/Permissions or the saved version changed/u)); cases++;
    cleanup(); failure = { status: 503, code: 'COMPOSIO_NOT_CONFIGURED', message: 'Composio is not configured.' };
    render(wrap(<AgentExtensionConnectionChooser target={existing} context={context} selector={{ kind: 'standalone', source: 'composio', toolkit: 'canva' }} onSelect={() => {}} />));
    await screen.findByRole('link', { name: 'Open Secrets in settings' }); assert.equal(screen.getByRole('link', { name: 'Open Secrets in settings' }).getAttribute('href'), '/settings?tab=secrets'); cases++;
    failure = null;

    cleanup(); requests.length = 0; reply = defaultReply;
    type Capability = AgentWorkflowPackageConfiguration['declarations'][number]['capabilities'][number];
    const originalTarget = { kind: 'personal' as const, source: 'composio' as const, ownerUserId: context.actorId,
      providerRef: 'actual-server-public-provider-reference', accountSelectionRef: receipt };
    let lastCapability: Capability | undefined;
    function CapabilityForm() {
      const [capability, setCapability] = React.useState<Capability>({ capabilityId: 'canva', required: true,
        selection: { mode: 'fixed', alternativeKey: 'composio:canva', target: originalTarget, toolCap: ['old_cap'] } });
      lastCapability = capability;
      return <AgentExtensionCapabilityEditor pin={pin} definition={packageMetadata.declarations[0].workflow.integrationCapabilities[0]} declarationPath=".canvas-plugin/plugin.json"
        target={prospective} context={context} value={capability} onChange={next => { if (next) setCapability(next); }} />;
    }
    render(wrap(<CapabilityForm />)); fireEvent.click(screen.getByRole('button', { name: /canva.*Required connection/u }));
    fireEvent.change(screen.getByLabelText('Binding for canva'), { target: { value: 'selectable' } });
    fireEvent.click(screen.getByText(/Tool limit/u, { selector: 'summary' })); fireEvent.click(screen.getByRole('checkbox', { name: 'Limit to these tools' }));
    assert(lastCapability?.selection.mode === 'selectable'); assert.equal(lastCapability.selection.allowedChoices[0].toolCap, null);
    fireEvent.click(screen.getByRole('button', { name: 'Change connection' })); fireEvent.click(await screen.findByRole('button', { name: /Design profile B/u }));
    await screen.findByText('Design account B'); fireEvent.click(screen.getByRole('button', { name: 'This account' }));
    assert(lastCapability?.selection.mode === 'selectable'); assert.equal(lastCapability.selection.allowedChoices[0].toolCap, null,
      'An explicit inherited cap on an existing choice must not revive the old fixed cap.'); cases++;

    cleanup(); requests.length = 0;
    let multiChanges = 0;
    const multiple: Capability = { capabilityId: 'canva', required: true, selection: { mode: 'selectable', allowedChoices: [
      { choiceId: 'account-a', alternativeKey: 'composio:canva', target: originalTarget, toolCap: null },
      { choiceId: 'account-b', alternativeKey: 'composio:canva', target: { ...originalTarget, providerRef: 'actual-server-public-provider-b' }, toolCap: null }] } };
    render(wrap(<AgentExtensionCapabilityEditor pin={pin} definition={packageMetadata.declarations[0].workflow.integrationCapabilities[0]} declarationPath=".canvas-plugin/plugin.json"
      target={prospective} context={context} value={multiple} onChange={() => { multiChanges++; }} />));
    fireEvent.click(screen.getByRole('button', { name: /canva.*Required connection/u })); fireEvent.change(screen.getByLabelText('Binding for canva'), { target: { value: 'fixed' } });
    await screen.findByRole('button', { name: /Design profile B/u }); assert.equal(multiChanges, 0, 'Multiple choices without a default require an explicit new selection; the first account is never silently fixed.'); cases++;

    cleanup(); requests.length = 0; validation = undefined;
    render(wrap(<Form target={existing} context={context} start={{ intent: 'keep', configuration: null }} />)); await ready(); assert.equal(currentValidation()?.blocked, true); assert.equal(requests.some(row => row.request.operation === 'preview'), false); assert.equal(screen.queryByPlaceholderText('Search plugins, skills, integrations and MCP…'), null); cases++;
    fireEvent.click(screen.getByText('Advanced configuration changes', { selector: 'summary' })); fireEvent.click(screen.getByTestId('agent-extension-reset-fixed'));
    assert.deepEqual(latest, { intent: 'keep', configuration: null });
    fireEvent.click(screen.getByTestId('agent-extension-reset-confirm')); fireEvent.click(screen.getByTestId('agent-extension-reset-apply')); await ready();
    assert.deepEqual(latest, { intent: 'replace', configuration: base() }); assert.equal(currentValidation()?.blocked, false); cases++;

    cleanup(); dom.window.localStorage.clear(); requests.length = 0; validation = undefined;
    const held = deferred<unknown>();
    reply = (request, workspace) => request.operation === 'preview' && !Object.hasOwn(request, 'enabledTools') ? held.promise : defaultReply(request, workspace);
    const fixedValue = { intent: 'replace' as const, configuration: base() }, states: AgentExtensionEditorValidation[] = [];
    const view = render(wrap(<AgentExtensionEditor target={prospective} context={context} value={fixedValue} onChange={() => {}} onValidationChange={state => states.push(state)} />));
    await waitFor(() => assert(requests.some(row => row.request.operation === 'preview')));
    view.rerender(wrap(<AgentExtensionEditor target={prospective} context={context} value={fixedValue} enabledTools={['__none__']} onChange={() => {}} onValidationChange={state => states.push(state)} />));
    await waitFor(() => assert(states.at(-1)?.pending === false)); const count = states.length;
    await act(async () => held.resolve(defaultReply({ operation: 'preview', target: prospective, configuration: base() }, context.workspaceId)));
    assert.equal(states.length, count, 'A resolved stale preview cannot publish validation for changed native tools.'); cases++;

    cleanup(); requests.length = 0; reply = defaultReply;
    const delayed = deferred<unknown>();
    reply = (request, workspace) => request.operation === 'search' && workspace === 'workspace-a' ? delayed.promise : defaultReply(request, workspace);
    const swapped = render(wrap(<Form target={prospective} context={context} />)); await waitFor(() => assert(requests.some(row => row.request.operation === 'search')));
    swapped.rerender(wrap(<Form target={prospective} context={{ ...context, workspaceId: 'workspace-b', actorId: 'other-user' }} />));
    await screen.findByRole('button', { name: /Canva.*Integration/u });
    const oldRequest = requests.find(row => row.url.searchParams.get('workspaceId') === 'workspace-a' && row.request.operation === 'search')!.request;
    await act(async () => delayed.resolve({ ...defaultReply(oldRequest, 'workspace-a') as object, items: [{ ...searchRows[0], item: { ...searchRows[0].item, displayName: 'Old forbidden row' } }] }));
    assert.equal(screen.queryByText('Old forbidden row'), null); cases++;

    cleanup(); requests.length = 0; reply = defaultReply; validation = undefined;
    render(wrap(<Form target={prospective} context={context} />, 'de')); await screen.findByLabelText('Plugins, Skills, Integrationen und MCP suchen');
    await ready(); assert(screen.getByText('Dauerhaft für diesen Agenten')); cases++;

    cleanup(); requests.length = 0; validation = undefined;
    const readSuggestedDraft = (): AgentExtensionEditorDraft => latest;
    const existingStandalone = { mode: 'fixed' as const, entry: { selection: mcpSelection, requirement: 'required' as const, toolCap: null } };
    const existingConfiguration = base(); assert(existingConfiguration.mode === 'fixed'); existingConfiguration.standalone = [existingStandalone];
    render(wrap(<Form target={existing} context={context} start={{ intent: 'keep', configuration: existingConfiguration }} suggestedPackage={pin} />));
    await ready(); assert.equal(readSuggestedDraft().intent, 'keep', 'The suggestion does not automatically change the existing configuration.');
    fireEvent.click(screen.getByTestId('agent-package-suggestion-add'));
    await waitFor(() => { const changed = readSuggestedDraft(); assert.equal(changed.intent, 'replace'); assert(changed.configuration?.mode === 'fixed' && changed.configuration.selections.length === 1); });
    const added = readSuggestedDraft().configuration; assert(added?.mode === 'fixed'); assert.deepEqual(added.standalone, [existingStandalone]);
    assert.deepEqual(added.workflow?.packages[0].publishedRevisionRef, pin.publishedRevisionRef);
    assert(requests.some(row => row.request.operation === 'package_version' && row.request.publishedRevisionRef === pin.publishedRevisionRef));
    await ready(); assert.equal((screen.getByTestId('agent-package-suggestion-add') as HTMLButtonElement).disabled, true); cases++;

    cleanup(); requests.length = 0; validation = undefined;
    const originalFixed = base(); assert(originalFixed.mode === 'fixed');
    const oldPinned = addExtensionPackage(originalFixed, { ...packageMetadata, pin: secondPin });
    render(wrap(<Form target={existing} context={context} start={{ intent: 'keep', configuration: oldPinned }} suggestedPackage={pin} />));
    await ready(); fireEvent.click(screen.getByTestId('agent-package-suggestion-add'));
    await screen.findByRole('alert'); assert.equal(readSuggestedDraft().intent, 'keep');
    assert.deepEqual(readSuggestedDraft().configuration, oldPinned, 'A suggestion cannot silently replace an existing pin for the same resource.'); cases++;

    const full = addExtensionPackage(base() as Extract<AgentExtensionConfigurationInput, { mode: 'fixed' }>, packageMetadata);
    assert(agentExtensionConfigurationInputSchema.safeParse(full).success);
    const withReceipt: AgentExtensionEditorDraft = { intent: 'replace', configuration: { ...full, standalone: [{ mode: 'fixed', entry: { selection: accountSelection, requirement: 'required', toolCap: ['read'], accountSelectionRef: receipt } }] } };
    const sanitized = sanitizeAgentExtensionDraft(withReceipt); assert(sanitized.requiresAccountReselection); assert.equal(JSON.stringify(sanitized).includes(receipt), false); assert.equal(withReceipt.configuration?.mode === 'fixed' && withReceipt.configuration.standalone[0].mode === 'fixed' && withReceipt.configuration.standalone[0].entry.accountSelectionRef, receipt);
    saveAgentExtensionDraft('display-test', withReceipt); assert(readAgentExtensionDraft('display-test')?.requiresAccountReselection); cases++;

    const bundled = await build({ entryPoints: ['app/components/agents/AgentExtensionEditor.tsx', 'app/components/agents/AgentExtensionConnectionChooser.tsx'],
      bundle: true, platform: 'browser', format: 'esm', write: false, outdir: '/private/tmp/agent-editor-browser-contract', logLevel: 'silent', tsconfig: 'tsconfig.json' });
    assert.equal(bundled.errors.length, 0); cases++;
    console.log(`Agent extension shared editor: PASS (${cases} meaningful React/DTO/browser-bundle cases; no browser/server/provider E2E).`);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.localStorage.clear(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
