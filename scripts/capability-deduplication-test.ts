import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createCapabilityReference } from '../app/lib/capabilities/reference';
import { resolveEffectiveCapabilities } from '../app/lib/capabilities/effective-resolver';
import { selectVisibleCapabilities } from '../app/lib/capabilities/visible-capabilities';
import type { CapabilityCandidate, CapabilityPolicy, CapabilityPolicyEffect, CapabilityScopeType } from '../app/lib/capabilities/types';
import type { CanvasPluginInstallRecord } from '../app/lib/plugins/canvas-plugin-registry';
import type { CanvasSkillInstallRecord } from '../app/lib/skills/canvas-skill-store';

const context = { organizationId: 'qa-org', userId: 'qa-owner', role: 'member', workspaceId: 'qa-workspace-a' };
const timestamp = '2026-10-03T00:00:00.000Z';

function candidate(scopeType: CapabilityScopeType, resourceId: string, overrides: Partial<CapabilityCandidate> = {}): CapabilityCandidate {
  return {
    ref: createCapabilityReference({ resourceType: 'plugin', scopeType, resourceId, name: 'qa-shared',
      version: scopeType === 'user' ? '9.0.0' : '1.0.0', revision: 1, checksum: `${scopeType}-checksum`,
      sourceType: 'standalone', organizationId: scopeType === 'organization' ? context.organizationId : null,
      ownerUserId: scopeType === 'user' ? context.userId : null, sourcePluginId: null }),
    description: `${scopeType} package`, enabled: true, runtimePath: null, userPreference: 'enabled',
    ...overrides,
  };
}

function policy(resourceId: string, effect: CapabilityPolicyEffect, resourceType: 'plugin' | 'skill' = 'plugin'): CapabilityPolicy {
  return { id: `${resourceId}:${effect}`, organizationId: context.organizationId, resourceType, resourceId,
    targetType: 'organization', targetId: context.organizationId, effect, revision: 1,
    createdByUserId: context.userId, updatedByUserId: context.userId, createdAt: 1, updatedAt: 1 };
}

function assertNamespaceMatrix() {
  const personal = candidate('user', 'personal');
  const org = candidate('organization', 'assigned');
  const system = candidate('system', 'system');
  const input = [personal, org, system];
  const original = structuredClone(input);
  assert.deepEqual(selectVisibleCapabilities(input), [system], 'system protects a plugin namespace across all lower scopes');
  assert.deepEqual(input, original, 'presentation selection must never mutate stored candidates');
  assert.equal(selectVisibleCapabilities([personal, org])[0], org, 'a newer personal version never replaces the organization namespace owner');
  const caseVariant = { ...org, ref: { ...org.ref, name: 'QA-SHARED' } };
  assert.deepEqual(selectVisibleCapabilities([personal, caseVariant]), [caseVariant], 'presentation namespaces ignore case like the effective resolver');
  const invalidWhitespaceName = { ...org, ref: { ...org.ref, name: '  QA-SHARED  ' } };
  assert.deepEqual(selectVisibleCapabilities([personal, invalidWhitespaceName]), [personal, invalidWhitespaceName], 'unregistrable whitespace names follow the same exact runtime namespace rule');
  const skill = { ...personal, ref: { ...personal.ref, resourceType: 'skill' as const, resourceId: 'personal-skill' } };
  assert.deepEqual(selectVisibleCapabilities([org, skill]), [org, skill], 'plugin and skill namespaces are independent');
  const otherOrg = { ...org, ref: { ...org.ref, resourceId: 'second-org-record', organizationId: 'other-org' } };
  assert.deepEqual(selectVisibleCapabilities([personal, org, otherOrg, org]), [org, otherOrg], 'duplicate references collapse while distinct same-scope conflicts remain visible');
  const sameScopeSkill = { ...skill, ref: { ...skill.ref, resourceId: 'plugin-owned-skill', sourceType: 'plugin' as const, sourcePluginId: 'personal' }, pluginResourceId: 'personal' };
  assert.equal(selectVisibleCapabilities([skill, sameScopeSkill]).length, 2, 'standalone and plugin-owned skills with distinct identities remain visible for conflict resolution');

  for (const scenario of [
    { label: 'optional enabled', effect: 'optional', enabled: true, preference: 'enabled', readiness: 'available', effectiveEnabled: true },
    { label: 'optional disabled preference', effect: 'optional', enabled: true, preference: 'disabled', readiness: 'disabled', effectiveEnabled: false },
    { label: 'optional unset preference', effect: 'optional', enabled: true, preference: 'unset', readiness: 'disabled', effectiveEnabled: false },
    { label: 'disabled organization package', effect: 'default-enabled', enabled: false, preference: 'enabled', readiness: 'disabled', effectiveEnabled: false },
    { label: 'required organization package', effect: 'required', enabled: false, preference: 'disabled', readiness: 'available', effectiveEnabled: true },
    { label: 'blocked organization package', effect: 'blocked', enabled: true, preference: 'enabled', readiness: 'blocked', effectiveEnabled: false },
    { label: 'missing required connection', effect: 'required', enabled: true, preference: 'enabled', readiness: 'personal-connection-required', effectiveEnabled: true, connectionRequirementCount: 1, connectionReady: false },
  ] as const) {
    const assigned = { ...org, enabled: scenario.enabled, userPreference: scenario.preference,
      connectionRequirementCount: 'connectionRequirementCount' in scenario ? scenario.connectionRequirementCount : 0,
      connectionReady: 'connectionReady' in scenario ? scenario.connectionReady : true };
    const snapshot = resolveEffectiveCapabilities({ context, candidates: [personal, assigned], policies: [policy(org.ref.resourceId, scenario.effect)] });
    const visible = selectVisibleCapabilities(snapshot.capabilities);
    assert.deepEqual(visible.map(entry => entry.ref.resourceId), ['assigned'], scenario.label);
    assert.equal(visible[0].readiness, scenario.readiness, `${scenario.label} keeps the real organization readiness`);
    assert.equal(visible[0].effectiveEnabled, scenario.effectiveEnabled);
    assert.equal(snapshot.capabilities.find(entry => entry.ref.resourceId === 'personal')?.readiness, 'conflict', `${scenario.label} cannot expose a personal policy bypass`);
    assert.equal(snapshot.capabilities.find(entry => entry.ref.resourceId === 'personal')?.effectiveEnabled, false);
    assert.equal(snapshot.capabilities.length, 2, 'the authoritative snapshot retains the hidden personal record');
  }
  const conflicts = resolveEffectiveCapabilities({ context, candidates: [personal, org, otherOrg], policies: [] });
  assert.equal(selectVisibleCapabilities(conflicts.capabilities).length, 2);
  assert.ok(selectVisibleCapabilities(conflicts.capabilities).every(entry => entry.readiness === 'conflict'));
  for (const workspaceId of ['qa-workspace-a', 'qa-workspace-b', 'qa-workspace-a']) {
    const selected = resolveEffectiveCapabilities({ context: { ...context, workspaceId }, candidates: [personal, org],
      policies: [{ ...policy(org.ref.resourceId, 'required'), targetType: 'workspace', targetId: 'qa-workspace-a' }] });
    assert.deepEqual(selectVisibleCapabilities(selected.capabilities).map(entry => entry.ref.resourceId), ['assigned'], 'workspace assignment does not release a protected name in another workspace');
    assert.equal(selected.capabilities.find(entry => entry.ref.resourceId === 'personal')?.effectiveEnabled, false);
  }
  const removed = resolveEffectiveCapabilities({ context, candidates: [personal], policies: [] });
  assert.equal(selectVisibleCapabilities(removed.capabilities)[0].effectiveEnabled, true, 'removing the organization resource restores the untouched personal candidate');
}

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const originalEnvironment = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
let policies: CapabilityPolicy[] = [];
let activeOrganizationId: string | null = context.organizationId;
const organizationPermissionSequence: Array<string | null> = [];
const verifiedWorkspaceRequests: string[] = [];

// The test retains real registry/file reads, catalog construction, policy mapping,
// effective resolution, namespace projection and API handlers. Only external
// authentication, organization/workspace permissions and SQL transport are fixtures.
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === 'next/headers') return { headers: async () => new Headers() };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: context.userId } }) } } };
  if (request === '@/app/lib/organization/permissions') return { readOrganizationPermissionForUser: async () => {
    const organizationId = organizationPermissionSequence.length ? organizationPermissionSequence.shift()! : activeOrganizationId;
    return { organizationId, permission: organizationId ? { status: 'active', role: 'member', canSharePluginsAndSkills: false } : null };
  } };
  if (request === '@/app/lib/pi/session-workspace-context') return { resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId?: string }) => {
    assert.equal(input.userId, context.userId);
    const workspaceId = input.workspaceId || context.workspaceId;
    assert.ok(['qa-workspace-a', 'qa-workspace-b', 'qa-foreign-workspace'].includes(workspaceId));
    verifiedWorkspaceRequests.push(workspaceId);
    return { workspaceId, organizationId: workspaceId === 'qa-foreign-workspace' ? 'qa-foreign-org' : context.organizationId, projectId: null };
  } };
  if (request === '@/app/lib/db' && /\/capabilities\/(catalog|policy-store)\.ts$/.test(parent?.filename || '')) return {
    openDb: async () => ({ all: async (sql: string, values: unknown[]) => {
      assert.match(sql, /FROM capability_policies/);
      return policies.filter(entry => entry.organizationId === values[0]).map(entry => ({
        id: entry.id, organization_id: entry.organizationId, resource_type: entry.resourceType,
        resource_id: entry.resourceId, target_type: entry.targetType, target_id: entry.targetId,
        effect: entry.effect, revision: entry.revision, created_by_user_id: entry.createdByUserId,
        updated_by_user_id: entry.updatedByUserId, created_at: entry.createdAt, updated_at: entry.updatedAt,
      }));
    }, get: async (sql: string, values: unknown[]) => {
      assert.match(sql, /FROM organization_user_permissions/);
      assert.deepEqual(values, [activeOrganizationId, context.userId]);
      return { role: 'member' };
    }, close: async () => undefined }),
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  assertNamespaceMatrix();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-capability-dedup-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const paths = await import('../app/lib/runtime-data-paths');
    const userScope = { scopeType: 'user' as const, userId: context.userId, organizationId: context.organizationId };
    const orgScope = { scopeType: 'organization' as const, organizationId: context.organizationId };
    const foreignScope = { scopeType: 'organization' as const, organizationId: 'qa-foreign-org' };
    const writeJson = async (file: string, value: unknown) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    };
    const writeSkill = async (directory: string, name: string, description: string) => {
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, 'SKILL.md');
      await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1.0.0"\n---\n\n# ${description}\n`);
      return file;
    };
    const makePlugin = async (scope: typeof userScope | typeof orgScope | typeof foreignScope, name: string, childName?: string): Promise<CanvasPluginInstallRecord> => {
      const version = scope.scopeType === 'user' ? '9.0.0' : '1.0.0';
      const installDir = path.join(paths.resolveScopedInstalledPluginsDir(scope), name, version);
      await fs.mkdir(path.join(installDir, '.canvas-plugin'), { recursive: true });
      const manifestPath = path.join(installDir, '.canvas-plugin', 'plugin.json');
      await writeJson(manifestPath, { name, version, description: `${scope.scopeType} fixture` });
      const childPath = childName ? await writeSkill(path.join(installDir, 'skills', childName), childName, `${scope.scopeType} child fixture`) : null;
      const ref = createCapabilityReference({ resourceType: 'plugin', scopeType: scope.scopeType, name, version,
        revision: 1, checksum: `${scope.scopeType}-checksum`, sourceType: 'standalone',
        organizationId: scope.scopeType === 'organization' ? scope.organizationId : null,
        ownerUserId: scope.scopeType === 'user' ? scope.userId : null, sourcePluginId: null });
      return { ...ref, sourceType: 'standalone', installedAt: timestamp, updatedAt: timestamp, description: `${scope.scopeType} fixture`, enabled: true,
        installDir, manifestPath, skills: childName && childPath ? [{ name: childName, title: childName, description: 'QA child',
          path: childPath, directory: path.dirname(childPath) }] : [] };
    };
    const makeSkill = async (scope: typeof userScope | typeof orgScope, name: string): Promise<CanvasSkillInstallRecord> => {
      const installDir = path.join(paths.resolveScopedSkillsDataDir(scope), 'installed', name, '1.0.0', name);
      const skillPath = await writeSkill(installDir, name, `${scope.scopeType} standalone fixture`);
      const ref = createCapabilityReference({ resourceType: 'skill', scopeType: scope.scopeType, name, version: '1.0.0',
        revision: 1, checksum: `${scope.scopeType}-checksum`, sourceType: 'standalone',
        organizationId: scope.scopeType === 'organization' ? scope.organizationId : null,
        ownerUserId: scope.scopeType === 'user' ? scope.userId : null, sourcePluginId: null });
      return { ...ref, sourceType: 'local', installedAt: timestamp, updatedAt: timestamp,
        description: `${scope.scopeType} standalone fixture`, installDir, skillPath };
    };
    const personalPlugin = await makePlugin(userScope, 'qa-shadow-package', 'qa-shared-child');
    const orgPlugin = await makePlugin(orgScope, 'qa-shadow-package', 'qa-shared-child');
    const personalOnly = await makePlugin(userScope, 'qa-personal-only');
    const foreignOnly = await makePlugin(foreignScope, 'qa-foreign-only');
    const personalSkill = await makeSkill(userScope, 'qa-shared-skill');
    const orgSkill = await makeSkill(orgScope, 'qa-shared-skill');
    const pluginRegistry = (plugins: CanvasPluginInstallRecord[]) => ({ version: 1, updatedAt: timestamp, plugins: Object.fromEntries(plugins.map(entry => [entry.name, entry])) });
    const skillRegistry = (skills: CanvasSkillInstallRecord[]) => ({ version: 1, updatedAt: timestamp, skills: Object.fromEntries(skills.map(entry => [entry.name, entry])) });
    await writeJson(paths.resolveScopedPluginRegistryPath(userScope), pluginRegistry([personalPlugin, personalOnly]));
    await writeJson(paths.resolveScopedPluginRegistryPath(orgScope), pluginRegistry([orgPlugin]));
    await writeJson(paths.resolveScopedPluginRegistryPath(foreignScope), pluginRegistry([foreignOnly]));
    await writeJson(paths.resolveScopedSkillRegistryPath(userScope), skillRegistry([personalSkill]));
    await writeJson(paths.resolveScopedSkillRegistryPath(orgScope), skillRegistry([orgSkill]));
    for (const scope of [userScope, orgScope]) await writeJson(path.join(paths.resolveScopedSettingsDir(scope), 'skills.json'), {
      version: 1, updatedAt: timestamp, enabledSkills: ['qa-shared-child', 'qa-shared-skill'],
    });

    const { resolveEffectiveCapabilitySnapshot, loadCapabilityCandidates } = await import('../app/lib/capabilities/catalog');
    const { GET: pluginsGet } = await import('../app/api/plugins/route');
    const { GET: skillsGet } = await import('../app/api/skills/route');
    const { GET: treeGet } = await import('../app/api/skills/tree/route');
    const { buildReferencedPluginRuntimeContext } = await import('../app/lib/plugins/plugin-reference-context');
    assert.match((await buildReferencedPluginRuntimeContext('/qa-shadow-package', orgScope)) || '', /organization fixture/, 'explicit organization management keeps its scoped reference context');
    const initial = await loadCapabilityCandidates(context, { resolveConnections: false });
    const child = initial.find(entry => entry.ref.scopeType === 'organization' && entry.ref.name === 'qa-shared-child')!;
    assert.ok(child, 'the real organization package skill is parsed from disk');
    const orgResources = [orgPlugin.resourceId!, orgSkill.resourceId!, child.ref.resourceId];
    const immutableFiles = [paths.resolveScopedPluginRegistryPath(userScope), paths.resolveScopedSkillRegistryPath(userScope), personalSkill.skillPath, personalPlugin.manifestPath];
    const preserved = await Promise.all(immutableFiles.map(file => fs.readFile(file, 'utf8')));
    const getJson = async (handler: (request: NextRequest) => Promise<Response>, query: string) => {
      const response = await handler(new NextRequest(`https://canvas.example.test${query}`));
      assert.equal(response.status, 200, `${query} must read the actual fixtures successfully`);
      return response.json();
    };
    for (const effect of ['default-enabled', 'optional', 'required', 'blocked'] as const) {
      policies = orgResources.map(resourceId => policy(resourceId, effect, resourceId === orgPlugin.resourceId ? 'plugin' : 'skill'));
      const snapshot = await resolveEffectiveCapabilitySnapshot(context);
      assert.equal(snapshot.capabilities.filter(entry => entry.ref.name === 'qa-shadow-package').length, 2, 'the full snapshot keeps both packages');
      assert.ok(snapshot.capabilities.filter(entry => entry.ref.scopeType === 'user' && ['qa-shadow-package', 'qa-shared-child', 'qa-shared-skill'].includes(entry.ref.name)).every(entry => !entry.effectiveEnabled && entry.readiness === 'conflict'));
      for (const identity of ['', '&identity=resource']) {
        const body = await getJson(pluginsGet, `/api/plugins?scope=user&workspaceId=qa-workspace-a&fresh=1${identity}`);
        assert.deepEqual(body.plugins.map((entry: { resourceId: string }) => entry.resourceId).sort(), [personalOnly.resourceId!, orgPlugin.resourceId!].sort());
        const winner = body.plugins.find((entry: { name: string }) => entry.name === orgPlugin.name);
        assert.equal(winner.scopeType, 'organization');
        assert.equal(winner.version, '1.0.0', 'a personal v9 update cannot supply metadata for the organization v1 winner');
        assert.equal(winner.enabled, snapshot.capabilities.find(entry => entry.ref.resourceId === orgPlugin.resourceId)!.effectiveEnabled);
        assert.equal(winner.readiness, snapshot.capabilities.find(entry => entry.ref.resourceId === orgPlugin.resourceId)!.readiness);
        assert.equal(winner.connectionReadiness.ready, true);
        assert.deepEqual(body.stats, { total: 2, enabled: body.plugins.filter((entry: { enabled: boolean }) => entry.enabled).length,
          disabled: body.plugins.filter((entry: { enabled: boolean }) => !entry.enabled).length });
      }
      const skills = await getJson(skillsGet, '/api/skills?scope=user&workspaceId=qa-workspace-a');
      const fixtureSkills = skills.skills.filter((entry: { name: string }) => entry.name.startsWith('qa-'));
      assert.deepEqual(fixtureSkills.map((entry: { resourceId: string }) => entry.resourceId).sort(), [orgSkill.resourceId!, child.ref.resourceId].sort());
      assert.ok(fixtureSkills.every((entry: { scopeType: string }) => entry.scopeType === 'organization'));
      const summary = await getJson(skillsGet, '/api/skills?scope=user&workspaceId=qa-workspace-a&summary=1&query=qa-&limit=1&page=1');
      assert.equal(summary.pagination.total, 2, 'global pagination counts visible identities before slicing');
      const enabled = await getJson(skillsGet, '/api/skills?scope=user&workspaceId=qa-workspace-a&summary=1&query=qa-&enabledOnly=1');
      assert.equal(enabled.pagination.total, fixtureSkills.filter((entry: { enabled: boolean }) => entry.enabled).length, 'a disabled organization winner never falls back to an enabled personal skill');
      const tree = await getJson(treeGet, '/api/skills/tree?scope=user&depth=2');
      assert.deepEqual(tree.data.filter((entry: { name: string }) => entry.name.startsWith('qa-')).map((entry: { resourceId: string }) => entry.resourceId).sort(), [orgSkill.resourceId!, child.ref.resourceId].sort());
      const referenced = await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId });
      if (effect === 'default-enabled' || effect === 'required') {
        assert.ok(referenced);
        assert.match(referenced, /v1\.0\.0/);
        assert.match(referenced, /organization fixture/);
        assert.ok(!referenced.includes('v9.0.0') && !referenced.includes('user fixture'), 'explicit references describe the effective organization owner');
      } else {
        assert.equal(referenced, null, `${effect} cannot use the hidden enabled personal package as a slash fallback`);
      }
      assert.deepEqual(await Promise.all(immutableFiles.map(file => fs.readFile(file, 'utf8'))), preserved, 'all read projections leave personal package data unchanged');
    }
    await writeJson(paths.resolveScopedPluginRegistryPath(orgScope), pluginRegistry([{ ...orgPlugin, enabled: false }]));
    policies = [policy(orgPlugin.resourceId!, 'default-enabled')];
    assert.equal(await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId }), null, 'a base-disabled organization package cannot fall back to a personal slash context');
    policies = [policy(orgPlugin.resourceId!, 'required')];
    assert.match((await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId })) || '', /organization fixture/, 'required effective activation also drives slash context for a base-disabled package');
    await writeJson(paths.resolveScopedPluginRegistryPath(orgScope), pluginRegistry([orgPlugin]));
    const orgDuplicateChild = await makeSkill(orgScope, 'qa-shared-child');
    await writeJson(paths.resolveScopedSkillRegistryPath(orgScope), skillRegistry([orgSkill, orgDuplicateChild]));
    policies = [policy(orgPlugin.resourceId!, 'required')];
    const conflictingSkills = await getJson(skillsGet, '/api/skills?workspaceId=qa-workspace-a&summary=1&query=qa-shared-child');
    assert.equal(conflictingSkills.pagination.total, 2, 'distinct same-scope standalone and package-owned skills remain visible');
    assert.deepEqual(conflictingSkills.skills.map((entry: { resourceId: string }) => entry.resourceId).sort(), [child.ref.resourceId, orgDuplicateChild.resourceId!].sort());
    assert.ok(conflictingSkills.skills.every((entry: { readiness: string; enabled: boolean }) => entry.readiness === 'conflict' && !entry.enabled));
    const conflictingTree = await getJson(treeGet, '/api/skills/tree?scope=user&depth=2');
    assert.equal(conflictingTree.data.filter((entry: { name: string }) => entry.name === 'qa-shared-child').length, 2);
    await writeJson(paths.resolveScopedSkillRegistryPath(orgScope), skillRegistry([orgSkill]));
    policies = [policy(orgPlugin.resourceId!, 'required')];
    for (const workspaceId of ['qa-workspace-a', 'qa-workspace-b', 'qa-workspace-a']) {
      const body = await getJson(pluginsGet, `/api/plugins?workspaceId=${workspaceId}`);
      assert.equal(body.plugins.find((entry: { name: string }) => entry.name === orgPlugin.name).resourceId, orgPlugin.resourceId, 'A-B-A reads do not cache a personal winner');
    }
    assert.deepEqual(verifiedWorkspaceRequests.slice(-3), ['qa-workspace-a', 'qa-workspace-b', 'qa-workspace-a']);
    activeOrganizationId = 'qa-foreign-org';
    const foreign = await getJson(pluginsGet, '/api/plugins?workspaceId=qa-foreign-workspace');
    assert.ok(foreign.plugins.some((entry: { resourceId: string }) => entry.resourceId === foreignOnly.resourceId));
    assert.ok(!foreign.plugins.some((entry: { resourceId: string }) => entry.resourceId === orgPlugin.resourceId), 'projection never crosses the authorized active organization');
    activeOrganizationId = context.organizationId;
    await writeJson(paths.resolveScopedPluginRegistryPath(orgScope), pluginRegistry([]));
    await writeJson(paths.resolveScopedSkillRegistryPath(orgScope), skillRegistry([]));
    policies = [];
    const removed = await getJson(pluginsGet, '/api/plugins?workspaceId=qa-workspace-a');
    assert.equal(removed.plugins.find((entry: { name: string }) => entry.name === personalPlugin.name).resourceId, personalPlugin.resourceId);
    assert.equal(removed.plugins.find((entry: { name: string }) => entry.name === personalPlugin.name).enabled, true);
    assert.match((await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId })) || '', /v9\.0\.0/, 'removal restores the personal explicit-reference context');
    const restoredSkills = await getJson(skillsGet, '/api/skills?workspaceId=qa-workspace-a&summary=1&query=qa-');
    assert.ok(restoredSkills.skills.every((entry: { scopeType: string }) => entry.scopeType === 'user'));
    assert.equal(restoredSkills.pagination.total, 2);
    await writeJson(paths.resolveScopedPluginRegistryPath(orgScope), pluginRegistry([orgPlugin]));
    policies = [policy(orgPlugin.resourceId!, 'required')];
    const readded = await getJson(pluginsGet, '/api/plugins?workspaceId=qa-workspace-a');
    assert.equal(readded.plugins.find((entry: { name: string }) => entry.name === orgPlugin.name).resourceId, orgPlugin.resourceId, 're-adding the organization package protects the name again');
    organizationPermissionSequence.push(context.organizationId, null);
    assert.equal(await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId }), null, 'revoking membership between the namespace lookup and runtime guard cannot emit raw organization hints');
    assert.equal(organizationPermissionSequence.length, 0, 'the regression exercises both real permission reads');
    activeOrganizationId = null;
    const noOrg = await buildReferencedPluginRuntimeContext('/qa-shadow-package', userScope, { workspaceId: context.workspaceId });
    assert.match(noOrg || '', /v9\.0\.0/, 'without organization membership the personal registry remains the explicit-reference source');
    assert.ok(!noOrg?.includes('organization fixture'));
    activeOrganizationId = context.organizationId;
    assert.deepEqual(await Promise.all(immutableFiles.map(file => fs.readFile(file, 'utf8'))), preserved);
    console.log('PASS capability namespace matrix and real registry Plugins/Skills/Tree GET projections');
  } finally {
    internals._load = originalLoad;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
