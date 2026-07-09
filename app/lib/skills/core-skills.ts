export const CORE_SKILL_NAMES = [
  'create-plugin',
  'skill-creator',
  'find-skills',
] as const;

export type CoreSkillName = (typeof CORE_SKILL_NAMES)[number];

const CORE_SKILL_NAME_SET = new Set<string>(CORE_SKILL_NAMES);

export function isCoreSkillName(skillName: string | null | undefined): skillName is CoreSkillName {
  return Boolean(skillName && CORE_SKILL_NAME_SET.has(skillName.trim()));
}

export function coreSkillInstallError(skillName: string): string {
  return `Skill "${skillName}" is a built-in Canvas core skill and cannot be replaced, disabled, edited, or removed.`;
}
