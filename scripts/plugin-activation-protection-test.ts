import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { createCapabilityResourceId } from '../app/lib/capabilities/reference';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const originalEnvironment = { ...process.env };
let membershipActive = true;
let membershipFails = false;
let audits = 0;
const permissionState = (userId: string) => {
  if (membershipFails) throw new Error('Permission database unavailable');
  return {
    organizationId: userId === 'user-only' ? null : 'actual-org',
    permission: userId === 'user-only' ? null : { status: membershipActive ? 'active' : 'disabled', role: 'admin', canSharePluginsAndSkills: true },
  };
};

internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/organization/permissions') return {
    readOrganizationPermissionForUser: async (userId: string) => permissionState(userId),
    requireOrganizationPermission: async () => ({ ok: true, session: { user: { id: 'member', email: 'member@example.test' } }, state: permissionState('member') }),
  };
  if (request === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => { audits += 1; } };
  if (request === '@/app/lib/pi/system-prompt-snapshot' || request.endsWith('/app/lib/pi/system-prompt-snapshot.ts')) return { invalidatePiSystemPromptSnapshotsForUser: async () => {}, invalidatePiSystemPromptSnapshotsForOrganization: async () => [] };
  if (request === '@/app/lib/pi/live-runtime' || request.endsWith('/app/lib/pi/live-runtime.ts')) return { requestPiRuntimePromptRefreshForUser: async () => {} };
  if (request === '@/app/lib/mobile/extensions') return { serializeMobileInstalledPlugin: (plugin: unknown) => plugin };
  return originalLoad(request, parent, isMain);
};

async function filesBelow(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else files[path.relative(root, fullPath)] = (await fs.readFile(fullPath)).toString('base64');
    }
  }
  await visit(root);
  return files;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-protection-data-'));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-protection-source-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.DATA = dataRoot;
  process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT = sourceRoot;
  try {
    const registry = await import('../app/lib/plugins/canvas-plugin-registry');
    const { resolveActivePluginOrganizationScope } = await import('../app/lib/plugins/plugin-scope-protection');
    const { resolveScopedPluginsDataDir, resolveScopedSkillRegistryPath, resolveScopedSkillsDataDir } = await import('../app/lib/runtime-data-paths');
    const user = { scopeType: 'user' as const, userId: 'member', organizationId: 'spoofed-org' };
    const organization = { scopeType: 'organization' as const, organizationId: 'actual-org' };
    const packageAt = async (name: string, version = '1.0.0', skillName = name) => {
      const root = path.join(sourceRoot, `${name}-${version}`);
      await fs.mkdir(path.join(root, '.canvas-plugin'), { recursive: true });
      await fs.mkdir(path.join(root, 'skills', skillName), { recursive: true });
      await fs.writeFile(path.join(root, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name, version, description: 'Activation protection fixture', license: 'MIT', skills: './skills' }));
      await fs.writeFile(path.join(root, 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Activation protection fixture\n---\n\n# Fixture\n`);
      return root;
    };
    const common = await packageAt('shared-plugin');
    const update = await packageAt('shared-plugin', '2.0.0');
    const solo = await packageAt('personal-plugin');
    await registry.writeCanvasPluginRegistry({ version: 1, updatedAt: '', plugins: {} }, user);
    assert.equal((await registry.installCanvasPluginFromPath(common, { scope: user, enable: false })).success, true);
    const orgInstall = await registry.installCanvasPluginFromPath(common, { scope: organization, enable: true });
    assert.equal(orgInstall.success, true, orgInstall.error || 'Organization package installs');
    assert.deepEqual(await resolveActivePluginOrganizationScope(user), organization, 'a caller cannot replace the verified organization with a scope hint');
    assert.equal(await resolveActivePluginOrganizationScope(organization), null, 'organization management keeps its own scope');

    const deniedWithoutChanges = async (operation: () => Promise<{ success: boolean; code?: string; status?: number; protectedResourceId?: string }>) => {
      const before = await filesBelow(dataRoot);
      const result = await operation();
      assert.equal(result.success, false);
      assert.equal(result.code, 'CAPABILITY_NAMESPACE_PROTECTED');
      assert.equal(result.status, 409);
      assert.equal(result.protectedResourceId, orgInstall.plugin?.resourceId);
      assert.deepEqual(await filesBelow(dataRoot), before, 'denial cannot adopt legacy records, alter files, enable skills or bump registry revisions');
      return result;
    };
    for (const state of ['active', 'disabled', 'blocked', 'different-case', 'legacy-id']) {
      const orgRegistry = await registry.readCanvasPluginRegistry(organization);
      const protectedPlugin = orgRegistry.plugins['shared-plugin'];
      protectedPlugin.enabled = state === 'active';
      protectedPlugin.effectivePolicy = state === 'blocked' ? 'blocked' : 'optional';
      protectedPlugin.name = state === 'different-case' ? 'SHARED-PLUGIN' : 'shared-plugin';
      protectedPlugin.scopeType = state === 'legacy-id' ? 'legacy' : 'organization';
      protectedPlugin.resourceId = state === 'legacy-id' ? 'old-system-plugin-id' : orgInstall.plugin!.resourceId;
      await registry.writeCanvasPluginRegistry(orgRegistry, organization);
      await deniedWithoutChanges(() => registry.setCanvasPluginEnabled('shared-plugin', true, user));
      await deniedWithoutChanges(() => registry.installCanvasPluginFromPath(update, { scope: user, enable: true, replace: true }));
    }
    const orgRegistry = await registry.readCanvasPluginRegistry(organization);
    orgRegistry.plugins['shared-plugin'].name = 'shared-plugin';
    orgRegistry.plugins['shared-plugin'].scopeType = 'organization';
    orgRegistry.plugins['shared-plugin'].resourceId = orgInstall.plugin!.resourceId;
    await registry.writeCanvasPluginRegistry(orgRegistry, organization);
    await deniedWithoutChanges(() => registry.installCanvasPluginFromPath(common, { scope: { userId: 'new-member' } }));
    await assert.rejects(fs.stat(resolveScopedPluginsDataDir({ userId: 'new-member' })), { code: 'ENOENT' }, 'denial cannot create personal storage through legacy adoption');
    assert.equal((await registry.setCanvasPluginEnabled('shared-plugin', false, user)).success, true, 'personal deactivation remains available');
    assert.equal((await registry.installCanvasPluginFromPath(update, { scope: user, enable: false, replace: true })).success, true, 'inactive personal copies may be retained or updated');
    assert.equal((await registry.setCanvasPluginEnabled('shared-plugin', true, organization)).success, true, 'the organization can still manage its own package');
    assert.equal((await registry.installCanvasPluginFromPath(solo, { scope: user, enable: true })).success, true, 'unrelated personal packages remain available');
    assert.equal((await registry.installCanvasPluginFromPath(common, { scope: { userId: 'user-only' }, enable: true })).success, true, 'the same name in an unrelated organization cannot globally block personal storage');
    const childScope = { userId: 'child-member' };
    const differentPlugin = await packageAt('different-plugin', '1.0.0', 'shared-plugin');
    const beforeChildInstall = await filesBelow(dataRoot);
    const childDenied = await registry.installCanvasPluginFromPath(differentPlugin, { scope: childScope, enable: true });
    assert.equal(childDenied.code, 'CAPABILITY_NAMESPACE_PROTECTED');
    assert.equal(childDenied.protectedName, 'shared-plugin', 'a different plugin name cannot activate a skill owned by an organization package');
    assert.equal(childDenied.protectedScopeType, 'organization');
    assert.deepEqual(await filesBelow(dataRoot), beforeChildInstall);
    assert.equal((await registry.installCanvasPluginFromPath(differentPlugin, { scope: childScope, enable: false })).success, true);
    const beforeChildEnable = await filesBelow(dataRoot);
    const childEnable = await registry.setCanvasPluginEnabled('different-plugin', true, childScope);
    assert.equal(childEnable.protectedName, 'shared-plugin');
    assert.deepEqual(await filesBelow(dataRoot), beforeChildEnable, 'enabling an existing plugin cannot change a protected child skill');
    const standaloneDir = path.join(resolveScopedSkillsDataDir(organization), 'org-standalone');
    await fs.mkdir(standaloneDir, { recursive: true });
    await fs.writeFile(path.join(standaloneDir, 'SKILL.md'), '---\nname: org-standalone\ndescription: Organization standalone fixture\n---\n\n# Fixture\n');
    const orgSkills = JSON.parse(await fs.readFile(resolveScopedSkillRegistryPath(organization), 'utf8'));
    orgSkills.skills['org-standalone'] = { name: 'org-standalone', resourceId: 'organization:org-standalone', version: '1.0.0', scopeType: 'organization', organizationId: 'actual-org', sourceType: 'local', skillPath: path.join(standaloneDir, 'SKILL.md'), installDir: standaloneDir };
    await fs.writeFile(resolveScopedSkillRegistryPath(organization), JSON.stringify(orgSkills));
    const standaloneChild = await packageAt('standalone-child-plugin', '1.0.0', 'org-standalone');
    const beforeStandaloneChild = await filesBelow(dataRoot);
    const standaloneDenied = await registry.installCanvasPluginFromPath(standaloneChild, { scope: childScope, enable: true });
    assert.equal(standaloneDenied.protectedName, 'org-standalone');
    assert.equal(standaloneDenied.protectedResourceId, 'organization:org-standalone');
    assert.deepEqual(await filesBelow(dataRoot), beforeStandaloneChild, 'standalone organization skills retain the same activation protection');
    orgSkills.skills['org-standalone'].scopeType = 'legacy';
    orgSkills.skills['org-standalone'].resourceId = 'old-system-skill-id';
    await fs.writeFile(resolveScopedSkillRegistryPath(organization), JSON.stringify(orgSkills));
    const beforeLegacySkill = await filesBelow(dataRoot);
    const legacySkillDenied = await registry.installCanvasPluginFromPath(standaloneChild, { scope: childScope, enable: true });
    assert.equal(legacySkillDenied.protectedResourceId, createCapabilityResourceId({ resourceType: 'skill', scopeType: 'organization', sourceType: 'standalone', name: 'org-standalone', organizationId: organization.organizationId }), 'legacy protection metadata uses the same synthesized organization identity as the catalog');
    assert.deepEqual(await filesBelow(dataRoot), beforeLegacySkill);
    const systemRecord = { ...orgInstall.plugin!, scopeType: 'system' as const, organizationId: null, resourceId: 'system:shared-plugin' };
    await registry.writeCanvasPluginRegistry({ version: 1, updatedAt: '', plugins: { 'shared-plugin': systemRecord } });
    const beforeSystem = await filesBelow(dataRoot);
    const systemDenied = await registry.setCanvasPluginEnabled('shared-plugin', true, { userId: 'system-fallback-user' });
    assert.equal(systemDenied.code, 'CAPABILITY_NAMESPACE_PROTECTED');
    assert.equal(systemDenied.protectedScopeType, 'system');
    assert.equal(systemDenied.protectedResourceId, systemRecord.resourceId);
    assert.deepEqual(await filesBelow(dataRoot), beforeSystem, 'visible system records retain their protected namespace before legacy adoption');
    membershipActive = false;
    assert.equal(await resolveActivePluginOrganizationScope(user), null);
    membershipActive = true;
    membershipFails = true;
    const beforeFailure = await filesBelow(dataRoot);
    await assert.rejects(registry.setCanvasPluginEnabled('personal-plugin', true, user), /Permission database unavailable/);
    assert.deepEqual(await filesBelow(dataRoot), beforeFailure, 'uncertain authorization fails closed before mutations');
    membershipFails = false;

    const checksum = await registry.computeCanvasPluginChecksum(update);
    const zip = new JSZip();
    for (const [name, contents] of Object.entries(await filesBelow(update))) zip.file(name, Buffer.from(contents, 'base64'));
    const archive = path.join(sourceRoot, 'shared-plugin.zip');
    await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
    const storePath = path.join(sourceRoot, 'store.json');
    await fs.writeFile(storePath, JSON.stringify({ schemaVersion: 1, id: 'protection-store', name: 'Protection store', updatedAt: new Date().toISOString(), plugins: [{ name: 'shared-plugin', displayName: 'Shared plugin', description: '', latestVersion: '2.0.0', versions: { '2.0.0': { version: '2.0.0', downloadUrl: pathToFileURL(archive).toString(), checksum: `sha256:${checksum}` } } }] }));
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(storePath).toString();
    const { installCanvasPluginFromStore } = await import('../app/lib/plugins/canvas-plugin-store');
    await deniedWithoutChanges(() => installCanvasPluginFromStore('shared-plugin', '2.0.0', { scope: user, enable: true }));
    const { setCanvasPluginEnabledForAgent, updateCanvasPluginFromWorkspace } = await import('../app/lib/plugins/agent-plugin-workspace');
    const protectedError = { code: 'CAPABILITY_NAMESPACE_PROTECTED', status: 409, protectedResourceId: orgInstall.plugin?.resourceId };
    await assert.rejects(setCanvasPluginEnabledForAgent({ pluginName: 'shared-plugin', enabled: true, scope: { userId: 'member' } }), protectedError);
    const personal = await registry.getCanvasPlugin('shared-plugin', user);
    await assert.rejects(updateCanvasPluginFromWorkspace({ workspaceRoot: sourceRoot, workspacePath: path.relative(sourceRoot, update), pluginName: 'shared-plugin', expectedVersion: personal!.version, expectedChecksum: personal!.checksum, scope: { userId: 'member' }, enable: true }), protectedError);

    const { POST: webEnable } = await import('../app/api/plugins/[name]/enable/route');
    const { POST: mobileEnable } = await import('../app/api/mobile/v1/extensions/plugins/[name]/enable/route');
    const { POST: webPathInstall } = await import('../app/api/plugins/install/route');
    const { POST: webStoreInstall } = await import('../app/api/plugins/store/install/route');
    const { POST: mobileStoreInstall } = await import('../app/api/mobile/v1/extensions/plugins/store/install/route');
    const beforeRoutes = await filesBelow(dataRoot);
    for (const enable of [webEnable, mobileEnable]) {
      const response = await enable(new Request('https://canvas.example.test/api/plugins/shared-plugin/enable'), { params: Promise.resolve({ name: 'shared-plugin' }) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'CAPABILITY_NAMESPACE_PROTECTED');
    }
    for (const [install, body] of [
      [webPathInstall, { sourcePath: update, enable: true, replace: true }],
      [webStoreInstall, { name: 'shared-plugin', enable: true }],
      [mobileStoreInstall, { name: 'shared-plugin', enable: true }],
    ] as const) {
      const response = await install(new Request('https://canvas.example.test/api/plugins/install', { method: 'POST', body: JSON.stringify(body) }));
      assert.equal(response.status, 409);
      const result = await response.json();
      assert.equal(result.code, 'CAPABILITY_NAMESPACE_PROTECTED');
      assert.equal(result.protectedResourceId, orgInstall.plugin?.resourceId);
    }
    assert.equal(audits, 0, 'denied routes do not record successful activation');
    assert.deepEqual(await filesBelow(dataRoot), beforeRoutes);
    console.log('Plugin activation protection: real registries/files, active/disabled/blocked namespaces, verified scope, Store/Path/Agent/mobile denials and no unintended mutations passed.');
  } finally {
    internals._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
