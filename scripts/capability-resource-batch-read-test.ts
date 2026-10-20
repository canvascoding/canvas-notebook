import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../app/lib/capabilities/resources/contracts';
import type { CanvasSkillInstallRecord } from '../app/lib/skills/canvas-skill-store';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual ACL SQL and artifact catalogues; instrumentation counts reads without replacing authorization. */
async function main() {
  const native = process.argv.includes('--native');
  const maintenanceUrl = native ? process.env.DATABASE_URL : undefined;
  if (native) {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'Native mode never silently falls back to PGlite.');
    const parsed = new URL(maintenanceUrl ?? '');
    assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, '55433'); assert.equal(parsed.search, '');
  }
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native, ...(native ? { nativePoolMax: 10 as const } : {}) });
  const originalOpen = fixture.database.openDb;
  let nonceDatabase: string | undefined;
  try {
    assert.equal(fixture.native, native);
    if (native) {
      const identity = await fixture.sql.get(`SELECT current_database() AS name,current_user AS role,pg_get_userbyid(datdba) AS owner
        FROM pg_database WHERE datname=current_database()`) as { name: string; role: string; owner: string };
      assert.match(identity.name, /^canvas_connection_test_[a-f0-9]{32}$/u);
      assert.equal(identity.owner, identity.role, 'The fixture may create and drop only its own nonce database.');
      assert.notEqual(identity.name, new URL(maintenanceUrl!).pathname.slice(1));
      nonceDatabase = identity.name;
    }
    const store = await import('../app/lib/capabilities/resources/store');
    const labels = await import('../app/lib/capabilities/resources/labels');
    const actions = await import('../app/lib/capabilities/resources/actions');
    const catalog = await import('../app/lib/capabilities/catalog');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const storeActions = await import('../app/lib/capabilities/packages/store-actions');
    const { organizationId, owner, alice, sql } = fixture;
    const binding = (name: string, extra: Partial<CapabilityResourceStorageBinding> = {}): CapabilityResourceStorageBinding => ({
      resourceType: 'skill', resourceId: `batch:${name}`, scopeType: 'organization', name, sourceType: 'standalone',
      organizationId, ownerUserId: null, sourcePluginId: null, ...extra,
    });
    const organization = binding('managed-organization');
    const personal = binding('managed-personal', { scopeType: 'user', ownerUserId: owner.userId, organizationId: null });
    const team = binding('managed-team');
    const managed = [];
    for (const storage of [organization, personal, team]) {
      managed.push(await store.adoptCapabilityResource(owner, storage, { expectedMetadataRevision: 0, expectedGrantsRevision: 0,
        accessMode: 'restricted', ...(storage === team ? { ownership: { type: 'team' as const, organizationId, workspaceId: 'store-team' } } : {}),
        metadata: { displayName: storage.name, responsibleUserId: alice.userId },
        grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false },
          { targetType: 'user', targetId: 'bob', canUse: false, canEdit: true, canManage: false }] }));
    }
    await sql.run(`INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at)
      VALUES('foreign','Foreign person','foreign@batch.example.test','user',1,0,1,1)`);
    await sql.run(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('foreign-org','foreign','team',1,1,1)`);
    await sql.run(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,created_at,updated_at)
      VALUES('foreign-org','foreign','owner','active',1,1)`);
    const unmanaged = [binding('baseline-organization'), binding('baseline-personal', { scopeType: 'user', ownerUserId: owner.userId, organizationId: null }),
      binding('baseline-system', { scopeType: 'system', sourceType: 'core', organizationId: null }),
      binding('foreign-baseline', { organizationId: 'foreign-org' })];
    const storages = [organization, personal, team, ...unmanaged, organization];
    const actors: CapabilityResourceActor[] = [owner, alice, fixture.actor('bob'), fixture.manager,
      { userId: 'foreign' }, { userId: 'missing' }, { ...alice, workspaceId: 'other-team' }];
    for (const actor of actors) {
      const individual = await Promise.all(storages.map(storage => store.getCapabilityResourceAccess(actor, storage)));
      const batch = await store.readCapabilityResourceAccessBatch(actor, storages, undefined, { includeGrants: true });
      assert.deepEqual(batch.map(({ metadata, access }) => ({ metadata, access })), individual,
        `Batch authorization must match existing individual reads for ${actor.userId}/${actor.workspaceId ?? ''}.`);
      for (const entry of batch) {
        if (entry.access.canManage) assert.deepEqual(entry.grants, entry.metadata.metadataRevision === 0 ? []
          : await store.listCapabilityResourceGrants(actor, entry.metadata.resourceRef));
        else assert.equal(entry.grants, undefined, 'Read or Use never exposes the management grant set.');
      }
    }
    await assert.rejects(store.readCapabilityResourceAccessBatch(owner, [{ ...organization, name: 'forged-binding' }]),
      { code: 'RESOURCE_BINDING_CONFLICT' });
    let reads: string[] = [];
    fixture.setBeforeRead(async query => { reads.push(query); });
    const budgets: number[] = [];
    for (const count of [1, 10, 50]) {
      reads = [];
      await store.readCapabilityResourceAccessBatch(alice, [...storages,
        ...Array.from({ length: count }, (_, index) => binding(`budget-${index}`))]);
      budgets.push(reads.length);
      assert.equal(reads.filter(query => query.includes('can_share_plugins_and_skills FROM organization_user_permissions')).length, 1,
        'Actor authority is read once per batch, regardless of candidate count.');
      assert(reads.length <= 9, `The complete mixed ACL phase used ${reads.length} queries.`);
    }
    assert.equal(new Set(budgets).size, 1, 'The query budget is constant for repeated and additional candidate bindings.');
    fixture.setBeforeRead(undefined);

    // The same caller-owned connection remains owned by the caller, including its transaction lifecycle.
    const base = await originalOpen();
    let nested = 0;
    const borrowed: SqlConnection = { ...base, run: async () => { throw new Error('Batch reader must not manage a borrowed transaction.'); },
      close: async () => { throw new Error('Batch reader must not close a borrowed lease.'); } };
    try {
      fixture.database.openDb = async () => { nested += 1; throw new Error('Nested batch checkout is forbidden.'); };
      const result = await store.readCapabilityResourceAccessBatch(alice, storages, borrowed);
      assert.equal(result[0].access.canUse, true);
      assert.equal(nested, 0);
    } finally { fixture.database.openDb = originalOpen; await base.close(); }

    const first = await store.readCapabilityResourceAccessBatch(alice, storages);
    await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [managed[0].metadata.resourceRef, alice.userId]);
    const revoked = await store.readCapabilityResourceAccessBatch(alice, storages);
    assert.equal(first[0].access.canUse, true);
    assert.equal(revoked[0].access.canRead, false, 'A subsequent phase observes current grant revocation.');
    assert.equal(revoked[1].access.canUse, true, 'An independent personal share remains available.');
    await sql.run('UPDATE "user" SET banned=1 WHERE id=$1', [owner.userId]);
    assert.equal((await store.readCapabilityResourceAccessBatch(alice, [personal]))[0].access.canRead, false,
      'A disabled source owner is checked independently from the requesting actor.');
    await sql.run('UPDATE "user" SET banned=0 WHERE id=$1', [owner.userId]);
    await sql.run(`UPDATE organization_user_permissions SET status='disabled' WHERE user_id=$1 AND organization_id=$2`, [owner.userId, organizationId]);
    assert.equal((await store.readCapabilityResourceAccessBatch(alice, [personal]))[0].access.canRead, false,
      'A shared personal source owner must retain active membership in the resource organization.');
    await sql.run(`UPDATE organization_user_permissions SET status='active' WHERE user_id=$1 AND organization_id=$2`, [owner.userId, organizationId]);
    await sql.run(`UPDATE capability_resources SET status='archived' WHERE resource_ref=$1`, [managed[1].metadata.resourceRef]);
    const archived = (await store.readCapabilityResourceAccessBatch(alice, [personal]))[0];
    assert.equal(archived.metadata.status, 'archived', 'An archived managed row must never fall back to unmanaged baseline rights.');
    assert.equal(archived.access.canRead, false);
    await sql.run(`UPDATE capability_resources SET status='active' WHERE resource_ref=$1`, [managed[1].metadata.resourceRef]);
    await sql.run('UPDATE "user" SET banned=1 WHERE id=$1', [alice.userId]);
    assert((await store.readCapabilityResourceAccessBatch(alice, storages)).every(entry => !entry.access.canRead), 'Actor bans revoke Core as well as managed resources.');
    await sql.run('UPDATE "user" SET banned=0 WHERE id=$1', [alice.userId]);
    await sql.run(`UPDATE canvas_workspaces SET status='archived' WHERE id='store-team'`);
    assert.equal((await store.readCapabilityResourceAccessBatch(fixture.manager, [team]))[0].access.canRead, false);
    await sql.run(`UPDATE canvas_workspaces SET status='active' WHERE id='store-team'`);

    const labelEntries = await store.readCapabilityResourceAccessBatch(owner, [organization, personal, team]);
    const enriched = await labels.readCapabilityResourceLabelsBatch(owner, labelEntries);
    assert.equal(enriched[0].people?.responsible?.name, 'alice');
    assert.equal(enriched[1].people?.owner?.name, 'owner');
    assert.equal(enriched[2].ownershipLabel, 'store-team');
    const foreignName = { ...labelEntries[0], metadata: { ...labelEntries[0].metadata, responsibleUserId: 'foreign' } };
    assert.equal((await labels.readCapabilityResourceLabelsBatch(owner, [foreignName]))[0].people?.responsible?.name, null,
      'A name from another organization cannot leak into provenance labels.');

    const personalDirectory = path.join(fixture.root, 'users', owner.userId, 'skills', personal.name);
    await fs.mkdir(personalDirectory, { recursive: true });
    await fs.writeFile(path.join(personalDirectory, 'SKILL.md'), `---\nname: ${personal.name}\ndescription: Actual shared personal fixture\n---\n\nRead only within the current grant.\n`);

    // Genuine immutable parent/child artifacts exercise the optimized management catalogue and inspection paths.
    const name = 'batch-read-plugin';
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Actual batch catalogue', skills: './skills' }),
      'skills/batch-read-child/SKILL.md': '---\nname: batch-read-child\ndescription: Actual child\nmetadata:\n  version: "1.0.0"\n---\n\nRead the actual child.\n',
    }, plugins.computeCanvasPluginChecksum);
    const installed = await storeActions.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const descriptors = await actions.listCapabilityResources(alice);
    const parent = descriptors.find(value => value.metadata.resourceRef === installed.resource.resourceRef)!;
    const child = descriptors.find(value => value.artifact.sourcePluginId === parent.artifact.resourceId)!;
    assert(parent.access.canUse && child.access.canUse);
    assert.equal(child.access.canEdit, false);
    assert.equal(child.grants, undefined);
    const inspected = await actions.inspectCapabilityResource(alice, parent.metadata.resourceRef);
    assert.deepEqual(inspected, parent, 'Same-actor inspection keeps the exact activation, source and ACL projection.');
    assert((await catalog.loadCapabilityCandidates({ ...alice, organizationId }, { resolveConnections: false }))
      .some(value => value.ref.name === 'batch-read-child' && value.resourceAccess?.canUse));

    let revokedBetweenPhases = false;
    fixture.setAfterRead(async (query, parameters) => {
      if (!revokedBetweenPhases && query.includes('FROM capability_package_versions') && parameters[0] === installed.resource.resourceRef) {
        revokedBetweenPhases = true;
        await sql.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2', [installed.resource.resourceRef, alice.userId]);
      }
    });
    try {
      const duringIo = await catalog.loadCapabilityCandidates({ ...alice, organizationId }, { resolveConnections: false });
      assert(revokedBetweenPhases, 'The real immutable pointer read must run between the preread and final ACL phases.');
      assert(duringIo.filter(value => value.ref.resourceId === parent.artifact.resourceId || value.ref.sourcePluginId === parent.artifact.resourceId)
        .every(value => !value.runtimePath && value.resourceAccess?.canRead === false),
      'Revocation during source I/O must clear both the parent and bundled child paths in the final fresh phase.');
    } finally {
      fixture.setAfterRead(undefined);
      await sql.run('UPDATE capability_resource_grants SET can_use=1 WHERE resource_ref=$1 AND target_id=$2', [installed.resource.resourceRef, alice.userId]);
    }

    const skillStore = await import('../app/lib/skills/canvas-skill-store');
    const localSkills: CanvasSkillInstallRecord[] = [];
    for (let index = 0; index < 50; index += 1) {
      const skillName = `batch-volume-${index}`, installDir = path.join(fixture.root, 'users', alice.userId, 'skills', skillName);
      const skillPath = path.join(installDir, 'SKILL.md'), staging = path.join(fixture.root, 'volume-staging', skillName);
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Actual local skill ${index}\n---\n\nFollow the current request.\n`);
      localSkills.push({ resourceId: `batch-volume:${index}`, scopeType: 'user', ownerUserId: alice.userId,
        organizationId: null, revision: 1, name: skillName, version: '1.0.0', description: `Actual local skill ${index}`,
        sourceType: 'local', installedAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
        checksum: await plugins.computeCanvasPluginChecksum(staging), installDir, skillPath });
    }
    const catalogBudgets: Array<{ count: number; queries: number; authority: number }> = [];
    let placed = 0;
    await fs.mkdir(path.join(fixture.root, 'users', alice.userId, 'skills'), { recursive: true });
    for (const count of [1, 10, 50]) {
      for (; placed < count; placed += 1) await fs.rename(path.join(fixture.root, 'volume-staging', localSkills[placed].name), localSkills[placed].installDir);
      await skillStore.writeCanvasSkillRegistry({ version: 1, updatedAt: '2026-10-16T00:00:00.000Z',
        skills: Object.fromEntries(localSkills.slice(0, count).map(skill => [skill.name, skill])) }, fixture.userScope(alice.userId));
      reads = [];
      fixture.setBeforeRead(async query => { reads.push(query); });
      const current = await actions.listCapabilityResources(alice);
      fixture.setBeforeRead(undefined);
      assert.equal(current.filter(value => value.artifact.name.startsWith('batch-volume-')).length, count);
      catalogBudgets.push({ count, queries: reads.length,
        authority: reads.filter(query => query.includes('can_share_plugins_and_skills FROM organization_user_permissions')).length });
    }
    assert.equal(new Set(catalogBudgets.map(value => value.authority)).size, 1,
      `Complete catalog authority must be constant for 1/10/50 real resources: ${JSON.stringify(catalogBudgets)}`);
    assert.equal(new Set(catalogBudgets.map(value => value.queries)).size, 1,
      `Complete catalog SQL must be constant for 1/10/50 real resources: ${JSON.stringify(catalogBudgets)}`);
    assert.equal(fixture.providerRequests(), 0);
    console.log(`PASS actual ${native ? 'native PostgreSQL' : 'PGlite'} resource batches: mixed ACL parity, scoped grants/labels, constant ${budgets[0]} queries for 9/18/58 bindings, borrowed lease ownership, current revocation/bans/team status, immutable parent/child catalogue and inspection, full 1/10/50-resource catalog budgets ${JSON.stringify(catalogBudgets)}, zero provider probes.`);
  } finally {
    fixture.database.openDb = originalOpen; await fixture.close();
    await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' }, 'The isolated fixture data directory is removed.');
    if (native && nonceDatabase) {
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try {
        assert.equal((await observer.query('SELECT datname FROM pg_database WHERE datname=$1', [nonceDatabase])).rowCount, 0,
          'The native helper must drop the exact owned nonce database after releasing all leases.');
        console.log('PASS native isolation and cleanup: distinct owned nonce database verified, nonce database absent after teardown, isolated fixture files removed.');
      } finally { await observer.end(); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
