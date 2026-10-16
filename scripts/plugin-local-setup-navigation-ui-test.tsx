import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { CapabilityPackagePresentation, CapabilityPackageMcpTemplate } from '../app/lib/capabilities/packages/presentation-contracts';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://canvas.test/en/plugins?view=browse', pretendToBeVisual: true});
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLFormElement', 'HTMLBodyElement', 'HTMLDetailsElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment',
  'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, {value: dom.window[key as keyof Window], configurable: true});
}
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)});
Object.defineProperty(globalThis, 'PointerEvent', {value: dom.window.MouseEvent, configurable: true});
Object.defineProperty(dom.window, 'PointerEvent', {value: dom.window.MouseEvent, configurable: true});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', {value: FixtureResizeObserver, configurable: true});

async function main() {
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown};
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? {Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) {return <a {...props} ref={ref} />;})}
    : originalLoad(name, parent, isMain);
  const {render, screen, fireEvent, cleanup, waitFor, within, act} = await import('@testing-library/react');
  const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111', checksum = 'a'.repeat(64), workspaceId = 'fixture-workspace';
  const permissions = {canRead: true, canUse: true, canManage: true};
  const session = {user: {id: 'alice', name: 'Alice', email: 'alice@fixture.invalid', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false},
    session: {id: 'local-navigation-session', token: 'CONTROLLED_UI_IDENTITY_ONLY', userId: 'alice', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0)}};
  const integration: Extract<PluginExtensionItem, {kind: 'integration'}> = {id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description: '', source: 'composio', stock: 'available',
    access: permissions, toolkit: {slug: 'canva', noAuth: false}, connections: []};
  const mcp: Extract<PluginExtensionItem, {kind: 'mcp'}> = {id: 'mcp-personal:existing', kind: 'mcp', name: 'Existing MCP', displayName: 'Existing MCP', description: '', source: 'mcp', stock: 'installed',
    access: permissions, mcp: {serverId: 'existing', transport: 'http', template: false}, connections: [{connectionRef: 'mcp-personal:existing', displayName: 'Existing MCP', ownership: {type: 'user', ownerUserId: 'alice', organizationId: 'org'},
      access: permissions, authorization: 'not_required', health: 'unknown', enabled: true}]};
  const template: CapabilityPackageMcpTemplate = {resourceRef, declaredBy: {kind: 'plugin', name: 'workflow'}, source: {resourceRef, version: '1.0.0', checksum, artifactRevision: 1},
    connector: {name: 'design-mcp'}, config: {url: 'https://fixture.invalid/mcp'}, redactedFields: []};
  const presentation = (source: 'composio' | 'mcp'): CapabilityPackagePresentation => ({schemaVersion: 1, origin: 'installed', resourceRef, sourceStamp: {checksum, artifactRevision: 1},
    kind: 'plugin', name: 'workflow', version: '1.0.0', title: 'Workflow', description: '', children: [], capabilities: [], scripts: [], compatibility: [], requiredEnv: [], readOnly: false, sourceStampCurrent: true,
    requirements: [{declaredBy: {kind: 'plugin', name: 'workflow'}, source, label: 'Design service', required: true, recommended: false,
      selector: source === 'mcp' ? {source, connector: 'design-mcp'} : {source, toolkit: 'canva'}}]});
  const shared: IntegrationConnectionDescriptor = {resource: {connectionRef: 'canvas-connection:22222222-2222-4222-8222-222222222222', source: 'mcp',
    ownership: {type: 'organization', organizationId: 'org'}, displayName: 'Shared saved MCP', description: null, application: null, responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 1, grantsRevision: 1, bindingRevision: 1, allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1}, access: permissions};
  const receipts: Array<{path: string; method: string}> = [];
  let confirmResult = false, confirmations = 0, heldWrite: Promise<void> | undefined;
  window.confirm = () => {confirmations += 1; return confirmResult;};
  const body = (data: unknown) => Response.json({success: true, data});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test'), path = decodeURIComponent(url.pathname), method = init?.method || 'GET';
    if (path === '/api/auth/get-session') return Response.json(session);
    receipts.push({path, method});
    if (path === '/api/plugins/search') return body({selectedItem: url.searchParams.get('selected') === mcp.id ? mcp : integration,
      items: [], coverage: [{source: url.searchParams.get('types') === 'mcp' ? 'mcp' : 'composio', status: 'complete'}], pagination: {hasNextPage: false}});
    if (path === '/api/integrations/shared-connections/setup') return body({scopes: [{ownership: {type: 'organization', organizationId: 'org'}, label: 'Organization'},
      {ownership: {type: 'team', organizationId: 'org', workspaceId: 'team-a'}, label: 'Team A'}]});
    if (path === '/api/integrations/mcp-definitions') return body({canManageDefinitions: true, definitions: []});
    if (path === '/api/integrations/mcp-config') return body({rawContent: JSON.stringify({mcpServers: {'Existing MCP': {connectionId: 'existing', ownerUserId: 'alice', url: 'https://fixture.invalid/mcp'}}})});
    if (path === '/api/integrations/mcp-status') return body({oauth: [{serverName: 'Existing MCP', configured: false, requiresAuth: false}]});
    if (path === '/api/composio/profiles') return Response.json({success: true, profiles: [{id: 'profile', name: 'Profile', status: 'active'}], effectiveProfile: {id: 'profile', name: 'Profile'}, workspace: {id: workspaceId}});
    if (path === '/api/composio/connect/canva') {await heldWrite; return Response.json({success: true});}
    if (path === '/api/integrations/shared-connections' && method === 'POST') {await heldWrite; return body({connection: shared});}
    if (path.endsWith('/mcp-matches')) return body({matches: [], coverage: 'complete', source: template.source});
    if (path.endsWith('/mcp-template')) return body({template});
    throw new Error(`Unexpected local navigation fixture: ${method} ${path}`);
  };
  const {authClient} = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, oldSession = atom.get();
  const seed = () => atom.set({...atom.get(), data: session, error: null, isPending: false, isRefetching: false});
  const {hasPluginNavigationBlockers} = await import('../app/components/plugins/plugin-navigation-guard');
  const {PluginMcpSetup} = await import('../app/components/plugins/PluginMcpSetup');
  const {PluginIntegrationDetail} = await import('../app/components/plugins/PluginIntegrationDetail');
  const {PackageRequirementsSetup} = await import('../app/components/plugins/PackageRequirementsSetup');
  const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{child}</NextIntlClientProvider>;
  const returnPath = `/en/plugins?view=browse&resourceRef=${encodeURIComponent(resourceRef)}&task=connections&q=canva`;
  const change = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, {target: {value}});
  const back = (id: string) => within(screen.getByTestId(id).querySelector('header')!).getByRole('button', {name: en.skills.workspace.setup.back});
  const deferred = () => {let release!: () => void; return {promise: new Promise<void>(resolve => {release = resolve;}), release: () => release()};};
  try {
    seed();
    render(wrap(<PluginMcpSetup workspaceId={workspaceId} returnPath="/en/plugins?view=browse&setup=mcp" onClose={() => undefined} onCreated={() => undefined} />));
    await screen.findByLabelText(en.skills.workspace.setup.scope);
    change('plugin-mcp-scope', 'organization'); await screen.findByTestId('shared-connection-create-form');
    change('shared-name', 'Keep my shared draft'); change('shared-url', 'https://fixture.invalid/draft');
    assert(hasPluginNavigationBlockers());
    const beforeScope = confirmations; change('plugin-mcp-scope', 'user');
    assert.equal(confirmations, beforeScope + 1); assert.equal((document.getElementById('plugin-mcp-scope') as HTMLSelectElement).value, 'organization');
    assert.equal((document.getElementById('shared-name') as HTMLInputElement).value, 'Keep my shared draft');
    assert(!receipts.some(value => value.method !== 'GET'));
    confirmResult = true; change('plugin-mcp-scope', 'team:team-a');
    assert.equal(confirmations, beforeScope + 2); assert.equal((document.getElementById('shared-name') as HTMLInputElement).value, '');
    cleanup(); assert(!hasPluginNavigationBlockers()); confirmResult = false; seed();

    render(wrap(<PackageRequirementsSetup presentation={presentation('composio')} workspaceId={workspaceId} returnPath={returnPath} onUpdated={() => undefined} />));
    fireEvent.click(await screen.findByTestId('package-requirement-connect-0')); await screen.findByTestId('plugin-integration-connect');
    change('plugin-integration-profile-name', 'Keep profile draft');
    const beforeBack = confirmations; fireEvent.click(back('plugin-integration-detail'));
    assert.equal(confirmations, beforeBack + 1); assert(screen.getByTestId('plugin-integration-detail'));
    assert.equal((document.getElementById('plugin-integration-profile-name') as HTMLInputElement).value, 'Keep profile draft');
    confirmResult = true; fireEvent.click(back('plugin-integration-detail')); await screen.findByTestId('package-requirement-connect-0');
    assert.equal(confirmations, beforeBack + 2); confirmResult = false;
    fireEvent.click(screen.getByTestId('package-requirement-connect-0')); await screen.findByTestId('plugin-integration-connect');
    const integrationWrite = deferred(); heldWrite = integrationWrite.promise; const integrationCalls = receipts.filter(value => value.path === '/api/composio/connect/canva').length;
    fireEvent.click(screen.getByTestId('plugin-integration-connect'));
    await waitFor(() => assert.equal(receipts.filter(value => value.path === '/api/composio/connect/canva').length, integrationCalls + 1));
    await waitFor(() => assert(hasPluginNavigationBlockers()));
    const pendingConfirmations = confirmations; fireEvent.click(back('plugin-integration-detail'));
    assert(screen.getByTestId('plugin-integration-detail')); assert.equal(confirmations, pendingConfirmations, 'Pending Back is blocked without a discard dialog.');
    await act(async () => integrationWrite.release()); heldWrite = undefined;
    await waitFor(() => assert(!hasPluginNavigationBlockers())); fireEvent.click(back('plugin-integration-detail'));
    await screen.findByTestId('package-requirement-connect-0'); assert.equal(confirmations, pendingConfirmations);
    cleanup(); seed();

    render(wrap(<PackageRequirementsSetup presentation={presentation('mcp')} workspaceId={workspaceId} returnPath={returnPath} onUpdated={() => undefined} />));
    fireEvent.click(await screen.findByTestId('package-requirement-connect-0')); await screen.findByTestId('plugin-mcp-setup');
    await screen.findByLabelText(en.skills.workspace.setup.scope); change('plugin-mcp-scope', 'organization'); await screen.findByTestId('shared-connection-create-form');
    change('shared-name', 'Keep MCP template draft');
    const beforeTemplate = confirmations; fireEvent.click(back('plugin-mcp-setup'));
    assert.equal(confirmations, beforeTemplate + 1); assert.equal((document.getElementById('shared-name') as HTMLInputElement).value, 'Keep MCP template draft');
    const mcpWrite = deferred(); heldWrite = mcpWrite.promise; const sharedCalls = receipts.filter(value => value.method === 'POST' && value.path === '/api/integrations/shared-connections').length;
    fireEvent.click(screen.getByRole('button', {name: en.sharedConnections.create}));
    await waitFor(() => assert.equal(receipts.filter(value => value.method === 'POST' && value.path === '/api/integrations/shared-connections').length, sharedCalls + 1));
    await waitFor(() => assert((document.getElementById('plugin-mcp-scope') as HTMLSelectElement).disabled));
    const duringShared = confirmations; fireEvent.click(back('plugin-mcp-setup'));
    assert(screen.getByTestId('plugin-mcp-setup')); assert.equal(confirmations, duringShared);
    await act(async () => mcpWrite.release()); heldWrite = undefined;
    await waitFor(() => assert.equal(screen.queryByTestId('plugin-mcp-setup'), null));
    assert(!hasPluginNavigationBlockers()); assert.equal(confirmations, duringShared, 'Committed success still returns automatically with clean guards.');
    cleanup(); seed();

    render(wrap(<PluginIntegrationDetail item={mcp} workspaceId={workspaceId} returnPath="/en/plugins?view=browse&extensionId=mcp-personal:existing" onUpdated={() => undefined} onClose={() => undefined} />));
    fireEvent.click(await screen.findByTestId('plugin-mcp-edit')); await screen.findByLabelText(en.skills.workspace.setup.scope);
    change('plugin-mcp-scope', 'organization'); await screen.findByTestId('shared-connection-create-form'); change('shared-name', 'Keep nested MCP edit');
    const beforeEdit = confirmations; fireEvent.click(back('plugin-mcp-setup'));
    assert.equal(confirmations, beforeEdit + 1); assert.equal((document.getElementById('shared-name') as HTMLInputElement).value, 'Keep nested MCP edit');
    confirmResult = true; fireEvent.click(back('plugin-mcp-setup')); await screen.findByTestId('plugin-integration-detail');
    assert.equal(confirmations, beforeEdit + 2); assert(!hasPluginNavigationBlockers());
    console.log('PASS actual local setup React guards: canceled dirty scope/Back retains inputs, nested package Integration/MCP and edit Back enforce pending/dirty blockers once, and committed success returns cleanly. Controlled HTTP fixtures only.');
  } finally {cleanup(); atom.set(oldSession); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
