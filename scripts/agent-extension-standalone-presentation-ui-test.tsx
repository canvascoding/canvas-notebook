import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { agentExtensionOptionsRequestSchema } from '../app/lib/agents/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS, type AgentExtensionConfigurationInput, type AgentStandaloneConfigurationInput } from '../app/lib/capabilities/extensions/contracts';
import { agentExtensionStandalonePresentationKey, type AgentExtensionStandaloneSummary } from '../app/lib/agents/extension-presentation-contracts';

// Actual shared editor and avatar, with controlled safe HTTP metadata. Server
// source/ACL evidence is covered separately by the real SQL fixture, not here.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://saved-editor.fixture.invalid/settings', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const context = { actorId: 'saved-user', workspaceId: 'saved-workspace' };
const target = { kind: 'existing' as const, agentId: 'saved-agent', expectedRevision: 3, expectedWorkflowRevision: 2 };
const ownSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'personal' as const,
  connectionRef: 'mcp-personal:11111111-1111-4111-8111-111111111111' } };
const sharedSelection = { kind: 'mcp' as const, source: 'mcp' as const, target: { kind: 'shared' as const,
  connectionRef: 'canvas-connection:22222222-2222-4222-8222-222222222222', bindingRevision: 3 } };
const composioSelection = { kind: 'composio' as const, source: 'composio' as const, toolkit: 'canva',
  target: { kind: 'personal' as const, profileId: 'saved-profile-b', accountBinding: 'account' as const,
    accountId: 'saved-account-b', connectionRef: 'composio-personal:saved-profile-b:saved-account-b' } };
const own: AgentStandaloneConfigurationInput = { mode: 'fixed', configurationId: 'own-mcp', entry: {
  selection: ownSelection, requirement: 'optional', toolCap: null } };
const shared: AgentStandaloneConfigurationInput = { mode: 'selectable', configurationId: 'shared-mcp', source: 'mcp', requirement: 'optional',
  allowedChoices: [{ choiceId: 'organization-b', selection: sharedSelection, toolCap: [] }] };
const composio: AgentStandaloneConfigurationInput = { mode: 'fixed', configurationId: 'canva-profile-b', entry: {
  selection: composioSelection, requirement: 'optional', toolCap: null, retainedBindingRef: `agent-extension-retain:v1:${'a'.repeat(64)}` } };
const summaries: AgentExtensionStandaloneSummary[] = [
  { configurationId: 'own-mcp', selection: ownSelection, label: 'Saved Knowledge MCP', scopeLabel: 'personal',
    icon: { url: `/api/plugins/mcp-icons/${encodeURIComponent(ownSelection.target.connectionRef)}?binding=${'a'.repeat(64)}`, sourceKey: 'saved-own-exact' } },
  { configurationId: 'shared-mcp', choiceId: 'organization-b', selection: sharedSelection, label: 'Organization B MCP', scopeLabel: 'organization',
    icon: { url: 'https://safe.fixture.invalid/shared.svg', sourceKey: 'saved-shared-revision-3' } },
  { configurationId: 'canva-profile-b', selection: composioSelection, label: 'Canva', scopeLabel: 'personal', profileLabel: 'Design Profile B',
    icon: { url: 'https://safe.fixture.invalid/canva.svg', sourceKey: 'saved-canva' } },
];
async function main() {
  const { render, screen, within, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { AgentExtensionEditor } = await import('../app/components/agents/AgentExtensionEditor');
  const { AgentExtensionStandaloneEditor } = await import('../app/components/agents/AgentExtensionStandaloneEditor');
  const savedFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = agentExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(request.operation);
    assert(['search', 'preview'].includes(request.operation), 'Saved summaries never open a connection/account chooser.');
    const head = { schemaVersion: 1, target: request.target, contextKey: JSON.stringify(request.target), coverage: [], limits: EXTENSION_SELECTION_LIMITS };
    if (request.operation === 'search') return Response.json({ success: true, data: { ...head, operation: 'search', items: [], selectedItem: null,
      scopes: { choices: ['all', 'user'], teams: [] }, pagination: { loadedItems: 0, nextCursor: null, hasNextPage: false } } });
    return Response.json({ success: true, data: { ...head, operation: 'preview', preview: { configurationReadiness: 'valid', contextValidation: 'complete',
      personalSetupRequired: false, runtimeReadiness: 'not_checked', providerHealth: 'unknown', finalSaveValidationRequired: true, issues: [], requirements: [],
      effectiveToolCaps: [], toolConflicts: [], budget: { usedBytes: 10, maxBytes: 8192, detailStatus: 'complete', omittedDetails: 0 }, contextPreview: 'Fixture preview.' } } });
  };
  const wrap = (node: React.ReactNode, locale = 'en') => <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{}}>{node}</NextIntlClientProvider>;
  const row = (slot: AgentStandaloneConfigurationInput, metadata = summaries) => <AgentExtensionStandaloneEditor slot={slot} context={context} target={target}
    summaries={metadata} onChange={() => assert.fail('Rendering metadata must not alter a selection.')} onRemove={() => {}} />;
  let cases = 0;
  try {
    const configuration: AgentExtensionConfigurationInput = { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null,
      standalone: [own, shared, composio] };
    const view = render(wrap(<AgentExtensionEditor context={context} target={target} value={{ intent: 'keep', configuration }}
      standaloneSummaries={summaries} onChange={() => assert.fail('Inspection is not a configuration mutation.')} />));
    await waitFor(() => assert(requests.includes('preview')));
    let headers = screen.getAllByTestId('agent-extension-standalone').map(element => element.querySelector('summary')!);
    assert(headers[0].textContent?.includes('Saved Knowledge MCP'));
    assert(headers[1].textContent?.includes('Organization B MCP'));
    assert(headers[2].textContent?.includes('Canva'));
    assert(headers[2].textContent?.includes('Saved personal account'));
    assert(headers[2].textContent?.includes('Profile: Design Profile B'));
    assert(!headers[2].textContent?.includes('saved-account-b'), 'No synthetic account name is inferred from an opaque account ID.');
    assert.equal(within(headers[0]).getByTestId('plugin-extension-avatar').dataset.sourceKey, 'saved-own-exact');
    assert.equal(within(headers[2]).getByTestId('plugin-extension-avatar-image').getAttribute('src'), summaries[2].icon!.url); cases++;
    fireEvent.error(within(headers[2]).getByTestId('plugin-extension-avatar-image'));
    assert.equal(within(headers[2]).getByTestId('plugin-extension-avatar-initials').textContent, 'CA'); cases++;
    // Real keyed editor recreation on actor/workspace change does not reuse old metadata.
    view.rerender(wrap(<AgentExtensionEditor context={{ actorId: 'other-user', workspaceId: 'other-workspace' }} target={target}
      value={{ intent: 'keep', configuration }} standaloneSummaries={[]} onChange={() => {}} />));
    headers = screen.getAllByTestId('agent-extension-standalone').map(element => element.querySelector('summary')!);
    assert(!headers[0].textContent?.includes('Saved Knowledge MCP'));
    assert(!headers[2].textContent?.includes('Design Profile B'));
    assert.equal(within(headers[0]).queryByTestId('plugin-extension-avatar-image'), null); cases++;

    cleanup(); render(wrap(row(shared, [{ ...summaries[1], selection: { ...sharedSelection, target: { ...sharedSelection.target, bindingRevision: 2 } } }])));
    assert(!screen.getByTestId('agent-extension-standalone').querySelector('summary')!.textContent?.includes('Organization B MCP'));
    assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null);
    assert.notEqual(agentExtensionStandalonePresentationKey(sharedSelection), agentExtensionStandalonePresentationKey({ ...sharedSelection, target: { ...sharedSelection.target, bindingRevision: 2 } })); cases++;
    cleanup(); render(wrap(row(shared, [{ ...summaries[1], choiceId: 'foreign-choice' }, { ...summaries[1], configurationId: 'foreign-slot' }])));
    assert(!screen.getByTestId('agent-extension-standalone').textContent?.includes('Organization B MCP'));
    assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null); cases++;
    cleanup(); render(wrap(row(composio, [{ ...summaries[2], selection: { ...composioSelection, target: { ...composioSelection.target,
      profileId: 'foreign-profile', connectionRef: 'composio-personal:foreign-profile:saved-account-b' } } }])));
    assert(!screen.getByTestId('agent-extension-standalone').textContent?.includes('Design Profile B'));
    assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null); cases++;
    cleanup(); render(wrap(row(composio), 'de'));
    assert(screen.getByTestId('agent-extension-standalone').querySelector('summary')!.textContent?.includes('Gespeichertes persönliches Konto'));
    assert(screen.getByTestId('agent-extension-standalone').querySelector('summary')!.textContent?.includes('Profil: Design Profile B')); cases++;
    console.log(`PASS ${cases} saved standalone presentation React cases: full editor reload props, exact slot/choice/revision/profile fences, image failure and DE/EN. Controlled HTTP, no backend/browser claim.`);
  } finally { cleanup(); globalThis.fetch = savedFetch; dom.window.localStorage.clear(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
