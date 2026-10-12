import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

/** Actual PGlite/ACL/catalog/filesystem fixture; only readFile call counts are instrumented. */
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  try {
    const resources = await import('../app/lib/capabilities/resources/actions');
    const paths = await import('../app/lib/runtime-data-paths');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const skills = await import('../app/lib/skills/canvas-skill-store');
    const readers = await import('../app/lib/plugins/store-installed-resource');
    const { projectActorCanvasSkillStoreState } = await import('../app/lib/skills/actor-skill-store-state');
    const bob = fixture.actor('bob'), scope = fixture.userScope('bob');
    const skillRoot = paths.resolveScopedSkillsDataDir(scope);
    const skillRegistryPath = paths.resolveScopedSkillRegistryPath(scope);
    const legacyRegistryPath = paths.resolveScopedSkillRegistryPath();
    await fs.mkdir(skillRoot, { recursive: true });
    const legacyNames = Array.from({ length: 23 }, (_, index) => `legacy-scan-${String(index + 1).padStart(2, '0')}`);
    const legacyPaths = new Set<string>();
    for (const name of legacyNames) {
      const filename = path.join(skillRoot, name, 'SKILL.md');
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, `---\nname: ${name}\ndescription: Unregistered Bob skill\nmetadata:\n  version: 1.0.0\n---\nBob owns ${name}.\n`);
      legacyPaths.add(filename);
    }
    await assert.rejects(fs.stat(skillRegistryPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(legacyRegistryPath), { code: 'ENOENT' });

    // A different user's same-name legacy import has real provenance, which Bob may never borrow.
    const sameName = legacyNames[0];
    await fixture.registry.addPackage('application', 'skill', sameName, '1.0.0', {
      'SKILL.md': `---\nname: ${sameName}\ndescription: Private Alice Store skill\nmetadata:\n  version: 1.0.0\n---\nAlice-only distinct source bytes.\n`,
    }, plugins.computeCanvasPluginChecksum);
    const foreignImport = await skills.installCanvasSkillFromStore(sameName, '1.0.0', {
      scope: fixture.userScope('alice'), enable: false, replace: false,
    });
    assert.equal(foreignImport.success, true);
    assert.ok(foreignImport.skill?.resourceId);
    assert.ok(foreignImport.skill.storeOrigin);
    const foreign = await resources.configureCapabilityResource(fixture.alice, foreignImport.skill.resourceId, {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', grants: [],
    });
    const foreignRegistryPath = paths.resolveScopedSkillRegistryPath(fixture.userScope('alice'));
    const foreignRegistryBefore = await fs.readFile(foreignRegistryPath);

    // Initial reads and byte-checksum expectations are outside the measured batch.
    const before = await resources.listCapabilityResources(bob);
    const legacy = legacyNames.map(name => {
      const matches = before.filter(value => value.artifact.resourceType === 'skill' && value.artifact.name === name);
      assert.equal(matches.length, 1);
      const descriptor = matches[0];
      assert.equal(descriptor.artifact.scopeType, 'user');
      assert.equal(descriptor.artifact.sourceType, 'standalone');
      assert.equal(descriptor.metadata.ownership.type, 'user');
      if (descriptor.metadata.ownership.type === 'user') assert.equal(descriptor.metadata.ownership.ownerUserId, 'bob');
      assert.deepEqual(descriptor.access, { canRead: true, canUse: true, canEdit: true, canManage: true });
      assert.equal(descriptor.metadata.metadataRevision, 0);
      assert.equal(descriptor.metadata.grantsRevision, 0);
      return descriptor;
    });
    for (const descriptor of legacy) assert.equal(descriptor.artifact.checksum,
      await plugins.computeCanvasPluginChecksum(path.join(skillRoot, descriptor.artifact.name)));
    assert(!before.some(value => value.metadata.resourceRef === foreign.metadata.resourceRef
      || value.artifact.resourceId === foreign.artifact.resourceId));
    assert.notEqual(legacy[0].artifact.resourceId, foreign.artifact.resourceId);
    assert.notEqual(legacy[0].artifact.checksum, foreign.artifact.checksum);
    await assert.rejects(resources.inspectCapabilityResource(bob, foreign.metadata.resourceRef), {
      code: 'CAPABILITY_RESOURCE_NOT_FOUND',
    });
    const source = await skills.readCanvasSkillStoreRegistry();
    const resourceRowsBefore = await fixture.sql.all('SELECT resource_ref,metadata_revision,grants_revision FROM capability_resources ORDER BY resource_ref');
    await assert.rejects(fs.stat(skillRegistryPath), { code: 'ENOENT' });

    const observedRead = mock.method(fs, 'readFile'); // No implementation replacement: every call executes the original IO.
    let observed: Awaited<ReturnType<typeof readers.readInstalledStoreResources>>;
    try { observed = await readers.readInstalledStoreResources(bob, legacy, { preserveInputOrder: true }); }
    finally { observedRead.mock.restore(); }
    const perPath = new Map([...legacyPaths].map(filename => [filename, 0]));
    for (const call of observedRead.mock.calls) {
      const filename = call.arguments[0];
      if (typeof filename === 'string' && perPath.has(filename)) perPath.set(filename, perPath.get(filename)! + 1);
    }
    const legacyReads = [...perPath.values()].reduce((total, count) => total + count, 0);
    assert([...perPath.values()].every(count => count > 0), 'All 23 actual legacy files must be observed; a cache or empty catalog cannot satisfy the read bound.');
    assert(legacyReads <= 4 * 23, `The 23-file batch must avoid repeated whole-catalog reads (actual ${legacyReads}, maximum ${4 * 23}).`);
    assert(!observedRead.mock.calls.some(call => call.arguments[0] === foreignImport.skill!.skillPath), 'Bob never reads the private same-name Alice skill.');
    assert.equal(observed.size, 23);
    for (const descriptor of legacy) assert.deepEqual(observed.get(descriptor.metadata.resourceRef), {
      resourceRef: descriptor.metadata.resourceRef, origin: null, checksum: null,
    });
    const projected = projectActorCanvasSkillStoreState(source, legacy, scope, observed);
    assert.equal(projected.installedResources.length, 23);
    for (const row of projected.installedResources) {
      const original = legacy.find(value => value.metadata.resourceRef === row.metadata.resourceRef);
      assert.ok(original);
      assert.deepEqual(row.metadata, original.metadata);
      assert.deepEqual(row.access, original.access);
      assert.deepEqual(row.storeState, { origin: 'unknown', localChanges: 'unknown', upstream: 'unknown' });
    }
    const offering = projected.skills.find(value => value.name === sameName);
    assert.ok(offering);
    assert.equal(offering.installed.installed, false);
    assert.deepEqual(offering.installed.resources, []);

    const foreignObserved = await readers.readInstalledStoreResources(bob, [foreign]);
    assert.deepEqual(foreignObserved.get(foreign.metadata.resourceRef), {
      resourceRef: foreign.metadata.resourceRef, origin: null, checksum: null,
    });
    const after = await resources.listCapabilityResources(bob);
    for (const descriptor of legacy) assert.deepEqual(after.find(value => value.metadata.resourceRef === descriptor.metadata.resourceRef), descriptor);
    assert.deepEqual(await fixture.sql.all('SELECT resource_ref,metadata_revision,grants_revision FROM capability_resources ORDER BY resource_ref'), resourceRowsBefore);
    assert.deepEqual(await fs.readFile(foreignRegistryPath), foreignRegistryBefore);
    await assert.rejects(fs.stat(skillRegistryPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(legacyRegistryPath), { code: 'ENOENT' });
    assert.equal(fixture.providerRequests(), 0);
    console.log(`Legacy Skill Store read bound PASS (${legacyReads} real reads / 23 files; real ACLs, unknown provenance, exact foreign denial, no registry creation).`);
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
