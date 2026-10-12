import assert from 'node:assert/strict';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';

// New isolated PostgreSQL-engine/HTTP fixture. Only DB transport is substituted; seats, Auth, packages and ACL are real.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const { registry, owner, alice, manager, sql } = fixture;
  let releaseWait: (() => void) | undefined;
  try {
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const resources = await import('../app/lib/capabilities/resources/actions');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const route = await import('../app/api/capabilities/packages/store/route');
    const add = async (name: string, version: string): Promise<CapabilityPackageStoreSelection> => {
      const prepared = await registry.addPackage('application', 'plugin', name, version, {
        '.canvas-plugin/plugin.json': JSON.stringify({ name, version, description: 'Controlled scope offering', skills: './skills' }),
        [`skills/${name}-context/SKILL.md`]: `---\nname: ${name}-context\ndescription: Controlled context\nmetadata:\n  version: ${version}\n---\n\nPrivate fixture bytes.\n`,
      }, plugins.computeCanvasPluginChecksum);
      return { kind: 'plugin', registryId: 'store-application', entryKey: name, version, checksum: prepared.checksum };
    };
    const source = await add('scoped-design', '1.0.0');
    const userGrant = { targetType: 'user' as const, targetId: 'alice', canUse: true, canEdit: false, canManage: false };
    const own = await stores.installCapabilityPackageFromStoreAction(alice, { source, ownership: { type: 'user' } });
    const org = await stores.installCapabilityPackageFromStoreAction(owner, { source, ownership: { type: 'organization' }, grants: [userGrant] });
    const shared = await stores.installCapabilityPackageFromStoreAction(fixture.actor('bob'), { source, ownership: { type: 'user' }, grants: [userGrant] });
    const teamSource = await add('scoped-team-design', '1.0.0');
    const team = await stores.installCapabilityPackageFromStoreAction(manager, { source: teamSource, ownership: { type: 'team', workspaceId: 'store-team' }, grants: [userGrant] });
    await add('scoped-design', '2.0.0');
    await add('scoped-team-design', '2.0.0');
    const renamed = await resources.updateCapabilityResource(alice, own.resource.resourceRef, {
      expectedMetadataRevision: own.resource.metadataRevision, expectedGrantsRevision: own.resource.grantsRevision,
      metadata: { displayName: 'My custom label', description: 'My locally configured description' },
    });
    assert.equal(renamed.metadata.displayName, 'My custom label');
    registry.resetCounts();
    const selectedOwn = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin', scope: 'user', q: 'scoped-design' });
    assert.equal(selectedOwn.installed.resources.length, 1); // The unchanged technical name remains searchable.
    assert.equal(selectedOwn.installed.summary.total, 1);
    assert.deepEqual(selectedOwn.stores[0].offerings[0].installedResourceRefs, [own.resource.resourceRef]);
    const offeringQuery = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin', scope: 'user', q: 'Controlled public offering' });
    assert.equal(offeringQuery.installed.resources.length, 0);
    assert.deepEqual(offeringQuery.stores[0].offerings[0].installedResourceRefs, [own.resource.resourceRef], 'Offering q preserves the renamed exact installed relation.');
    const selectedOrg = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin', scope: 'organization' });
    assert.equal(selectedOrg.installed.summary.total, 1);
    assert.equal(selectedOrg.installed.resources[0].metadata.resourceRef, org.resource.resourceRef);
    assert.equal(selectedOrg.installed.resources[0].access.canManage, false);
    assert.equal(selectedOrg.installed.resources[0].access.canEdit, false);
    assert.equal(selectedOrg.installed.summary.updates, 1);
    assert.equal(selectedOrg.installed.summary.comparison, 'known');
    const selectedShared = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin', scope: 'user', audience: 'shared' });
    assert.deepEqual(new Set(selectedShared.installed.resources.map(item => item.metadata.resourceRef)), new Set([org.resource.resourceRef, shared.resource.resourceRef, team.resource.resourceRef]));
    assert.equal(selectedShared.installed.resources.find(item => item.metadata.resourceRef === team.resource.resourceRef)?.metadata.ownership.type, 'team');
    assert(!selectedShared.scopes.teams.some(value => value.teamId === 'store-team'), 'Exact Team resource grant does not grant team browse authority.');
    await assert.rejects(() => stores.listCapabilityPackageStoreAction(alice, { scope: 'team', teamId: 'store-team' }), { status: 404 });
    const selectedTeam = await stores.listCapabilityPackageStoreAction(manager, { kind: 'plugin', scope: 'team', teamId: 'store-team' });
    assert.equal(selectedTeam.installed.resources[0].metadata.resourceRef, team.resource.resourceRef);
    const requiredTeam = await stores.listCapabilityPackageStoreAction(manager, { kind: 'plugin', scope: 'team' });
    assert.equal(requiredTeam.selection.selectionRequired, 'team'); assert.deepEqual(requiredTeam.installed.resources, []);
    const all = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin' });
    assert.equal(all.installed.resources.filter(item => item.artifact.name === 'scoped-design').length, 3);
    assert.deepEqual(new Set(all.stores[0].offerings.find(item => item.entryKey === 'scoped-design')!.installedResourceRefs), new Set([own.resource.resourceRef, org.resource.resourceRef, shared.resource.resourceRef]));
    assert.equal(registry.count('archive'), 0, 'Metadata discovery performs no archive download.');
    assert.equal(fixture.providerRequests(), 0);
    console.log('scoped-store: actual readonly Org, exact same-name instances, own/shared/team grants and metadata-only discovery PASS');

    // Actual complete local package imports exercise >50 selected resources without fabricated resource/permission rows.
    for (let index = 0; index < 55; index += 1) {
      const name = `scoped-bulk-${String(index).padStart(3, '0')}`;
      const installed = await importSkillPackage({ kind: 'text', content: `---\nname: ${name}\ndescription: Bulk pagination package\n---\n\nPrivate complete local package.\n` },
        { scope: fixture.userScope('alice'), updatedBy: 'alice', enable: false });
      assert.equal(installed.success, true);
    }
    const page1 = await stores.listCapabilityPackageStoreAction(alice, { kind: 'skill', scope: 'user', installedLimit: 50, q: 'scoped-bulk' });
    const page2 = await stores.listCapabilityPackageStoreAction(alice, { kind: 'skill', scope: 'user', installedLimit: 50, installedPage: 2, q: 'scoped-bulk' });
    assert.equal(page1.installed.pagination.totalItems, 55); assert.equal(page1.installed.resources.length, 50); assert.equal(page2.installed.resources.length, 5);
    assert(!page1.installed.resources.some(item => page2.installed.resources.some(other => item.metadata.resourceRef === other.metadata.resourceRef)));
    assert.equal(page1.installed.summary.observed, 32); assert.equal(page1.installed.summary.comparison, 'unknown');
    assert.equal(page1.installed.summary.total, 56, 'Scope summary also includes the existing own plugin child outside the q-filtered installed rows.');
    assert.equal(page1.installed.summary.unknown, 56); assert.equal(page1.installed.summary.updates, 0);
    assert.equal(page2.installed.summary.observed, 32);
    console.log('scoped-store: actual 55 complete local packages, independent installed pages and honest checked-unknown budget PASS');

    const get = (query = '', userId = 'alice', workspaceId = `personal-${userId}`) => {
      const headers = fixture.headers(userId); headers.set('x-canvas-workspace-id', workspaceId);
      return route.GET(new Request(`http://localhost:3001/api/capabilities/packages/store?${query}`, { headers }), { params: Promise.resolve({}) });
    };
    const response = await get('kind=plugin&scope=organization&installedLimit=1');
    assert.equal(response.status, 200);
    const publicResponse = (await response.json() as { data: CapabilityPackageStoreListResponse }).data;
    assert.equal(publicResponse.installed.resources[0].metadata.resourceRef, org.resource.resourceRef);
    assert.equal(publicResponse.installed.resources[0].access.canManage, false);
    for (const forbidden of [fixture.root, registry.baseUrl, 'registryIdentity', 'storeOrigin', 'downloadUrl', 'installDir', 'Private fixture bytes']) assert(!JSON.stringify(publicResponse).includes(forbidden));
    assert.equal((await route.GET(new Request('http://localhost:3001/api/capabilities/packages/store'), { params: Promise.resolve({}) })).status, 401);
    for (const query of ['scope=user&scope=organization', 'scope=all&audience=shared', 'scope=user&teamId=store-team', 'installedPage=0',
      'installedLimit=51', 'installedLimit=1&installedLimit=2', 'actorUserId=owner', 'installedState=current']) assert.equal((await get(query)).status, 400, query);
    assert.equal((await get('scope=team&teamId=store-team')).status, 404);
    assert.equal((await get('kind=plugin', 'alice', 'personal-bob')).status, 403);

    // Outage preserves every currently readable exact instance with unavailable/unknown comparison.
    registry.setStatus('application', 503);
    const outage = await stores.listCapabilityPackageStoreAction(alice, { kind: 'plugin', scope: 'user', audience: 'shared' });
    assert.equal(outage.stores[0].availability, 'unavailable'); assert.equal(outage.installed.summary.total, 3);
    assert.equal(outage.installed.summary.updates, 0); assert.equal(outage.installed.summary.unknown, 3);
    assert(outage.installed.resources.every(item => item.storeState?.upstream === 'unknown'));
    registry.setStatus('application', 200);

    // First-kind metadata cannot survive a grant revoke while the second configured registry awaits transport.
    let fetched = 0, arrived!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { arrived = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    releaseWait = release;
    fixture.setBeforeFetch(async () => { if (++fetched === 2) { arrived(); await released; } });
    const pending = stores.listCapabilityPackageStoreAction(alice, { scope: 'user', audience: 'shared' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([waiting, pending.then(() => { throw new Error('Expected second registry wait was not observed.'); }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Bounded registry wait timed out.')), 30_000); })]);
      const before = await resources.inspectCapabilityResource(owner, org.resource.resourceRef);
      await resources.updateCapabilityResource(owner, org.resource.resourceRef, { expectedMetadataRevision: before.metadata.metadataRevision,
        expectedGrantsRevision: before.metadata.grantsRevision, grants: [] });
    } finally { if (timeout) clearTimeout(timeout); release(); fixture.setBeforeFetch(undefined); }
    const after = await pending; releaseWait = undefined;
    assert(!after.installed.resources.some(item => item.metadata.resourceRef === org.resource.resourceRef));
    assert(after.stores.every(store => !store.installedResources.some(item => item.metadata.resourceRef === org.resource.resourceRef)
      && store.offerings.every(offering => !offering.installedResourceRefs.includes(org.resource.resourceRef))));
    assert.equal(after.installed.summary.total, 4, 'Revoked parent and plugin child are removed; remaining shared rows retain current authority.');
    await sql.run("UPDATE canvas_workspace_members SET status='suspended' WHERE workspace_id='store-team' AND user_id='manager'");
    await assert.rejects(() => stores.listCapabilityPackageStoreAction(manager, { scope: 'team', teamId: 'store-team' }), { status: 404 });
    assert.equal(fixture.providerRequests(), 0);
    console.log('Scoped Store authority PASS: actual PGlite/BetterAuth/registry/package services, exact scopes/paging, safe HTTP and late-revoke/outage denial without providers.');
  } finally { releaseWait?.(); await fixture.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.stack : 'Scoped Store fixture failed.'); process.exitCode = 1; });
