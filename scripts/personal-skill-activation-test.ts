import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
const originalEnvironment = { ...process.env };
const userId = 'skill-guard-user';
let organizationId: string | null = 'skill-guard-org';
let organizationStatus = 'active';
let organizationBulkCalls = 0;
let auditCalls = 0;
const permissionState = () => ({ configured: Boolean(organizationId), organizationId, permission: organizationId ? { status: organizationStatus, role: 'owner', canSharePluginsAndSkills: true } : null });
const authenticated = () => ({ ok: true, session: { user: { id: userId, email: 'skill-guard@example.test' } }, state: permissionState() });

internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/organization/permissions') return {
    readOrganizationPermissionForUser: async (requestedUser: string) => {
      assert.equal(requestedUser, userId, 'organization authority derives from the actual user');
      return permissionState();
    },
    requireOrganizationPermission: async () => authenticated(),
  };
  if (request === '@/app/lib/capabilities/request-auth') return { requireActiveCapabilityUser: async () => authenticated() };
  if (request === '@/app/lib/capabilities/request-scope') return { resolveCapabilityStorageScope: (input: { requestedScope?: string; userId: string }) => input.requestedScope === 'organization' ? { scopeType: 'organization', organizationId } : { scopeType: 'user', userId: input.userId } };
  if (request === '@/app/lib/capabilities/activation-actions') return {
    refreshPersonalCapabilityRuntime: async () => undefined,
    refreshCapabilityRuntimeForScope: async () => undefined,
    setAllPersonalOrganizationCapabilityActivations: async () => { organizationBulkCalls += 1; return 1; },
  };
  if (request === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => { auditCalls += 1; } };
  if (request === '@earendil-works/pi-ai') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  if (request === '@earendil-works/pi-ai/oauth') return {};
  return originalLoad(request, parent, isMain);
};

function skillContent(name: string, version = '1.0.0'): string {
  return `---\nname: ${name}\ndescription: "Skill activation namespace regression fixture."\nmetadata:\n  version: "${version}"\n---\n\n# ${name}\n\nPreserved personal content.\n`;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-personal-skill-activation-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const { resolveScopedSkillsDataDir, resolveScopedSkillRegistryPath, resolveScopedPluginRegistryPath, resolveScopedSettingsDir } = await import('../app/lib/runtime-data-paths');
    const { assertPersonalSkillActivationAllowed, readProtectedPersonalSkillNames, PersonalSkillActivationError } = await import('../app/lib/skills/personal-skill-activation');
    const { installCanvasSkillFromStore, restoreCanvasSkill, listCanvasSkillStore } = await import('../app/lib/skills/canvas-skill-store');
    const { importSkillPackage } = await import('../app/lib/skills/skill-package-import');
    const { createSkillDirectory } = await import('../app/lib/skills/skill-loader');
    const { installCanvasSkillFromWorkspace, updateCanvasSkillFromWorkspace } = await import('../app/lib/skills/agent-skill-workspace');
    const { readEnabledSkillsForScope, writeEnabledSkillsForScope } = await import('../app/lib/skills/skill-settings');
    const { POST: enable } = await import('../app/api/skills/[name]/enable/route');
    const { POST: enableAll } = await import('../app/api/skills/enable-all/route');
    const { POST: storeInstall } = await import('../app/api/skills/store/install/route');
    const { POST: upload } = await import('../app/api/skills/upload/route');
    const { POST: restore } = await import('../app/api/skills/[name]/restore/route');
    const scope = { userId, organizationId: 'forged-org' };
    const orgScope = { scopeType: 'organization' as const, organizationId: 'skill-guard-org' };
    const personalPath = path.join(resolveScopedSkillsDataDir(scope), 'shared-skill', 'SKILL.md');
    const settingsPath = path.join(resolveScopedSettingsDir(scope), 'skills.json');
    await writeFile(personalPath, skillContent('shared-skill'));
    const orgPath = path.join(resolveScopedSkillsDataDir(orgScope), 'shared-skill', 'SKILL.md');
    await writeFile(orgPath, skillContent('shared-skill', '2.0.0'));
    const orgRecord = { name: 'shared-skill', scopeType: 'organization', organizationId: orgScope.organizationId, resourceId: 'exact-org-skill', sourceType: 'local', version: '2.0.0', description: 'Org version', installDir: path.dirname(orgPath), skillPath: orgPath, checksum: 'a'.repeat(64), installedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeFile(resolveScopedSkillRegistryPath(orgScope), JSON.stringify({ version: 1, skills: { 'shared-skill': orgRecord } }));
    await writeFile(resolveScopedPluginRegistryPath(orgScope), JSON.stringify({ version: 1, plugins: { 'disabled-org-plugin': { name: 'disabled-org-plugin', version: '3.0.0', enabled: false, scopeType: 'organization', skills: [{ name: 'plugin-child', version: '3.1.0' }] } } }));
    await writeEnabledSkillsForScope(['__none__'], { scope });
    const beforeContent = await fs.readFile(personalPath, 'utf8');
    const beforeConfig = await fs.readFile(settingsPath, 'utf8');
    const names = await readProtectedPersonalSkillNames(scope);
    assert.deepEqual([...names].sort(), ['plugin-child', 'shared-skill']);
    for (const name of ['shared-skill', 'SHARED-SKILL', 'plugin-child']) {
      await assert.rejects(assertPersonalSkillActivationAllowed(name, scope), PersonalSkillActivationError);
    }
    await assertPersonalSkillActivationAllowed('find-skills', scope);
    await assertPersonalSkillActivationAllowed('shared-skill', orgScope);

    const response = await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: 'shared-skill' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'SKILL_SCOPE_PROTECTED');
    assert.equal(auditCalls, 0, 'denied activation emits no success audit');
    assert.equal((await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: 'unknown-skill' }) })).status, 404);
    assert.equal((await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: '../invalid' }) })).status, 400);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), beforeConfig);
    const bulk = await enableAll(new Request('http://fixture/enable-all', { method: 'POST' }));
    const bulkBody = await bulk.json();
    assert.equal(bulkBody.allEnabled, false);
    assert.deepEqual(await readEnabledSkillsForScope(scope), ['__none__'], 'all protected optional skills serialize NONE, never ALL');
    assert.equal(organizationBulkCalls, 1, 'optional organization personal activation remains delegated to exact-resource preferences');
    const coreResponse = await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: 'find-skills' }) });
    assert.equal(coreResponse.status, 200, 'built-in core enable remains a harmless supported action');
    assert.deepEqual(await readEnabledSkillsForScope(scope), ['__none__']);
    auditCalls = 0;

    const storeResult = await installCanvasSkillFromStore('shared-skill', undefined, { scope });
    assert.equal(storeResult.code, 'SKILL_SCOPE_PROTECTED');
    assert.equal(storeResult.statusCode, 409);
    const restored = await restoreCanvasSkill('shared-skill', { scope });
    assert.equal(restored.code, 'SKILL_SCOPE_PROTECTED', 'restore does not swallow denial in a seed fallback');
    await writeFile(resolveScopedSkillRegistryPath(orgScope), JSON.stringify({ version: 1, skills: { 'shared-skill': orgRecord, docx: { ...orgRecord, name: 'docx' } } }));
    const seedRestore = await restoreCanvasSkill('docx', { scope, prefer: 'seed' });
    assert.equal(seedRestore.code, 'SKILL_SCOPE_PROTECTED', 'seed restore rejects shadow activation before changing data');
    await assert.rejects(importSkillPackage({ kind: 'text', content: skillContent('plugin-child') }, { scope }), PersonalSkillActivationError);
    const created = await createSkillDirectory('plugin-child', 'Shadow copy', undefined, scope);
    assert.equal(created.code, 'SKILL_SCOPE_PROTECTED');
    const workspaceRoot = path.join(dataRoot, 'workspace');
    await writeFile(path.join(workspaceRoot, 'plugin-child', 'SKILL.md'), skillContent('plugin-child'));
    await assert.rejects(installCanvasSkillFromWorkspace({ workspaceRoot, draftPath: 'plugin-child', scope }), PersonalSkillActivationError);
    await assert.rejects(updateCanvasSkillFromWorkspace({ workspaceRoot, draftPath: 'plugin-child', skillName: 'shared-skill', expectedVersion: '1.0.0', expectedChecksum: 'b'.repeat(64), scope }), PersonalSkillActivationError);
    assert.equal(await fs.readFile(personalPath, 'utf8'), beforeContent, 'existing personal content survives every rejected write');
    assert.equal(await fs.stat(path.join(resolveScopedSkillsDataDir(scope), 'plugin-child')).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(path.join(workspaceRoot, 'plugin-child', 'SKILL.md')).then(() => true), true, 'rejected workspace install keeps the draft');
    const apiRequest = (body: unknown) => new Request('http://fixture/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const apiResponse of [await storeInstall(apiRequest({ name: 'shared-skill' })), await upload(apiRequest({ content: skillContent('plugin-child') })), await restore(apiRequest({}), { params: Promise.resolve({ name: 'shared-skill' }) })]) {
      assert.equal(apiResponse.status, 409);
      assert.equal((await apiResponse.json()).code, 'SKILL_SCOPE_PROTECTED');
    }

    // Store reads prefer the organization record and also reserve plugin-owned
    // names without inventing a personal installation or recovery target.
    const registryPath = path.join(dataRoot, 'catalog.json');
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, id: 'guard-store', name: 'Guard Store', updatedAt: new Date().toISOString(), plugins: [], skills: ['shared-skill', 'plugin-child'].map((name) => ({ name, displayName: name, description: 'Fixture', latestVersion: '4.0.0', versions: { '4.0.0': { version: '4.0.0', downloadUrl: 'https://example.test/unused.zip', checksum: 'c'.repeat(64) } } })) }));
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();
    const catalog = await listCanvasSkillStore({ scope });
    const shared = catalog.skills.find((skill) => skill.name === 'shared-skill')!;
    assert.equal(shared.installed.installedSkill?.resourceId, 'exact-org-skill');
    assert.equal(shared.installed.version, '2.0.0');
    assert.equal(shared.installed.managedByOrganization, true);
    assert.equal(shared.installed.restoreAvailable, false);
    assert.equal(shared.installed.updateAvailable, false);
    const pluginChild = catalog.skills.find((skill) => skill.name === 'plugin-child')!;
    assert.equal(pluginChild.installed.managedByOrganization, true);
    assert.equal(pluginChild.installed.version, '3.1.0');
    assert.equal(pluginChild.installed.enabled, false);
    assert.equal(pluginChild.installed.installedSkill, undefined);

    await writeFile(path.join(resolveScopedSkillsDataDir(scope), 'personal-only', 'SKILL.md'), skillContent('personal-only'));
    const mixedBulk = await enableAll(new Request('http://fixture/enable-all', { method: 'POST' }));
    assert.equal((await mixedBulk.json()).allEnabled, false);
    assert.deepEqual(await readEnabledSkillsForScope(scope), ['personal-only'], 'bulk enables unrelated personal skills and excludes protected ones');
    const allowedEnable = await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: 'personal-only' }) });
    assert.equal(allowedEnable.status, 200);
    auditCalls = 0;

    const disabledImport = await importSkillPackage({ kind: 'text', content: skillContent('plugin-child') }, { scope, enable: false });
    assert.equal(disabledImport.success, true, 'non-activating import remains allowed');
    organizationStatus = 'suspended';
    assert.equal((await readProtectedPersonalSkillNames(scope)).size, 0, 'no foreign namespace exposed without active membership');
    organizationStatus = 'active';
    organizationId = null;
    const noOrgBulk = await enableAll(new Request('http://fixture/enable-all', { method: 'POST' }));
    assert.equal((await noOrgBulk.json()).allEnabled, true);
    assert.deepEqual(await readEnabledSkillsForScope(scope), [], 'no-organization ALL behavior remains compatible');
    const noOrgEnable = await enable(new Request('http://fixture/enable', { method: 'POST' }), { params: Promise.resolve({ name: 'shared-skill' }) });
    assert.equal(noOrgEnable.status, 200);
    assert.equal(auditCalls, 1);
    assert.equal(await fs.readFile(personalPath, 'utf8'), beforeContent);
    console.log('Personal skill activation protection tests passed.');
  } finally {
    internals._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
