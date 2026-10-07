import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capabilityStoreRegistryIdentity, compareCapabilityStoreVersions, deriveCapabilityStoreOrigin,
  isIssuedCapabilityStoreOrigin, issueVerifiedCapabilityStoreOrigin, normalizeCapabilityStoreOrigin,
  sameCapabilityStoreOrigin } from '../app/lib/capabilities/packages/store-origin';

async function main() {
  for (const [left, right, expected] of [
    ['1.0.0', '2.0.0', -1], ['1.0.0-alpha', '1.0.0', -1], ['1.0.0-alpha.9', '1.0.0-alpha.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.0.0+one', '1.0.0+two', 0], ['9007199254740993.0.0', '9007199254740992.0.0', 1],
    ['1', '1.0.0', null], ['1.0', '1.0.0', null], ['01.0.0', '1.0.0', null], ['1.0.0-01', '1.0.0', null],
    ['local', '1.0.0', null], ['1.0.0-Alpha', '1.0.0-alpha', -1],
  ] as const) {
    assert.equal(compareCapabilityStoreVersions(left, right), expected, `${left}/${right}`);
    if (expected !== null) assert.equal(compareCapabilityStoreVersions(right, left), expected === 0 ? 0 : -expected);
  }
  assert.equal(capabilityStoreRegistryIdentity('https://store.example.test:443/registry.json#irrelevant'),
    capabilityStoreRegistryIdentity('https://store.example.test/registry.json'));
  assert.notEqual(capabilityStoreRegistryIdentity('https://store.example.test/registry.json?tenant=a'),
    capabilityStoreRegistryIdentity('https://store.example.test/registry.json?tenant=b'));
  assert.notEqual(capabilityStoreRegistryIdentity('https://reader:a@store.example.test/registry.json'),
    capabilityStoreRegistryIdentity('https://reader:b@store.example.test/registry.json'));
  assert.throws(() => capabilityStoreRegistryIdentity('javascript:private'));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-origin-'));
  const packageRoot = path.join(root, 'package');
  process.env.DATA = path.join(root, 'data');
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BASE_URL = 'http://localhost:3001';
  await fs.mkdir(process.env.DATA, { recursive: true });
  await fs.mkdir(packageRoot);
  try {
    await fs.writeFile(path.join(packageRoot, 'SKILL.md'), '---\nname: origin-test\ndescription: Test\nversion: 1.0.0\n---\nOriginal\n');
    await fs.mkdir(path.join(packageRoot, 'scripts'));
    await fs.writeFile(path.join(packageRoot, 'scripts/run.js'), 'process.stdout.write("hello");\n');
    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry');
    const checksum = await computeCanvasPluginChecksum(packageRoot);
    const input = { resourceId: 'skill:user:exact', registryId: 'fixture', registryUrl: 'https://user:private@store.test/registry?secret=token',
      kind: 'skill' as const, entryKey: 'origin-test', version: '1.0.0', upstreamChecksum: checksum, packageRoot };
    const origin = await issueVerifiedCapabilityStoreOrigin(input);
    assert.equal(origin.baselineChecksum, checksum);
    assert.equal(origin.upstreamChecksum, checksum);
    assert.equal(isIssuedCapabilityStoreOrigin(origin, input.resourceId), true);
    assert.equal(isIssuedCapabilityStoreOrigin(structuredClone(origin), input.resourceId), false);
    assert.equal(isIssuedCapabilityStoreOrigin(origin, 'skill:user:other'), false);
    assert(!JSON.stringify(origin).includes('private'));
    assert(!JSON.stringify(origin).includes('token'));
    assert.equal(normalizeCapabilityStoreOrigin(origin, 'skill:user:other'), null);
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, arbitrarySecret: 'private' }), null);
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, kind: ['skill'] }), null);
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, relation: ['installed'], baselineChecksum: null }), null);
    assert.equal(normalizeCapabilityStoreOrigin({ ...origin, baselineChecksum: null }), null);
    assert.equal(sameCapabilityStoreOrigin(origin, structuredClone(origin)), true);
    assert.equal(sameCapabilityStoreOrigin(origin, { ...origin, version: '2.0.0' }), false);
    assert.equal(sameCapabilityStoreOrigin(undefined, undefined), true);
    assert.equal(sameCapabilityStoreOrigin({}, {}), false);
    const fork = deriveCapabilityStoreOrigin(origin, 'skill:user:fork')!;
    assert.equal(fork.relation, 'derived');
    assert.equal(fork.resourceId, 'skill:user:fork');
    assert.equal(fork.baselineChecksum, checksum);
    assert.equal(fork.version, '1.0.0');
    assert.equal(isIssuedCapabilityStoreOrigin(fork, fork.resourceId), true);
    const child = deriveCapabilityStoreOrigin(origin, 'skill:user:child', 'skills/origin-test')!;
    assert.equal(child.componentPath, 'skills/origin-test');
    assert.equal(child.baselineChecksum, null);
    assert.equal(deriveCapabilityStoreOrigin(origin, 'child', '../private'), undefined);
    assert.equal(deriveCapabilityStoreOrigin(origin, 'child', '/private'), undefined);
    assert.equal(deriveCapabilityStoreOrigin(origin, 'child', 'C:/private'), undefined);
    assert.equal(deriveCapabilityStoreOrigin(origin, 'child', 'skills\\private'), undefined);
    await fs.writeFile(path.join(packageRoot, 'scripts/run.js'), 'process.stdout.write("changed asset");\n');
    await assert.rejects(issueVerifiedCapabilityStoreOrigin(input), /complete package/u);
    assert.equal(origin.baselineChecksum, checksum);
    await assert.rejects(issueVerifiedCapabilityStoreOrigin({ ...input, upstreamChecksum: 'not-a-digest' }), /digest/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log('Capability Store origin and version precedence test passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
