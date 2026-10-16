import assert from 'node:assert/strict';
import { parsePluginExtensionQuery, projectPluginExtensionPage, searchPluginExtensions,
  type PluginExtensionSearchDependencies } from '../app/lib/plugins/plugin-extension-search';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

const actor = { userId: 'core-search-user', workspaceId: 'core-search-workspace' };
const scopes = { choices: ['all', 'user', 'organization', 'system'] as const, teams: [] };
const query = (value = '') => parsePluginExtensionQuery(new URLSearchParams(value));
const baseQuery = 'source=all&stock=installed&scope=system&types=plugin,skill';
const access = { canRead: true, canUse: true, canManage: false };
const creator: PluginExtensionItem = { id: 'canvas-capability:v1:plugin:system:core:plugin-creator', kind: 'plugin',
  name: 'plugin-creator', displayName: 'Plugin Creator', description: 'Create plugins', source: 'local', stock: 'installed',
  ownership: { type: 'system' }, access, package: { resourceRef: 'canvas-capability:v1:plugin:system:core:plugin-creator',
    legacyResourceId: 'canvas-capability:v1:plugin:system:core:plugin-creator', kind: 'plugin', name: 'plugin-creator',
    displayName: 'Plugin Creator', description: 'Create plugins', version: '1.0.0', revision: 1,
    ownership: { type: 'system' }, access: { ...access, canEdit: false } } };
const skill: PluginExtensionItem = { id: 'canvas-capability:v1:skill:system:core:skill-creator', kind: 'skill',
  name: 'skill-creator', displayName: 'Skill Creator', description: 'Create skills', source: 'local', stock: 'installed',
  ownership: { type: 'system' }, access };
const offering: PluginExtensionItem = { id: 'store:plugin:official:available', kind: 'plugin', name: 'available',
  displayName: 'Available Store plugin', description: '', source: 'store', stock: 'available', access: { ...access, canUse: false },
  offering: { kind: 'plugin', registryId: 'official', entryKey: 'available', displayName: 'Available Store plugin', description: '',
    latestVersion: '1.0.0', versions: [{ version: '1.0.0', checksum: 'a'.repeat(64) }], installedResourceRefs: [], installedRefsTruncated: false } };

async function main(): Promise<void> {
  let storeCalls = 0, packageCalls = 0, contextCalls = 0, revalidationCalls = 0;
  let storeOptions: Parameters<PluginExtensionSearchDependencies['store']>[1];
  const dependencies: PluginExtensionSearchDependencies = {
    context: async value => { assert.deepEqual(value, actor); contextCalls++; return { actorUserId: actor.userId,
      workspaceId: actor.workspaceId, readableTeamIds: new Set(), organizationAvailable: true, teams: [] }; },
    packages: async value => { assert.deepEqual(value, actor); packageCalls++; return { items: [creator, skill],
      scopes: { choices: [...scopes.choices], teams: [] }, coverage: { source: 'packages', status: 'complete' } }; },
    store: async (_value, options) => { storeCalls++; storeOptions = options; return { items: [offering], coverage: { source: 'store', status: 'complete' } }; },
    composio: async () => { throw new Error('A package-only query must not load integrations.'); },
    mcp: async () => { throw new Error('A package-only query must not load MCPs.'); },
    revalidate: async (value, items) => { assert.deepEqual(value, actor); revalidationCalls++; return items; },
  };
  for (const failure of ['throw', 'hang'] as const) {
    storeCalls = 0; packageCalls = 0; contextCalls = 0; revalidationCalls = 0;
    const result = await searchPluginExtensions(actor, query(baseQuery), { timeoutMs: 10, dependencies: { ...dependencies,
      store: async () => { storeCalls++; if (failure === 'throw') throw new Error('Unrelated Store is unavailable.'); return new Promise(() => {}); },
    } });
    assert.equal(storeCalls, 0, `Installed System discovery must never enter the ${failure}ing external Store.`);
    assert.deepEqual(result.items.map(item => item.id), [creator.id, skill.id]);
    assert.equal(packageCalls, 1); assert.equal(contextCalls, 2); assert.equal(revalidationCalls, 1);
    assert.deepEqual(result.coverage, [{ source: 'packages', status: 'complete' }]);
    assert.equal(result.pagination.totalItems, 2);
  }
  const revoked = await searchPluginExtensions(actor, query(baseQuery), { dependencies: { ...dependencies,
    revalidate: async (_value, items) => items.map(item => ({ ...item, access: { ...item.access, canRead: false } })),
  } });
  assert.equal(revoked.items.length, 0, 'Skipping Store IO must not bypass current resource Read revalidation.');
  const noUse = await searchPluginExtensions(actor, query(baseQuery), { dependencies: { ...dependencies,
    revalidate: async (_value, items) => items.map(item => ({ ...item, access: { ...item.access, canUse: false } })),
  } });
  assert(noUse.items.length && noUse.items.every(item => !item.access.canUse), 'Readable Core metadata never invents current Use.');
  for (const parameters of [
    'source=store&stock=installed&scope=system&types=plugin',
    'source=all&stock=all&scope=system&types=plugin',
    'source=all&stock=available&scope=system&types=plugin',
    'source=all&stock=installed&scope=all&types=plugin',
    'source=all&stock=installed&scope=user&types=plugin',
    'source=all&stock=installed&scope=organization&types=plugin',
    `${baseQuery}&selected=${encodeURIComponent(offering.id)}`,
  ]) {
    storeCalls = 0;
    const result = await searchPluginExtensions(actor, query(parameters), { dependencies });
    assert.equal(storeCalls, 1, `Existing Store discovery must remain active for ${parameters}.`);
    if (parameters.includes('selected=')) assert.equal(result.selectedItem?.id, offering.id, 'An exact Store selection survives unrelated browse filters.');
  }
  const selection = query(baseQuery);
  const cursor = projectPluginExtensionPage(actor, selection, [], { choices: [...scopes.choices], teams: [] },
    [{ source: 'store', status: 'partial' }], { store: 'second-store-page' }).pagination.nextCursor;
  assert(cursor); storeCalls = 0;
  await searchPluginExtensions(actor, { ...selection, cursor }, { dependencies });
  assert.equal(storeCalls, 1); assert.equal(storeOptions?.continuation, 'second-store-page', 'An existing Store continuation is always preserved.');
  storeCalls = 0;
  const first = await searchPluginExtensions(actor, query(`${baseQuery}&limit=1`), { dependencies });
  assert(first.pagination.nextCursor);
  const next = await searchPluginExtensions(actor, { ...query(`${baseQuery}&limit=1`), cursor: first.pagination.nextCursor }, { dependencies });
  assert.deepEqual([...first.items, ...next.items].map(item => item.id), [creator.id, skill.id]);
  assert.equal(next.pagination.nextCursor, null); assert.equal(storeCalls, 0, 'Local Core pagination must not open a new Store source.');
  const controller = new AbortController(), reason = new Error('The caller cancelled this discovery.');
  let resolvePackages!: (value: Awaited<ReturnType<PluginExtensionSearchDependencies['packages']>>) => void;
  let sourceStarted!: () => void;
  const started = new Promise<void>(resolve => { sourceStarted = resolve; });
  revalidationCalls = 0;
  const pending = searchPluginExtensions(actor, selection, { signal: controller.signal, dependencies: { ...dependencies,
    packages: () => { sourceStarted(); return new Promise(resolve => { resolvePackages = resolve; }); },
  } });
  await started; controller.abort(reason);
  resolvePackages({ items: [creator], scopes: { choices: [...scopes.choices], teams: [] }, coverage: { source: 'packages', status: 'complete' } });
  await assert.rejects(() => pending, error => error === reason);
  assert.equal(revalidationCalls, 0, 'A cancelled query must not project stale source results.');
  assert.equal(storeCalls, 0);
  console.info('PASS Core installed System search: unrelated throwing/hanging Store skipped; package/context/current Read+Use checks retained; explicit Store/filter/selected/continuation and local cursor paths unchanged; caller Abort preserved.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
