import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { buildAgentExtensionSetupLinks } from '../app/components/agents/agent-extension-setup-links';
import { AgentExtensionConnectionChooser } from '../app/components/agents/AgentExtensionConnectionChooser';
import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest, type AgentExtensionSetupAlternative } from '../app/lib/agents/extension-options-contracts';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';

// Real chooser + request schema; only metadata HTTP DTOs are controlled. Link
// generation and explicit refresh are client evidence, not server authority.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://setup-links.fixture.invalid/settings', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const definitionId = '10000000-0000-4000-8000-000000000001';
const alternatives: AgentExtensionSetupAlternative[] = [
  { source: 'composio', toolkit: 'canva', label: 'Canva', alternativeKey: 'composio:canva' },
  { source: 'composio', toolkit: 'github', label: 'GitHub', alternativeKey: 'composio:github' },
  { source: 'mcp', connector: 'knowledge', definitionId, label: 'Approved knowledge', alternativeKey: 'mcp:knowledge' },
  { source: 'mcp', connector: 'design-server', label: 'design-server', alternativeKey: 'mcp:design-server' },
];
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }

async function main() {
  let cases = 0;
  const links = buildAgentExtensionSetupLinks({ alternatives, workspaceId: 'workspace-a', locale: 'de' });
  assert.equal(links.length, 4);
  assert.deepEqual(links.map(link => { const url = new URL(link.href, dom.window.location.origin); return [url.pathname, url.searchParams.get('extensionId'), url.searchParams.get('setup')]; }), [
    ['/de/plugins', 'composio:canva', null], ['/de/plugins', 'composio:github', null], ['/de/plugins', `mcp-definition:${definitionId}`, null], ['/de/plugins', null, 'mcp'],
  ]);
  for (const link of links) {
    const url = new URL(link.href, dom.window.location.origin); assert.equal(url.searchParams.get('workspaceId'), 'workspace-a');
    assert([...url.searchParams.keys()].every(key => ['view', 'workspaceId', 'extensionId', 'setup'].includes(key)));
    assert(!/resourceRef|publishedRevision|profileId|accountId|providerRef|receipt|accountSelectionRef/u.test(link.href));
  }
  assert.equal(links[3].connector, 'design-server'); cases++;
  assert.equal(buildAgentExtensionSetupLinks({ alternatives: [...alternatives, alternatives[0]], workspaceId: null, locale: 'fr' }).length, 4);
  assert(buildAgentExtensionSetupLinks({ alternatives, workspaceId: null, locale: '../../evil' }).every(link => link.href.startsWith('/en/plugins?')));
  assert.deepEqual(buildAgentExtensionSetupLinks({ alternatives: [{ source: 'composio', toolkit: 'canva&profileId=secret', label: 'bad' },
    { source: 'mcp', definitionId: '../private-profile', label: 'bad' }], workspaceId: null, locale: 'en' }), []); cases++;
  for (const malformed of [null, {}, 'canva', [null, {}, { source: 'composio', toolkit: 'canva' }, { source: 'mcp', label: 17 },
    { source: 'mcp', label: 'MCP', connector: {} }, { source: 'composio', label: 'x'.repeat(161), toolkit: 'canva' }]]) {
    assert.deepEqual(buildAgentExtensionSetupLinks({ alternatives: malformed, workspaceId: null, locale: 'en' }), []);
  } cases++;

  const { render, screen, within, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const context = { actorId: 'setup-user', workspaceId: 'workspace-a', organizationId: 'fixture-org' };
  const target = { kind: 'prospective' as const, scopeType: 'user' as const };
  const pin = { resourceRef: 'canvas-resource:10000000-0000-4000-8000-000000000002',
    publishedRevisionRef: 'canvas-package-revision:10000000-0000-4000-8000-000000000003', checksum: 'a'.repeat(64) };
  const selector = { kind: 'package' as const, package: pin, declarationPath: '.canvas-plugin/plugin.json', capabilityId: 'design', alternativeKey: 'composio:canva' };
  const requests: Array<{ request: AgentExtensionOptionsRequest; workspaceId: string | null }> = [];
  let setup: AgentExtensionSetupAlternative[] | undefined = [alternatives[0]], selected = 0;
  const originalFetch = globalThis.fetch;
  let override: ((workspaceId: string | null) => Response | Promise<Response> | undefined) | undefined;
  const body = (request: AgentExtensionOptionsRequest, values = setup) => ({ success: true, data: {
    schemaVersion: 1, target: request.target, selector: 'selector' in request ? request.selector : null, operation: 'connection_choices',
    contextKey: 'safe-fixture-context', limits: EXTENSION_SELECTION_LIMITS, coverage: [], connections: [], profiles: [], accounts: [],
    ...(values !== undefined ? { setupAlternatives: values } : {}), pagination: { nextCursor: null, hasNextPage: false, loadedItems: 0 },
  } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin); assert.equal(url.pathname, '/api/agents/extension-options'); assert.equal(init?.method, 'POST');
    const request = agentExtensionOptionsRequestSchema.parse(JSON.parse(String(init?.body))); assert(request.operation === 'connection_choices');
    assert.equal(request.profileId, undefined, 'Setup navigation does not enumerate accounts.');
    const workspaceId = url.searchParams.get('workspaceId'); requests.push({ request, workspaceId });
    return override?.(workspaceId) ?? Response.json(body(request));
  };
  const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">{child}</NextIntlClientProvider>;
  const renderChooser = (workspaceId = context.workspaceId) => wrap(<AgentExtensionConnectionChooser target={target} context={{ ...context, workspaceId }} selector={selector}
    setupHref={`/plugins?resourceRef=${pin.resourceRef}&profileId=never-copy`} onSelect={() => { selected++; }} />);
  try {
    render(renderChooser());
    const area = await screen.findByTestId('agent-extension-setup-links');
    const link = within(area).getByRole<HTMLAnchorElement>('link');
    assert.equal(new URL(link.href).searchParams.get('extensionId'), 'composio:canva'); assert(!link.href.includes(pin.resourceRef));
    assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
    const firstRequest = requests[0].request; assert(firstRequest.operation === 'connection_choices' && firstRequest.selector.kind === 'package');
    assert.deepEqual(firstRequest.selector.package, pin, 'The held package remains the chooser source instead of the latest catalogue head.');
    assert.equal(selected, 0); const count = requests.length;
    await act(async () => window.dispatchEvent(new Event('focus'))); assert.equal(requests.length, count, 'Returning focus cannot silently select or probe an account.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh after setup' }));
    await waitFor(() => assert.equal(requests.length, count + 1));
    assert(requests.every(row => row.request.operation === 'connection_choices' && row.request.selector.kind === 'package' && row.request.selector.package.publishedRevisionRef === pin.publishedRevisionRef));
    assert.equal(selected, 0); cases++;

    cleanup(); setup = alternatives;
    const slotTarget = { kind: 'user_choice' as const, agentId: 'shared-agent', capabilityKey: `agent-capability:${'a'.repeat(43)}`, expectedWorkflowRevision: 2, expectedPreferenceRevision: 0 };
    render(wrap(<AgentExtensionConnectionChooser target={slotTarget} context={context} selector={{ kind: 'slot' }} onSelect={() => { selected++; }} />));
    const slotLinks = within(await screen.findByTestId('agent-extension-setup-links')).getAllByRole<HTMLAnchorElement>('link');
    assert.equal(slotLinks.length, 4); assert.deepEqual(slotLinks.map(link => new URL(link.href).searchParams.get('extensionId') ?? new URL(link.href).searchParams.get('setup')),
      ['composio:canva', 'composio:github', `mcp-definition:${definitionId}`, 'mcp']);
    assert(screen.getByText('MCP · design-server')); assert.equal(selected, 0); cases++;

    cleanup(); setup = undefined; render(renderChooser());
    await screen.findByText('No matching connection found.'); assert.equal(screen.queryByTestId('agent-extension-setup-links'), null, 'An old/missing DTO cannot activate the generic package-head setup fallback.'); cases++;

    cleanup(); setup = [alternatives[0]]; const delayed = deferred<Response>();
    override = workspaceId => workspaceId === 'workspace-a' ? delayed.promise : undefined;
    const changing = render(renderChooser()); await waitFor(() => assert(requests.at(-1)?.workspaceId === 'workspace-a'));
    setup = [alternatives[1]]; changing.rerender(renderChooser('workspace-b'));
    const fresh = within(await screen.findByTestId('agent-extension-setup-links')).getByRole<HTMLAnchorElement>('link');
    assert.equal(new URL(fresh.href).searchParams.get('workspaceId'), 'workspace-b'); assert.equal(new URL(fresh.href).searchParams.get('extensionId'), 'composio:github');
    await act(async () => { delayed.resolve(Response.json(body(requests[0].request, [alternatives[0]]))); });
    assert.equal(screen.queryByText('Canva'), null); assert(screen.getByText('GitHub')); cases++;

    cleanup(); override = () => Response.json({ success: false, code: 'AGENT_ACCESS_DENIED', error: 'Denied' }, { status: 403 });
    render(renderChooser()); await screen.findByText('Denied'); assert.equal(screen.queryByTestId('agent-extension-setup-links'), null); cases++;
    console.log(`PASS ${cases} exact setup link/real chooser cases: explicit alternatives, approved definition/connector, scoped URL allowlist, held pin, no profile/receipt leak, explicit refresh and late/denied context fences.`);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
