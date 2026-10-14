import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../app/lib/db';
import type { CapabilityResourceActor } from '../app/lib/capabilities/resources/contracts';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual source/ACL SQL; only the connection transport is instrumented. */
async function verifyBorrowedCapabilityCatalogue() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const originalOpen = fixture.database.openDb;
  try {
    const { owner, alice, organizationId } = fixture;
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const catalog = await import('../app/lib/capabilities/catalog');
    const resources = await import('../app/lib/capabilities/resources/store');
    const { capabilityResourceStorageBinding } = await import('../app/lib/capabilities/resources/storage-binding');
    const prefix = `borrowed-${randomUUID().slice(0, 8)}`;
    const skill = (name: string) => `---\nname: ${name}\ndescription: Actual borrowed catalogue fixture\nmetadata:\n  version: "1.0.0"\n---\n\nUse the actual immutable source.\n`;
    async function install(kind: 'plugin' | 'skill', suffix: string, actor: CapabilityResourceActor,
      ownership: { type: 'user' | 'organization' }) {
      const name = `${prefix}-${suffix}`;
      const files: Record<string, string> = kind === 'skill' ? { 'SKILL.md': skill(name) } : {
        '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', description: 'Actual plugin', skills: './skills' }),
        [`skills/${name}-child/SKILL.md`]: skill(`${name}-child`),
      };
      const archive = await fixture.registry.addPackage('application', kind, name, '1.0.0', files,
        plugins.computeCanvasPluginChecksum);
      return stores.installCapabilityPackageFromStoreAction(actor, {
        source: { kind, registryId: 'store-application', entryKey: name, version: '1.0.0', checksum: archive.checksum },
        ownership,
        grants: actor.userId === owner.userId ? [{ targetType: 'user', targetId: alice.userId,
          canUse: true, canEdit: false, canManage: false }] : [],
      });
    }
    const organizationPlugin = await install('plugin', 'organization-plugin', owner, { type: 'organization' });
    const organizationSkill = await install('skill', 'organization-skill', owner, { type: 'organization' });
    const ownPlugin = await install('plugin', 'own-plugin', alice, { type: 'user' });
    const ownSkill = await install('skill', 'own-skill', alice, { type: 'user' });
    const sharedPlugin = await install('plugin', 'shared-plugin', owner, { type: 'user' });
    const sharedSkill = await install('skill', 'shared-skill', owner, { type: 'user' });
    const context = { ...alice, organizationId, role: 'member' };
    const baseline = await catalog.loadCapabilityCandidates(context, { resolveConnections: false });
    const fixtures = [organizationPlugin, organizationSkill, ownPlugin, ownSkill, sharedPlugin, sharedSkill];
    for (const item of fixtures) {
      const actual = baseline.find(value => value.ref.resourceId === item.resource.legacyResourceId);
      assert(actual?.runtimePath, 'All genuine organization, owned and explicitly shared packages must be readable.');
      assert.equal(actual.resourceAccess?.canUse, true);
    }
    for (const item of [organizationPlugin, ownPlugin, sharedPlugin]) {
      assert(baseline.some(value => value.ref.sourcePluginId === item.resource.legacyResourceId && value.runtimePath),
        'Each genuinely readable parent includes its declared child source.');
    }
    const base = await originalOpen();
    let nestedCheckouts = 0;
    let borrowedReads = 0;
    let lifecycleCalls = 0;
    const borrowed: SqlConnection = { ...base,
      get: async (query, params) => { borrowedReads += 1; return base.get(query, params); },
      all: async (query, params) => { borrowedReads += 1; return base.all(query, params); },
      run: async () => { lifecycleCalls += 1; throw new Error('Catalogue must not mutate or own the borrowed transaction.'); },
      close: async () => { lifecycleCalls += 1; throw new Error('Catalogue must not close a borrowed lease.'); },
    };
    try {
      await base.run('BEGIN');
      fixture.database.openDb = async () => { nestedCheckouts += 1; throw new Error('Nested catalogue checkout is forbidden.'); };
      const actual = await catalog.loadCapabilityCandidates(context, { resolveConnections: false, database: borrowed });
      assert.deepEqual(actual, baseline, 'Caller-owned reads retain the exact legacy source, pin and ACL projection.');
      assert(borrowedReads > 20, 'Actual source/pointer and ACL queries use the caller lease.');
      assert.equal(nestedCheckouts, 0, 'No hidden checkout can be swallowed by an unavailable-source fallback.');
      assert.equal(lifecycleCalls, 0);
      assert.deepEqual(await base.get('SELECT 1 AS usable'), { usable: 1 }, 'The held transaction remains usable.');

      const existing = actual.find(value => value.ref.resourceId === sharedPlugin.resource.legacyResourceId)!;
      const storage = capabilityResourceStorageBinding(existing.ref);
      assert.equal((await resources.getCapabilityResourceAccess(alice, storage, borrowed)).access.canUse, true);
      assert((await resources.listCapabilityResourceRecordsForActor(alice, borrowed))
        .some(value => value.metadata.resourceRef === sharedPlugin.resource.resourceRef));
      await base.run('UPDATE capability_resource_grants SET can_use=0 WHERE resource_ref=$1 AND target_id=$2',
        [sharedPlugin.resource.resourceRef, alice.userId]);
      assert.equal((await resources.getCapabilityResourceAccess(alice, storage, borrowed)).access.canRead, false);
      const revoked = await catalog.loadCapabilityCandidates(context, { resolveConnections: false, database: borrowed });
      assert(!revoked.some(value => value.ref.resourceId === sharedPlugin.resource.legacyResourceId && value.runtimePath));
      assert(!revoked.some(value => value.ref.sourcePluginId === sharedPlugin.resource.legacyResourceId && value.runtimePath),
        'A current parent grant revocation cannot retain a readable bundled child.');
      assert(revoked.some(value => value.ref.resourceId === sharedSkill.resource.legacyResourceId && value.runtimePath),
        'Independent explicit shares remain readable.');

      await base.run('UPDATE capability_package_versions SET checksum=$1 WHERE resource_ref=$2 AND revision_ref=$3',
        ['0'.repeat(64), organizationPlugin.resource.resourceRef, organizationPlugin.published.revisionRef]);
      const stale = await catalog.loadCapabilityCandidates(context, { resolveConnections: false, database: borrowed });
      assert(!stale.some(value => value.ref.resourceId === organizationPlugin.resource.legacyResourceId && value.runtimePath));
      assert(!stale.some(value => value.ref.sourcePluginId === organizationPlugin.resource.legacyResourceId && value.runtimePath),
        'Current SQL publication checks reject the stale parent and its children.');
      await assert.rejects(catalog.loadCapabilityCandidates(context, { database: borrowed }), /metadata-only/u);
      await assert.rejects(catalog.loadCapabilityCandidates(context, { database: borrowed, resolveConnections: true }), /metadata-only/u);
      assert.equal(nestedCheckouts, 0);
      assert.equal(lifecycleCalls, 0);
    } finally {
      fixture.database.openDb = originalOpen;
      await base.run('ROLLBACK');
      await base.close();
    }
    assert.deepEqual(await catalog.loadCapabilityCandidates(context, { resolveConnections: false }), baseline,
      'Rollback and the original owned-connection read API retain their former behavior.');
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS actual PGlite catalogue: organization/own/shared plugin and standalone pointers, bundled children, exact baseline parity, zero nested checkouts or borrowed lifecycle writes, current grant revocation and publication mismatch, unchanged owned reads after rollback, zero provider probes.');
  } finally {
    fixture.database.openDb = originalOpen;
    await fixture.close();
  }
}

void verifyBorrowedCapabilityCatalogue().catch(error => { console.error(error); process.exitCode = 1; });
