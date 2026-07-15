import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { openDb } from '@/app/lib/db';

import {
  createCapabilityReference,
} from '@/app/lib/capabilities/reference';
import {
  resolveEffectiveCapabilities,
} from '@/app/lib/capabilities/effective-resolver';
import { readCapabilityPreferences } from '@/app/lib/capabilities/preference-store';
import { withCapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import type {
  CapabilityCandidate,
  CapabilityResolutionContext,
  CapabilityScopeType,
  EffectiveCapabilitySnapshot,
} from '@/app/lib/capabilities/types';
import {
  computeCanvasPluginChecksum,
  listCanvasPlugins,
  type CanvasPluginInstallRecord,
  type CanvasPluginStorageScope,
} from '@/app/lib/plugins/canvas-plugin-registry';
import { resolvePluginConnectionReadiness } from '@/app/lib/plugins/plugin-connection-readiness';
import { readCanvasSkillRegistry } from '@/app/lib/skills/canvas-skill-store';
import { loadCoreSkills } from '@/app/lib/skills/core-skill-loader';
import {
  DISABLED_ALL_SKILLS_SENTINEL,
  normalizeEnabledSkillsConfig,
  resolveEnabledSkillNames,
} from '@/app/lib/skills/enabled-skills';
import { parseSkillFile, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { loadSkillSummaries } from '@/app/lib/skills/skill-summaries';
import { readEnabledSkillsForScope } from '@/app/lib/skills/skill-settings';
import { resolveScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';

function checksumText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function skillUserPreference(
  skillName: string,
  enabledSkills?: string[] | null,
): 'unset' | 'enabled' | 'disabled' {
  const normalized = normalizeEnabledSkillsConfig(enabledSkills);
  if (normalized.length === 0) return 'unset';
  if (normalized.includes(DISABLED_ALL_SKILLS_SENTINEL)) return 'disabled';
  return normalized.includes(skillName) ? 'enabled' : 'disabled';
}

function capabilityScopeType(
  storedScopeType: string | null | undefined,
  fallback: CapabilityScopeType,
): CapabilityScopeType {
  if (storedScopeType === 'system' || storedScopeType === 'organization' || storedScopeType === 'user') {
    return storedScopeType;
  }
  return fallback;
}

function connectionRequirementCount(plugin: CanvasPluginInstallRecord): number {
  const connectors = plugin.connectors;
  if (!connectors) return 0;
  return (connectors.composio?.length || 0)
    + (connectors.composioToolkits?.length || 0)
    + (connectors.email?.length || 0)
    + (connectors.mcp?.length || 0)
    + (connectors.mcpServers ? 1 : 0);
}

function pluginCandidate(
  plugin: CanvasPluginInstallRecord,
  scopeType: CapabilityScopeType,
  context: CapabilityResolutionContext,
  connectionReady: boolean,
): CapabilityCandidate {
  const refScope = capabilityScopeType(plugin.scopeType, scopeType);
  const ref = createCapabilityReference({
    resourceType: 'plugin',
    scopeType: refScope,
    resourceId: plugin.scopeType === 'legacy' ? undefined : plugin.resourceId,
    name: plugin.name,
    version: plugin.version,
    revision: plugin.revision || 1,
    checksum: plugin.checksum,
    sourceType: 'standalone',
    organizationId: refScope === 'organization' ? context.organizationId : null,
    ownerUserId: refScope === 'user' ? context.userId : null,
    sourcePluginId: null,
  });
  return {
    ref,
    description: plugin.description,
    enabled: plugin.enabled,
    runtimePath: plugin.manifestPath,
    connectionRequirementCount: connectionRequirementCount(plugin),
    connectionReady,
  };
}

async function resolvePluginReadiness(
  plugins: CanvasPluginInstallRecord[],
  userId: string,
): Promise<Map<CanvasPluginInstallRecord, boolean>> {
  const entries = await Promise.all(plugins.map(async (plugin) => {
    if (connectionRequirementCount(plugin) === 0) return [plugin, true] as const;
    const readiness = await resolvePluginConnectionReadiness({
      connectors: plugin.connectors,
      userId,
    });
    return [plugin, readiness.ready] as const;
  }));
  return new Map(entries);
}

async function pluginSkillCandidates(
  plugin: CanvasPluginInstallRecord,
  pluginResourceId: string,
  scopeType: CapabilityScopeType,
  context: CapabilityResolutionContext,
  enabledSkillNames: Set<string>,
  enabledSkillsConfig?: string[] | null,
  includeUserPreference = true,
): Promise<CapabilityCandidate[]> {
  const refScope = capabilityScopeType(plugin.scopeType, scopeType);
  const candidates: CapabilityCandidate[] = [];
  for (const record of plugin.skills) {
    const skillPath = record.path || path.join(record.directory, 'SKILL.md');
    const skill = await parseSkillFile(skillPath).catch(() => null);
    if (!skill) continue;
    const checksum = await computeCanvasPluginChecksum(skill.directory).catch(() => plugin.checksum);
    candidates.push({
      ref: createCapabilityReference({
        resourceType: 'skill',
        scopeType: refScope,
        name: skill.name,
        version: skill.version || record.version || plugin.version,
        revision: plugin.revision || 1,
        checksum,
        sourceType: 'plugin',
        organizationId: refScope === 'organization' ? context.organizationId : null,
        ownerUserId: refScope === 'user' ? context.userId : null,
        sourcePluginId: pluginResourceId,
        sourcePluginName: plugin.name,
      }),
      description: skill.description,
      enabled: plugin.enabled && enabledSkillNames.has(skill.name),
      userPreference: includeUserPreference
        ? skillUserPreference(skill.name, enabledSkillsConfig)
        : 'unset',
      runtimePath: skill.path,
      pluginResourceId,
    });
  }
  return candidates;
}

async function standaloneSkillCandidates(input: {
  scope: CanvasPluginStorageScope;
  scopeType: CapabilityScopeType;
  context: CapabilityResolutionContext;
  enabledSkillNames: Set<string>;
  enabledSkillsConfig?: string[] | null;
  includeUserPreference?: boolean;
}): Promise<CapabilityCandidate[]> {
  const registry = await readCanvasSkillRegistry(input.scope);
  return Promise.all(Object.values(registry.skills)
    .filter((record) => record.sourceType !== 'plugin')
    .map(async (record): Promise<CapabilityCandidate> => {
      const refScope = capabilityScopeType(record.scopeType, input.scopeType);
      return {
        ref: createCapabilityReference({
          resourceType: 'skill',
          scopeType: refScope,
          resourceId: record.scopeType === 'legacy' ? undefined : record.resourceId,
          name: record.name,
          version: record.version,
          revision: record.revision || 1,
          checksum: record.checksum,
          sourceType: 'standalone',
          organizationId: refScope === 'organization' ? input.context.organizationId : null,
          ownerUserId: refScope === 'user' ? input.context.userId : null,
          sourcePluginId: null,
        }),
        description: record.description,
        enabled: input.enabledSkillNames.has(record.name),
        userPreference: input.includeUserPreference === false
          ? 'unset'
          : skillUserPreference(record.name, input.enabledSkillsConfig),
        runtimePath: record.skillPath,
      };
    }));
}

async function unregisteredPersonalSkillCandidates(input: {
  context: CapabilityResolutionContext;
  knownSkillNames: Set<string>;
  enabledSkillNames: Set<string>;
  enabledSkillsConfig?: string[] | null;
}): Promise<CapabilityCandidate[]> {
  const scope = { scopeType: 'user' as const, userId: input.context.userId };
  const skillsDir = resolveScopedSkillsDataDir(scope);
  const summaries = await loadSkillSummaries(undefined, scope);
  const custom = summaries.filter((skill) => (
    !skill.core
    && !skill.plugin
    && !input.knownSkillNames.has(skill.name)
  ));
  return Promise.all(custom.map(async (skill): Promise<CapabilityCandidate> => {
    const skillPath = path.join(skillsDir, skill.name, 'SKILL.md');
    const directory = path.dirname(skillPath);
    const checksum = await computeCanvasPluginChecksum(directory).catch(async () => (
      checksumText(await fs.readFile(skillPath, 'utf8').catch(() => skill.description))
    ));
    const userPreference = skillUserPreference(skill.name, input.enabledSkillsConfig);
    return {
      ref: createCapabilityReference({
        resourceType: 'skill',
        scopeType: 'user',
        name: skill.name,
        version: skill.version || 'unversioned',
        revision: 1,
        checksum,
        sourceType: 'standalone',
        organizationId: null,
        ownerUserId: input.context.userId,
        sourcePluginId: null,
      }),
      description: skill.description,
      enabled: userPreference === 'unset' || input.enabledSkillNames.has(skill.name),
      userPreference,
      runtimePath: skillPath,
    };
  }));
}

export async function loadCapabilityCandidates(
  context: CapabilityResolutionContext,
  options: { resolveConnections?: boolean } = {},
): Promise<CapabilityCandidate[]> {
  const organizationScope = {
    scopeType: 'organization' as const,
    organizationId: context.organizationId,
  };
  const userScope = {
    scopeType: 'user' as const,
    userId: context.userId,
    organizationId: context.organizationId,
  };
  const [coreSkills, organizationSkillRegistry, personalSkillRegistry, organizationPlugins, personalPlugins, organizationEnabledSkills, enabledSkills, capabilityPreferences] = await Promise.all([
    loadCoreSkills(),
    readCanvasSkillRegistry(organizationScope),
    readCanvasSkillRegistry(userScope),
    listCanvasPlugins(organizationScope),
    listCanvasPlugins(userScope),
    readEnabledSkillsForScope(organizationScope),
    readEnabledSkillsForScope(userScope),
    readCapabilityPreferences(context.userId),
  ]);
  const organizationSkillNames = new Set<string>([
    ...Object.keys(organizationSkillRegistry.skills),
    ...organizationPlugins.flatMap((plugin) => plugin.skills.map((skill) => skill.name)),
  ]);
  const personalSkillNames = new Set<string>([
    ...coreSkills.map((skill) => skill.name),
    ...Object.keys(personalSkillRegistry.skills),
    ...personalPlugins.flatMap((plugin) => plugin.skills.map((skill) => skill.name)),
  ]);
  const organizationEnabledSkillNames = resolveEnabledSkillNames(organizationSkillNames, organizationEnabledSkills);
  const enabledSkillNames = resolveEnabledSkillNames(personalSkillNames, enabledSkills);
  const pluginReadiness = options.resolveConnections === false
    ? new Map([...organizationPlugins, ...personalPlugins].map((plugin) => [plugin, true] as const))
    : await resolvePluginReadiness(
      [...organizationPlugins, ...personalPlugins],
      context.userId,
    );
  const candidates: CapabilityCandidate[] = coreSkills.map((skill) => ({
    ref: createCapabilityReference({
      resourceType: 'skill',
      scopeType: 'system',
      name: skill.name,
      version: skill.version || 'bundled',
      revision: 1,
      checksum: checksumText(`${skill.name}\0${skill.version || 'bundled'}\0${skill.content}`),
      sourceType: 'core',
      organizationId: null,
      ownerUserId: null,
      sourcePluginId: null,
    }),
    description: skill.description,
    enabled: true,
    runtimePath: skill.path,
  }));

  candidates.push(...await standaloneSkillCandidates({
    scope: organizationScope,
    scopeType: 'organization',
    context,
    enabledSkillNames: organizationEnabledSkillNames,
    enabledSkillsConfig: organizationEnabledSkills,
    includeUserPreference: false,
  }));
  candidates.push(...await standaloneSkillCandidates({
    scope: userScope,
    scopeType: 'user',
    context,
    enabledSkillNames,
    enabledSkillsConfig: enabledSkills,
  }));

  for (const plugin of organizationPlugins) {
    const pluginEntry = pluginCandidate(plugin, 'organization', context, pluginReadiness.get(plugin) === true);
    candidates.push(pluginEntry);
    candidates.push(...await pluginSkillCandidates(
      plugin,
      pluginEntry.ref.resourceId,
      'organization',
      context,
      organizationEnabledSkillNames,
      organizationEnabledSkills,
      false,
    ));
  }
  for (const plugin of personalPlugins) {
    const pluginEntry = pluginCandidate(plugin, 'user', context, pluginReadiness.get(plugin) === true);
    candidates.push(pluginEntry);
    candidates.push(...await pluginSkillCandidates(plugin, pluginEntry.ref.resourceId, 'user', context, enabledSkillNames, enabledSkills));
  }

  candidates.push(...await unregisteredPersonalSkillCandidates({
    context,
    knownSkillNames: new Set(Object.keys(personalSkillRegistry.skills)),
    enabledSkillNames,
    enabledSkillsConfig: enabledSkills,
  }));
  return candidates.map((candidate) => {
    const preference = capabilityPreferences.preferences[candidate.ref.resourceId];
    if (!preference || candidate.ref.scopeType !== 'organization') return candidate;
    return {
      ...candidate,
      userPreference: preference.enabled ? 'enabled' : 'disabled',
    };
  });
}

export async function resolveEffectiveCapabilitySnapshot(
  context: CapabilityResolutionContext,
): Promise<EffectiveCapabilitySnapshot> {
  let effectiveContext = context;
  if (!context.role) {
    const connection = await openDb();
    try {
      const row = await connection.get(
        `SELECT role FROM organization_user_permissions
         WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
        [context.organizationId, context.userId],
      ) as { role?: string | null } | undefined;
      effectiveContext = { ...context, role: row?.role || null };
    } finally {
      await connection.close();
    }
  }
  const [candidates, policies] = await Promise.all([
    loadCapabilityCandidates(effectiveContext),
    withCapabilityPolicyStore((store) => store.listOrganizationPolicies(effectiveContext.organizationId)),
  ]);
  return resolveEffectiveCapabilities({ context: effectiveContext, candidates, policies });
}

export async function loadEffectiveSkills(
  snapshot: EffectiveCapabilitySnapshot,
): Promise<CanvasSkill[]> {
  const entries = snapshot.capabilities.filter((entry) => (
    entry.ref.resourceType === 'skill'
    && entry.effectiveEnabled
    && entry.readiness === 'available'
    && entry.runtimePath
  ));
  const skills = await Promise.all(entries.map(async (entry) => {
    const skill = await parseSkillFile(entry.runtimePath!);
    if (!skill) return null;
    skill.enabled = true;
    return skill;
  }));
  return skills
    .filter((skill): skill is CanvasSkill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name));
}
