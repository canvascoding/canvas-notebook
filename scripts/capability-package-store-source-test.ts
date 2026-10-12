import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCapabilityPackageError } from '../app/lib/capabilities/packages/contracts';
import { projectCapabilityPackageStoreVersions } from '../app/lib/capabilities/packages/store-offerings';

async function main() {
  const releases = Object.fromEntries(Array.from({ length: 150 }, (_, index) => {
    const version = `${index + 1}.0.0`;
    return [version, { version, checksum: `sha256:${(index + 1).toString(16).padStart(64, '0')}` }];
  }));
  const versions = projectCapabilityPackageStoreVersions(releases, '150.0.0');
  assert.equal(versions.length, 100);
  assert.deepEqual(versions[0], { version: '150.0.0', checksum: '96'.padStart(64, '0') });
  assert.equal(new Set(versions.map(version => version.version)).size, 100);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-source-proof-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://127.0.0.1:1', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:1', DATABASE_URL: 'postgresql://127.0.0.1:1/unopened_store_source' };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const { copyCapabilityPackageSourceWithReferences, readExactPackageInventory } = await import('../app/lib/capabilities/packages/io');
    const { issueVerifiedCapabilityStoreOrigin } = await import('../app/lib/capabilities/packages/store-origin');
    const { assertPreparedCapabilityStorePackage, disposePreparedCapabilityStorePackage, getPreparedCapabilityStorePackage,
      issuePreparedCapabilityStorePackage } = await import('../app/lib/capabilities/packages/store-source');
    await fs.writeFile(path.join(root, 'SKILL.md'), '---\nname: source-proof\ndescription: Actual source proof fixture\nversion: 1.0.0\n---\n# Package\n');
    const inventory = await readExactPackageInventory(root), resourceId = 'canvas-capability:v1:proof-a';
    const origin = await issueVerifiedCapabilityStoreOrigin({ resourceId, kind: 'skill', entryKey: 'source-proof',
      registryId: 'proof', registryUrl: 'https://example.invalid/proof/registry.json', version: '1.0.0',
      upstreamChecksum: inventory.checksum, packageRoot: root });
    let reads = 0, cleanups = 0;
    const input = { resourceId, kind: 'skill' as const, entryKey: 'source-proof', registryId: 'proof',
      registryIdentity: origin.registryIdentity, version: '1.0.0', upstreamChecksum: inventory.checksum,
      baselineChecksum: inventory.checksum, packageRoot: root, storeOrigin: origin,
      validation: { valid: true, kind: 'skill' as const, name: 'source-proof', version: '1.0.0', checksum: inventory.checksum,
        files: inventory.files.map(file => ({ path: file.relativePath, size: file.size, checksum: file.checksum })),
        totalBytes: inventory.totalBytes, errors: [], warnings: [] },
      verifyCurrent: async () => { reads++; }, cleanup: async () => { cleanups++; } };
    const receipt = issuePreparedCapabilityStorePackage(input), expected = { kind: receipt.kind, registryId: receipt.registryId,
      entryKey: receipt.entryKey, version: receipt.version, checksum: receipt.checksum, resourceId };
    assert(!JSON.stringify(receipt).includes(root));
    await assertPreparedCapabilityStorePackage(receipt, expected);
    assert.equal(reads, 1);
    assert.throws(() => getPreparedCapabilityStorePackage(structuredClone(receipt)), error => isCapabilityPackageError(error) && error.code === 'PACKAGE_ACCESS_DENIED');
    assert.throws(() => issuePreparedCapabilityStorePackage({ ...input, storeOrigin: structuredClone(origin) }), error => isCapabilityPackageError(error) && error.code === 'PACKAGE_ACCESS_DENIED');
    await assert.rejects(assertPreparedCapabilityStorePackage(receipt, { ...expected, resourceId: 'canvas-capability:v1:proof-b' }),
      error => isCapabilityPackageError(error) && error.code === 'PACKAGE_ACCESS_DENIED');
    const exposed = getPreparedCapabilityStorePackage(receipt);
    exposed.validation.checksum = '0'.repeat(64);
    assert.equal(getPreparedCapabilityStorePackage(receipt).validation.checksum, inventory.checksum);
    await fs.appendFile(path.join(root, 'SKILL.md'), 'Changed bytes\n');
    await assert.rejects(assertPreparedCapabilityStorePackage(receipt, expected), error => isCapabilityPackageError(error) && error.code === 'PACKAGE_SOURCE_CHANGED');
    await disposePreparedCapabilityStorePackage(receipt);
    await disposePreparedCapabilityStorePackage(receipt);
    assert.equal(cleanups, 1);
    assert.throws(() => getPreparedCapabilityStorePackage(receipt), error => isCapabilityPackageError(error) && error.code === 'PACKAGE_ACCESS_DENIED');
    const seedRoot = path.join(root, 'seed');
    await fs.mkdir(seedRoot);
    await fs.writeFile(path.join(seedRoot, 'SKILL.md'), '---\nname: seed-proof\ndescription: Captured fixture bytes\n---\nOriginal dependency\n');
    const seed = await readExactPackageInventory(seedRoot);
    for (const alias of ['skillRefs', 'skill_refs', 'seedSkills', 'seed_skills']) {
      const packageRoot = path.join(root, `original-${alias}`), targetRoot = path.join(root, `captured-${alias}`);
      await fs.mkdir(path.join(packageRoot, '.canvas-plugin'), { recursive: true });
      await fs.writeFile(path.join(packageRoot, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'alias-proof', version: '1.0.0',
        description: 'Canonical reference capture', [alias]: ['seed-proof'] }));
      const before = await readExactPackageInventory(packageRoot);
      const captured = await copyCapabilityPackageSourceWithReferences({ rootPath: packageRoot, resourceRef: 'mechanics-only-source',
        kind: 'plugin', name: 'alias-proof', owner: { type: 'system' } }, targetRoot, { expectedSourceChecksum: before.checksum,
        bundledReferences: [{ source: { rootPath: seedRoot, resourceRef: 'mechanics-only-dependency', kind: 'skill', name: 'seed-proof',
          owner: { type: 'system' } }, relativeTargetRoot: 'skills/seed-proof', checksum: seed.checksum }] });
      assert.notEqual(captured.checksum, before.checksum);
      assert.equal((await readExactPackageInventory(packageRoot)).checksum, before.checksum);
      const manifest = JSON.parse(await fs.readFile(path.join(targetRoot, '.canvas-plugin/plugin.json'), 'utf8'));
      assert.equal(manifest.skills, './skills');
      for (const key of ['skillRefs', 'skill_refs', 'seedSkills', 'seed_skills']) assert.equal(manifest[key], undefined);
      assert.equal(await fs.readFile(path.join(targetRoot, 'skills/seed-proof/SKILL.md'), 'utf8'), await fs.readFile(path.join(seedRoot, 'SKILL.md'), 'utf8'));
    }
    console.log('Verified Store preparation proof, identity, byte binding and cleanup PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
