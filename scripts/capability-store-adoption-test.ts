import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanvasPluginInstallRecord } from '../app/lib/plugins/canvas-plugin-registry';
import type { CanvasSkillInstallRecord } from '../app/lib/skills/canvas-skill-store';

// New isolated filesystem regression. No configured DB, server or provider is used.
// Runtime notification seams are unused by the authority/copy/origin paths under test.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-store-adoption-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://127.0.0.1:1', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:1', DATABASE_URL: 'postgresql://127.0.0.1:1/unopened_adoption_fixture' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalReaddir = fs.readdir;
  loader._load = (request, parent, isMain) => {
    if (request === '@/app/lib/pi/live-runtime' || /\/pi\/live-runtime(?:\.ts)?$/u.test(request)) return { requestPiRuntimePromptRefreshForUser: async () => {} };
    if (request === '@/app/lib/pi/system-prompt-snapshot' || /\/pi\/system-prompt-snapshot(?:\.ts)?$/u.test(request)) return { invalidatePiSystemPromptSnapshotsForUser: async () => [] };
    return originalLoad(request, parent, isMain);
  };
  try {
    const paths = await import('../app/lib/runtime-data-paths');
    const { createCapabilityResourceId } = await import('../app/lib/capabilities/reference');
    const { issueVerifiedCapabilityStoreOrigin, sameCapabilityStoreOrigin } = await import('../app/lib/capabilities/packages/store-origin');
    const { computeCanvasPluginChecksum, installCanvasPluginFromPath, readCanvasPluginRegistry } = await import('../app/lib/plugins/canvas-plugin-registry');
    const { adoptLegacyStandaloneSkillsForScope } = await import('../app/lib/skills/legacy-skill-adoption');
    const legacySkills = paths.resolveScopedSkillsDataDir();
    await fs.mkdir(legacySkills, { recursive: true });
    const skillRecords: Record<string, CanvasSkillInstallRecord> = {};
    for (const name of ['adoption-copied-skill', 'adoption-existing-skill']) {
      const installDir = path.join(legacySkills, name), skillPath = path.join(installDir, 'SKILL.md');
      await fs.mkdir(path.join(installDir, 'scripts'), { recursive: true });
      await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: Exact legacy source\nmetadata:\n  version: "1.0.0"\n---\nVerified original body.\n`);
      await fs.writeFile(path.join(installDir, 'scripts/run.js'), 'process.stdout.write("legacy-source");\n');
      const resourceId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'standalone', name });
      const checksum = await computeCanvasPluginChecksum(installDir);
      const storeOrigin = await issueVerifiedCapabilityStoreOrigin({ resourceId, registryId: 'adoption-store', registryUrl: 'https://store.example.test/registry.json',
        kind: 'skill', entryKey: name, version: '1.0.0', upstreamChecksum: checksum, packageRoot: installDir });
      skillRecords[name] = { resourceId, scopeType: 'legacy', organizationId: null, ownerUserId: null, name, version: '1.0.0', description: 'Exact legacy source',
        sourceType: 'store', installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', checksum, installDir, skillPath, storeOrigin };
    }
    await fs.writeFile(paths.resolveScopedSkillRegistryPath(), JSON.stringify({ version: 1, updatedAt: '', skills: skillRecords }));
    const copiedScope = { userId: 'adoption-copy-user' };
    assert.equal(await paths.shouldUseLegacyScopedSkillsFallback(copiedScope), true);
    assert.equal(await adoptLegacyStandaloneSkillsForScope(copiedScope), true);
    const copiedRegistry = JSON.parse(await fs.readFile(paths.resolveScopedSkillRegistryPath(copiedScope), 'utf8')) as { skills: Record<string, CanvasSkillInstallRecord> };
    const copied = copiedRegistry.skills['adoption-copied-skill'], source = skillRecords['adoption-copied-skill'];
    const expectedId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'user', sourceType: 'standalone', name: source.name, ownerUserId: copiedScope.userId });
    assert.equal(copied.resourceId, expectedId);
    assert.equal(copied.storeOrigin?.resourceId, expectedId);
    assert.equal(copied.storeOrigin?.relation, 'derived');
    assert.equal(copied.storeOrigin?.baselineChecksum, source.storeOrigin?.baselineChecksum);
    assert.equal(copied.storeOrigin?.upstreamChecksum, source.storeOrigin?.upstreamChecksum);
    assert.equal(copied.storeOrigin?.verifiedAt, source.storeOrigin?.verifiedAt);
    assert.equal(await computeCanvasPluginChecksum(copied.installDir), source.checksum);
    assert(!sameCapabilityStoreOrigin(copied.storeOrigin, source.storeOrigin));
    const racingScope = { userId: 'adoption-race-user' }, ownTarget = path.join(paths.resolveScopedSkillsDataDir(racingScope), 'adoption-existing-skill');
    assert.equal(await paths.shouldUseLegacyScopedSkillsFallback(racingScope), true);
    let injected = false;
    // Reproduce the real readiness/copy race after the actual fallback check:
    // another writer creates a same-name personal package before the legacy scan resolves.
    fs.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
      if (!injected && String(args[0]) === legacySkills) {
        injected = true;
        await fs.mkdir(ownTarget, { recursive: true });
        await fs.writeFile(path.join(ownTarget, 'SKILL.md'), 'UNRELATED_OWN_PACKAGE_BYTES');
      }
      return Reflect.apply(originalReaddir, fs, args);
    }) as typeof fs.readdir;
    try { assert.equal(await adoptLegacyStandaloneSkillsForScope(racingScope), true); }
    finally { fs.readdir = originalReaddir; }
    assert.equal(injected, true);
    assert.equal(await fs.readFile(path.join(ownTarget, 'SKILL.md'), 'utf8'), 'UNRELATED_OWN_PACKAGE_BYTES');
    const raceRegistry = JSON.parse(await fs.readFile(paths.resolveScopedSkillRegistryPath(racingScope), 'utf8')) as { skills: Record<string, CanvasSkillInstallRecord> };
    assert.equal(raceRegistry.skills['adoption-existing-skill'].storeOrigin, undefined,
      'A preexisting personal package that was never copied cannot inherit a legacy Store origin.');
    assert.equal(raceRegistry.skills['adoption-copied-skill'].storeOrigin?.relation, 'derived');

    const pluginRecords: Record<string, CanvasPluginInstallRecord> = {};
    const pluginPackage = async (name: string): Promise<string> => {
      const directory = path.join(root, 'plugin-sources', name), child = `${name}-child`;
      await fs.mkdir(path.join(directory, '.canvas-plugin'), { recursive: true });
      await fs.mkdir(path.join(directory, 'skills', child), { recursive: true });
      await fs.writeFile(path.join(directory, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Own adoption fixture', skills: 'skills' }));
      await fs.writeFile(path.join(directory, 'skills', child, 'SKILL.md'), `---\nname: ${child}\ndescription: Exact plugin child\n---\nChild body.\n`);
      return directory;
    };
    for (const [name, binding] of [['adoption-good-plugin', 'good'], ['adoption-missing-plugin', 'missing'], ['adoption-wrong-plugin', 'wrong']] as const) {
      const installDir = await pluginPackage(name), checksum = await computeCanvasPluginChecksum(installDir);
      const resourceId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'system', sourceType: 'standalone', name });
      const storeOrigin = await issueVerifiedCapabilityStoreOrigin({ resourceId: binding === 'wrong' ? 'different-source-resource' : resourceId,
        registryId: 'adoption-store', registryUrl: 'https://store.example.test/registry.json', kind: 'plugin', entryKey: name, version: '1.0.0', upstreamChecksum: checksum, packageRoot: installDir });
      pluginRecords[name] = { ...(binding === 'missing' ? {} : { resourceId }), scopeType: 'legacy', sourceType: 'standalone', name, version: '1.0.0', description: 'Own adoption fixture',
        source: 'local', sourcePath: installDir, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', enabled: false,
        checksum, installDir, manifestPath: path.join(installDir, '.canvas-plugin/plugin.json'), skillsDir: path.join(installDir, 'skills'), skills: [], storeOrigin };
    }
    await fs.mkdir(path.dirname(paths.resolveScopedPluginRegistryPath()), { recursive: true });
    await fs.writeFile(paths.resolveScopedPluginRegistryPath(), JSON.stringify({ version: 1, updatedAt: '', plugins: pluginRecords }));
    const pluginScope = { userId: 'adoption-plugin-user' };
    assert.equal(await paths.shouldUseLegacyScopedPluginsFallback(pluginScope), true);
    const trigger = await installCanvasPluginFromPath(await pluginPackage('adoption-trigger-plugin'), { scope: pluginScope, enable: false });
    assert.equal(trigger.success, true, trigger.error ?? 'The actual personal plugin installation must adopt the legacy registry.');
    const adopted = await readCanvasPluginRegistry(pluginScope);
    const good = adopted.plugins['adoption-good-plugin'], goodSource = pluginRecords['adoption-good-plugin'];
    assert(good && good.resourceId);
    assert.notEqual(good.resourceId, goodSource.resourceId);
    assert.equal(good.storeOrigin?.resourceId, good.resourceId);
    assert.equal(good.storeOrigin?.relation, 'derived');
    assert.equal(good.storeOrigin?.baselineChecksum, goodSource.storeOrigin?.baselineChecksum);
    assert.equal(good.storeOrigin?.verifiedAt, goodSource.storeOrigin?.verifiedAt);
    assert.equal(await computeCanvasPluginChecksum(good.installDir), goodSource.checksum);
    assert.equal(adopted.plugins['adoption-missing-plugin'].storeOrigin, undefined);
    assert.equal(adopted.plugins['adoption-wrong-plugin'].storeOrigin, undefined);
    console.log('Capability Store adoption PASS: actual legacy filesystem copies, readiness/copy collision, exact derived scoped identities, immutable baselines and missing/wrong plugin source bindings stay unknown.');
  } finally {
    fs.readdir = originalReaddir;
    loader._load = originalLoad;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
