import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CapabilityResourceDescriptor, CapabilityResourceOwnerScope } from '../app/lib/capabilities/resources/contracts';
import type { CanvasSkillStoreRegistry } from '../app/lib/skills/canvas-skill-store';
import type { CanvasPluginStoreRegistry } from '../app/lib/plugins/canvas-plugin-store';
import { capabilityPackageStoreListSchema } from '../app/lib/capabilities/packages/store-contracts';
import { capabilityPackageStoreCatalogQuery, prioritizeScopedStoreResources, projectScopedCapabilityPackageStore,
  retainCurrentScopedStoreObservations } from '../app/lib/capabilities/packages/store-scoped-projection';
import { capabilityStoreRegistryIdentity } from '../app/lib/capabilities/packages/store-origin';
import { installedStoreResourceObservation, type PrivateInstalledStoreResource } from '../app/lib/plugins/store-installed-resource';
import { selectPluginWorkspaceCatalogResources } from '../app/lib/plugins/plugin-workspace-catalog';

// New pure contract/projection fixture. No database, filesystem, remote source or provider is opened.
function main() {
  const registryUrl = 'https://private-registry.invalid/source?token=NEVER_EXPOSE_URL';
  const digest = 'a'.repeat(64), latestDigest = 'b'.repeat(64);
  const context = { actorUserId: 'alice', organizationAvailable: true, readableTeamIds: new Set(['readable-team']), teams: [{ teamId: 'readable-team', label: 'Design team' }] };
  const user: CapabilityResourceOwnerScope = { type: 'user', ownerUserId: 'alice', organizationId: 'org' };
  const resource = (index: number, ownership: CapabilityResourceOwnerScope = user, kind: 'plugin' | 'skill' = 'plugin'): CapabilityResourceDescriptor => {
    const resourceRef = `canvas-resource:${randomUUID()}`, legacyResourceId = `legacy-${kind}-${index}`;
    return { metadata: { resourceRef, legacyResourceId, resourceType: kind, sourceType: 'standalone', sourcePluginId: null, ownership,
      displayName: `Resource ${String(index).padStart(3, '0')}`, description: 'Selected metadata', responsibleUserId: null,
      createdByUserId: 'alice', updatedByUserId: null, metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
    access: { canRead: true, canUse: false, canEdit: false, canManage: false },
    artifact: { resourceType: kind, resourceId: legacyResourceId, scopeType: ownership.type === 'user' ? 'user' : 'organization', name: 'same-name',
      version: '1.0.0', checksum: 'PRIVATE_LOCAL_CHECKSUM', revision: 1, sourceType: 'standalone', sourcePluginId: null } };
  };
  const versions = { '1.0.0': { version: '1.0.0', checksum: digest, downloadUrl: 'https://private-archive.invalid/secret' },
    '2.0.0': { version: '2.0.0', checksum: latestDigest, downloadUrl: 'https://private-archive.invalid/secret', notes: 'New release', releasedAt: '2026-10-07' } };
  const plugin: CanvasPluginStoreRegistry = { schemaVersion: 1, id: 'registry', name: 'Store', updatedAt: 'today', registryUrl,
    plugins: [{ name: 'same-name', displayName: 'Same package', description: 'Offering', latestVersion: '2.0.0', versions, publisher: { name: 'Publisher', url: 'https://secret-publisher.invalid' } }] };
  const skill: CanvasSkillStoreRegistry = { schemaVersion: 1, id: 'registry', name: 'Store', updatedAt: 'today', registryUrl,
    skills: [{ name: 'same-name', displayName: 'Same skill', description: 'Offering', latestVersion: '2.0.0', versions }] };
  const observe = (records: readonly CapabilityResourceDescriptor[], derived = false) => new Map(records.map(record => [record.metadata.resourceRef, {
    resourceRef: record.metadata.resourceRef, checksum: digest, observation: installedStoreResourceObservation(record),
    origin: { contractVersion: 1 as const, resourceId: record.artifact.resourceId, registryId: 'registry', registryIdentity: capabilityStoreRegistryIdentity(registryUrl),
      kind: record.artifact.resourceType, entryKey: 'same-name', version: '1.0.0', checksumAlgorithm: 'canvas-package-tree-sha256-v1' as const,
      upstreamChecksum: digest, baselineChecksum: digest, relation: derived ? 'derived' as const : 'installed' as const, verifiedAt: 1 },
  }]));
  const records = Array.from({ length: 65 }, (_, index) => resource(index));
  const organization = resource(80, { type: 'organization', organizationId: 'org' });
  const outsideTeam = resource(81, { type: 'team', organizationId: 'org', workspaceId: 'unreadable-team' });
  const selectedQuery = capabilityPackageStoreListSchema.parse({ scope: 'user', installedPage: 3, installedLimit: 20 });
  const catalogQuery = capabilityPackageStoreCatalogQuery(selectedQuery);
  const selected = selectPluginWorkspaceCatalogResources([...records, organization, outsideTeam], context, catalogQuery);
  const priority = prioritizeScopedStoreResources(selected, catalogQuery);
  assert.deepEqual(priority.slice(0, 20).map(item => item.metadata.displayName), records.slice(40, 60).map(item => item.metadata.displayName));
  const observations = observe(priority.slice(0, 32));
  const result = projectScopedCapabilityPackageStore([...records, organization, outsideTeam], context, selectedQuery, { plugin, skill }, observations);
  assert.equal(result.installed.summary.total, 65);
  assert.equal(result.installed.summary.observed, 32);
  assert.equal(result.installed.summary.updates, 32);
  assert.equal(result.installed.summary.unknown, 33);
  assert.equal(result.installed.summary.comparison, 'partial');
  assert.equal(result.installed.resources.length, 20);
  assert(result.installed.resources.every(item => item.storeState?.upstream === 'update-available'));
  assert.equal(result.stores[0].installedResources.length, 50);
  assert.equal(result.installed.pagination.totalItems, 65);
  assert.equal(result.installed.pagination.hasNextPage, true);
  assert.deepEqual(new Set(result.stores[0].offerings[0].installedResourceRefs), new Set(priority.slice(0, 32).map(item => item.metadata.resourceRef)));
  assert.equal(result.stores[0].offerings[0].publisher?.name, 'Publisher');
  assert.equal(result.stores[0].offerings[0].versions[0].checksum, latestDigest);
  assert.equal(result.stores[0].offerings[0].versions[0].notes, 'New release');
  for (const forbidden of ['NEVER_EXPOSE_URL', 'private-archive', 'secret-publisher', 'PRIVATE_LOCAL_CHECKSUM', 'registryIdentity', 'downloadUrl', 'installDir']) assert(!JSON.stringify(result).includes(forbidden));
  const all = [records[0], organization, outsideTeam, resource(90, user, 'skill')];
  const allObserved = observe(all);
  const both = projectScopedCapabilityPackageStore(all, context, {}, { plugin, skill }, allObserved);
  assert.equal(both.installed.summary.total, 4);
  assert.equal(both.installed.summary.comparison, 'known');
  assert.equal(new Set(both.stores[0].offerings[0].installedResourceRefs).size, 3, 'Same names preserve exact three different owners/instances.');
  const shared = projectScopedCapabilityPackageStore(all, context, { scope: 'user', audience: 'shared' }, { plugin, skill }, allObserved);
  assert.deepEqual(new Set(shared.installed.resources.map(item => item.metadata.resourceRef)), new Set([organization.metadata.resourceRef, outsideTeam.metadata.resourceRef]));
  assert.throws(() => projectScopedCapabilityPackageStore(all, context, { scope: 'team', teamId: 'unreadable-team' }, { plugin, skill }, allObserved), /unavailable/u);
  assert.equal(projectScopedCapabilityPackageStore(all, context, { scope: 'team' }, { plugin, skill }, allObserved).selection.selectionRequired, 'team');
  const derived = projectScopedCapabilityPackageStore([records[0]], context, {}, { plugin, skill }, observe([records[0]], true));
  assert.deepEqual(derived.stores[0].offerings[0].installedResourceRefs, []);
  assert.equal(derived.installed.summary.unknown, 1);
  const outage = projectScopedCapabilityPackageStore(all, context, {}, { plugin: null, skill: null }, allObserved);
  assert.equal(outage.installed.summary.total, 4);
  assert.equal(outage.installed.summary.updates, 0);
  assert.equal(outage.installed.summary.unknown, 4);
  assert(outage.installed.resources.every(item => item.storeState?.upstream === 'unknown'));
  const changed = structuredClone(records[0]); changed.metadata.metadataRevision += 1;
  const retained = retainCurrentScopedStoreObservations(all, [changed, organization], allObserved);
  assert(!retained.has(changed.metadata.resourceRef));
  assert(!retained.has(outsideTeam.metadata.resourceRef));
  assert(retained.has(organization.metadata.resourceRef));
  assert.equal(projectScopedCapabilityPackageStore([changed, organization], context, {}, { plugin, skill }, retained).installed.summary.unknown, 1);
  const renamed = structuredClone(records[0]); renamed.metadata.displayName = 'Locally renamed'; renamed.metadata.description = 'Local wording';
  const searched = projectScopedCapabilityPackageStore([renamed], context, { q: 'Same package', kind: 'plugin' }, { plugin, skill }, observe([renamed]));
  assert.equal(searched.installed.resources.length, 0);
  assert.equal(searched.installed.summary.total, 1);
  assert.deepEqual(searched.stores[0].offerings[0].installedResourceRefs, [renamed.metadata.resourceRef], 'Offering search never removes the exact scope-wide installation link.');
  assert.equal(searched.stores[0].installedResources.length, 1);
  const builtin = structuredClone(records[0]); builtin.artifact.sourceType = 'core'; builtin.artifact.scopeType = 'system'; builtin.metadata.ownership = { type: 'system' };
  assert.deepEqual(prioritizeScopedStoreResources([builtin, organization], capabilityPackageStoreCatalogQuery({})), [organization]);
  const checkedUnknown = retainCurrentScopedStoreObservations([records[0]], [records[0]], new Map([[records[0].metadata.resourceRef,
    { resourceRef: records[0].metadata.resourceRef, origin: null, checksum: null }]]));
  const unknownResult = projectScopedCapabilityPackageStore([records[0]], context, {}, { plugin, skill }, checkedUnknown);
  assert.equal(unknownResult.installed.summary.observed, 1, 'Checked unknown does not become known, but counts toward observation coverage.');
  assert.equal(unknownResult.installed.summary.unknown, 1);
  const modifiedObservation = observe([records[0]]); modifiedObservation.get(records[0].metadata.resourceRef)!.checksum = 'c'.repeat(64);
  const modified = projectScopedCapabilityPackageStore([records[0]], context, { installedState: 'attention' }, { plugin, skill }, modifiedObservation);
  assert.equal(modified.installed.summary.modified, 1); assert.equal(modified.installed.summary.unknown, 0);
  assert.equal(modified.installed.summary.updates, 1); assert.equal(modified.installed.summary.comparison, 'known');
  assert.equal(modified.installed.resources.length, 1, 'Modified and update-available are independent axes.');
  const attention = projectScopedCapabilityPackageStore(records, context, { scope: 'user', installedState: 'attention', installedLimit: 50 }, { plugin, skill }, observations);
  assert.equal(attention.installed.pagination.totalItems, 33);
  assert(attention.installed.resources.every(item => item.storeState?.upstream === 'unknown'));
  const updates = projectScopedCapabilityPackageStore(records, context, { scope: 'user', installedState: 'updates', installedLimit: 50 }, { plugin, skill }, observations);
  assert.equal(updates.installed.pagination.totalItems, 32);
  assert.equal(updates.installed.summary.comparison, 'partial');
  for (const value of [{ audience: 'shared' }, { scope: 'all', audience: 'shared' }, { scope: 'user', teamId: 'x' }, { scope: 'other' },
    { installedLimit: 51 }, { installedPage: 0 }, { installedState: 'ready' }, { actorUserId: 'alice' }, { q: '\0' }]) assert(!capabilityPackageStoreListSchema.safeParse(value).success);
  const privateMap: ReadonlyMap<string, PrivateInstalledStoreResource> = allObserved;
  assert.equal(privateMap.size, 4);
  console.log('Scoped Store projection PASS: one scope selector, exact offering refs, prioritized 32 budget, >50 pagination, honest partial/outage/derived state and late observation invalidation.');
}
main();
