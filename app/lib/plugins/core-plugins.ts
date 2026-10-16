import { isCoreSkillName } from '@/app/lib/skills/core-skills';

export const CORE_PLUGIN_NAMES = ['plugin-creator'] as const;
export const CORE_PLUGIN_CHILD_SKILL_NAMES = ['plugin-visual'] as const;

export function isCorePluginName(name: string | null | undefined): boolean {
  return Boolean(name && CORE_PLUGIN_NAMES.some(value => value === name.trim().toLowerCase()));
}

export function isCorePluginChildSkillName(name: string | null | undefined): boolean {
  return Boolean(name && CORE_PLUGIN_CHILD_SKILL_NAMES.some(value => value === name.trim().toLowerCase()));
}

export function isProtectedCoreSkillName(name: string | null | undefined): boolean {
  return isCoreSkillName(name) || isCorePluginChildSkillName(name);
}

export function isProtectedCoreCapabilityName(kind: 'plugin' | 'skill', name: string): boolean {
  return kind === 'plugin' ? isCorePluginName(name) : isProtectedCoreSkillName(name);
}

export function corePluginResourceId(name: string): string | null {
  return isCorePluginName(name) ? `canvas-capability:v1:plugin:system:core:${name.trim().toLowerCase()}` : null;
}

export function corePluginDisplayName(name: string): string | null {
  return isCorePluginName(name) ? 'Plugin Creator' : null;
}

export function corePluginMutationError(name: string): string {
  return `Plugin "${name}" is a built-in Canvas core plugin and cannot be replaced, disabled, edited, configured, or removed.`;
}
