import assert from 'node:assert/strict';
import Module from 'node:module';
import { CapabilityResourceError, type CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import { parsePluginExtensionQuery, projectPluginExtensionPage, revalidateExtensions, searchPluginExtensions, type PluginExtensionSearchDependencies } from '../app/lib/plugins/plugin-extension-search';
import type { PluginExtensionConnection, PluginExtensionItem, PluginExtensionQuery } from '../app/lib/plugins/plugin-extension-contracts';

const actor = { userId: 'alice', workspaceId: 'personal-alice' };
const scopes = { choices: ['all', 'user', 'team', 'organization'] as const, teams: [{ teamId: 'team-a', label: 'Design' }] };
const context = { actorUserId: 'alice', readableTeamIds: new Set(['team-a']), organizationAvailable: true, teams: scopes.teams };
const permissions = { canRead: true, canUse: true, canManage: true };
const ownership = { type: 'user' as const, ownerUserId: 'alice', organizationId: null };
const query = (parameters = '') => parsePluginExtensionQuery(new URLSearchParams(parameters));
const connection = (name: string, shared = false): PluginExtensionConnection => ({ connectionRef: name, displayName: name,
  ownership: shared ? { type: 'team', workspaceId: 'team-a', organizationId: 'org-a' } : ownership,
  access: { ...permissions, canManage: !shared }, authorization: 'authorized', health: 'unknown', enabled: true });
const installed: PluginExtensionItem = { id: 'canvas-resource:design', kind: 'plugin', name: 'design', displayName: 'Design package', description: 'Build a Canva campaign',
  source: 'local', stock: 'installed', access: permissions, ownership,
  package: { resourceRef: 'canvas-resource:design', legacyResourceId: 'design', kind: 'plugin', name: 'design', displayName: 'Design package', description: 'Build a Canva campaign',
    version: '1.0.0', revision: 1, ownership, access: { ...permissions, canEdit: true } } };
const skill: PluginExtensionItem = { id: 'canvas-resource:skill', kind: 'skill', name: 'canva-brief', displayName: 'Canva brief', description: '', source: 'local', stock: 'installed', access: permissions, ownership };
const integration: PluginExtensionItem = { id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description: 'Design', source: 'composio', stock: 'installed',
  access: permissions, toolkit: { slug: 'canva', noAuth: false }, connections: [connection('personal-a'), connection('personal-b'), connection('shared-a', true)] };
const mcp: PluginExtensionItem = { id: 'mcp-personal:canva', kind: 'mcp', name: 'canva-mcp', displayName: 'Canva MCP', description: '', source: 'mcp', stock: 'installed', access: permissions,
  ownership, mcp: { serverId: 'canva', transport: 'http', template: false }, connections: [connection('mcp-personal:canva')] };
const stock: PluginExtensionItem[] = [installed, skill, integration, mcp];
const coverage = [{ source: 'packages' as const, status: 'complete' as const }];
const project = (selection: PluginExtensionQuery, candidates = stock) => projectPluginExtensionPage(actor, selection, candidates, { choices: [...scopes.choices], teams: scopes.teams }, coverage);

async function main() {
  assert.deepEqual(query().types, ['plugin', 'skill', 'integration', 'mcp']);
  assert.equal(query().scope, 'all');
  for (const invalid of ['userId=bob', 'types=plugin,bogus', 'types=plugin,plugin', 'scope=all&teamId=team-a', 'scope=team&audience=own', 'source=other', 'stock=ready',
    'workspaceId=a&workspaceId=b', 'q=%00', 'limit=51', 'limit=00', 'cursor=', 'selected=', 'types=']) {
    assert.throws(() => query(invalid), error => error instanceof CapabilityResourceError && error.status === 400, invalid);
  }
  const all = project(query('q=canva&limit=1'));
  assert.equal(all.items[0].id, 'composio:canva', 'an exact integration outranks a package description match');
  assert.equal(all.pagination.totalItems, 4);
  assert(all.pagination.nextCursor);
  const second = project({ ...query('q=canva&limit=1'), cursor: all.pagination.nextCursor });
  assert.equal(second.items[0].kind, 'skill');
  assert.throws(() => project({ ...query('q=other&limit=1'), cursor: all.pagination.nextCursor }), { code: 'PLUGIN_SEARCH_CURSOR_INVALID' });
  assert.throws(() => projectPluginExtensionPage({ ...actor, userId: 'bob' }, { ...query('q=canva&limit=1'), cursor: all.pagination.nextCursor }, stock,
    { choices: [...scopes.choices], teams: scopes.teams }, coverage), { code: 'PLUGIN_SEARCH_CURSOR_INVALID' });
  assert.throws(() => projectPluginExtensionPage({ ...actor, workspaceId: 'different' }, { ...query('q=canva&limit=1'), cursor: all.pagination.nextCursor }, stock,
    { choices: [...scopes.choices], teams: scopes.teams }, coverage), { code: 'PLUGIN_SEARCH_CURSOR_INVALID' });
  assert.deepEqual(new Set(project(query('q=canva')).items.map(item => item.kind)), new Set(['plugin', 'skill', 'integration', 'mcp']));
  assert.equal(project(query()).items[0].kind, 'plugin', 'without a search packages come first');
  const team = project(query('types=integration&scope=team&teamId=team-a')).items[0];
  assert(team.kind === 'integration'); assert.deepEqual(team.connections.map(value => value.connectionRef), ['shared-a']);
  assert.equal(team.access.canManage, false, 'personal management rights cannot leak into the filtered team summary');
  const selected = project(query('q=missing&types=skill&stock=available&selected=composio%3Acanva'));
  assert.equal(selected.items.length, 0); assert.equal(selected.selectedItem?.id, 'composio:canva', 'OAuth return preserves exact selected details despite browse filters');
  const crossOwnerSelected = project(query('scope=organization&selected=mcp-personal%3Acanva'));
  assert.equal(crossOwnerSelected.items.some(item => item.id === mcp.id), false, 'organization filter still excludes personal list rows');
  assert.equal(crossOwnerSelected.selectedItem?.id, mcp.id, 'creating a personal MCP from an organization-filtered list retains exact readable details');
  const sharedMcp: PluginExtensionItem = {...mcp, id: 'canvas-connection:shared', ownership: connection('shared', true).ownership,
    connections: [connection('canvas-connection:shared', true)]};
  const ownSelected = project(query('scope=user&audience=own&selected=canvas-connection%3Ashared'), [sharedMcp]);
  assert.equal(ownSelected.items.length, 0);
  assert.equal(ownSelected.selectedItem?.id, sharedMcp.id, 'an exact newly created shared connection survives the personal list filter');
  const teamSelected = project(query('scope=team&teamId=team-a&selected=mcp-personal%3Acanva'));
  assert.equal(teamSelected.items.some(item => item.id === mcp.id), false);
  assert.equal(teamSelected.selectedItem?.id, mcp.id, 'team selection filters results without changing exact detail authority');
  const noAuth: PluginExtensionItem = { ...integration, toolkit: { slug: 'canva', noAuth: true }, connections: [], stock: 'available' };
  assert.equal(project(query('types=integration'), [noAuth]).items[0].access.canUse, false, 'a no-auth declaration never grants runtime permission');
  const hidden: PluginExtensionItem = { ...skill, id: 'private', access: { canRead: false, canUse: false, canManage: false } };
  assert(!project(query(), [...stock, hidden]).items.some(item => item.id === 'private'));
  assert.equal(project(query('scope=organization&selected=private'), [hidden]).selectedItem, null, 'unreadable exact selections stay hidden across filters');
  const offering: PluginExtensionItem = { id: 'store:plugin:registry:design', kind: 'plugin', name: 'design', displayName: 'Design package', description: 'Canva', source: 'store', stock: 'installed', access: permissions,
    offering: { kind: 'plugin', registryId: 'registry', entryKey: 'design', displayName: 'Design package', description: 'Canva', latestVersion: '1.0.0', versions: [{ version: '1.0.0', checksum: 'a'.repeat(64) }],
      installedResourceRefs: ['canvas-resource:design'], installedRefsTruncated: false } };
  const linked = project(query('source=store'), [installed, offering]);
  assert.equal(linked.items.length, 1); assert.equal(linked.items[0].id, installed.id); assert.equal(linked.items[0].source, 'store');
  const deferred: string[] = [];
  const dependencies: PluginExtensionSearchDependencies = {
    context: async () => context,
    packages: async () => ({ items: [installed, skill], scopes: { choices: [...scopes.choices], teams: scopes.teams }, coverage: { source: 'packages', status: 'complete' } }),
    store: async () => ({ items: [], coverage: { source: 'store', status: 'complete' } }),
    composio: async () => { deferred.push('composio'); return { items: [integration], coverage: { source: 'composio', status: 'complete' } }; },
    mcp: async () => ({ items: [mcp], coverage: { source: 'mcp', status: 'complete' } }),
    revalidate: async (_actor, values) => values.filter(value => value.id !== installed.id),
  };
  const refreshed = await searchPluginExtensions(actor, query('q=canva'), { dependencies });
  assert(!refreshed.items.some(item => item.id === installed.id), 'revocation during remote catalogue IO is applied before response');
  assert.equal(refreshed.items.length, 3);
  const partial = await searchPluginExtensions(actor, query(), { dependencies: { ...dependencies, composio: async () => { throw new Error('SECRET_PROVIDER_TOKEN'); } } });
  assert.equal(partial.items.length, 2); assert.equal(partial.pagination.totalItems, undefined); assert(partial.coverage.some(source => source.status === 'unavailable'));
  assert(!JSON.stringify(partial).includes('SECRET_PROVIDER_TOKEN'));
  const timeout = await searchPluginExtensions(actor, query(), { timeoutMs: 5, dependencies: { ...dependencies, composio: () => new Promise(() => {}) } });
  assert(timeout.coverage.some(source => source.error?.code === 'PLUGIN_SEARCH_SOURCE_TIMEOUT'));
  await assert.rejects(() => searchPluginExtensions(actor, query('scope=team&teamId=private'), { dependencies }), { status: 404 });
  const sourceCalls: string[] = [];
  const continuedDependencies: PluginExtensionSearchDependencies = { ...dependencies, revalidate: async (_actor, items) => items,
    composio: async (_actor, _signal, options) => {
      sourceCalls.push(`composio:${options?.search}:${options?.continuation ?? 'first'}`);
      return options?.continuation ? { items: [{ ...integration, id: 'composio:canva-later', name: 'canva-later', displayName: 'Canva Later' }], coverage: { source: 'composio', status: 'complete' } }
        : { items: [integration], continuation: 'second-source-page', coverage: { source: 'composio', status: 'partial' } };
    }, packages: async () => { sourceCalls.push('packages'); return dependencies.packages(actor); },
    store: async () => { sourceCalls.push('store'); return dependencies.store(actor); }, mcp: async () => { sourceCalls.push('mcp'); return dependencies.mcp(actor); } };
  const firstBatch = await searchPluginExtensions(actor, query('q=canva&types=integration&limit=50'), { dependencies: continuedDependencies });
  assert(firstBatch.pagination.nextCursor); assert.deepEqual(sourceCalls, ['composio:canva:first'], 'type filtering avoids unrelated SDK/resource work');
  sourceCalls.length = 0;
  const laterBatch = await searchPluginExtensions(actor, { ...query('q=canva&types=integration&limit=50'), cursor: firstBatch.pagination.nextCursor }, { dependencies: continuedDependencies });
  assert.equal(laterBatch.items[0].id, 'composio:canva-later'); assert.equal(laterBatch.pagination.nextCursor, null); assert.equal(laterBatch.pagination.totalItems, undefined);
  assert.deepEqual(sourceCalls, ['composio:canva:second-source-page']);
  const abort = new AbortController(); let abortedAtSource = false;
  const pending = searchPluginExtensions(actor, query('types=integration'), { signal: abort.signal, dependencies: { ...dependencies,
    composio: async (_actor, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { abortedAtSource = true; reject(signal.reason); }, { once: true }); abort.abort(); }) } });
  await assert.rejects(() => pending); assert(abortedAtSource, 'request cancellation reaches SDK source signals');

  await metadataAndRouteChecks(dependencies);
  console.log('PASS extension search: four types, relevance, exact accounts, filters, selected OAuth return, scoped cursor, current rights, safe failures, local/managed collection-loader pagination, and route contract.');
}

async function metadataAndRouteChecks(dependencies: PluginExtensionSearchDependencies) {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown; _resolveFilename: (name: string, parent: NodeModule | null) => string }, original = loader._load;
  let mode: 'local' | 'managed' | 'disabled' = 'local', scenario: 'normal' | 'repeated' | 'malformed' | 'later-failure' | 'malformed-identity' = 'normal', revision = 'v1', signedIn = true;
  const cursors: Array<string | undefined> = [];
  const searches: Array<string | undefined> = [];
  let currentResources: CapabilityResourceDescriptor[] | null = null;
  const profile = (id: string) => ({ kind: 'resolved_composio_context', userId: 'alice', workspaceId: actor.workspaceId, profileId: id,
    profileName: id, profileSource: 'default', composioUserId: `PRIVATE_PROVIDER_ENTITY_${id}`, cacheRevision: revision, storageScope: { secretScope: 'user', userId: 'alice' } });
  const page = (cursor?: string) => {
    cursors.push(cursor);
    if (cursor && scenario === 'later-failure') throw new Error('SECRET_PAGE_TOKEN');
    return !cursor ? { items: [{ slug: 'photos', name: 'Photos', apiKey: 'SECRET_METADATA_KEY' }], next_cursor: 'page-2' }
      : { items: [{ slug: 'canva', name: 'Canva', noAuth: false }, { slug: 'public_search', name: 'Public search', noAuth: true }, { slug: 'string_flag', name: 'Bad flag', noAuth: 'false' }, { slug: 'openai', name: 'Hidden native provider' },
        ...(scenario === 'malformed-identity' ? [{ slug: 'ca\u0000nva', name: 'Should never overwrite Canva', noAuth: true }] : [])],
        next_cursor: scenario === 'repeated' ? 'page-2' : scenario === 'malformed' ? 123 : null };
  };
  const account = (id: string) => ({ id: `account-${id.replace('PRIVATE_PROVIDER_ENTITY_', '')}`, toolkit: { slug: 'canva', name: 'Canva' }, status: 'ACTIVE', token: 'SECRET_ACCOUNT_TOKEN' });
  const fixtures = new Map<string, unknown>([
    ['@/app/lib/composio/composio-client', { getComposioMode: async () => mode, getComposio: async () => ({ getClient: () => ({ toolkits: {
      list: async (params: { cursor?: string; search?: string }) => { searches.push(params.search); return page(params.cursor); },
      retrieve: async (slug: string) => ({ slug, name: 'Selected app', noAuth: true }),
    } }),
      connectedAccounts: { list: async (params: { userIds: string[] }) => ({ items: [account(params.userIds[0]), ...(scenario === 'malformed-identity'
        ? [{ ...account(params.userIds[0]), id: `${account(params.userIds[0]).id}\u0000` }] : [])], next_cursor: null }) } }) }],
    ['@/app/lib/composio/composio-context', { resolveComposioContext: async () => profile('profile-a'), resolveBoundComposioContext: async (input: { profileId: string }) => profile(input.profileId) }],
    ['@/app/lib/composio/composio-profiles', { listComposioProfiles: async () => [{ id: 'profile-a', status: 'active' }, { id: 'profile-b', status: 'active' }] }],
    ['@/app/lib/composio/managed-composio-client', { requestManagedComposio: async (route: string, options: { query?: URLSearchParams }, value: { profileId: string }) => {
      if (route === '/status') return { configured: true, connectedAccounts: [account(value.profileId)] };
      searches.push(options.query?.get('search') ?? undefined);
      const raw = page(options.query?.get('cursor') ?? undefined); return { toolkits: raw.items, nextCursor: raw.next_cursor };
    } }],
    ['@/app/lib/integration-tools/connections/store', { listSharedIntegrationConnections: async () => [] }],
  ]);
  fixtures.set('@/app/lib/plugins/plugin-workspace-selection', { resolvePluginWorkspaceCatalogScopeContext: async () => context,
    selectPluginWorkspaceItems: (items: unknown[]) => items });
  fixtures.set('@/app/lib/capabilities/resources/actions', { listCapabilityResources: async () => {
    if (currentResources) return currentResources;
    throw new Error('PRIVATE_PACKAGE_STORAGE_FAILURE');
  } });
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    let resolved = name;
    try { resolved = loader._resolveFilename(name, parent); } catch { /* Alias lookup can still match. */ }
    const key = resolved.replace(`${process.cwd()}/`, '@/').replace(/\.(?:ts|tsx|js)$/u, '');
    return fixtures.has(name) ? fixtures.get(name) : fixtures.has(key) ? fixtures.get(key) : original(name, parent, isMain);
  };
  try {
    const unavailableInstalled: PluginExtensionItem = { ...installed, id: 'store:plugin:registry:installed', package: undefined, offering: {
      kind: 'plugin', registryId: 'registry', entryKey: 'installed', displayName: 'Installed', description: '', latestVersion: '1.0.0',
      versions: [], installedResourceRefs: [installed.id], installedRefsTruncated: false } };
    const availableOffering: PluginExtensionItem = { ...unavailableInstalled, id: 'store:plugin:registry:available', offering: {
      ...unavailableInstalled.offering!, entryKey: 'available', installedResourceRefs: [] } };
    const rechecked = await revalidateExtensions(actor, [unavailableInstalled, availableOffering]);
    assert.deepEqual(rechecked.items.map(item => item.id), [availableOffering.id], 'a failed installed-resource check cannot turn an installed offering into Installieren');
    assert(rechecked.coverage.some(source => source.source === 'store' && source.status === 'partial'));
    assert(!JSON.stringify(rechecked).includes('PRIVATE_PACKAGE_STORAGE_FAILURE'));
    currentResources = [{ metadata: { resourceRef: installed.id, status: 'active', ownership, displayName: installed.displayName, description: installed.description },
      artifact: { resourceType: 'plugin', resourceId: 'legacy-design', sourceType: 'standalone', sourcePluginId: null, name: installed.name, version: '1.0.0', revision: 1 },
      access: { ...permissions, canEdit: true } } as unknown as CapabilityResourceDescriptor];
    const continued = await revalidateExtensions(actor, [structuredClone(unavailableInstalled)]);
    assert(continued.items.some(item => item.id === installed.id && item.package), 'a later Store batch includes its freshly revalidated installed instances');
    const collapsed = projectPluginExtensionPage(actor, query('stock=installed'), continued.items, { choices: [...scopes.choices], teams: scopes.teams }, [{ source: 'store', status: 'complete' }]);
    assert.deepEqual(collapsed.items.map(item => item.id), [installed.id]);
    assert.equal(collapsed.items[0].stock, 'installed');
    const { readComposioExtensions, revalidatePersonalComposioExtensionConnection } = await import('../app/lib/plugins/plugin-extension-integrations');
    for (const selectedMode of ['local', 'managed'] as const) {
      mode = selectedMode; cursors.length = 0;
      const result = await readComposioExtensions(actor, new AbortController().signal);
      assert.equal(result.coverage.status, 'complete'); assert.deepEqual(cursors, [undefined, 'page-2']);
      const canva = result.items.find(value => value.id === 'composio:canva'); assert(canva?.kind === 'integration');
      assert.equal(canva.connections.length, 2, 'distinct exact profile/account bindings are retained');
      assert.equal(canva.connections[0].health, 'unknown', 'catalogue authorization is not a business API health probe');
      assert.equal(await revalidatePersonalComposioExtensionConnection(actor, canva.connections[0]), true);
      revision = 'rotated'; assert.equal(await revalidatePersonalComposioExtensionConnection(actor, canva.connections[0]), false); revision = 'v1';
      assert(!result.items.some(value => value.name === 'openai'));
      const badFlag = result.items.find(value => value.name === 'string_flag'); assert(badFlag?.kind === 'integration'); assert.equal(badFlag.toolkit.noAuth, false);
      const publicSearch = result.items.find(value => value.name === 'public_search'); assert(publicSearch?.kind === 'integration'); assert.equal(publicSearch.access.canUse, false);
      const serialized = JSON.stringify(result);
      for (const forbidden of ['SECRET_METADATA', 'SECRET_ACCOUNT', 'PRIVATE_PROVIDER_ENTITY']) assert(!serialized.includes(forbidden));
    }
    for (const selectedMode of ['local', 'managed'] as const) {
      mode = selectedMode; searches.length = 0;
      const first = await readComposioExtensions(actor, new AbortController().signal, { search: 'canva', maxPages: 1 });
      assert(first.continuation); assert.equal(first.coverage.status, 'partial'); assert(searches.every(value => value === 'canva'));
      const later = await readComposioExtensions(actor, new AbortController().signal, { search: 'canva', continuation: first.continuation, maxPages: 1 });
      assert.equal(later.coverage.status, 'complete'); assert(later.items.some(value => value.name === 'public_search'));
      revision = 'rotated';
      const changed = await readComposioExtensions(actor, new AbortController().signal, { search: 'canva', continuation: first.continuation, maxPages: 1 });
      assert.equal(changed.coverage.status, 'unavailable', 'a source cursor cannot continue under a rotated profile/entity binding'); revision = 'v1';
    }
    mode = 'local';
    const exact = await readComposioExtensions(actor, new AbortController().signal, { search: 'other', maxPages: 1, selectedSlug: 'known_selected_app' });
    assert(exact.items.some(value => value.name === 'known_selected_app'), 'selected metadata is independently resolved outside the current source batch');
    scenario = 'malformed-identity';
    const malformed = await readComposioExtensions(actor, new AbortController().signal);
    assert.equal(malformed.coverage.status, 'partial');
    const exactCanva = malformed.items.find(value => value.name === 'canva'); assert(exactCanva?.kind === 'integration');
    assert.equal(exactCanva.displayName, 'Canva'); assert.equal(exactCanva.toolkit.noAuth, false); assert.equal(exactCanva.connections.length, 2);
    assert(!JSON.stringify(malformed).includes('Should never overwrite'));
    mode = 'local';
    for (scenario of ['repeated', 'malformed', 'later-failure']) {
      const result = await readComposioExtensions(actor, new AbortController().signal);
      assert.equal(result.coverage.status, 'partial'); assert(result.items.some(value => value.name === 'photos'));
      assert(!JSON.stringify(result).includes('SECRET_PAGE_TOKEN'));
    }
    mode = 'disabled'; scenario = 'normal';
    assert.equal((await readComposioExtensions(actor, new AbortController().signal)).coverage.status, 'not_configured');
    const { NextResponse } = await import('next/server');
    fixtures.set('@/app/api/capabilities/resources/http', {
      resourceRequestActor: async (request: Request) => signedIn ? { ...actor, workspaceId: request.headers.get('x-canvas-workspace-id') || new URL(request.url).searchParams.get('workspaceId') || actor.workspaceId }
        : NextResponse.json({ success: false }, { status: 401 }),
      resourceResponse: (data: unknown) => NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } }),
      resourceResponseError: (error: unknown) => NextResponse.json({ success: false }, { status: error instanceof CapabilityResourceError ? error.status : 500 }),
    });
    fixtures.set('@/app/lib/plugins/plugin-extension-search', { parsePluginExtensionQuery, searchPluginExtensions: (value: typeof actor, selection: PluginExtensionQuery) => searchPluginExtensions(value, selection, { dependencies }) });
    const { GET } = await import('../app/api/plugins/search/route');
    const response = await GET(new Request('https://example.test/api/plugins/search?q=canva'));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal((await response.json()).data.items.length, 3);
    assert.equal((await GET(new Request('https://example.test/api/plugins/search?userId=bob'))).status, 400);
    assert.equal((await GET(new Request('https://example.test/api/plugins/search?workspaceId=other', { headers: { 'x-canvas-workspace-id': actor.workspaceId } }))).status, 400);
    signedIn = false; assert.equal((await GET(new Request('https://example.test/api/plugins/search'))).status, 401);
  } finally { loader._load = original; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
