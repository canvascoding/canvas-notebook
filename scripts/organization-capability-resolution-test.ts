import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import JSZip from 'jszip';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-org-capabilities-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const [
      { runMigrations },
      { CapabilityPolicyStore, CapabilityPolicyConflictError },
      { createCapabilityReference },
      { resolveEffectiveCapabilities },
      { resolveScopedPluginsDataDir, resolveScopedSettingsDir, resolveScopedSkillsDataDir },
      { readEnabledSkillsForScope },
    ] = await Promise.all([
      import('../app/lib/db/migrate'),
      import('../app/lib/capabilities/policy-store'),
      import('../app/lib/capabilities/reference'),
      import('../app/lib/capabilities/effective-resolver'),
      import('../app/lib/runtime-data-paths'),
      import('../app/lib/skills/skill-settings'),
    ]);

    assert.equal(
      resolveScopedSkillsDataDir({ scopeType: 'organization', organizationId: 'org-one' }),
      path.join(dataRoot, 'organizations', 'org-one', 'skills'),
    );
    assert.equal(
      resolveScopedPluginsDataDir({ scopeType: 'organization', organizationId: 'org-one' }),
      path.join(dataRoot, 'organizations', 'org-one', 'plugins'),
    );
    assert.equal(
      resolveScopedSettingsDir({ scopeType: 'organization', organizationId: 'org-one' }),
      path.join(dataRoot, 'organizations', 'org-one', 'settings'),
    );
    assert.equal(
      resolveScopedSkillsDataDir({ scopeType: 'user', userId: 'user-one' }),
      path.join(dataRoot, 'users', 'user-one', 'skills'),
    );
    assert.throws(
      () => resolveScopedSkillsDataDir({ scopeType: 'organization' }),
      /organizationId is required/,
    );
    const [{ writePiRuntimeConfig }, { DEFAULT_PI_CONFIG }] = await Promise.all([
      import('../app/lib/agents/storage'),
      import('../app/lib/pi/config'),
    ]);
    await writePiRuntimeConfig({
      ...JSON.parse(JSON.stringify(DEFAULT_PI_CONFIG)),
      enabledSkills: ['legacy-skill'],
      updatedBy: 'test',
    });
    assert.equal(
      await readEnabledSkillsForScope({ scopeType: 'organization', organizationId: 'org-one' }),
      undefined,
      'organization settings must never inherit legacy or personal skill activation',
    );

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run('user-one', 'Owner', 'owner@example.com', now, now);
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, 'team', 1, ?, ?)
    `).run('org-one', 'user-one', now, now);

    const connection = {
      get: (sql: string, params?: unknown[]) => sqlite.prepare(sql).get(...(params || [])),
      run: (sql: string, params?: unknown[]) => sqlite.prepare(sql).run(...(params || [])),
      all: (sql: string, params?: unknown[]) => sqlite.prepare(sql).all(...(params || [])),
      close: () => undefined,
    };
    const store = new CapabilityPolicyStore(connection);

    const stableV1 = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'organization',
      name: 'brand-writing',
      version: '1.0.0',
      revision: 1,
      checksum: 'checksum-v1',
      sourceType: 'standalone',
      organizationId: 'org-one',
      ownerUserId: null,
      sourcePluginId: null,
    });
    const stableV2 = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      version: '2.0.0',
      revision: 2,
      checksum: 'checksum-v2',
    });
    const personalRef = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      scopeType: 'user',
      organizationId: null,
      ownerUserId: 'user-one',
    });
    assert.equal(stableV1.resourceId, stableV2.resourceId, 'versions must retain one stable resource id');
    assert.notEqual(stableV1.resourceId, personalRef.resourceId, 'scope must be part of the stable resource id');
    const canonicalStableRef = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      name: ' BRAND-WRITING ',
      organizationId: 'ORG-ONE',
    });
    assert.equal(
      stableV1.resourceId,
      canonicalStableRef.resourceId,
      'stable resource ids must use one canonical case and whitespace normalization',
    );

    const {
      CapabilityPreferenceConflictError,
      readCapabilityPreferences,
      setCapabilityPreference,
    } = await import('../app/lib/capabilities/preference-store');
    const [brandPreference, secondaryPreference] = await Promise.all([
      setCapabilityPreference({
        userId: 'user-one',
        resourceId: stableV1.resourceId,
        enabled: true,
        expectedRevision: 0,
      }),
      setCapabilityPreference({
        userId: 'user-one',
        resourceId: 'canvas-capability:v1:skill:org:org-one:standalone:secondary',
        enabled: false,
        expectedRevision: 0,
      }),
    ]);
    assert.equal(brandPreference.revision, 1);
    assert.equal(secondaryPreference.revision, 1);
    assert.equal(Object.keys((await readCapabilityPreferences('user-one')).preferences).length, 2);
    await assert.rejects(
      setCapabilityPreference({
        userId: 'user-one',
        resourceId: stableV1.resourceId,
        enabled: false,
        expectedRevision: 0,
      }),
      CapabilityPreferenceConflictError,
    );

    const requiredOnlyRef = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      name: 'required-only',
      checksum: 'required-only-checksum',
    });

    const required = await store.upsertPolicy({
      organizationId: 'org-one',
      resourceType: 'skill',
      resourceId: stableV1.resourceId,
      targetType: 'organization',
      targetId: 'org-one',
      effect: 'required',
      actorUserId: 'user-one',
      expectedRevision: 0,
    });
    assert.equal(required.revision, 1);
    const blocked = await store.upsertPolicy({
      organizationId: 'org-one',
      resourceType: 'skill',
      resourceId: stableV1.resourceId,
      targetType: 'user',
      targetId: 'user-one',
      effect: 'blocked',
      actorUserId: 'user-one',
      expectedRevision: 0,
    });
    await store.upsertPolicy({
      organizationId: 'org-one',
      resourceType: 'skill',
      resourceId: requiredOnlyRef.resourceId,
      targetType: 'organization',
      targetId: 'org-one',
      effect: 'required',
      actorUserId: 'user-one',
      expectedRevision: 0,
    });
    const updatedRequired = await store.upsertPolicy({
      organizationId: 'org-one',
      resourceType: 'skill',
      resourceId: stableV1.resourceId,
      targetType: 'organization',
      targetId: 'org-one',
      effect: 'default-enabled',
      actorUserId: 'user-one',
      expectedRevision: required.revision,
    });
    assert.equal(updatedRequired.revision, 2);
    await assert.rejects(
      store.upsertPolicy({
        organizationId: 'org-one',
        resourceType: 'skill',
        resourceId: stableV1.resourceId,
        targetType: 'organization',
        targetId: 'org-one',
        effect: 'optional',
        actorUserId: 'user-one',
        expectedRevision: required.revision,
      }),
      CapabilityPolicyConflictError,
    );
    assert.equal((await store.listOrganizationPolicies('org-one')).length, 3);

    const pluginRef = createCapabilityReference({
      resourceType: 'plugin',
      scopeType: 'organization',
      name: 'campaign-suite',
      version: '1.0.0',
      revision: 1,
      checksum: 'plugin-checksum',
      sourceType: 'standalone',
      organizationId: 'org-one',
      ownerUserId: null,
      sourcePluginId: null,
    });
    const pluginSkillRef = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'organization',
      name: 'campaign-copy',
      version: '1.0.0',
      revision: 1,
      checksum: 'plugin-skill-checksum',
      sourceType: 'plugin',
      organizationId: 'org-one',
      ownerUserId: null,
      sourcePluginId: pluginRef.resourceId,
      sourcePluginName: pluginRef.name,
    });
    const coreRef = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'system',
      name: 'core-protected',
      version: 'bundled',
      revision: 1,
      checksum: 'core-checksum',
      sourceType: 'core',
      organizationId: null,
      ownerUserId: null,
      sourcePluginId: null,
    });
    const shadowRef = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'user',
      name: 'core-protected',
      version: '1.0.0',
      revision: 1,
      checksum: 'shadow-checksum',
      sourceType: 'standalone',
      organizationId: null,
      ownerUserId: 'user-one',
      sourcePluginId: null,
    });
    const sameScopeStandalone = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'organization',
      name: 'same-scope-conflict',
      version: '1.0.0',
      revision: 1,
      checksum: 'standalone-conflict',
      sourceType: 'standalone',
      organizationId: 'org-one',
      ownerUserId: null,
      sourcePluginId: null,
    });
    const sameScopePlugin = createCapabilityReference({
      ...sameScopeStandalone,
      resourceId: undefined,
      checksum: 'plugin-conflict',
      sourceType: 'plugin',
      sourcePluginId: pluginRef.resourceId,
      sourcePluginName: pluginRef.name,
    });
    const optionalRef = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      name: 'optional-skill',
      checksum: 'optional-checksum',
    });
    const defaultEnabledRef = createCapabilityReference({
      ...stableV1,
      resourceId: undefined,
      name: 'default-enabled-skill',
      checksum: 'default-enabled-checksum',
    });
    const personalConnectionRef = createCapabilityReference({
      resourceType: 'plugin',
      scopeType: 'user',
      name: 'personal-connection-plugin',
      version: '1.0.0',
      revision: 1,
      checksum: 'personal-connection-checksum',
      sourceType: 'standalone',
      organizationId: null,
      ownerUserId: 'user-one',
      sourcePluginId: null,
    });
    const personalConnectionSkillRef = createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'user',
      name: 'personal-connection-skill',
      version: '1.0.0',
      revision: 1,
      checksum: 'personal-connection-skill-checksum',
      sourceType: 'plugin',
      organizationId: null,
      ownerUserId: 'user-one',
      sourcePluginId: personalConnectionRef.resourceId,
      sourcePluginName: personalConnectionRef.name,
    });

    const pluginBlockedPolicy = await store.upsertPolicy({
      organizationId: 'org-one',
      resourceType: 'plugin',
      resourceId: pluginRef.resourceId,
      targetType: 'role',
      targetId: 'member',
      effect: 'blocked',
      actorUserId: 'user-one',
      expectedRevision: 0,
    });
    const policies = await store.listOrganizationPolicies('org-one');
    assert.equal(pluginBlockedPolicy.effect, 'blocked');

    const candidates = [
      { ref: stableV2, description: 'Brand writing', enabled: false, runtimePath: '/org/brand/SKILL.md' },
      { ref: requiredOnlyRef, description: 'Required skill', enabled: false, userPreference: 'disabled' as const, runtimePath: '/org/required/SKILL.md' },
      { ref: pluginRef, description: 'Campaign plugin', enabled: true, runtimePath: '/org/plugin.json', connectionRequirementCount: 1, connectionReady: false },
      { ref: pluginSkillRef, description: 'Campaign copy', enabled: true, runtimePath: '/org/campaign/SKILL.md', pluginResourceId: pluginRef.resourceId },
      { ref: coreRef, description: 'Core', enabled: true, runtimePath: '/system/core/SKILL.md' },
      { ref: shadowRef, description: 'Shadow', enabled: true, runtimePath: '/user/core/SKILL.md' },
      { ref: sameScopeStandalone, description: 'Standalone conflict', enabled: true, runtimePath: '/org/a/SKILL.md' },
      { ref: sameScopePlugin, description: 'Plugin conflict', enabled: true, runtimePath: '/org/b/SKILL.md', pluginResourceId: pluginRef.resourceId },
    ];
    const context = {
      organizationId: 'org-one',
      userId: 'user-one',
      role: 'member',
      workspaceId: 'workspace-marketing',
      projectId: 'project-campaign',
    };
    const snapshot = resolveEffectiveCapabilities({ context, candidates, policies, createdAt: new Date(0) });
    const brand = snapshot.capabilities.find((entry) => entry.ref.resourceId === stableV1.resourceId)!;
    assert.equal(brand.effectivePolicy, 'blocked', 'blocked must win over organization defaults/required policies');
    assert.equal(brand.effectiveEnabled, false);
    const requiredOnly = snapshot.capabilities.find((entry) => entry.ref.resourceId === requiredOnlyRef.resourceId)!;
    assert.equal(requiredOnly.effectivePolicy, 'required');
    assert.equal(requiredOnly.effectiveEnabled, true, 'required must override a personal disabled preference');
    const plugin = snapshot.capabilities.find((entry) => entry.ref.resourceId === pluginRef.resourceId)!;
    assert.equal(plugin.readiness, 'blocked');
    const pluginSkill = snapshot.capabilities.find((entry) => entry.ref.resourceId === pluginSkillRef.resourceId)!;
    assert.equal(pluginSkill.effectiveEnabled, false, 'a blocked plugin must block its skill candidates');
    const core = snapshot.capabilities.find((entry) => entry.ref.resourceId === coreRef.resourceId)!;
    const shadow = snapshot.capabilities.find((entry) => entry.ref.resourceId === shadowRef.resourceId)!;
    assert.equal(core.readiness, 'available');
    assert.equal(shadow.readiness, 'conflict');
    assert.equal(shadow.conflictResourceIds.includes(coreRef.resourceId), true);
    assert.equal(
      snapshot.capabilities.filter((entry) => entry.ref.name === 'same-scope-conflict').every((entry) => entry.readiness === 'conflict'),
      true,
      'same-scope standalone/plugin name conflicts must block both resources',
    );
    assert.ok(snapshot.conflicts.some((entry) => entry.name === 'core-protected' && entry.protectedResourceId === coreRef.resourceId));
    const repeated = resolveEffectiveCapabilities({ context, candidates, policies, createdAt: new Date(1) });
    assert.equal(snapshot.snapshotId, repeated.snapshotId, 'snapshot identity must not depend on wall-clock time');

    const { getEffectiveSkillReadRoots } = await import('../app/lib/skills/effective-skill-read-roots');
    const mainAgentSkillRoots = getEffectiveSkillReadRoots({
      snapshot,
      agentId: 'canvas-agent',
    });
    assert.deepEqual(
      mainAgentSkillRoots.sort(),
      ['/org/required', '/system/core'].sort(),
      'the main agent may read only enabled and available skill packages',
    );
    const specializedAgentSkillRoots = getEffectiveSkillReadRoots({
      snapshot,
      agentId: 'campaign-agent',
      relevantSkills: [],
    });
    assert.deepEqual(
      specializedAgentSkillRoots.sort(),
      ['/org/required', '/system/core'].sort(),
      'specialized agents retain core and organization-required skill access',
    );
    assert.equal(
      mainAgentSkillRoots.includes('/org/campaign'),
      false,
      'skills blocked through their source plugin must never become read roots',
    );

    const defaultEnabledPolicy = {
      ...required,
      id: 'policy-default-enabled',
      resourceId: defaultEnabledRef.resourceId,
      effect: 'default-enabled' as const,
    };
    const personalChoiceSnapshot = resolveEffectiveCapabilities({
      context,
      candidates: [
        { ref: optionalRef, description: 'Optional', enabled: true, userPreference: 'unset', runtimePath: '/org/optional/SKILL.md' },
        { ref: defaultEnabledRef, description: 'Default enabled', enabled: true, userPreference: 'unset', runtimePath: '/org/default/SKILL.md' },
        { ref: personalConnectionRef, description: 'Connection', enabled: true, runtimePath: '/user/plugin.json', connectionRequirementCount: 1, connectionReady: false },
        { ref: personalConnectionSkillRef, description: 'Connection skill', enabled: true, runtimePath: '/user/connection/SKILL.md', pluginResourceId: personalConnectionRef.resourceId },
      ],
      policies: [defaultEnabledPolicy],
    });
    assert.equal(
      personalChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === optionalRef.resourceId)?.effectiveEnabled,
      false,
      'organization optional capabilities require an explicit personal opt-in',
    );
    assert.equal(
      personalChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === defaultEnabledRef.resourceId)?.effectiveEnabled,
      true,
      'default-enabled capabilities are active until personally disabled',
    );
    assert.equal(
      personalChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === personalConnectionRef.resourceId)?.readiness,
      'personal-connection-required',
    );
    const connectionSkill = personalChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === personalConnectionSkillRef.resourceId);
    assert.equal(connectionSkill?.readiness, 'personal-connection-required');
    assert.equal(connectionSkill?.effectiveEnabled, false, 'plugin connection readiness must cascade to its skills');
    assert.deepEqual(
      getEffectiveSkillReadRoots({
        snapshot: personalChoiceSnapshot,
        agentId: 'campaign-agent',
        relevantSkills: ['default-enabled-skill'],
      }),
      ['/org/default'],
      'a specialized agent may read an assigned effective skill but not disabled or connection-blocked skills',
    );
    const userOptionalOverride = {
      ...defaultEnabledPolicy,
      id: 'policy-user-optional',
      targetType: 'user' as const,
      targetId: 'user-one',
      effect: 'optional' as const,
    };
    const targetCascadeSnapshot = resolveEffectiveCapabilities({
      context,
      candidates: [
        { ref: defaultEnabledRef, description: 'Default enabled', enabled: true, userPreference: 'unset', runtimePath: '/org/default/SKILL.md' },
      ],
      policies: [defaultEnabledPolicy, userOptionalOverride],
    });
    assert.equal(
      targetCascadeSnapshot.capabilities[0]?.effectivePolicy,
      'optional',
      'a more specific optional policy must override a broader default-enabled policy',
    );
    assert.equal(targetCascadeSnapshot.capabilities[0]?.effectiveEnabled, false);
    const fullCascadePolicies = [
      {
        ...defaultEnabledPolicy,
        id: 'policy-cascade-organization',
        resourceId: defaultEnabledRef.resourceId,
        targetType: 'organization' as const,
        targetId: 'org-one',
        effect: 'optional' as const,
      },
      {
        ...defaultEnabledPolicy,
        id: 'policy-cascade-role',
        resourceId: defaultEnabledRef.resourceId,
        targetType: 'role' as const,
        targetId: 'member',
        effect: 'default-enabled' as const,
      },
      {
        ...defaultEnabledPolicy,
        id: 'policy-cascade-workspace',
        resourceId: defaultEnabledRef.resourceId,
        targetType: 'workspace' as const,
        targetId: 'workspace-marketing',
        effect: 'optional' as const,
      },
      {
        ...defaultEnabledPolicy,
        id: 'policy-cascade-project',
        resourceId: defaultEnabledRef.resourceId,
        targetType: 'project' as const,
        targetId: 'project-campaign',
        effect: 'default-enabled' as const,
      },
      {
        ...defaultEnabledPolicy,
        id: 'policy-cascade-user',
        resourceId: defaultEnabledRef.resourceId,
        targetType: 'user' as const,
        targetId: 'user-one',
        effect: 'optional' as const,
      },
    ];
    const fullCascadeSnapshot = resolveEffectiveCapabilities({
      context,
      candidates: [
        { ref: defaultEnabledRef, description: 'Full target cascade', enabled: true, userPreference: 'unset', runtimePath: '/org/cascade/SKILL.md' },
      ],
      policies: fullCascadePolicies,
    });
    assert.equal(
      fullCascadeSnapshot.capabilities[0]?.effectivePolicy,
      'optional',
      'user policy must be the most specific soft policy after organization, role, workspace and project',
    );
    const projectCascadeSnapshot = resolveEffectiveCapabilities({
      context: { ...context, userId: 'another-user' },
      candidates: [
        { ref: defaultEnabledRef, description: 'Project target cascade', enabled: true, userPreference: 'unset', runtimePath: '/org/cascade/SKILL.md' },
      ],
      policies: fullCascadePolicies,
    });
    assert.equal(
      projectCascadeSnapshot.capabilities[0]?.effectivePolicy,
      'default-enabled',
      'project policy must override matching organization, role and workspace policies when no user policy matches',
    );
    const overriddenChoiceSnapshot = resolveEffectiveCapabilities({
      context,
      candidates: [
        { ref: optionalRef, description: 'Optional', enabled: true, userPreference: 'enabled', runtimePath: '/org/optional/SKILL.md' },
        { ref: defaultEnabledRef, description: 'Default enabled', enabled: true, userPreference: 'disabled', runtimePath: '/org/default/SKILL.md' },
        { ref: personalConnectionRef, description: 'Connection', enabled: true, runtimePath: '/user/plugin.json', connectionRequirementCount: 1, connectionReady: true },
        { ref: personalConnectionSkillRef, description: 'Connection skill', enabled: true, runtimePath: '/user/connection/SKILL.md', pluginResourceId: personalConnectionRef.resourceId },
      ],
      policies: [defaultEnabledPolicy],
    });
    assert.equal(overriddenChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === optionalRef.resourceId)?.effectiveEnabled, true);
    assert.equal(overriddenChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === defaultEnabledRef.resourceId)?.effectiveEnabled, false);
    assert.equal(overriddenChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === personalConnectionRef.resourceId)?.readiness, 'available');
    assert.equal(overriddenChoiceSnapshot.capabilities.find((entry) => entry.ref.resourceId === personalConnectionSkillRef.resourceId)?.readiness, 'available');

    await store.deletePolicy({ id: blocked.id, organizationId: 'org-one', expectedRevision: blocked.revision });
    assert.equal((await store.listOrganizationPolicies('org-one')).length, 3);

    const capabilityPolicyColumns = sqlite.prepare(`PRAGMA table_info(capability_policies)`).all() as Array<{ name: string }>;
    assert.ok(capabilityPolicyColumns.some((column) => column.name === 'revision'));
    assert.ok(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_capability_policies_binding'`).get());

    const organizationScope = { scopeType: 'organization' as const, organizationId: 'org-one' };
    const pluginPackage = path.join(dataRoot, 'test-packages', 'org-plugin');
    await fs.mkdir(path.join(pluginPackage, '.canvas-plugin'), { recursive: true });
    await fs.mkdir(path.join(pluginPackage, 'skills', 'org-plugin-skill'), { recursive: true });
    await fs.writeFile(path.join(pluginPackage, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'org-plugin',
      version: '1.0.0',
      description: 'Organization plugin test package.',
      skills: './skills',
    }, null, 2));
    await fs.writeFile(path.join(pluginPackage, 'skills', 'org-plugin-skill', 'SKILL.md'), `---
name: org-plugin-skill
description: "Organization plugin skill."
metadata:
  version: "1.0.0"
---

# Organization Plugin Skill
`);
    const {
      installCanvasPluginFromPath,
      computeCanvasPluginChecksum,
    } = await import('../app/lib/plugins/canvas-plugin-registry');
    const { validateCanvasPluginPackage } = await import('../app/lib/plugins/canvas-plugin-manifest');
    const bundledSecretPath = path.join(pluginPackage, '.env');
    await fs.writeFile(bundledSecretPath, 'PRIVATE_TOKEN=test-only\n');
    const secretValidation = await validateCanvasPluginPackage(pluginPackage);
    assert.equal(secretValidation.valid, false);
    assert.match(secretValidation.errors.join(' '), /instead of bundling secret files/i);
    await fs.rm(bundledSecretPath);
    await fs.writeFile(path.join(pluginPackage, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'org-plugin',
      version: '1.0.0',
      description: 'Organization plugin with an inline connector secret.',
      skills: './skills',
      connectors: {
        mcp: [{ name: 'example-mcp', required: true, env: ['PRIVATE_TOKEN=test-only'] }],
      },
    }, null, 2));
    const inlineSecretValidation = await validateCanvasPluginPackage(pluginPackage);
    assert.equal(inlineSecretValidation.valid, false);
    assert.match(inlineSecretValidation.errors.join(' '), /environment variable name, never a value/i);
    await fs.writeFile(path.join(pluginPackage, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'org-plugin',
      version: '1.0.0',
      description: 'Organization plugin test package.',
      skills: './skills',
    }, null, 2));
    const pluginInstallV1 = await installCanvasPluginFromPath(pluginPackage, {
      enable: true,
      scope: organizationScope,
      installedBy: 'user-one',
    });
    assert.equal(pluginInstallV1.success, true, pluginInstallV1.error || 'Plugin v1 install failed.');
    assert.equal(pluginInstallV1.plugin?.scopeType, 'organization');
    assert.equal(pluginInstallV1.plugin?.organizationId, 'org-one');
    assert.equal(pluginInstallV1.plugin?.revision, 1);
    assert.match(pluginInstallV1.plugin?.installDir || '', /organizations\/org-one\/plugins\/installed\/org-plugin\/1\.0\.0$/);
    const pluginV1Path = pluginInstallV1.plugin!.installDir;
    const pluginResourceId = pluginInstallV1.plugin!.resourceId;
    const activePluginSkillPath = path.join(
      resolveScopedSkillsDataDir(organizationScope),
      'org-plugin-skill',
      'SKILL.md',
    );
    const activePluginSkillV1 = await fs.readFile(activePluginSkillPath, 'utf8');

    await fs.writeFile(path.join(pluginPackage, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'org-plugin',
      version: '1.0.0',
      description: 'Mutated organization plugin without a version bump.',
      skills: './skills',
    }, null, 2));
    const immutablePluginInstall = await installCanvasPluginFromPath(pluginPackage, {
      enable: true,
      replace: true,
      scope: organizationScope,
      installedBy: 'user-one',
    });
    assert.equal(immutablePluginInstall.success, false);
    assert.match(immutablePluginInstall.error || '', /without a version bump/i);
    assert.equal(
      await fs.readFile(activePluginSkillPath, 'utf8'),
      activePluginSkillV1,
      'a rejected immutable plugin update must restore the active materialized skill',
    );

    await fs.writeFile(path.join(pluginPackage, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'org-plugin',
      version: '1.1.0',
      description: 'Organization plugin test package update.',
      skills: './skills',
    }, null, 2));
    await fs.writeFile(path.join(pluginPackage, 'skills', 'org-plugin-skill', 'SKILL.md'), `---
name: org-plugin-skill
description: "Organization plugin skill update."
metadata:
  version: "1.1.0"
---

# Organization Plugin Skill Update
`);
    const pluginInstallV2 = await installCanvasPluginFromPath(pluginPackage, {
      enable: true,
      replace: true,
      scope: organizationScope,
      installedBy: 'user-one',
    });
    assert.equal(pluginInstallV2.success, true, pluginInstallV2.error || 'Plugin v2 install failed.');
    assert.equal(pluginInstallV2.plugin?.resourceId, pluginResourceId);
    assert.equal(pluginInstallV2.plugin?.revision, 2);
    assert.equal(await fs.stat(path.join(pluginV1Path, '.canvas-plugin', 'plugin.json')).then((stat) => stat.isFile()), true);

    async function writeSkillStore(version: string, description: string, sensitiveFile?: string) {
      const skillPackageRoot = path.join(dataRoot, 'test-packages', `org-skill-${version}`);
      await fs.rm(skillPackageRoot, { recursive: true, force: true });
      await fs.mkdir(skillPackageRoot, { recursive: true });
      await fs.writeFile(path.join(skillPackageRoot, 'SKILL.md'), `---
name: org-skill
description: ${JSON.stringify(description)}
metadata:
  version: ${JSON.stringify(version)}
---

# Organization Skill ${version}
`);
      if (sensitiveFile) {
        await fs.writeFile(path.join(skillPackageRoot, sensitiveFile), 'TEST_SECRET=must-not-be-imported\n');
      }
      const checksum = await computeCanvasPluginChecksum(skillPackageRoot);
      const zip = new JSZip();
      zip.file('package/SKILL.md', await fs.readFile(path.join(skillPackageRoot, 'SKILL.md')));
      if (sensitiveFile) {
        zip.file(`package/${sensitiveFile}`, await fs.readFile(path.join(skillPackageRoot, sensitiveFile)));
      }
      const archivePath = path.join(dataRoot, 'test-packages', `org-skill-${version}.zip`);
      await fs.writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));
      const registryPath = path.join(dataRoot, 'test-packages', `skill-registry-${version}.json`);
      await fs.writeFile(registryPath, JSON.stringify({
        schemaVersion: 1,
        id: 'org-skill-test-store',
        name: 'Organization Skill Test Store',
        updatedAt: new Date().toISOString(),
        plugins: [],
        skills: [{
          name: 'org-skill',
          displayName: 'Organization Skill',
          description,
          latestVersion: version,
          versions: {
            [version]: {
              version,
              downloadUrl: pathToFileURL(archivePath).toString(),
              packagePath: 'package',
              checksum: `sha256:${checksum}`,
            },
          },
        }],
      }, null, 2));
      process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();
    }

    const { installCanvasSkillFromStore } = await import('../app/lib/skills/canvas-skill-store');
    await writeSkillStore('0.9.0', 'Sensitive organization skill package.', 'private-key.pem');
    const sensitiveSkillInstall = await installCanvasSkillFromStore('org-skill', '0.9.0', {
      enable: true,
      scope: organizationScope,
      updatedBy: 'user-one',
    });
    assert.equal(sensitiveSkillInstall.success, false);
    assert.match(sensitiveSkillInstall.error || '', /instead of bundling secret files/i);
    await writeSkillStore('1.0.0', 'Organization skill test package.');
    const skillInstallV1 = await installCanvasSkillFromStore('org-skill', '1.0.0', {
      enable: true,
      scope: organizationScope,
      updatedBy: 'user-one',
    });
    assert.equal(skillInstallV1.success, true, skillInstallV1.error || 'Skill v1 install failed.');
    assert.equal(skillInstallV1.skill?.scopeType, 'organization');
    assert.equal(skillInstallV1.skill?.revision, 1);
    assert.match(skillInstallV1.skill?.installDir || '', /organizations\/org-one\/skills\/installed\/org-skill\/1\.0\.0\/org-skill$/);
    const skillV1Path = skillInstallV1.skill!.installDir;
    const skillResourceId = skillInstallV1.skill!.resourceId;

    await writeSkillStore('1.0.0', 'Mutated organization skill without a version bump.');
    const immutableSkillInstall = await installCanvasSkillFromStore('org-skill', '1.0.0', {
      enable: true,
      replace: true,
      scope: organizationScope,
      updatedBy: 'user-one',
    });
    assert.equal(immutableSkillInstall.success, false);
    assert.match(immutableSkillInstall.error || '', /without a version bump/i);
    assert.equal(
      await fs.readFile(path.join(skillV1Path, 'SKILL.md'), 'utf8').then((value) => value.includes('Organization Skill 1.0.0')),
      true,
      'a rejected immutable skill update must preserve the published package',
    );

    await writeSkillStore('1.1.0', 'Organization skill test package update.');
    const skillInstallV2 = await installCanvasSkillFromStore('org-skill', '1.1.0', {
      enable: true,
      replace: true,
      scope: organizationScope,
      updatedBy: 'user-one',
    });
    assert.equal(skillInstallV2.success, true, skillInstallV2.error || 'Skill v2 install failed.');
    assert.equal(skillInstallV2.skill?.resourceId, skillResourceId);
    assert.equal(skillInstallV2.skill?.revision, 2);
    assert.equal(await fs.stat(path.join(skillV1Path, 'SKILL.md')).then((stat) => stat.isFile()), true);

    const userScope = {
      scopeType: 'user' as const,
      userId: 'user-one',
      organizationId: 'org-one',
    };
    const personalSkillInstall = await installCanvasSkillFromStore('org-skill', '1.1.0', {
      enable: true,
      scope: userScope,
      updatedBy: 'user-one',
    });
    assert.equal(personalSkillInstall.success, true, personalSkillInstall.error || 'Personal skill install failed.');
    assert.equal(personalSkillInstall.skill?.scopeType, 'user');
    assert.notEqual(personalSkillInstall.skill?.resourceId, skillResourceId);
    const personalPluginInstall = await installCanvasPluginFromPath(pluginPackage, {
      enable: true,
      scope: userScope,
      installedBy: 'user-one',
    });
    assert.equal(personalPluginInstall.success, true, personalPluginInstall.error || 'Personal plugin install failed.');
    assert.equal(personalPluginInstall.plugin?.scopeType, 'user');
    assert.notEqual(personalPluginInstall.plugin?.resourceId, pluginResourceId);

    const { loadCapabilityCandidates } = await import('../app/lib/capabilities/catalog');
    const installedCandidates = await loadCapabilityCandidates({
      organizationId: 'org-one',
      userId: 'user-one',
      role: 'owner',
    });
    assert.ok(installedCandidates.some((candidate) => (
      candidate.ref.resourceId === skillResourceId
      && candidate.ref.scopeType === 'organization'
      && candidate.ref.version === '1.1.0'
    )));
    assert.ok(installedCandidates.some((candidate) => (
      candidate.ref.resourceId === pluginResourceId
      && candidate.ref.scopeType === 'organization'
      && candidate.ref.version === '1.1.0'
    )));
    const installedSnapshot = resolveEffectiveCapabilities({
      context: {
        organizationId: 'org-one',
        userId: 'user-one',
        role: 'owner',
      },
      candidates: installedCandidates,
      policies: [],
    });
    assert.equal(
      installedSnapshot.capabilities.find((candidate) => candidate.ref.resourceId === personalSkillInstall.skill?.resourceId)?.readiness,
      'conflict',
      'a personal standalone skill must not silently replace an organization standalone skill',
    );
    assert.equal(
      installedSnapshot.capabilities.find((candidate) => candidate.ref.resourceId === personalPluginInstall.plugin?.resourceId)?.readiness,
      'conflict',
      'a personal plugin must not silently replace an organization plugin',
    );

    const { getPostgresSchemaTableName, getPostgresSchemaTables } = await import('../app/lib/db/postgres');
    assert.ok(getPostgresSchemaTables().map(getPostgresSchemaTableName).includes('capability_policies'));
    sqlite.close();

    console.log('organization-capability-resolution-test: ok');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
