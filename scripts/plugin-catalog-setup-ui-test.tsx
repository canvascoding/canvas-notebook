import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { IntegrationConnectionDescriptor, SharedIntegrationConnectionOwnership } from '../app/lib/integration-tools/connections/contracts';

let observeNavigation: (() => void) | undefined;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) observeNavigation?.(); else throw error; });
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://canvas.test/en/plugins?view=advanced&scope=organization', pretendToBeVisual: true, virtualConsole,
});
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLFormElement', 'HTMLBodyElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

/** Real setup components and navigation guard; controlled metadata HTTP is UI evidence only. */
async function main() {
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown};
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? {Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; })}
    : originalLoad(name, parent, isMain);
  const {render, screen, fireEvent, waitFor, cleanup} = await import('@testing-library/react');
  const actor = 'actor-a', canManageMcp = true; let noAuth = false, mcpRequiresAuth = false, failProfiles = false, failScopes = false, partialCoverage = false;
  const receipts: Array<{path: string; method: string; body: Record<string, unknown> | null}> = [];
  const session = () => ({user: {id: actor, name: actor, email: `${actor}@fixture.invalid`, emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false},
    session: {id: `session-${actor}`, token: 'CONTROLLED_UI_SESSION', userId: actor, expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0)}});
  const item = () => ({id: 'composio:canva', kind: 'integration' as const, name: 'canva', displayName: 'Canva', description: '', source: 'composio' as const, stock: 'installed' as const,
    access: {canRead: true, canUse: true, canManage: true}, toolkit: {slug: 'canva', noAuth}, connections: noAuth ? [] : ['one', 'two'].map((id, index) => ({connectionRef: `composio-personal:profile-${index}:${id}`,
      displayName: `Account ${id}`, ownership: {type: 'user' as const, ownerUserId: actor, organizationId: null}, access: {canRead: true, canUse: true, canManage: true}, authorization: 'authorized' as const,
      health: 'unknown' as const, enabled: true, profileId: `profile-${index}`, accountId: id}))});
  const mcpItem = {id: 'mcp-personal:actual-mcp', kind: 'mcp' as const, name: 'Fixture MCP', displayName: 'Fixture MCP', description: '', source: 'mcp' as const, stock: 'installed' as const,
    access: {canRead: true, canUse: true, canManage: true}, mcp: {serverId: 'actual-mcp', transport: 'http' as const, template: false},
    connections: [{connectionRef: 'mcp-personal:actual-mcp', displayName: 'Fixture MCP', ownership: {type: 'user' as const, ownerUserId: actor, organizationId: null}, access: {canRead: true, canUse: true, canManage: true}, authorization: 'unknown' as const, health: 'unknown' as const, enabled: true}]};
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test'), path = decodeURIComponent(url.pathname), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (path === '/api/auth/get-session') return Response.json(session());
    receipts.push({path, method, body});
    if (path === '/api/plugins/search') return Response.json({success: true, data: {selectedItem: url.searchParams.get('selected') === mcpItem.id ? mcpItem : item(), items: [], coverage: [{source: url.searchParams.get('selected') === mcpItem.id ? 'mcp' : 'composio', status: partialCoverage ? 'partial' : 'complete'}], pagination: {hasNextPage: false}}});
    if (path === '/api/composio/profiles' && failProfiles) return Response.json({success: false, code: 'PROFILE_UNAVAILABLE', error: 'PRIVATE_PROVIDER_ERROR'}, {status: 503});
    if (path === '/api/composio/profiles') return Response.json({success: true, profiles: [0, 1].map(index => ({id: `profile-${index}`, name: `Profile ${index}`, status: 'active'})), effectiveProfile: {id: 'profile-0', name: 'Profile 0', workspaceId: 'fixture-workspace'}, workspace: {id: 'fixture-workspace'}});
    if (path === '/api/composio/workspace-profile') return Response.json({success: true});
    if (path === '/api/integrations/shared-connections/setup' && failScopes) return Response.json({success: false, code: 'SETUP_UNAVAILABLE'}, {status: 503});
    if (path === '/api/integrations/shared-connections/setup') return Response.json({success: true, data: {scopes: []}});
    if (path === '/api/integrations/mcp-status') return Response.json({success: true, data: {oauth: [{serverName: 'Fixture MCP', configured: true, requiresAuth: mcpRequiresAuth}]}});
    if (path === '/api/integrations/mcp-definitions') return Response.json({success: true, data: {canManageDefinitions: canManageMcp, definitions: []}});
    if (path === '/api/integrations/mcp-config') {
      if (method === 'GET') return Response.json({success: true, data: {rawContent: '{}'}});
      const config = JSON.parse(String(body?.rawContent)); const name = Object.keys(config.mcpServers)[0]; config.mcpServers[name].connectionId = 'actual-created-id';
      return Response.json({success: true, data: {rawContent: JSON.stringify(config)}});
    }
    throw new Error(`Unexpected UI setup HTTP ${method} ${path}`);
  };
  const {authClient} = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, oldSession = atom.get();
  const seed = () => atom.set({...atom.get(), data: session(), error: null, isPending: false, isRefetching: false});
  const {hasPluginNavigationBlockers} = await import('../app/components/plugins/plugin-navigation-guard');
  const {PluginIntegrationDetail} = await import('../app/components/plugins/PluginIntegrationDetail');
  const {PluginMcpSetup} = await import('../app/components/plugins/PluginMcpSetup');
  const {SharedConnectionCreateForm} = await import('../app/components/plugins/SharedConnectionForms');
  const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{child}</NextIntlClientProvider>;
  try {
    seed();
    render(wrap(<PluginIntegrationDetail item={item()} workspaceId="fixture-workspace" returnPath="/en/plugins?view=browse&scope=all&extensionId=composio:canva&q=canva" onUpdated={() => undefined} onClose={() => undefined} />));
    await screen.findByTestId('plugin-integration-connect');
    const account = screen.getByLabelText(en.skills.workspace.setup.account) as HTMLSelectElement;
    assert.equal(account.value, '', 'multiple owned accounts require an explicit selection');
    fireEvent.change(account, {target: {value: 'composio-personal:profile-1:two'}});
    assert.equal((screen.getByLabelText(en.skills.workspace.setup.profile) as HTMLSelectElement).value, 'profile-1', 'explicit account inspection selects its actual owned profile');
    fireEvent.click(screen.getByRole('button', {name: en.skills.workspace.setup.useConnection}));
    await waitFor(() => assert(receipts.some(value => value.path === '/api/composio/workspace-profile' && value.body?.profileId === 'profile-1' && value.body?.workspaceId === 'fixture-workspace')));
    assert(!receipts.some(value => value.path.includes('/connect/')), 'profile selection does not create or fake an account authorization');
    await screen.findByTestId('plugin-integration-connect');
    failProfiles = true; failScopes = true; fireEvent.click(screen.getByTestId('plugin-integration-reload'));
    await screen.findByText(en.skills.workspace.setup.profilesUnavailable); await screen.findByText(en.skills.workspace.setup.sharedSetupUnavailable);
    assert.equal(screen.queryByTestId('plugin-integration-connect'), null, 'a failed profile refresh clears old profiles and fails closed for Connect');
    assert.equal(screen.queryByText(en.skills.workspace.setup.notConfigured), null, 'a metadata outage is not reported as missing platform configuration');
    assert(!document.body.textContent?.includes('PRIVATE_PROVIDER_ERROR'));
    failProfiles = false; failScopes = false; partialCoverage = true; fireEvent.click(screen.getByTestId('plugin-integration-reload'));
    await screen.findByTestId('plugin-integration-connect'); await screen.findByText(en.skills.workspace.setup.partialCoverage);
    assert(screen.getByLabelText(en.skills.workspace.setup.account), 'partial catalog coverage preserves current valid selected accounts');
    partialCoverage = false;
    cleanup(); noAuth = true; seed();
    render(wrap(<PluginIntegrationDetail item={item()} workspaceId="fixture-workspace" returnPath="/en/plugins?view=browse&extensionId=composio:canva" onUpdated={() => undefined} onClose={() => undefined} />));
    await waitFor(() => assert(screen.queryByText(en.skills.workspace.setup.noAuth)));
    assert.equal(screen.queryByTestId('plugin-integration-connect'), null, 'no-auth toolkit never starts OAuth');
    cleanup(); seed();
    render(wrap(<PluginIntegrationDetail item={mcpItem} workspaceId="fixture-workspace" returnPath="/en/plugins?view=browse&extensionId=mcp-personal:actual-mcp" onUpdated={() => undefined} onClose={() => undefined} />));
    await screen.findByTestId('plugin-mcp-check');
    assert.equal(screen.queryByTestId('plugin-mcp-authorize'), null, 'unknown bearer/env authorization does not manufacture OAuth support');
    cleanup(); mcpRequiresAuth = true; seed();
    render(wrap(<PluginIntegrationDetail item={mcpItem} workspaceId="fixture-workspace" returnPath="/en/plugins?view=browse&extensionId=mcp-personal:actual-mcp" onUpdated={() => undefined} onClose={() => undefined} />));
    await screen.findByTestId('plugin-mcp-authorize');
    cleanup(); seed();
    let created = 0;
    render(wrap(<PluginMcpSetup workspaceId="fixture-workspace" returnPath="/en/plugins?view=browse&setup=mcp" onClose={() => undefined} onCreated={result => { created++; assert.equal(result.id, 'mcp-personal:actual-created-id'); assert.equal(hasPluginNavigationBlockers(), false, 'save completion navigates only after pending and dirty guards are clear'); }} />));
    fireEvent.click(await screen.findByTestId('plugin-mcp-add-personal'));
    fireEvent.change(document.getElementById('mcp-server-name')!, {target: {value: ' Selected MCP '}});
    fireEvent.change(document.getElementById('mcp-url')!, {target: {value: 'https://fixture.example/mcp'}});
    fireEvent.click(screen.getByRole('button', {name: en.settings.mcpConfig.saveServer}));
    await waitFor(() => assert.equal(created, 1));
    assert.equal(hasPluginNavigationBlockers(), false); cleanup();
    const ownership: SharedIntegrationConnectionOwnership = {type: 'organization', organizationId: 'fixture-org'};
    let sharedCreated = 0;
    const descriptor: IntegrationConnectionDescriptor = {resource: {connectionRef: 'canvas-connection:11111111-1111-4111-8111-111111111111', source: 'composio', ownership, displayName: 'Canva', description: null, application: 'canva', responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
      metadataRevision: 1, grantsRevision: 1, bindingRevision: 1, allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1}, access: {canRead: true, canUse: false, canManage: true}};
    render(wrap(<SharedConnectionCreateForm scopes={[{ownership, label: 'Org'}]} initialSource="composio" initialToolkit="canva" initialName="Canva" compact lockSource onSaved={() => undefined} onCreated={() => { sharedCreated++; assert.equal(hasPluginNavigationBlockers(), false); }}
      api={async <T,>(path: string) => path.includes('/shared-profiles') ? {profiles: [{id: 'shared-profile', name: 'Exact shared profile', providerMode: 'managed'}]} as T : {connection: descriptor} as T} />));
    await screen.findByText('Exact shared profile');
    assert.equal(hasPluginNavigationBlockers(), false, 'prefilled catalog source/name and sole authorized scope/profile are the untouched baseline');
    assert.equal(document.getElementById('shared-source'), null, 'catalog MCP/Composio source is fixed');
    assert.equal(document.getElementById('shared-app'), null, 'canonical catalog slug is a summary rather than an editable field');
    fireEvent.click(screen.getByRole('button', {name: en.sharedConnections.create})); await waitFor(() => assert.equal(sharedCreated, 1));
    assert.equal(hasPluginNavigationBlockers(), false);
    console.log('Plugin catalog setup UI PASS: explicit account/profile, no-auth and MCP auth predicates, actual MCP save identity, clean completion guards and compact canonical shared setup.');
  } finally { cleanup(); atom.set(oldSession); globalThis.fetch = originalFetch; loader._load = originalLoad; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
