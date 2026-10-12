import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthorizedCapabilityPackageResource } from '../app/lib/capabilities/packages/contracts';
import type { SqlConnection } from '../app/lib/db';

// New isolated proof/registry-guard fixture. Uses real package IO and pure unmanaged guards;
// no configured database, provider, server, production data or transport authorization mock.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-package-origin-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://127.0.0.1:1', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:1', DATABASE_URL: 'postgresql://127.0.0.1:1/unopened_origin_fixture' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const { capabilityPackageLegacyStorageBinding, assertCapabilityPackageRegistryWriteAllowed } = await import('../app/lib/capabilities/packages/artifacts');
    const { getCapabilityPackagePublicationStoreOrigin, withCapabilityPackagePublication } = await import('../app/lib/capabilities/packages/store');
    const { readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    const { deriveCapabilityStoreOrigin, issueVerifiedCapabilityStoreOrigin, isIssuedCapabilityStoreOrigin, normalizeCapabilityStoreOrigin, sameCapabilityStoreOrigin } = await import('../app/lib/capabilities/packages/store-origin');
    const { capabilityPackageDraftCreationSchema, capabilityPackageFileWriteSchema, capabilityPackagePublishSchema } = await import('../app/lib/capabilities/packages/schemas');
    await fs.mkdir(path.join(root, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(root, 'skills/design-child/scripts'), { recursive: true });
    await fs.writeFile(path.join(root, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'origin-package', version: '1.0.0', description: 'An exact import fixture', skills: 'skills' }));
    await fs.writeFile(path.join(root, 'skills/design-child/SKILL.md'), '---\nname: design-child\ndescription: Exact parent component\n---\nUse the script.\n');
    await fs.writeFile(path.join(root, 'skills/design-child/scripts/run.js'), 'process.stdout.write("upstream-one");\n');
    const scope = { userId: 'origin-owner' }, storage = capabilityPackageLegacyStorageBinding('plugin', 'origin-package', scope);
    const inventory = await readExactPackageInventory(root);
    const origin = await issueVerifiedCapabilityStoreOrigin({ resourceId: storage.resourceId, registryId: 'origin-registry',
      registryUrl: 'https://store.example.test/registry.json?namespace=design', kind: 'plugin', entryKey: 'origin-package', version: '1.0.0',
      upstreamChecksum: inventory.checksum, packageRoot: root });
    assert(isIssuedCapabilityStoreOrigin(origin, storage.resourceId));
    assert(!isIssuedCapabilityStoreOrigin(structuredClone(origin), storage.resourceId));
    assert(!isIssuedCapabilityStoreOrigin(origin, 'other-resource'));
    assert.equal(origin.baselineChecksum, inventory.checksum);
    const before = { resourceId: storage.resourceId, version: '1.0.0', checksum: inventory.checksum, installDir: root };
    const imported = { ...before, storeOrigin: origin };
    await assertCapabilityPackageRegistryWriteAllowed('plugin', {}, { 'origin-package': imported }, scope);
    await assert.rejects(() => assertCapabilityPackageRegistryWriteAllowed('plugin', {}, { 'origin-package': { ...before, storeOrigin: structuredClone(origin) } }, scope), { code: 'PACKAGE_REVISION_CONFLICT' });
    await assert.rejects(() => assertCapabilityPackageRegistryWriteAllowed('plugin', {}, { 'origin-package': { ...before, resourceId: 'foreign-resource', storeOrigin: origin } }, scope), { code: 'PACKAGE_REVISION_CONFLICT' });
    const persisted = { ...before, storeOrigin: structuredClone(origin) };
    await assertCapabilityPackageRegistryWriteAllowed('plugin', { 'origin-package': persisted }, { 'origin-package': structuredClone(persisted) }, scope);
    await fs.writeFile(path.join(root, 'skills/design-child/scripts/run.js'), 'process.stdout.write("local-edit");\n');
    const changed = await readExactPackageInventory(root);
    assert.notEqual(changed.checksum, origin.baselineChecksum);
    const edited = { ...persisted, version: '99.0.0', checksum: changed.checksum };
    await assertCapabilityPackageRegistryWriteAllowed('plugin', { 'origin-package': persisted }, { 'origin-package': edited }, scope);
    assert.equal(edited.storeOrigin.version, '1.0.0');
    assert.equal(edited.storeOrigin.relation, 'installed');
    assert.equal(edited.storeOrigin.baselineChecksum, inventory.checksum);
    const rebased = { ...origin, baselineChecksum: changed.checksum };
    await assert.rejects(() => assertCapabilityPackageRegistryWriteAllowed('plugin', { 'origin-package': persisted }, { 'origin-package': { ...edited, storeOrigin: rebased } }, scope), { code: 'PACKAGE_REVISION_CONFLICT' });
    const forkStorage = capabilityPackageLegacyStorageBinding('plugin', 'origin-fork', scope);
    const forkOrigin = deriveCapabilityStoreOrigin(persisted.storeOrigin, forkStorage.resourceId);
    assert(forkOrigin);
    assert.equal(forkOrigin.relation, 'derived');
    assert.equal(forkOrigin.resourceId, forkStorage.resourceId);
    assert.equal(forkOrigin.baselineChecksum, origin.baselineChecksum);
    assert.equal(forkOrigin.upstreamChecksum, origin.upstreamChecksum);
    assert.equal(forkOrigin.version, '1.0.0');
    assert(!sameCapabilityStoreOrigin(forkOrigin, origin));
    assert(isIssuedCapabilityStoreOrigin(forkOrigin, forkStorage.resourceId));
    assert(Object.isFrozen(forkOrigin), 'Issued derived origins cannot be mutated after verification.');
    await assertCapabilityPackageRegistryWriteAllowed('plugin', {}, { 'origin-fork': { ...before, resourceId: forkStorage.resourceId, storeOrigin: forkOrigin } }, scope);
    const childId = 'exact-parent-owned-child', childOrigin = deriveCapabilityStoreOrigin(origin, childId, 'skills/design-child');
    assert(childOrigin);
    assert.equal(childOrigin.kind, 'plugin');
    assert.equal(childOrigin.entryKey, 'origin-package');
    assert.equal(childOrigin.componentPath, 'skills/design-child');
    assert.equal(childOrigin.baselineChecksum, null);
    assert.equal(childOrigin.relation, 'derived');
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, componentPath: '../other' }), null);
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, injected: 'untrusted' }), null);
    assert.equal(normalizeCapabilityStoreOrigin(origin, 'foreign-resource'), null);
    assert.equal(normalizeCapabilityStoreOrigin(undefined), null);
    await assert.rejects(() => issueVerifiedCapabilityStoreOrigin({ resourceId: storage.resourceId, registryId: 'origin-registry',
      registryUrl: 'https://store.example.test/registry.json', kind: 'plugin', entryKey: 'origin-package', version: '1.0.0',
      upstreamChecksum: inventory.checksum, packageRoot: root }), /does not match/u);
    assert.throws(() => getCapabilityPackagePublicationStoreOrigin(storage), { code: 'PACKAGE_ACCESS_DENIED' });
    await assert.rejects(() => withCapabilityPackagePublication({} as AuthorizedCapabilityPackageResource,
      { revisionRef: 'canvas-package-revision:00000000-0000-0000-0000-000000000000', version: '1.0.0', checksum: inventory.checksum, rootPath: root, storeOrigin: origin },
      {} as SqlConnection, async () => undefined), { code: 'PACKAGE_ACCESS_DENIED' });
    assert.equal(capabilityPackageDraftCreationSchema.safeParse({ operation: 'edit', resourceRef: 'canvas-resource:00000000-0000-0000-0000-000000000000',
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null, storeOrigin: origin }).success, false);
    assert.equal(capabilityPackageFileWriteSchema.safeParse({ path: 'scripts/run.js', encoding: 'base64', content: '', expectedDraftRevision: 1, storeOrigin: origin }).success, false);
    assert.equal(capabilityPackagePublishSchema.safeParse({ draftRef: 'canvas-package-draft:00000000-0000-0000-0000-000000000000', expectedDraftRevision: 1,
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, expectedPackageRevision: 0, expectedPublishedRevisionRef: null, storeOrigin: origin }).success, false);
    console.log('Capability package origin guard PASS: real complete digests, private import proof, immutable baseline, exact derived identities, child provenance and strict public schemas.');
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
