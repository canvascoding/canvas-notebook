import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import JSZip from 'jszip';
import { createPiTestDatabase } from './helpers/pi-test-database';

let fixtureDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (fixtureDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) return fixtureDatabase;
  if (request === 'server-only') {
    return {};
  }
  // Native dynamic imports may omit the parent and use an absolute filename.
  // Mock only these two provider boundaries; readiness and plugin lifecycle stay real.
  {
    if (request === '@/app/lib/composio/composio-context' || request === './composio-context' || request.endsWith('/app/lib/composio/composio-context.ts')) {
      return { resolveComposioContext: async (input: { userId: string }) => {
        assert.equal(input.userId, 'test-user');
        return { userId: input.userId };
      } };
    }
    if (request === '@/app/lib/composio/composio-gateway' || request === './composio-gateway' || request.endsWith('/app/lib/composio/composio-gateway.ts')) {
      return {
        getGatewayStatus: async (context: { userId: string }) => {
          assert.equal(context.userId, 'test-user');
          return { configured: true, apiKeyValid: true, apiKeyState: 'valid', providerHealthy: true, connectedAccounts: [] };
        },
        getGatewayToolkits: async () => ({ toolkits: [{ slug: 'google-drive', name: 'Google Drive', connected: false }] }),
      };
    }
  }
  if (request === '@earendil-works/pi-ai') {
    return {
      completeSimple: async () => {
        throw new Error('pi-ai should not be called by the Canvas plugin runtime test.');
      },
      streamSimple: async function* () {
        throw new Error('pi-ai should not be streamed by the Canvas plugin runtime test.');
      },
      getModels: () => [],
      getProviders: () => [],
      isContextOverflow: () => false,
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/oauth' || request === '@earendil-works/pi-agent-core') {
    return {};
  }
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function createTestPluginPackage(): Promise<string> {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-package-'));

  await writeFile(path.join(pluginRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({
    name: 'test-plugin',
    version: '1.0.0',
    description: 'Temporary plugin runtime test.',
    license: 'MIT',
    skills: './skills',
    interface: {
      displayName: 'Test Plugin',
      shortDescription: 'Runtime test plugin',
      brandColor: '#2563EB',
      icon: './assets/icon.svg',
    },
    connectors: {
      composio: ['google-drive'],
    },
  }, null, 2));

  await writeFile(path.join(pluginRoot, 'skills', 'test-plugin-skill', 'SKILL.md'), `---
name: test-plugin-skill
description: "Use this temporary plugin skill for Canvas plugin runtime tests."
metadata:
  version: "1.0.0"
---

# Test Plugin Skill

This is a temporary test skill.
`);

  await writeFile(path.join(pluginRoot, 'skills', 'test-plugin-skill', 'agents', 'canvas.yaml'), `interface:
  display_name: Test Plugin Skill
  short_description: Temporary plugin skill
  brand_color: "#2563EB"
  icon_small: "./icon.svg"
`);

  await writeFile(
    path.join(pluginRoot, 'skills', 'test-plugin-skill', 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#2563EB"/><text x="16" y="21" font-size="12" text-anchor="middle" fill="white">TP</text></svg>\n',
  );

  return pluginRoot;
}

async function createSeedRefPluginPackage(): Promise<string> {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-seed-ref-package-'));

  await writeFile(path.join(pluginRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({
    name: 'seed-ref-plugin',
    version: '1.0.0',
    description: 'Temporary plugin runtime test for seed skill references.',
    license: 'MIT',
    skillRefs: ['pdf'],
    interface: {
      displayName: 'Seed Ref Plugin',
      shortDescription: 'Runtime seed ref test plugin',
      brandColor: '#2563EB',
    },
  }, null, 2));

  return pluginRoot;
}

async function createStoreArchive(pluginRoot: string, checksum: string): Promise<string> {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-store-'));
  const packagePrefix = 'canvas-plugin-marketplace-test/plugins/test-plugin/1.0.0';
  const zip = new JSZip();

  async function addDirectory(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await addDirectory(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(pluginRoot, fullPath).split(path.sep).join('/');
        zip.file(`${packagePrefix}/${relativePath}`, await fs.readFile(fullPath));
      }
    }
  }

  await addDirectory(pluginRoot);
  const zipPath = path.join(storeRoot, 'test-plugin.zip');
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const registryPath = path.join(storeRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    id: 'test-store',
    name: 'Test Plugin Store',
    updatedAt: '2026-06-17T00:00:00.000Z',
    plugins: [
      {
        name: 'test-plugin',
        displayName: 'Test Plugin',
        description: 'Temporary plugin store test.',
        latestVersion: '1.0.0',
        icon: 'plugins/test-plugin/1.0.0/assets/icon.svg',
        brandColor: '#2563EB',
        connectors: {
          composio: ['google-drive'],
        },
        skills: ['test-plugin-skill'],
        versions: {
          '1.0.0': {
            version: '1.0.0',
            downloadUrl: pathToFileURL(zipPath).toString(),
            packagePath: packagePrefix,
            checksum: `sha256:${checksum}`,
            manifestPath: '.canvas-plugin/plugin.json',
            releasedAt: '2026-06-17T00:00:00.000Z',
            minCanvasVersion: '2026.6.19.1',
          },
        },
      },
    ],
  }, null, 2));

  return registryPath;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-test-data-'));
  const pluginRoot = await createTestPluginPackage();
  const seedRefPluginRoot = await createSeedRefPluginPackage();
  let storeRoot: string | null = null;
  const envKeys = ['CANVAS_DATA_ROOT', 'CANVAS_PLUGIN_STORE_REGISTRY_URL', 'BASE_URL', 'BETTER_AUTH_BASE_URL'] as const;
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.BASE_URL = 'http://127.0.0.1:3000';
  process.env.BETTER_AUTH_BASE_URL = 'http://127.0.0.1:3000';
  fixtureDatabase = await createPiTestDatabase();
  const raw = await fixtureDatabase.openDb();
  for (const id of ['test-user', 'plugin-user-a', 'plugin-user-b']) await raw.run(
    'INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@plugin-runtime.example.test`]);

  try {
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    await writeFile(
      path.join(dataRoot, 'settings', 'pi-runtime-config.json'),
      JSON.stringify(DEFAULT_PI_CONFIG, null, 2),
    );

    const {
      deleteCanvasPlugin,
      computeCanvasPluginChecksum,
      installCanvasPluginFromPath,
      listCanvasPlugins,
      setCanvasPluginEnabled,
    } = await import('../app/lib/plugins/canvas-plugin-registry');
    const {
      installCanvasPluginFromStore,
      listCanvasPluginStore,
      preflightCanvasPluginFromStore,
    } = await import('../app/lib/plugins/canvas-plugin-store');
    const {
      buildReferencedPluginRuntimeContext,
    } = await import('../app/lib/plugins/plugin-reference-context');
    const { loadSkillsFromDisk } = await import('../app/lib/skills/skill-loader');
    const { readCanvasSkillRegistry, removeCanvasSkillRegistryRecord } = await import('../app/lib/skills/canvas-skill-store');
    const { capabilityStoreRegistryIdentity, normalizeCapabilityStoreOrigin } = await import('../app/lib/capabilities/packages/store-origin');

    const install = await installCanvasPluginFromPath(pluginRoot, { enable: true });
    assert.equal(install.success, true, install.error || JSON.stringify(install.validation));
    await writeFile(path.join(dataRoot, 'skills', 'legacy-standalone-skill', 'SKILL.md'), `---
name: legacy-standalone-skill
description: "Temporary legacy standalone skill for scoped plugin adoption tests."
metadata:
  version: "1.0.0"
---

# Legacy Standalone Skill

This skill lives in the legacy global skills directory.
`);

    let plugins = await listCanvasPlugins();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'test-plugin');
    assert.equal(plugins[0].installedBy, undefined, 'a legacy installation without installer metadata remains unknown');
    const globalPluginInstallDir = plugins[0].installDir;
    const legacyPluginScope = { userId: 'legacy-plugin-user' };
    assert.equal((await listCanvasPlugins(legacyPluginScope)).some((plugin) => plugin.name === 'test-plugin'), true);
    assert.equal(
      (await loadSkillsFromDisk(undefined, legacyPluginScope)).some((skill) => skill.name === 'legacy-standalone-skill'),
      true,
    );
    const legacyDisable = await setCanvasPluginEnabled('test-plugin', false, legacyPluginScope, 'legacy-plugin-user@example.com');
    assert.equal(legacyDisable.success, true, legacyDisable.error ?? 'Expected legacy plugin disable to succeed');
    const legacyPlugins = await listCanvasPlugins(legacyPluginScope);
    assert.equal(legacyPlugins.length, 1);
    assert.equal(legacyPlugins[0].enabled, false);
    assert.equal(legacyPlugins[0].installedBy, undefined, 'legacy adoption does not invent an installer from the current user');
    assert.match(legacyPlugins[0].installDir, /users\/legacy-plugin-user\/plugins\/installed\/test-plugin\/1\.0\.0$/);
    assert.equal(
      await fs.stat(path.join(dataRoot, 'users', 'legacy-plugin-user', 'plugins', 'installed', 'test-plugin', '1.0.0', '.canvas-plugin', 'plugin.json')).then((stat) => stat.isFile()),
      true,
    );
    assert.equal(
      await fs.stat(path.join(dataRoot, 'users', 'legacy-plugin-user', 'skills', 'legacy-standalone-skill', 'SKILL.md')).then((stat) => stat.isFile()),
      true,
    );
    assert.equal(
      (await loadSkillsFromDisk(undefined, legacyPluginScope)).some((skill) => skill.name === 'legacy-standalone-skill'),
      true,
    );
    assert.equal(await fs.stat(globalPluginInstallDir).then((stat) => stat.isDirectory()), true);
    const legacyDeleted = await deleteCanvasPlugin('test-plugin', legacyPluginScope, 'legacy-plugin-user@example.com');
    assert.equal(legacyDeleted.success, true, legacyDeleted.error ?? 'Expected legacy plugin delete to succeed');
    assert.equal((await listCanvasPlugins(legacyPluginScope)).length, 0);
    assert.equal(await fs.stat(globalPluginInstallDir).then((stat) => stat.isDirectory()), true);
    await assert.rejects(fs.stat(path.join(dataRoot, 'users', 'legacy-plugin-user', 'skills', 'test-plugin-skill', 'SKILL.md')));
    assert.equal(plugins[0].skills[0].name, 'test-plugin-skill');
    assert.equal(plugins[0].skills[0].materialized, true);
    assert.equal(plugins[0].skills[0].preexistingStandalone, false);
    assert.equal(
      await fs.stat(path.join(dataRoot, 'skills', 'test-plugin-skill', 'SKILL.md')).then((stat) => stat.isFile()),
      true,
    );

    let skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill' && !skill.plugin), true);

    const pluginRuntimeContext = await buildReferencedPluginRuntimeContext('Use /test-plugin for this workflow.', undefined, { actor: { userId: 'test-user' } });
    assert.match(pluginRuntimeContext || '', /Referenced Canvas Plugins/);
    assert.match(pluginRuntimeContext || '', /test-plugin-skill/);

    const disable = await setCanvasPluginEnabled('test-plugin', false);
    assert.equal(disable.success, true, disable.error ?? 'Expected plugin disable to succeed');
    skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill' && !skill.plugin), true);

    const enable = await setCanvasPluginEnabled('test-plugin', true);
    assert.equal(enable.success, true, enable.error ?? 'Expected plugin enable to succeed');
    skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill'), true);

    const deleted = await deleteCanvasPlugin('test-plugin');
    assert.equal(deleted.success, true, deleted.error ?? 'Expected plugin delete to succeed');
    plugins = await listCanvasPlugins();
    assert.equal(plugins.length, 0);
    skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill'), false);

    const seedRefInstall = await installCanvasPluginFromPath(seedRefPluginRoot, { enable: true });
    assert.equal(seedRefInstall.success, true, seedRefInstall.error || JSON.stringify(seedRefInstall.validation));
    assert.equal(seedRefInstall.plugin?.skills[0].name, 'pdf');
    assert.equal(seedRefInstall.plugin?.skills[0].sourceType, 'seed');
    assert.equal(seedRefInstall.plugin?.skills[0].materialized, true);
    assert.equal(
      await fs.stat(path.join(dataRoot, 'skills', 'pdf', 'SKILL.md')).then((stat) => stat.isFile()),
      true,
    );

    const seedRefDeleted = await deleteCanvasPlugin('seed-ref-plugin');
    assert.equal(seedRefDeleted.success, true, seedRefDeleted.error ?? 'Expected seed reference plugin delete to succeed');

    const checksum = await computeCanvasPluginChecksum(pluginRoot);
    const registryPath = await createStoreArchive(pluginRoot, checksum);
    storeRoot = path.dirname(registryPath);
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();

    let store = await listCanvasPluginStore({ actor: { userId: 'test-user' } });
    assert.equal(store.plugins.length, 1);
    assert.equal(store.plugins[0].name, 'test-plugin');
    assert.equal(store.plugins[0].installed.installed, false);
    assert.equal(store.pagination.totalItems, 1);
    assert.equal(store.stats.available, 1);

    const paginatedStore = await listCanvasPluginStore({ page: 1, pageSize: 1, query: 'test', state: 'available' });
    assert.equal(paginatedStore.plugins.length, 1);
    assert.equal(paginatedStore.pagination.pageSize, 1);
    assert.equal(paginatedStore.pagination.totalItems, 1);

    const preflight = await preflightCanvasPluginFromStore('test-plugin', undefined, 'test-user');
    assert.equal(preflight.pluginName, 'test-plugin');
    assert.equal(preflight.summary.total, 1);
    assert.equal(preflight.items[0].type, 'composio');
    assert.equal(preflight.items[0].ready, false, 'real readiness evaluates a deterministic missing personal connection');

    const storeInstall = await installCanvasPluginFromStore('test-plugin', undefined, { enable: true });
    assert.equal(storeInstall.success, true, storeInstall.error || JSON.stringify(storeInstall.validation));
    assert.equal(storeInstall.plugin?.skills[0].materialized, true);
    assert.equal(storeInstall.plugin?.skills[0].preexistingStandalone, false);

    const legacyStoredPlugin = (await listCanvasPlugins()).find((plugin) => plugin.name === 'test-plugin');
    assert(legacyStoredPlugin);
    assert.equal(legacyStoredPlugin.scopeType, 'legacy');
    assert.equal(legacyStoredPlugin.version, '1.0.0');
    const legacyStoreOrigin = normalizeCapabilityStoreOrigin(legacyStoredPlugin.storeOrigin, legacyStoredPlugin.resourceId);
    assert(legacyStoreOrigin, 'the actual unscoped Store install retains its original verified import');
    assert.equal(legacyStoreOrigin.relation, 'installed');
    assert.equal(legacyStoreOrigin.upstreamChecksum, checksum);
    assert.equal(legacyStoreOrigin.baselineChecksum, legacyStoredPlugin.checksum);
    assert.equal((await readCanvasSkillRegistry()).skills['test-plugin-skill'].sourcePluginName, 'test-plugin');
    assert.equal(await fs.stat(path.join(dataRoot, 'skills', 'test-plugin-skill', 'SKILL.md')).then((stat) => stat.isFile()), true);
    const installedPreflight = await preflightCanvasPluginFromStore('test-plugin', undefined, 'test-user');
    assert.equal(installedPreflight.version, '1.0.0');
    assert.equal(installedPreflight.skillSummary.total, 1);
    assert.equal(installedPreflight.skillSummary.installed, 1);
    assert.equal(installedPreflight.skillSummary.repairable, 0);

    // Legacy import IDs are not actor-scoped provenance. Safe Store DTOs omit materialization details.
    const emptyStoreSkillSummary = { total: 0, installed: 0, missing: 0, updateAvailable: 0, modified: 0, repairable: 0 };
    store = await listCanvasPluginStore({ actor: { userId: 'test-user' } });
    assert.equal(store.plugins[0].installed.installed, false);
    assert.equal(store.plugins[0].installed.version, undefined);
    assert.deepEqual(store.plugins[0].installed.resources, []);
    assert.deepEqual(store.plugins[0].installed.skills, []);
    assert.deepEqual(store.plugins[0].installed.skillSummary, emptyStoreSkillSummary);
    const legacyActorResource = store.installedResources?.find((resource) => resource.artifact.name === 'test-plugin');
    assert(legacyActorResource, 'readable legacy metadata survives an unknown Store comparison');
    assert.equal(legacyActorResource.access.canRead, true);
    assert.notEqual(legacyActorResource.artifact.resourceId, legacyStoredPlugin.resourceId);
    assert.deepEqual(legacyActorResource.storeState, { origin: 'unknown', localChanges: 'unknown', upstream: 'unknown' });

    await fs.rm(path.join(dataRoot, 'skills', 'test-plugin-skill'), { recursive: true, force: true });
    await removeCanvasSkillRegistryRecord('test-plugin-skill');
    assert.equal((await readCanvasSkillRegistry()).skills['test-plugin-skill'], undefined);
    await assert.rejects(fs.stat(path.join(dataRoot, 'skills', 'test-plugin-skill', 'SKILL.md')), { code: 'ENOENT' });

    store = await listCanvasPluginStore({ actor: { userId: 'test-user' } });
    assert.equal(store.plugins[0].installed.installed, false);
    assert.deepEqual(store.plugins[0].installed.skillSummary, emptyStoreSkillSummary);

    const skillRepairPreflight = await preflightCanvasPluginFromStore('test-plugin', undefined, 'test-user');
    assert.equal(skillRepairPreflight.hasSkillIssues, true);
    assert.equal(skillRepairPreflight.skillSummary.total, 1);
    assert.equal(skillRepairPreflight.skillSummary.missing, 1);
    assert.equal(skillRepairPreflight.skillSummary.repairable, 1);
    assert.equal(skillRepairPreflight.skills[0].status, 'missing');

    const repairInstall = await installCanvasPluginFromStore('test-plugin', undefined, { enable: true });
    assert.equal(repairInstall.success, true, repairInstall.error || JSON.stringify(repairInstall.validation));
    assert.equal(
      await fs.stat(path.join(dataRoot, 'skills', 'test-plugin-skill', 'SKILL.md')).then((stat) => stat.isFile()),
      true,
    );
    assert.equal((await readCanvasSkillRegistry()).skills['test-plugin-skill'].sourcePluginName, 'test-plugin');
    const repairedPreflight = await preflightCanvasPluginFromStore('test-plugin', undefined, 'test-user');
    assert.equal(repairedPreflight.hasSkillIssues, false);
    assert.equal(repairedPreflight.skillSummary.total, 1);
    assert.equal(repairedPreflight.skillSummary.installed, 1);
    assert.equal(repairedPreflight.skillSummary.missing, 0);
    assert.equal(repairedPreflight.skillSummary.repairable, 0);

    store = await listCanvasPluginStore({ actor: { userId: 'test-user' } });
    assert.equal(store.plugins[0].installed.installed, false);
    assert.deepEqual(store.plugins[0].installed.skillSummary, emptyStoreSkillSummary);

    // A real explicit personal Store install binds the issued origin to the exact actor resource.
    const storeUserScope = { scopeType: 'user' as const, userId: 'test-user' };
    const legacyBeforeScopedInstall = await listCanvasPlugins();
    const userStoreInstall = await installCanvasPluginFromStore('test-plugin', undefined, { enable: true, scope: storeUserScope });
    assert.equal(userStoreInstall.success, true, userStoreInstall.error || JSON.stringify(userStoreInstall.validation));
    const userStoredPlugin = (await listCanvasPlugins(storeUserScope)).find((plugin) => plugin.name === 'test-plugin');
    assert(userStoredPlugin);
    assert.equal(userStoredPlugin.scopeType, 'user');
    assert.equal(userStoredPlugin.ownerUserId, 'test-user');
    assert(userStoredPlugin.resourceId);
    assert.notEqual(userStoredPlugin.resourceId, legacyStoredPlugin.resourceId);
    const userStoreOrigin = normalizeCapabilityStoreOrigin(userStoredPlugin.storeOrigin, userStoredPlugin.resourceId);
    assert(userStoreOrigin);
    assert.equal(userStoreOrigin.relation, 'installed');
    assert.equal(userStoreOrigin.kind, 'plugin');
    assert.equal(userStoreOrigin.entryKey, 'test-plugin');
    assert.equal(userStoreOrigin.registryId, 'test-store');
    assert.equal(userStoreOrigin.registryIdentity, capabilityStoreRegistryIdentity(pathToFileURL(registryPath).toString()));
    assert.equal(userStoreOrigin.version, '1.0.0');
    assert.equal(userStoreOrigin.upstreamChecksum, checksum);
    assert.equal(userStoreOrigin.baselineChecksum, await computeCanvasPluginChecksum(userStoredPlugin.installDir));
    const userStore = await listCanvasPluginStore({ actor: { userId: 'test-user' } });
    assert.equal(userStore.plugins[0].installed.installed, true);
    assert.equal(userStore.plugins[0].installed.version, '1.0.0');
    assert.equal(userStore.plugins[0].installed.updateAvailable, false);
    assert.deepEqual(userStore.plugins[0].installed.skills, []);
    assert.deepEqual(userStore.plugins[0].installed.skillSummary, emptyStoreSkillSummary);
    assert.equal(userStore.plugins[0].installed.resources?.length, 1);
    const userActorResource = userStore.plugins[0].installed.resources?.[0];
    assert(userActorResource);
    assert.equal(userActorResource.artifact.resourceId, userStoredPlugin.resourceId);
    assert.equal(userActorResource.metadata.legacyResourceId, userStoredPlugin.resourceId);
    assert.equal(userActorResource.artifact.scopeType, 'user');
    assert.deepEqual(userActorResource.metadata.ownership, { type: 'user', ownerUserId: 'test-user', organizationId: null });
    assert.equal(userActorResource.access.canRead, true);
    assert.deepEqual(userActorResource.storeState, { origin: 'verified', localChanges: 'unchanged', upstream: 'current',
      source: { registryId: 'test-store', entryKey: 'test-plugin', version: '1.0.0' } });
    assert.equal(Object.hasOwn(userActorResource, 'storeOrigin'), false);
    assert.equal(Object.hasOwn(userActorResource.artifact, 'checksum'), false);
    assert.deepEqual(await listCanvasPlugins(), legacyBeforeScopedInstall, 'personal install leaves the original legacy record unchanged');

    const originalInstaller = 'first-installer@example.com';
    await writeFile(path.join(dataRoot, 'users', 'known-owner', 'plugins', 'registry.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), plugins: {} }));
    const knownInstall = await installCanvasPluginFromPath(pluginRoot, { enable: true, replace: true, installedBy: originalInstaller, scope: { userId: 'known-owner' } });
    assert.equal(knownInstall.success, true, knownInstall.error || 'Expected first scoped install');
    assert.equal(knownInstall.plugin?.installedBy, originalInstaller);
    const knownUpdate = await installCanvasPluginFromPath(pluginRoot, { enable: true, replace: true, installedBy: 'updater@example.com', scope: { userId: 'known-owner' } });
    assert.equal(knownUpdate.success, true, knownUpdate.error || 'Expected scoped update');
    assert.equal(knownUpdate.plugin?.installedBy, originalInstaller, 'updates preserve the first installer');
    assert.equal((await listCanvasPlugins({ userId: 'known-owner' }))[0].installedBy, originalInstaller);

    const unknownUpdate = await installCanvasPluginFromStore('test-plugin', undefined, { enable: true, installedBy: 'later-updater@example.com' });
    assert.equal(unknownUpdate.success, true, unknownUpdate.error || 'Expected legacy update');
    assert.equal(unknownUpdate.plugin?.installedBy, undefined, 'updating an installation with unknown provenance keeps it unknown');
    assert.equal((await deleteCanvasPlugin('test-plugin')).success, true);
    const freshKnownInstall = await installCanvasPluginFromPath(pluginRoot, { enable: true, installedBy: originalInstaller });
    assert.equal(freshKnownInstall.success, true, freshKnownInstall.error || 'Expected fresh global install');
    const knownAdoption = await setCanvasPluginEnabled('test-plugin', false, { userId: 'known-adopter' }, 'adopter@example.com');
    assert.equal(knownAdoption.success, true, knownAdoption.error || 'Expected known provenance adoption');
    assert.equal((await listCanvasPlugins({ userId: 'known-adopter' }))[0].installedBy, originalInstaller, 'legacy adoption preserves a recorded first installer');

    const pluginScopeA = { userId: 'plugin-user-a' };
    const pluginScopeB = { userId: 'plugin-user-b' };
    await fs.mkdir(path.join(dataRoot, 'users', 'plugin-user-a', 'plugins'), { recursive: true });
    await fs.mkdir(path.join(dataRoot, 'users', 'plugin-user-a', 'skills'), { recursive: true });
    await fs.mkdir(path.join(dataRoot, 'users', 'plugin-user-b', 'plugins'), { recursive: true });
    await fs.mkdir(path.join(dataRoot, 'users', 'plugin-user-b', 'skills'), { recursive: true });
    await writeFile(path.join(dataRoot, 'users', 'plugin-user-b', 'plugins', 'registry.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-17T00:00:00.000Z',
      plugins: {},
    }, null, 2));
    const scopedInstall = await installCanvasPluginFromPath(pluginRoot, {
      enable: true,
      installedBy: 'plugin-user-a@example.com',
      scope: pluginScopeA,
    });
    assert.equal(scopedInstall.success, true, scopedInstall.error || JSON.stringify(scopedInstall.validation));
    assert.equal((await listCanvasPlugins(pluginScopeA)).length, 1);
    assert.equal((await listCanvasPlugins(pluginScopeB)).length, 0);
    assert.equal(
      await fs.stat(path.join(dataRoot, 'users', 'plugin-user-a', 'plugins', 'installed', 'test-plugin', '1.0.0', '.canvas-plugin', 'plugin.json')).then((stat) => stat.isFile()),
      true,
    );
    assert.equal(
      await fs.stat(path.join(dataRoot, 'users', 'plugin-user-a', 'skills', 'test-plugin-skill', 'SKILL.md')).then((stat) => stat.isFile()),
      true,
    );
    await assert.rejects(fs.stat(path.join(dataRoot, 'users', 'plugin-user-b', 'skills', 'test-plugin-skill', 'SKILL.md')));
    assert.equal((await loadSkillsFromDisk(undefined, pluginScopeA)).some((skill) => skill.name === 'test-plugin-skill'), true);
    assert.equal((await loadSkillsFromDisk(undefined, pluginScopeB)).some((skill) => skill.name === 'test-plugin-skill'), false);
    assert.match(
      await buildReferencedPluginRuntimeContext('Use /test-plugin for this workflow.', pluginScopeA) || '',
      /Referenced Canvas Plugins/,
    );
    assert.equal(await buildReferencedPluginRuntimeContext('Use /test-plugin for this workflow.', pluginScopeB), null);

    console.log('canvas plugin runtime test passed');
  } finally {
    moduleInternals._load = originalLoad;
    await fixtureDatabase.close(); fixtureDatabase = undefined;
    for (const key of envKeys) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
    await fs.rm(seedRefPluginRoot, { recursive: true, force: true });
    if (storeRoot) {
      await fs.rm(storeRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
