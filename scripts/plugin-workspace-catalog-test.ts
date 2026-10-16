import assert from 'node:assert/strict';
import { CapabilityResourceError, type CapabilityResourceDescriptor, type CapabilityResourceOwnerScope } from '../app/lib/capabilities/resources/contracts';
import { parsePluginWorkspaceCatalogQuery, projectPluginWorkspaceCatalog } from '../app/lib/plugins/plugin-workspace-catalog';
import type { PluginWorkspaceCatalogScopeContext } from '../app/lib/plugins/plugin-workspace-catalog-contracts';

// New pure/query fixture: no configured database, source package, provider, server or browser is opened.
function main() {
  const query = (value = '') => parsePluginWorkspaceCatalogQuery(new URLSearchParams(value));
  const rejects = (callback: () => unknown, status: number) => assert.throws(callback,
    (error: unknown) => error instanceof CapabilityResourceError && error.status === status);
  const owner = (type: 'own' | 'foreign' | 'organization' | 'team' | 'outside-team' | 'system'): CapabilityResourceOwnerScope =>
    type === 'own' || type === 'foreign' ? { type: 'user', ownerUserId: type === 'own' ? 'alice' : 'bob', organizationId: 'org' }
      : type === 'team' || type === 'outside-team' ? { type: 'team', organizationId: 'org', workspaceId: type === 'team' ? 'team-readable' : 'team-private' }
        : type === 'organization' ? { type: 'organization', organizationId: 'org' } : { type: 'system' };
  const resource = (id: string, ownership: CapabilityResourceOwnerScope, options: { skill?: boolean; name?: string; parent?: string; blocked?: boolean; readable?: boolean } = {}): CapabilityResourceDescriptor => ({
    metadata: { resourceRef: `canvas-resource:${id}`, legacyResourceId: `legacy-${id}`, resourceType: options.skill ? 'skill' : 'plugin', sourceType: options.parent ? 'plugin' : 'standalone',
      sourcePluginId: options.parent ?? null, ownership, displayName: options.name ?? 'Same package', description: 'A readable resource',
      responsibleUserId: 'existing-person', createdByUserId: 'existing-person', updatedByUserId: null, metadataRevision: 4, grantsRevision: 5,
      accessMode: 'restricted', status: 'active', createdAt: 1000, updatedAt: 2000 },
    artifact: { resourceType: options.skill ? 'skill' : 'plugin', resourceId: `legacy-${id}`, scopeType: ownership.type === 'system' ? 'system' : ownership.type === 'user' ? 'user' : 'organization',
      name: options.name ?? 'same-package', version: '1.2.3', revision: 7, checksum: 'PRIVATE_CHECKSUM', sourceType: options.parent ? 'plugin' : 'standalone', sourcePluginId: options.parent ?? null },
    access: { canRead: options.readable !== false, canUse: !options.blocked, canEdit: ownership.type === 'user' && ownership.ownerUserId === 'alice', canManage: false },
    activation: { effectivePolicy: options.blocked ? 'blocked' : 'optional', enabled: !options.blocked, readiness: options.blocked ? 'blocked' : 'unknown', blockedReason: options.blocked ? 'A protected shared resource owns this name.' : null },
    grants: [{ id: 'PRIVATE_GRANT_ID', resourceRef: `canvas-resource:${id}`, targetType: 'user', targetId: 'PRIVATE_GRANT_TARGET', canUse: true, canEdit: false, canManage: false,
      createdByUserId: 'PRIVATE_GRANT_CREATOR', updatedByUserId: null, createdAt: 1000, updatedAt: 2000 }],
    people: { owner: { userId: 'PRIVATE_PERSON_ID', name: 'Readable\u202e label' }, responsible: { userId: 'existing-person', name: null } }, ownershipLabel: 'Readable owner',
  });
  const records = [resource('own-shadow', owner('own'), { blocked: true }), resource('shared-user', owner('foreign')), resource('org', owner('organization')),
    resource('team', owner('team')), resource('outside-team', owner('outside-team')), resource('system', owner('system')),
    resource('child', owner('team'), { skill: true, parent: 'legacy-team', name: 'Child skill' }), resource('hidden', owner('foreign'), { readable: false })];
  const context: PluginWorkspaceCatalogScopeContext = { actorUserId: 'alice', organizationAvailable: true, readableTeamIds: new Set(['team-readable', 'team-beyond-picker']),
    teams: [{ teamId: 'team-readable', label: 'Readable team' }, { teamId: 'team-private', label: 'NEVER_EXPOSE_PRIVATE_TEAM' }] };
  const project = (value = '') => projectPluginWorkspaceCatalog(records, context, query(value));
  assert.deepEqual(query(), { kind: null, scope: 'all', audience: null, teamId: null, q: '', page: 1, limit: 20 });
  assert.equal(query('scope=user').audience, 'own');
  for (const value of ['ownerUserId=alice', 'actor=alice', 'source=local', 'kind=plugin&kind=skill', 'scope=team&scope=user', 'workspaceId=a&workspaceId=b',
    'scope=user&teamId=team-readable', 'scope=all&audience=shared', 'scope=team&teamId=', 'kind=other', 'scope=other', 'scope=user&audience=other',
    'page=0', 'page=-1', 'page=1.5', 'page=01', 'page=100001', 'limit=51', 'limit=0', 'q=' + 'x'.repeat(513), 'q=%00', 'workspaceId=%00']) rejects(() => query(value), 400);
  assert.equal(query('q=' + 'x'.repeat(512)).q.length, 512);
  assert.equal(query('workspaceId=personal-alice&scope=user').scope, 'user');
  const all = project();
  assert.equal(all.schemaVersion, 1);
  assert.equal(all.pagination.totalItems, 7);
  assert.deepEqual(all.scopes.teams, [{ teamId: 'team-readable', label: 'Readable team' }]);
  assert(all.scopes.choices.includes('organization'));
  const own = project('scope=user');
  assert.deepEqual(own.items.map(item => item.resourceRef), ['canvas-resource:own-shadow']);
  assert.equal(own.items[0].activation?.readiness, 'blocked');
  assert.equal(own.items[0].activation?.enabled, false);
  assert.equal(own.items[0].access.canUse, false);
  assert.equal(own.items[0].ownership.type, 'user');
  const shared = project('scope=user&audience=shared');
  assert.deepEqual(new Set(shared.items.map(item => item.resourceRef)), new Set(['canvas-resource:shared-user', 'canvas-resource:org', 'canvas-resource:team', 'canvas-resource:outside-team', 'canvas-resource:child']));
  assert.equal(shared.items.find(item => item.resourceRef === 'canvas-resource:outside-team')?.ownership.type, 'team');
  rejects(() => project('scope=team&teamId=team-private'), 404);
  rejects(() => project('scope=team&teamId=unknown'), 404);
  const needsSelection = project('scope=team');
  assert.equal(needsSelection.selection.selectionRequired, 'team');
  assert.deepEqual(needsSelection.items, []);
  assert.equal(needsSelection.pagination.totalItems, 0);
  assert.deepEqual(project('scope=team&teamId=team-readable').items.map(item => item.resourceRef).sort(), ['canvas-resource:child', 'canvas-resource:team']);
  assert.deepEqual(project('scope=team&teamId=team-beyond-picker').items, []);
  assert.deepEqual(project('scope=organization').items.map(item => item.resourceRef), ['canvas-resource:org']);
  assert.deepEqual(project('scope=system').items.map(item => item.resourceRef), ['canvas-resource:system']);
  const childOnly = project('kind=skill&limit=1');
  assert.equal(childOnly.items[0].parentResourceRef, 'canvas-resource:team');
  assert.equal(childOnly.items[0].kind, 'skill');
  const duplicateParent = resource('different-parent', owner('team'));
  duplicateParent.artifact.resourceId = 'legacy-team';
  const ambiguous = projectPluginWorkspaceCatalog([...records, duplicateParent], context, query('kind=skill'));
  assert.equal(ambiguous.items[0].parentResourceRef, undefined);
  assert.equal(project('q=child').items[0].resourceRef, 'canvas-resource:child');
  assert.equal(project('q=readable+owner').pagination.totalItems, 7);
  const one = project('limit=2&page=1'), two = project('limit=2&page=2');
  assert.equal(one.pagination.hasNextPage, true);
  assert.equal(one.pagination.hasPreviousPage, false);
  assert.equal(two.pagination.hasPreviousPage, true);
  assert(!one.items.some(item => two.items.some(other => item.resourceRef === other.resourceRef)));
  assert.deepEqual(projectPluginWorkspaceCatalog([...records].reverse(), context, query('limit=2&page=2')), two);
  assert.deepEqual(project('page=100000').items, []);
  const empty = projectPluginWorkspaceCatalog([], context, query());
  assert(empty.scopes.choices.includes('organization'), 'An accessible current organization is selectable even without installed resources.');
  assert.equal(empty.pagination.totalPages, 0);
  const serialized = JSON.stringify(all);
  for (const forbidden of ['PRIVATE_CHECKSUM', 'PRIVATE_GRANT', 'PRIVATE_PERSON_ID', 'NEVER_EXPOSE_PRIVATE_TEAM', 'checksum', 'sourcePluginId', 'createdByUserId']) assert(!serialized.includes(forbidden));
  assert.equal(all.items[0].people?.owner?.name, 'Readable label');
  assert.equal(all.items[0].people?.responsible?.name, null);
  const duplicate = projectPluginWorkspaceCatalog([...records, structuredClone(records[0])], context, query());
  assert.equal(duplicate.pagination.totalItems, 7);
  const inconsistent = structuredClone(records[0]);
  inconsistent.access.canUse = true;
  rejects(() => projectPluginWorkspaceCatalog([...records, inconsistent], context, query()), 503);
  const archived = structuredClone(records[0]);
  archived.metadata.status = 'archived';
  assert.deepEqual(projectPluginWorkspaceCatalog([archived], context, query()).items, []);
  const legacyDescription = structuredClone(records[0]);
  legacyDescription.metadata.description = null;
  legacyDescription.description = 'Safe legacy source description';
  assert.equal(projectPluginWorkspaceCatalog([legacyDescription], context, query()).items[0].description, 'Safe legacy source description');
  legacyDescription.metadata.description = 'Current metadata description';
  assert.equal(projectPluginWorkspaceCatalog([legacyDescription], context, query()).items[0].description, 'Current metadata description');
  const longAlias = structuredClone(records[0]);
  const noImage = structuredClone(records[0]);
  noImage.artifact.hasDeclaredIcon = false;
  assert.equal(projectPluginWorkspaceCatalog([noImage], context, query()).items[0].icon, undefined,
    'Known image-free packages must not create speculative image requests.');
  noImage.artifact.hasDeclaredIcon = true;
  assert(projectPluginWorkspaceCatalog([noImage], context, query()).items[0].icon,
    'Declared local images retain the authorized image endpoint.');
  longAlias.metadata.resourceRef = 'canvas-capability:v1:' + 'x'.repeat(1500);
  longAlias.artifact.resourceId = longAlias.metadata.resourceRef;
  assert.equal(projectPluginWorkspaceCatalog([longAlias], context, query()).items[0].resourceRef, longAlias.metadata.resourceRef);
  longAlias.metadata.resourceRef = 'x'.repeat(2049);
  rejects(() => projectPluginWorkspaceCatalog([longAlias], context, query()), 503);
  all.items[0].access.canRead = false;
  assert(records.every(record => record.artifact.resourceId === 'legacy-hidden' || record.access.canRead));
  assert.equal(records[0].people?.owner?.name, 'Readable\u202e label');
  console.log('Plugin workspace catalog query/projection PASS: exact identities, own/shared/team scopes, namespace metadata, bounded deterministic pages and safe output.');
}

main();
