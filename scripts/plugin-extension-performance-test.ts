import assert from 'node:assert/strict';
import Module from 'node:module';
import { readBoundedStoreRegistryJson } from '../app/lib/plugins/store-registry-reader';
import { getPluginExtensionSearchDependencies, getPluginExtensionSearchResourceSnapshot, parsePluginExtensionQuery,
  searchPluginExtensions, type PluginExtensionSearchDependencies } from '../app/lib/plugins/plugin-extension-search';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

const actor = { userId: 'phase-owner', workspaceId: 'phase-workspace' };
const scopes = { choices: ['all', 'user'] as const, teams: [] };
const context = { actorUserId: actor.userId, readableTeamIds: new Set<string>(), organizationAvailable: false, teams: [] };
const item: PluginExtensionItem = { id: 'canvas-resource:phase', kind: 'plugin', name: 'phase', displayName: 'Phase', description: '',
  source: 'local', stock: 'installed', access: { canRead: true, canUse: true, canManage: false } };
const query = (raw = '') => parsePluginExtensionQuery(new URLSearchParams(raw));

async function phaseChecks() {
  const calls: string[] = [], resources: CapabilityResourceDescriptor[] = [];
  const dependencies: PluginExtensionSearchDependencies = {
    context: async () => context,
    packages: async () => { calls.push('packages'); return { items: [item], scopes: { ...scopes, choices: [...scopes.choices] }, coverage: { source: 'packages', status: 'complete' } }; },
    store: async () => { calls.push('store'); return { items: [], coverage: { source: 'store', status: 'complete' } }; },
    composio: async (_actor, _signal, options) => { calls.push(options?.localOnly ? 'known-composio' : 'remote-composio'); return { items: [], coverage: { source: 'composio', status: 'complete' } }; },
    mcp: async () => { calls.push('mcp'); return { items: [], coverage: { source: 'mcp', status: 'complete' } }; },
    revalidate: async (_actor, items) => ({ items, coverage: [], resources }),
  };
  assert.throws(() => query('phase=bogus'));
  const local = await searchPluginExtensions(actor, query('phase=local'), { dependencies });
  assert.deepEqual(calls.sort(), ['known-composio', 'mcp', 'packages']);
  assert.equal(local.items[0].id, item.id);
  assert.equal(getPluginExtensionSearchResourceSnapshot(local, actor), resources, 'Only the final request-local resource observation is reused.');
  assert.equal(getPluginExtensionSearchResourceSnapshot(local, { ...actor, userId: 'foreign' }), undefined);
  assert(!JSON.stringify(local).includes('resources'), 'Private descriptors are not serialized.');
  calls.length = 0;
  await searchPluginExtensions(actor, query('phase=remote'), { dependencies });
  assert.deepEqual(calls.sort(), ['remote-composio', 'store'], 'Remote discovery does not repeat initial local inventories.');
  calls.length = 0;
  await searchPluginExtensions(actor, query('stock=installed'), { dependencies });
  assert(!calls.includes('store'), 'Installed search does not depend on an unrelated Store.');
  calls.length = 0;
  await searchPluginExtensions(actor, query('stock=installed&source=store'), { dependencies });
  assert(calls.includes('store'), 'An explicit Store filter still verifies its offering provenance.');
  const paginated = await searchPluginExtensions(actor, query('phase=local&limit=1'), { dependencies: { ...dependencies,
    packages: async current => { const value = await dependencies.packages(current); return { ...value, items: [item, { ...item, id: 'second' }] }; },
  } });
  assert(paginated.pagination.nextCursor);
  await assert.rejects(() => searchPluginExtensions(actor, { ...query('phase=remote&limit=1'), cursor: paginated.pagination.nextCursor }, { dependencies }), { code: 'PLUGIN_SEARCH_CURSOR_INVALID' });
  const abort = new AbortController(); let sourceSignal: AbortSignal | undefined;
  const cancelled = searchPluginExtensions(actor, query('phase=remote&types=plugin'), { dependencies: { ...dependencies,
    store: async (_actor, options) => { sourceSignal = options?.signal; abort.abort(); return new Promise(() => {}); },
  }, signal: abort.signal });
  await assert.rejects(cancelled); assert(sourceSignal?.aborted, 'Store receives cancellation and its caller stops without waiting for the timeout.');
}

async function registryChecks() {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), calls = 0, fail = false, block = false, fetchAborted = false, release: (() => void) | undefined;
  Date.now = () => now;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (fail) throw new Error('CONTROLLED_REGISTRY_FAILURE');
    if (block) await new Promise<never>((_resolve, reject) => {
      const abort = () => { fetchAborted = true; reject(options?.signal?.reason); };
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) abort();
    });
    if (release === undefined) await new Promise<void>((resolve, reject) => {
      release = resolve;
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
    return Response.json({ registry: 'public', nested: { value: 1 } });
  };
  try {
    const url = 'https://registry.fixture.invalid/metadata';
    const cancelled = new AbortController();
    const first = readBoundedStoreRegistryJson(url, { cache: 'metadata', signal: cancelled.signal });
    const second = readBoundedStoreRegistryJson(url, { cache: 'metadata' });
    cancelled.abort(); await assert.rejects(first); assert.equal(calls, 1);
    release!(); const value = await second as { nested: { value: number } }; value.nested.value = 7;
    assert.deepEqual(await readBoundedStoreRegistryJson(url, { cache: 'metadata' }), { registry: 'public', nested: { value: 1 } });
    assert.equal(calls, 1, 'Concurrent public metadata readers share one fetch and receive isolated values.');
    await readBoundedStoreRegistryJson(url); assert.equal(calls, 2, 'Source review/install default remains a fresh fetch.');
    await assert.rejects(() => readBoundedStoreRegistryJson(url, { cache: 'metadata', allowedProtocols: ['file:'] }));
    now += 30_001;
    await readBoundedStoreRegistryJson(url, { cache: 'metadata' }); assert.equal(calls, 3, 'Expired metadata is revalidated.');
    fail = true;
    await assert.rejects(() => readBoundedStoreRegistryJson(`${url}/failure`, { cache: 'metadata' }));
    fail = false;
    await readBoundedStoreRegistryJson(`${url}/failure`, { cache: 'metadata' }); assert.equal(calls, 5, 'Failure is not retained as a healthy cache entry.');
    block = true;
    const firstAbort = new AbortController(), secondAbort = new AbortController();
    const cancelledFirst = assert.rejects(readBoundedStoreRegistryJson(`${url}/cancel-all`, { cache: 'metadata', signal: firstAbort.signal }));
    const cancelledSecond = assert.rejects(readBoundedStoreRegistryJson(`${url}/cancel-all`, { cache: 'metadata', signal: secondAbort.signal }));
    firstAbort.abort(); secondAbort.abort(); await Promise.all([cancelledFirst, cancelledSecond]);
    assert(fetchAborted, 'The underlying fetch is cancelled when its final consumer leaves.');
    block = false;
    await readBoundedStoreRegistryJson(`${url}/cancel-all`, { cache: 'metadata' }); assert.equal(calls, 7, 'A cancelled in-flight result is replaced by a new real fetch.');
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
}

async function storePageChecks() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load, pages: number[] = [];
  loader._load = (name, parent, main) => /(?:^|\/)plugin-workspace-selection(?:\.ts)?$/u.test(name) ? { resolvePluginWorkspaceCatalogScopeContext: async () => context }
    : /(?:^|\/)plugin-extension-integrations(?:\.ts)?$/u.test(name) ? { readComposioExtensions: async () => ({}), readMcpExtensions: async () => ({}) }
    : /(?:^|\/)capabilities\/packages\/store-actions(?:\.ts)?$/u.test(name) ? {
    listCapabilityPackageStoreAction: async (_actor: unknown, options: { page: number }) => {
      pages.push(options.page);
      return { stores: [{ availability: 'available', offerings: [], pagination: { hasNextPage: true } }] };
    },
  } : original(name, parent, main);
  try {
    const dependencies = await getPluginExtensionSearchDependencies();
    const first = await dependencies.store(actor, { search: 'one' });
    assert.deepEqual(pages, [1]); assert.equal(first.continuation, '2');
    await dependencies.store(actor, { search: 'one', continuation: first.continuation });
    assert.deepEqual(pages, [1, 2], 'One genuine Store page is loaded per source cursor.');
  } finally { loader._load = original; }
}

void (async () => { await phaseChecks(); await registryChecks(); await storePageChecks();
  console.log('PASS extension performance contracts: local/provider phases, installed Store independence, phase-bound cursors, request-local final authority, cancellation, one Store page, bounded public metadata singleflight/TTL and fresh source reads.');
})().catch(error => { console.error(error); process.exitCode = 1; });
