import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilityStoreRegistryIdentity, deriveCapabilityStoreOrigin, type CapabilityStoreOrigin } from '../app/lib/capabilities/packages/store-origin';
import { projectActorCanvasSkillStoreState } from '../app/lib/skills/actor-skill-store-state';
import { compareInstalledStoreResource, installedStoreResourceObservation, type PrivateInstalledStoreResource } from '../app/lib/plugins/store-installed-resource';
import { readBoundedStoreRegistryJson } from '../app/lib/plugins/store-registry-reader';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CanvasSkillStoreRegistry } from '../app/lib/skills/canvas-skill-store';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-origin-reader-'));
  try {
    const registry: CanvasSkillStoreRegistry = { schemaVersion: 1, id: 'store', name: 'Store', registryUrl: 'https://user:token@store.example.test/a?branch=one',
      updatedAt: '2026-10-07', skills: [{ name: 'original', displayName: 'Original', description: '', latestVersion: '2.0.0', versions: {
        '1.0.0': { version: '1.0.0', checksum: 'a'.repeat(64), downloadUrl: 'https://store.example.test/1.zip' },
        '2.0.0': { version: '2.0.0', checksum: 'b'.repeat(64), downloadUrl: 'https://store.example.test/2.zip' },
      } }] };
    const descriptor = (id: string, name = 'original'): CapabilityResourceDescriptor => ({ metadata: { resourceRef: id, legacyResourceId: `legacy-${id}`,
      resourceType: 'skill', sourceType: 'standalone', sourcePluginId: null, ownership: { type: 'user', ownerUserId: 'alice', organizationId: 'org' },
      displayName: null, description: '', responsibleUserId: null, createdByUserId: 'alice', updatedByUserId: null,
      metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
      access: { canRead: true, canUse: true, canEdit: true, canManage: true }, artifact: { resourceType: 'skill', resourceId: `legacy-${id}`, scopeType: 'user',
        name, version: '100.0.0', revision: 5, checksum: 'c'.repeat(64), sourceType: 'standalone', sourcePluginId: null },
      activation: { effectivePolicy: 'optional', enabled: true, readiness: 'unknown', blockedReason: null } });
    const direct = descriptor('direct'), variant = descriptor('variant', 'variant'), unknown = descriptor('legacy');
    const origin: CapabilityStoreOrigin = { contractVersion: 1, resourceId: direct.artifact.resourceId, registryId: registry.id,
      registryIdentity: capabilityStoreRegistryIdentity(registry.registryUrl), kind: 'skill', entryKey: 'original', version: '1.0.0',
      checksumAlgorithm: 'canvas-package-tree-sha256-v1', upstreamChecksum: 'a'.repeat(64), baselineChecksum: 'a'.repeat(64), relation: 'installed', verifiedAt: 1 };
    const observed = (resource: CapabilityResourceDescriptor, source: CapabilityStoreOrigin): PrivateInstalledStoreResource => ({ resourceRef: resource.metadata.resourceRef,
      origin: source, checksum: 'c'.repeat(64), observation: installedStoreResourceObservation(resource) });
    const observations = new Map([[direct.metadata.resourceRef, observed(direct, origin)],
      [variant.metadata.resourceRef, observed(variant, deriveCapabilityStoreOrigin(origin, variant.artifact.resourceId)!)] ]);
    const result = projectActorCanvasSkillStoreState(registry, [direct, variant, unknown], undefined, observations);
    assert.equal(result.skills[0].installed.installed, true);
    assert.equal(result.skills[0].installed.updateAvailable, true, 'A local v100 never replaces the Store baseline v1');
    assert.equal(result.skills[0].installed.version, undefined, 'Multiple exact variants have no arbitrary singular version');
    assert.equal(result.skills[0].installed.restoreAvailable, false);
    assert.deepEqual(result.installedResources.map(resource => resource.metadata.resourceRef), ['direct', 'legacy', 'variant']);
    assert.deepEqual(result.skills[0].installed.resources?.map(resource => resource.metadata.resourceRef), ['direct', 'variant']);
    assert.deepEqual(result.installedResources[0].storeState, { origin: 'verified', localChanges: 'modified', upstream: 'update-available',
      source: { registryId: 'store', entryKey: 'original', version: '1.0.0' } });
    assert.equal(result.installedResources[2].storeState?.origin, 'derived'); assert.equal(result.installedResources[2].storeState?.upstream, 'unknown');
    const alternate = { ...registry, registryUrl: 'https://user:token@store.example.test/a?branch=two' };
    const crossSource = projectActorCanvasSkillStoreState(alternate, [direct], undefined, observations);
    assert.equal(crossSource.skills[0].installed.installed, false); assert.deepEqual(crossSource.skills[0].installed.resources, []);
    const offline = projectActorCanvasSkillStoreState(null, [direct, unknown], undefined, observations);
    assert.equal(offline.availability, 'unavailable'); assert.equal(offline.comparison, 'unknown'); assert.equal(offline.skills.length, 0);
    assert.equal(offline.installedResources.length, 2); assert.equal(offline.installedResources[0].storeState?.localChanges, 'modified');
    const changed = structuredClone(direct); changed.artifact.revision++;
    assert.equal(projectActorCanvasSkillStoreState(registry, [changed], undefined, observations).installedResources[0].storeState?.origin, 'unknown');
    const conflicting = structuredClone(registry.skills[0]); conflicting.versions['1.0.0'].checksum = 'd'.repeat(64);
    assert.equal(compareInstalledStoreResource(observations.get('direct'), registry, conflicting, 'skill').upstream, 'conflict');
    const publicOutput = JSON.stringify(result); for (const forbidden of ['token', 'registryIdentity', 'upstreamChecksum', 'baselineChecksum', 'c'.repeat(64), 'storeOrigin']) assert(!publicOutput.includes(forbidden));

    const file = path.join(root, 'registry.json'), url = pathToFileURL(file).href;
    await fs.writeFile(file, '{"skills":[],"nested":{"name":"first","na\\u006de":"last"}}');
    await assert.rejects(readBoundedStoreRegistryJson(url), /duplicate/);
    await fs.writeFile(file, '{"skills":[],"one":{"name":"a"},"two":{"name":"b"}}');
    assert.deepEqual(await readBoundedStoreRegistryJson(url), { skills: [], one: { name: 'a' }, two: { name: 'b' } });
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1, 32));
    await assert.rejects(readBoundedStoreRegistryJson(url), /byte limit/);
    console.log('Store origin comparison/projection/bounded JSON reader PASS.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
