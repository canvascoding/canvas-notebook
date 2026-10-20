import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  try {
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const { createCapabilityResourceId } = await import('../app/lib/capabilities/reference');
    const { resolveScopedPluginRegistryPath } = await import('../app/lib/runtime-data-paths');
    const { GET } = await import('../app/api/capabilities/packages/[resourceRef]/icon/route');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20" fill="blue"/></svg>';
    const installed: Array<{ name: string; resourceRef: string; childRef: string }> = [];
    for (let index = 0; index < 10; index++) {
      const name = `targeted-icons-${index}`;
      const files = { '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Targeted actual image', skills: 'skills', interface: { logo: './assets/image.svg' } }),
        'assets/image.svg': svg, 'skills/actual-child/SKILL.md': '---\nname: actual-child\ndescription: Actual child image\n---\n',
        'skills/actual-child/agents/canvas.yaml': 'interface:\n  icon_large: ./image.svg\n', 'skills/actual-child/image.svg': svg };
      const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', files, plugins.computeCanvasPluginChecksum);
      const value = await stores.installCapabilityPackageFromStoreAction(fixture.owner, { source: { kind: 'plugin', registryId: 'store-application', entryKey: name, version: '1.0.0', checksum: archive.checksum },
        ownership: { type: 'organization' }, grants: [{ targetType: 'user', targetId: 'alice', canUse: true, canEdit: false, canManage: false }] });
      installed.push({ name, resourceRef: value.resource.resourceRef, childRef: createCapabilityResourceId({ resourceType: 'skill', scopeType: 'organization', organizationId: fixture.organizationId,
        sourceType: 'plugin', sourcePluginName: name, name: 'actual-child' }) });
    }
    const counts = async () => Promise.all(['capability_resources', 'capability_package_states', 'capability_package_versions', 'capability_resource_history']
      .map(async table => (await fixture.sql.get(`SELECT COUNT(*)::int AS count FROM ${table}`) as { count: number }).count));
    const before = await counts();
    let broadCatalogReads = 0;
    fixture.setBeforeRead(async query => { if (query.includes('SELECT * FROM capability_resources WHERE status =')) broadCatalogReads++; });
    const request = async (resourceRef: string, childName?: string, user = 'alice', revision = '1') => {
      const query = new URLSearchParams({ workspaceId: `personal-${user}`, revision, ...(childName ? { childName } : {}) });
      const headers = fixture.headers(user); headers.delete('x-canvas-workspace-id');
      return GET(new Request(`http://localhost:3001/api/capabilities/packages/${encodeURIComponent(resourceRef)}/icon?${query}`, { headers }),
        { params: Promise.resolve({ resourceRef }) });
    };
    let requests = 0;
    for (const value of installed) for (const [ref, child] of [[value.resourceRef, undefined], [value.resourceRef, 'actual-child'], [value.childRef, undefined]] as const) {
      const response = await request(ref, child); requests++;
      assert.equal(response.status, 200, `${value.name}:${child ?? ref}`); assert.equal(await response.text(), svg);
      const timing = response.headers.get('Server-Timing') ?? '';
      assert.match(timing, /(?:^|, )icon;dur=/u);
      assert(!/(?:^|, )(?:artifact_resolve|catalog);/u.test(timing), 'Actual managed image routes never invoke full artifact or catalogue resolution.');
    }
    assert.equal(requests, 30); assert.equal(broadCatalogReads, 0);
    assert.deepEqual(await counts(), before, 'Thirty genuine image API reads create or mutate no resource, version, draft or history.');
    assert.equal(fixture.providerRequests(), 0);
    const first = installed[0], registryPath = resolveScopedPluginRegistryPath(fixture.organizationScope);
    const parentRecord = await fixture.sql.get('SELECT legacy_resource_id FROM capability_resources WHERE resource_ref=$1', [first.resourceRef]) as { legacy_resource_id: string };
    const childAlias = `canvas-resource:${randomUUID()}`, childKey = createHash('sha256').update(JSON.stringify([
      'skill', first.childRef, 'organization', 'actual-child', 'plugin', fixture.organizationId, null, parentRecord.legacy_resource_id])).digest('hex');
    // Imported historical rows may have a UUID reference for the same immutable
    // child binding. Exercise the actual row through both supported references.
    await fixture.sql.run(`INSERT INTO capability_resources (resource_ref,storage_binding_key,legacy_resource_id,resource_type,source_type,source_plugin_id,artifact_name,
      storage_scope_type,storage_organization_id,storage_owner_user_id,ownership_type,organization_id,owner_user_id,team_workspace_id,
      created_by_user_id,updated_by_user_id,metadata_revision,grants_revision,access_mode,status,created_at,updated_at)
      SELECT $1,$2,$3,'skill','plugin',legacy_resource_id,'actual-child',storage_scope_type,storage_organization_id,storage_owner_user_id,
      ownership_type,organization_id,owner_user_id,team_workspace_id,created_by_user_id,updated_by_user_id,1,1,'restricted','active',created_at,updated_at
      FROM capability_resources WHERE resource_ref=$4`, [childAlias, childKey, first.childRef, first.resourceRef]);
    for (const reference of [childAlias, first.childRef]) {
      const response = await request(reference); assert.equal(response.status, 200); assert.equal(await response.text(), svg);
      assert(!/(?:^|, )(?:artifact_resolve|catalog);/u.test(response.headers.get('Server-Timing') ?? ''));
    }
    assert.equal((await request(childAlias, 'actual-child')).status, 404, 'A stored child cannot be rebound with a childName parameter.');
    assert.equal((await request(first.childRef.replace(':actual-child', ':%61ctual-child'))).status, 404, 'Noncanonical encoded aliases do not manufacture a child binding.');
    const registry = await plugins.readCanvasPluginRegistry(fixture.organizationScope), pointer = registry.plugins[first.name];
    const markerPath = path.join(path.dirname(pointer.installDir), 'published.json'), marker = await fs.readFile(markerPath);
    await fs.chmod(markerPath, 0o600); await fs.writeFile(markerPath, '{"malformed":true}');
    assert.equal((await request(first.resourceRef)).status, 409, 'A malformed snapshot marker cannot be bypassed by the targeted route.');
    await fs.writeFile(markerPath, marker); await fs.chmod(markerPath, 0o400);
    const originalRegistry = await fs.readFile(registryPath), forged = JSON.parse(originalRegistry.toString());
    forged.plugins[first.name].resourceId = 'foreign-exact-record'; await fs.writeFile(registryPath, JSON.stringify(forged));
    assert.equal((await request(first.resourceRef)).status, 409, 'A wrong registry resource identity cannot supply bytes.');
    await fs.writeFile(registryPath, originalRegistry);
    assert.equal((await request(first.resourceRef, 'not-declared')).status, 404);
    assert.equal((await request(first.resourceRef, '../actual-child')).status, 404);
    assert.equal((await request(first.resourceRef, undefined, 'alice', '999')).status, 409);
    assert.equal((await request(first.resourceRef, undefined, 'unassigned')).status, 404);
    let changed = false;
    fixture.setBeforeRead(async query => {
      if (!changed && query.startsWith('SELECT pg_advisory_xact_lock')) {
        changed = true; await fs.chmod(path.join(pointer.installDir, 'assets', 'image.svg'), 0o600);
        await fs.writeFile(path.join(pointer.installDir, 'assets', 'image.svg'), '<svg/>');
      }
    });
    assert.equal((await request(first.resourceRef)).status, 409, 'A source change at the actual held Read boundary cannot return an image.');
    fixture.setBeforeRead(undefined); assert(changed);
    await fs.writeFile(path.join(pointer.installDir, 'assets', 'image.svg'), svg); await fs.chmod(path.join(pointer.installDir, 'assets', 'image.svg'), 0o400);
    await fixture.sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [first.resourceRef, 'alice']);
    assert.equal((await request(first.resourceRef)).status, 404);
    assert.equal((await request(first.childRef)).status, 404, 'A direct child image rechecks current parent Read.');
    assert.equal((await request(childAlias)).status, 404, 'The actual stored child alias rechecks current parent Read too.');
    console.log(`PASS ${fixture.native ? 'native PostgreSQL' : 'PGlite'} targeted icon API: 10 actual immutable plugins / 30 parent, contained-child and direct-child reads; zero full catalogue/artifact resolution, no mutations/provider I/O, exact registry/snapshot identities, current revisions, malformed markers, source-race denial and parent Read revocation.`);
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
