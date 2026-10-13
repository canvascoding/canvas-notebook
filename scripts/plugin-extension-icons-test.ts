import assert from 'node:assert/strict';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import { installedPluginExtensionIcon, publicPluginExtensionIcon } from '../app/lib/plugins/plugin-extension-icons';
import { projectPluginWorkspaceCatalog } from '../app/lib/plugins/plugin-workspace-catalog';
import { projectScopedCapabilityPackageStore } from '../app/lib/capabilities/packages/store-scoped-projection';

const safe = publicPluginExtensionIcon('https://images.example/logo.svg?token=PRIVATE_TOKEN#private', 'composio:canva');
assert.equal(safe?.url, 'https://images.example/logo.svg');
assert(!JSON.stringify(safe).includes('PRIVATE_TOKEN'));
for (const value of ['http://example.com/x', 'https://user:PRIVATE_PASSWORD@example.com/x', 'data:image/svg+xml,x', 'file:///private/x',
  '//example.com/logo', 'https://example.com/\u0000', 'https://example.com/' + 'x'.repeat(4096)]) assert.equal(publicPluginExtensionIcon(value, 'x'), undefined);
const first = installedPluginExtensionIcon('canvas-resource:one', 4, 'workspace-a');
const url = new URL(first.url, 'https://canvas.example');
assert.equal(decodeURIComponent(url.pathname.split('/')[4]), 'canvas-resource:one');
assert.equal(url.searchParams.get('revision'), '4');
assert.equal(url.searchParams.get('workspaceId'), 'workspace-a');
assert.notEqual(first.sourceKey, installedPluginExtensionIcon('canvas-resource:one', 5, 'workspace-a').sourceKey);
assert.notEqual(first.sourceKey, installedPluginExtensionIcon('canvas-resource:one', 4, 'workspace-b').sourceKey);
assert.notEqual(first.sourceKey, installedPluginExtensionIcon('canvas-resource:two', 4, 'workspace-a').sourceKey);
assert.equal(new URL(installedPluginExtensionIcon('canvas-resource:one', 4, 'workspace-a', 'skill-a').url, url.origin).searchParams.get('childName'), 'skill-a');
const resource = (resourceRef: string, readable = true): CapabilityResourceDescriptor => ({
  metadata: {resourceRef, legacyResourceId: resourceRef, resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null,
    ownership: {type: 'user', ownerUserId: 'alice', organizationId: null}, displayName: 'Same name', description: '',
    responsibleUserId: null, createdByUserId: 'alice', updatedByUserId: null, metadataRevision: 1, grantsRevision: 1,
    accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1},
  artifact: {resourceType: 'plugin', resourceId: resourceRef, scopeType: 'user', name: 'same-name', version: '1.0.0',
    checksum: 'PRIVATE_DIGEST', revision: 4, sourceType: 'standalone', sourcePluginId: null},
  access: {canRead: readable, canUse: false, canEdit: false, canManage: false},
});
const context = {actorUserId: 'alice', workspaceId: 'workspace-a', organizationAvailable: false, readableTeamIds: new Set<string>(), teams: []};
const rows = [resource('canvas-resource:one'), resource('canvas-resource:two'), resource('canvas-resource:hidden', false)];
const catalog = projectPluginWorkspaceCatalog(rows, context, {kind: null, scope: 'all', audience: null, teamId: null, q: '', page: 1, limit: 20});
assert.equal(catalog.items.length, 2);
assert.deepEqual(catalog.items[0].icon, first);
assert.notEqual(catalog.items[0].icon?.sourceKey, catalog.items[1].icon?.sourceKey, 'same display names preserve exact image sources');
assert(!JSON.stringify(catalog).includes('PRIVATE_DIGEST'));
const store = projectScopedCapabilityPackageStore(rows, context, {}, {plugin: {schemaVersion: 1, id: 'registry', name: 'Store', updatedAt: '',
  registryUrl: 'https://registry.example/private?key=PRIVATE_KEY', plugins: [{name: 'same-name', displayName: 'Same name', description: '',
    iconUrl: 'https://images.example/package.svg?key=PRIVATE_KEY#private', latestVersion: '1.0.0',
    versions: {'1.0.0': {version: '1.0.0', checksum: 'a'.repeat(64), downloadUrl: 'https://registry.example/package.zip'}}}]}, skill: null}, new Map());
assert.deepEqual(store.installed.resources.find(row => row.metadata.resourceRef === 'canvas-resource:one')?.icon, first);
assert.equal(store.stores[0].offerings[0].icon?.url, 'https://images.example/package.svg');
assert(!JSON.stringify(store).includes('PRIVATE_KEY'));
console.log('PASS exact catalog/update image provenance, workspace/revision isolation and safe public logo metadata.');
