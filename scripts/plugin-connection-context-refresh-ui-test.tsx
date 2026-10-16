import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useMemo, useSyncExternalStore } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackagePresentation, CapabilityPackageMcpTemplate } from '../app/lib/capabilities/packages/presentation-contracts';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { PluginWorkspaceCatalogItem } from '../app/lib/plugins/plugin-workspace-catalog-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.scrollTo = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

/** Actual shell -> detail -> requirement -> setup components; only framework context and HTTP transport are controlled. */
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  const eventName = 'plugin-connection-router-fixture', originalPush = window.history.pushState.bind(window.history), originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args) => { originalPush(...args); window.dispatchEvent(new Event(eventName)); };
  window.history.replaceState = (...args) => { originalReplace(...args); window.dispatchEvent(new Event(eventName)); };
  const subscribe = (callback: () => void) => { window.addEventListener(eventName, callback); return () => window.removeEventListener(eventName, callback); };
  const workspaceId = 'fixture-workspace', resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111', checksum = 'a'.repeat(64);
  const previousRef = 'canvas-connection:22222222-2222-4222-8222-222222222222', createdMcpRef = 'canvas-connection:33333333-3333-4333-8333-333333333333';
  const createdComposioRef = 'canvas-connection:44444444-4444-4444-8444-444444444444';
  const workspace = { initialized: true, activeWorkspaceId: workspaceId, organizationId: 'fixture-org', workspaces: [{id: workspaceId, name: 'Design workspace'}] };
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return {useSearchParams: () => { const search = useSyncExternalStore(subscribe, () => window.location.search); return useMemo(() => new URLSearchParams(search), [search]); }};
    if (name === '@/app/store/workspace-store') return {useWorkspaceStore: (select: (value: typeof workspace) => unknown) => select(workspace)};
    if (name === '@/i18n/navigation') return {Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) {return <a {...props} ref={ref} />;})};
    return originalLoad(name, parent, isMain);
  };
  const {render, screen, fireEvent, cleanup, waitFor, act, within} = await import('@testing-library/react');
  const session = {user: {id: 'alice', name: 'Alice', email: 'alice@fixture.invalid', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false},
    session: {id: 'connection-context-session', token: 'CONTROLLED_UI_IDENTITY_ONLY', userId: 'alice', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0)}};
  const access = {canRead: true, canUse: true, canManage: true};
  const resource: CapabilityResourceDescriptor = {metadata: {resourceRef, legacyResourceId: 'legacy-workflow', resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null,
    ownership: {type: 'user', ownerUserId: 'alice', organizationId: 'fixture-org'}, displayName: 'Canva workflow', description: '', responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1},
    artifact: {resourceId: 'legacy-workflow', resourceType: 'plugin', scopeType: 'user', name: 'canva-workflow', version: '1.0.0', revision: 1, checksum, sourceType: 'standalone', sourcePluginId: null},
    access: {...access, canEdit: false}, activation: {effectivePolicy: 'optional', enabled: true, readiness: 'unknown', blockedReason: null}};
  const packageItem: PluginWorkspaceCatalogItem = {resourceRef, legacyResourceId: 'legacy-workflow', kind: 'plugin', name: 'canva-workflow', displayName: 'Canva workflow', description: '', version: '1.0.0', revision: 1,
    ownership: resource.metadata.ownership, access: {...access, canEdit: false}};
  const presentation: CapabilityPackagePresentation = {schemaVersion: 1, origin: 'installed', resourceRef, sourceStamp: {checksum, artifactRevision: 1}, kind: 'plugin', name: 'canva-workflow', version: '1.0.0',
    title: 'Canva workflow', description: '', children: [], capabilities: [], scripts: [], compatibility: [], requiredEnv: [], readOnly: false, sourceStampCurrent: true,
    requirements: [{declaredBy: {kind: 'plugin', name: 'canva-workflow'}, source: 'mcp', label: 'Design service', required: true, recommended: false, selector: {source: 'mcp', connector: 'design-mcp'}}]};
  const template: CapabilityPackageMcpTemplate = {resourceRef, declaredBy: {kind: 'plugin', name: 'canva-workflow'}, source: {resourceRef, version: '1.0.0', checksum, artifactRevision: 1},
    connector: {name: 'design-mcp', oauth: true}, config: {url: 'https://fixture.invalid/mcp'}, redactedFields: []};
  const shared = (ref: string, source: 'mcp' | 'composio'): IntegrationConnectionDescriptor => ({resource: {connectionRef: ref, source, ownership: {type: 'organization', organizationId: 'fixture-org'},
    displayName: 'Same display name', description: null, application: source === 'composio' ? 'canva' : null, responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 1, grantsRevision: 1, bindingRevision: 1, accessMode: 'restricted', allowedToolNames: null, status: 'active', createdAt: 1, updatedAt: 1}, access});
  const connection = (ref: string, source: 'mcp' | 'composio') => ({connectionRef: ref, displayName: 'Same display name', ownership: shared(ref, source).resource.ownership, access,
    enabled: true, authorization: 'unknown' as const, health: 'unknown' as const});
  const mcp = (ref: string): Extract<PluginExtensionItem, {kind: 'mcp'}> => ({id: ref, kind: 'mcp', name: 'Same display name', displayName: 'Same display name', description: '', source: 'mcp', stock: 'installed', access,
    ownership: shared(ref, 'mcp').resource.ownership, mcp: {connectionRef: ref, template: false, transport: 'unknown'}, connections: [connection(ref, 'mcp')]});
  let createdMcp = false, createdComposio = false, denySelected = false, revokedMcp = false, statusAuthorized = false;
  let heldStatus: Promise<void> | undefined;
  const integration = (): Extract<PluginExtensionItem, {kind: 'integration'}> => ({id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description: '', source: 'composio', stock: 'installed', access,
    toolkit: {slug: 'canva', noAuth: false}, connections: [connection(previousRef, 'composio'), {connectionRef: 'composio-personal:profile:account', displayName: 'Same display name',
      ownership: {type: 'user', ownerUserId: 'alice', organizationId: null}, access, enabled: true, authorization: 'authorized', health: 'unknown', profileId: 'profile', accountId: 'account'},
    ...(createdComposio ? [connection(createdComposioRef, 'composio')] : [])]});
  const scopes = {choices: ['all', 'user', 'organization'] as const, teams: []};
  const receipts: Array<{path: string; method: string; query: URLSearchParams; body?: Record<string, unknown>}> = [];
  const success = (data: unknown) => Response.json({success: true, data});
  const extensionResponse = (url: URL): PluginExtensionSearchResponse => {
    const candidates: PluginExtensionItem[] = [{id: resourceRef, kind: 'plugin', name: packageItem.name, displayName: packageItem.displayName, description: '', source: 'local', stock: 'installed', access, package: packageItem},
      integration(), mcp(previousRef), ...(createdMcp && !revokedMcp ? [mcp(createdMcpRef)] : [])];
    const selected = url.searchParams.get('selected');
    return {schemaVersion: 1, query: {q: url.searchParams.get('q') || '', types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null, cursor: null, selected, limit: 20},
      items: candidates, selectedItem: candidates.find(item => item.id === selected) || null, scopes: {choices: [...scopes.choices], teams: []},
      coverage: ['packages', 'store', 'mcp', 'composio'].map(source => ({source, status: 'complete'})) as PluginExtensionSearchResponse['coverage'],
      pagination: {loadedItems: candidates.length, totalItems: candidates.length, hasNextPage: false, nextCursor: null}};
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test'), path = decodeURIComponent(url.pathname), method = init?.method || 'GET';
    if (path === '/api/auth/get-session') return Response.json(session);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    receipts.push({path, method, query: url.searchParams, body});
    if (path === '/api/plugins/search') return denySelected && url.searchParams.get('selected') === 'composio:canva'
      ? Response.json({success: false, code: 'PLUGIN_ACCESS_DENIED'}, {status: 403}) : success(extensionResponse(url));
    if (path === '/api/plugins/catalog') return success({schemaVersion: 1, items: [packageItem], scopes, pagination: {page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false}});
    if (path === '/api/capabilities/packages/store') return success({schemaVersion: 1, stores: [], scopes, installed: {resources: [], summary: {updates: 0}, pagination: {hasNextPage: false}}});
    if (path === `/api/capabilities/resources/${resourceRef}`) return success({resource});
    if (path.endsWith('/presentation')) return success({presentation});
    if (path.endsWith('/mcp-matches')) return success({matches: [previousRef, ...(createdMcp ? [createdMcpRef] : [])].map(connectionRef => ({connectionRef, compatibility: 'endpoint'})), coverage: 'complete', source: template.source});
    if (path.endsWith('/mcp-template')) return success({template});
    if (path === '/api/integrations/mcp-definitions') return success({canManageDefinitions: true, definitions: []});
    if (path === '/api/integrations/mcp-config') return success({rawContent: '{}'});
    if (path === '/api/integrations/shared-connections/setup') return success({scopes: [{ownership: {type: 'organization', organizationId: 'fixture-org'}, label: 'Organization'}]});
    if (path === '/api/composio/profiles') return Response.json({success: true, profiles: [{id: 'profile', name: 'Personal', status: 'active'}], effectiveProfile: {id: 'profile', name: 'Personal', workspaceId}, workspace: {id: workspaceId}});
    if (path === '/api/composio/shared-profiles') return success({profiles: [{id: 'shared-profile', name: 'Organization profile', providerMode: 'managed'}]});
    if (path === '/api/integrations/shared-connections' && method === 'POST') {
      if (body?.source === 'mcp') {createdMcp = true; return success({connection: shared(createdMcpRef, 'mcp')});}
      createdComposio = true; return success({connection: shared(createdComposioRef, 'composio')});
    }
    if (path.startsWith('/api/integrations/shared-connections/') && path.endsWith('/targets')) return success({targets: {users: [], workspaces: [], projects: [], agents: []}});
    if (path.startsWith('/api/integrations/shared-connections/')) return success({connection: shared(path.split('/').at(-1)!, path.includes(createdComposioRef) ? 'composio' : 'mcp')});
    if (path.startsWith('/api/mcp/shared-connections/') && path.endsWith('/oauth')) {await heldStatus; return success({configured: true, requiresAuth: true, authorized: statusAuthorized});}
    throw new Error(`Unexpected connection context fixture: ${method} ${path}`);
  };
  const {authClient} = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, oldSession = atom.get();
  const seed = () => atom.set({...atom.get(), data: session, error: null, isPending: false, isRefetching: false});
  const {PluginWorkspace} = await import('../app/components/plugins/PluginWorkspace');
  const {PluginMcpSetup} = await import('../app/components/plugins/PluginMcpSetup');
  const {PackageRequirementsSetup} = await import('../app/components/plugins/PackageRequirementsSetup');
  const wrap = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{child}</NextIntlClientProvider>;
  const change = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, {target: {value}});
  const rootSearchCount = () => receipts.filter(value => value.path === '/api/plugins/search' && value.query.get('limit') === '20').length;
  window.confirm = () => true;
  try {
    seed(); originalReplace(null, '', `/en/plugins?view=browse&resourceRef=${resourceRef}&task=connections&q=canva`);
    render(wrap(<PluginWorkspace canManageOrganizationCapabilities />));
    fireEvent.click(await screen.findByTestId('package-requirement-connect-0'));
    await screen.findByLabelText(messages.skills.workspace.setup.scope); change('plugin-mcp-scope', 'organization');
    await screen.findByTestId('shared-connection-create-form');
    assert.equal((screen.getByRole('checkbox', {name: messages.sharedConnections.oauth}) as HTMLInputElement).checked, true, 'Manifest-only OAuth is required in the shared template form.');
    const packageReads = receipts.filter(value => value.path.endsWith('/presentation')).length;
    const searchReads = rootSearchCount();
    fireEvent.click(screen.getByRole('button', {name: messages.sharedConnections.create}));
    await waitFor(() => assert(!screen.queryByTestId('plugin-mcp-setup')));
    await waitFor(() => assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).value, createdMcpRef));
    assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).options.length, 3, 'Two same-name candidates retain separate exact identities.');
    assert.equal(receipts.filter(value => value.path.endsWith('/presentation')).length, packageReads, 'Connection refresh never remounts the actual parent package detail.');
    await waitFor(() => assert(rootSearchCount() > searchReads, 'The common catalogue still refreshes after package connection changes.'));
    const submittedMcp = receipts.find(value => value.path === '/api/integrations/shared-connections' && value.body?.source === 'mcp')?.body;
    assert.deepEqual(submittedMcp?.config, {url: 'https://fixture.invalid/mcp', transport: 'http', auth: 'oauth'});
    assert.deepEqual(submittedMcp?.secrets, []);
    fireEvent.click(screen.getByTestId('package-detail-reload'));
    await waitFor(() => assert(receipts.filter(value => value.path.endsWith('/presentation')).length > packageReads, 'Explicit package reload still reloads package metadata.'));
    cleanup(); seed();

    // Config-declared OAuth uses the same existing draft interpretation, without carrying its metadata or credentials into a shared create.
    render(wrap(<PluginMcpSetup workspaceId={workspaceId} template={{...template, connector: {name: 'design-mcp'}, config: {url: 'https://fixture.invalid/mcp', oauth: {issuer: 'https://fixture.invalid'}}}}
      returnPath={`/en/plugins?view=browse&resourceRef=${resourceRef}&task=connections`} onCreated={() => undefined} onClose={() => undefined} />));
    await screen.findByLabelText(messages.skills.workspace.setup.scope); change('plugin-mcp-scope', 'organization');
    await screen.findByTestId('shared-connection-create-form');
    assert.equal((screen.getByRole('checkbox', {name: messages.sharedConnections.oauth}) as HTMLInputElement).checked, true);
    cleanup(); seed();

    originalReplace(null, '', '/en/plugins?view=browse&extensionId=composio:canva&q=canva');
    render(wrap(<PluginWorkspace canManageOrganizationCapabilities />));
    await screen.findByTestId('plugin-integration-new-shared');
    const rootsBeforeCreate = rootSearchCount();
    fireEvent.click(screen.getByTestId('plugin-integration-new-shared'));
    await screen.findByTestId('shared-connection-create-form');
    await waitFor(() => assert.equal(screen.getByRole('button', {name: messages.sharedConnections.create}).hasAttribute('disabled'), false));
    fireEvent.click(screen.getByRole('button', {name: messages.sharedConnections.create}));
    await waitFor(() => assert.equal((document.getElementById('plugin-integration-account') as HTMLSelectElement)?.value, createdComposioRef));
    assert.equal(rootSearchCount(), rootsBeforeCreate, 'Standalone refresh is local while exact multi-account detail remains open.');
    assert.equal(new URL(window.location.href).searchParams.get('extensionId'), 'composio:canva');
    fireEvent.click(screen.getByTestId('plugin-extension-back'));
    await waitFor(() => assert(rootSearchCount() > rootsBeforeCreate));
    await waitFor(() => assert.equal(screen.getByTestId('plugin-extension-results').getAttribute('aria-busy'), 'false'));
    assert.equal((screen.getByTestId('plugin-extension-search-input') as HTMLInputElement).value, 'canva');

    // Deferring parent invalidation never keeps rejected detail actions visible.
    await act(async () => window.history.pushState(null, '', '/en/plugins?view=browse&extensionId=composio:canva&q=canva'));
    await screen.findByTestId('plugin-integration-new-shared'); denySelected = true;
    fireEvent.click(screen.getByTestId('plugin-integration-reload'));
    await waitFor(() => assert(!screen.queryByTestId('plugin-integration-new-shared')));
    assert(!screen.queryByTestId('plugin-integration-connect'));
    cleanup(); seed(); denySelected = false;

    const callback = (ref: string, parent = resourceRef, workspace = workspaceId) => `/en/plugins?view=browse&resourceRef=${parent}&workspaceId=${workspace}&task=connections&connectionRef=${encodeURIComponent(ref)}&sharedOAuth=connected`;
    let releaseStatus!: () => void; heldStatus = new Promise<void>(resolve => {releaseStatus = resolve;});
    originalReplace(null, '', callback(createdMcpRef));
    render(wrap(<PluginWorkspace canManageOrganizationCapabilities />));
    await waitFor(() => assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).value, createdMcpRef));
    assert(screen.queryByText(messages.skills.workspace.setup.setupIncomplete), 'OAuth marker alone never proves a usable account.');
    statusAuthorized = true; await act(async () => releaseStatus()); heldStatus = undefined;
    await waitFor(() => assert(!screen.queryByText(messages.skills.workspace.setup.setupIncomplete), 'Actual saved auth inspection closes readiness only after its successful response.'));
    change('package-requirement-connection-0', previousRef);
    await waitFor(() => assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).value, previousRef));
    fireEvent.click(within(screen.getByTestId('package-requirement-0')).getByRole('button', {name: messages.skills.workspace.setup.manage}));
    fireEvent.click(await screen.findByTestId('plugin-integration-reload'));
    await waitFor(() => assert(!screen.getByTestId('plugin-integration-reload').hasAttribute('disabled')));
    fireEvent.click(within(screen.getByTestId('plugin-integration-detail').querySelector('header')!).getByRole('button', {name: messages.skills.workspace.setup.back}));
    await waitFor(() => assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).value, previousRef, 'An explicit later choice survives refresh rather than being overwritten by the old callback.'));
    cleanup(); seed();
    const unmatchedRef = 'canvas-connection:55555555-5555-4555-8555-555555555555', foreignRef = 'canvas-resource:66666666-6666-4666-8666-666666666666';
    for (const [label, path, revoke] of [
      ['unmatched', callback(unmatchedRef), false], ['private', callback('composio-personal:foreign-profile:private-account'), false],
      ['revoked', callback(createdMcpRef), true], ['foreign resource', callback(createdMcpRef, foreignRef), false],
      ['foreign workspace', callback(createdMcpRef, resourceRef, 'foreign-workspace'), false],
    ] as const) {
      revokedMcp = revoke; const before = receipts.length;
      render(wrap(<PackageRequirementsSetup presentation={presentation} workspaceId={workspaceId} returnPath={path} onUpdated={() => undefined} />));
      await screen.findByTestId('package-requirement-connection-0');
      await waitFor(() => assert(!screen.queryByText(messages.skills.workspace.setup.loading)));
      assert.equal((screen.getByTestId('package-requirement-connection-0') as HTMLSelectElement).value, '', `${label} callback never selects another account`);
      assert(!receipts.slice(before).some(value => value.path.startsWith('/api/mcp/shared-connections/')), `${label} callback never inspects an unauthorized/unmatched account`);
      cleanup(); seed();
    }
    console.log('PASS actual common shell/detail/setup parent chain: exact created MCP choice survives refresh; manifest/config OAuth and safe shared POST; multi-account Composio choice until Back; rejected detail actions removed; fresh matched OAuth resume with unknown-until-inspected auth; unmatched/private/revoked/foreign callback references ignored. Controlled HTTP fixtures only.');
  } finally {cleanup(); atom.set(oldSession); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
