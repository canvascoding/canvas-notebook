import assert from 'node:assert/strict';
import Module from 'node:module';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { PluginExtensionConnection, PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'Real PostgreSQL profile acceptance never falls back to an in-memory database.');
  const fixture = await createCapabilityPackageStoreApplicationFixture({native: true});
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, main: boolean) => unknown;
    _resolveFilename: (name: string, parent: NodeModule | null) => string};
  const previousLoad = loader._load;
  let mode: 'local' | 'managed' | 'disabled' = 'local';
  const entityAccounts = new Map<string, string>(), queriedEntities: string[] = [];
  const sdk = {
    getComposioMode: async () => mode,
    getComposio: async () => ({
      getClient: () => ({toolkits: {list: async () => ({items: [{slug: 'canva', name: 'Canva', noAuth: false}], next_cursor: null})}}),
      connectedAccounts: {list: async (query: {userIds: string[]}) => {
        assert.equal(query.userIds.length, 1);queriedEntities.push(query.userIds[0]);
        const id = entityAccounts.get(query.userIds[0]);assert(id, 'Accounts use the actual resolved profile entity');
        return {items: [{id, toolkit: {slug: 'canva', name: 'Canva'}, status: 'ACTIVE'}], next_cursor: null};
      }},
    }),
  };
  loader._load = (name, parent, isMain) => {
    let resolved = name;
    try { resolved = loader._resolveFilename(name, parent); } catch { /* Alias can still match below. */ }
    return name === '@/app/lib/composio/composio-client' || resolved === `${process.cwd()}/app/lib/composio/composio-client.ts`
      ? sdk : previousLoad(name, parent, isMain);
  };
  try {
    assert.equal(fixture.native, true);
    const profiles = await import('../app/lib/composio/composio-profiles');
    const contexts = await import('../app/lib/composio/composio-context');
    const {readComposioExtensions, revalidatePersonalComposioExtensionConnection} = await import('../app/lib/plugins/plugin-extension-integrations');
    const {searchPluginExtensions, parsePluginExtensionQuery} = await import('../app/lib/plugins/plugin-extension-search');
    const defaultProfile = await profiles.ensureDefaultComposioProfile(fixture.owner.userId);
    const override = await profiles.createComposioProfile({ownerUserId: fixture.owner.userId, name: 'Workspace design'});
    const separate = await profiles.createComposioProfile({ownerUserId: fixture.owner.userId, name: 'Separate account'});
    for (const [index, profile] of [defaultProfile, override, separate].entries()) entityAccounts.set(profile.composioUserId, `account-${index}`);
    const effective = await contexts.resolveComposioContext(fixture.owner), bound = await contexts.resolveBoundComposioContext({...fixture.owner, profileId: defaultProfile.id});
    assert.notEqual(effective.cacheRevision, bound.cacheRevision, 'Real effective and fixed-bound profile revisions deliberately differ');
    const personal = (items: PluginExtensionItem[]) => {
      const item = items.find(value => value.kind === 'integration' && value.name === 'canva');assert(item?.kind === 'integration');
      return item.connections.filter(connection => connection.ownership.type === 'user' && connection.ownership.ownerUserId === fixture.owner.userId);
    };
    const read = async () => {
      const result = await readComposioExtensions(fixture.owner, new AbortController().signal);assert.equal(result.coverage.status, 'complete');
      const values = personal(result.items);assert.equal(values.length, 3);return values;
    };
    const checkAll = async (values: PluginExtensionConnection[]) => {
      for (const connection of values) {
        assert.equal(connection.authorization, 'authorized');assert.equal(connection.health, 'unknown');
        assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, connection), true, connection.profileId);
      }
      const publicBody = JSON.stringify(values);
      for (const value of [defaultProfile.composioUserId, effective.cacheRevision, bound.cacheRevision, 'profileRevision', '"context":']) {
        assert(!publicBody.includes(value), 'Private provider entity/revalidation provenance never enters connection DTOs');
      }
    };
    const original = await read();await checkAll(original);
    const searched = await searchPluginExtensions(fixture.owner, parsePluginExtensionQuery(new URLSearchParams('types=integration&q=canva&limit=1')));
    assert.equal(personal(searched.items).length, 3, 'Common search retains the currently authorized real default profile account');
    assert(!searched.coverage.some(value => value.error?.code === 'COMPOSIO_BINDING_CHANGED'));
    await profiles.setComposioWorkspaceProfileOverride({userId: fixture.owner.userId, workspaceId: fixture.owner.workspaceId!, profileId: override.id});
    const inOverride = await read();await checkAll(inOverride);
    const overrideConnection = inOverride.find(value => value.profileId === override.id);assert(overrideConnection);
    const boundConnection = inOverride.find(value => value.profileId === separate.id);assert(boundConnection);
    await profiles.setComposioWorkspaceProfileOverride({userId: fixture.owner.userId, workspaceId: fixture.owner.workspaceId!, profileId: separate.id});
    assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, overrideConnection), false, 'A current workspace override switch invalidates its previous effective observation');
    assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, boundConnection), true, 'An explicitly observed readable non-effective binding keeps its own semantics');
    const afterSwitch = await read();await checkAll(afterSwitch);
    const nowBoundOverride = afterSwitch.find(value => value.profileId === override.id);assert(nowBoundOverride);
    await profiles.archiveComposioProfile({ownerUserId: fixture.owner.userId, profileId: override.id});
    assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, nowBoundOverride), false, 'An archived owned profile never survives revalidation');
    const current = afterSwitch.find(value => value.profileId === separate.id);assert(current);
    for (const changedMode of ['managed', 'disabled'] as const) {
      mode = changedMode;assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, current), false, 'Provider mode change fails closed');
    }
    mode = 'local';assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, current), true);
    await fixture.sql.run('UPDATE canvas_workspaces SET status=$1 WHERE id=$2', ['archived', fixture.owner.workspaceId]);
    assert.equal(await revalidatePersonalComposioExtensionConnection(fixture.owner, current), false, 'Revoked workspace access fails closed');
    assert.equal(fixture.providerRequests(), 0);assert(queriedEntities.includes(defaultProfile.composioUserId));
    console.log('PASS real PostgreSQL Composio profiles: effective default/override and bound account revalidation, common search, late switches/archive/mode/workspace revoke, private provenance.');
  } finally { loader._load = previousLoad;await fixture.close(); }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
