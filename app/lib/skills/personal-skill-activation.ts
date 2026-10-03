import 'server-only';

import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveDataStorageScope, type UserScopedDataStorageScope } from '@/app/lib/runtime-data-paths';
import { isCoreSkillName } from '@/app/lib/skills/core-skills';
import type { CanvasSkillInstallRecord } from '@/app/lib/skills/canvas-skill-store';
import type { CanvasPluginInstallRecord, CanvasPluginSkillRecord } from '@/app/lib/plugins/canvas-plugin-registry';

export class PersonalSkillActivationError extends Error {
  readonly code = 'SKILL_SCOPE_PROTECTED';
  readonly statusCode = 409;

  constructor(readonly skillName: string) {
    super(`Skill "${skillName}" is managed by your organization. Use the organization skill instead of activating a personal copy.`);
    this.name = 'PersonalSkillActivationError';
  }
}

export interface PersonalSkillNamespace {
  names: Set<string>;
  organizationScope: { scopeType: 'organization'; organizationId: string } | null;
  skillsByName: Map<string, CanvasSkillInstallRecord>;
  pluginSkillsByName: Map<string, { skill: CanvasPluginSkillRecord; plugin: CanvasPluginInstallRecord }>;
}

/** Organization names remain reserved even when a package is disabled or blocked. */
export async function readProtectedPersonalSkillNamespace(
  scope?: UserScopedDataStorageScope | null,
): Promise<PersonalSkillNamespace> {
  const empty: PersonalSkillNamespace = {
    names: new Set(), organizationScope: null, skillsByName: new Map(), pluginSkillsByName: new Map(),
  };
  const resolved = resolveDataStorageScope(scope);
  if (resolved.scopeType !== 'user' || !resolved.userId) return empty;
  const state = await readOrganizationPermissionForUser(resolved.userId);
  if (!state.organizationId || state.permission?.status !== 'active') return empty;

  // These modules also use the activation guard during installation. Load them
  // at the read boundary rather than creating an eager module cycle.
  const [{ readCanvasSkillRegistry }, { listCanvasPlugins }] = await Promise.all([
    import('@/app/lib/skills/canvas-skill-store'),
    import('@/app/lib/plugins/canvas-plugin-registry'),
  ]);
  const organizationScope = { scopeType: 'organization' as const, organizationId: state.organizationId };
  const [registry, plugins] = await Promise.all([
    readCanvasSkillRegistry(organizationScope),
    listCanvasPlugins(organizationScope),
  ]);
  const skillsByName = new Map(Object.values(registry.skills).map((skill) => [skill.name.trim().toLowerCase(), skill]));
  const pluginSkillsByName = new Map(plugins.flatMap((plugin) => plugin.skills.map((skill) => (
    [skill.name.trim().toLowerCase(), { skill, plugin }] as const
  ))));
  return { names: new Set([...skillsByName.keys(), ...pluginSkillsByName.keys()]), organizationScope, skillsByName, pluginSkillsByName };
}

export async function readProtectedPersonalSkillNames(
  scope?: UserScopedDataStorageScope | null,
): Promise<Set<string>> {
  return (await readProtectedPersonalSkillNamespace(scope)).names;
}

export async function assertPersonalSkillActivationAllowed(
  skillName: string,
  scope?: UserScopedDataStorageScope | null,
): Promise<void> {
  // Core enable is an existing harmless operation; core replacement is guarded
  // by the package installation boundaries themselves.
  if (isCoreSkillName(skillName)) return;
  const protectedNames = await readProtectedPersonalSkillNames(scope);
  if (protectedNames.has(skillName.trim().toLowerCase())) {
    throw new PersonalSkillActivationError(skillName);
  }
}
