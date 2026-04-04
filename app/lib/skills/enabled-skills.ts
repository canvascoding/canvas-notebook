export const DISABLED_ALL_SKILLS_SENTINEL = '__none__';

function normalizeSkillNames(skillNames: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const skillName of skillNames) {
    const normalized = skillName.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function normalizeEnabledSkillsConfig(enabledSkills?: string[] | null): string[] {
  if (!Array.isArray(enabledSkills)) {
    return [];
  }

  return normalizeSkillNames(enabledSkills);
}

export function resolveEnabledSkillNames(
  allSkillNames: Iterable<string>,
  enabledSkills?: string[] | null,
): Set<string> {
  const canonicalSkillNames = normalizeSkillNames(allSkillNames);
  const canonicalSkillSet = new Set(canonicalSkillNames);
  const configuredSkills = normalizeEnabledSkillsConfig(enabledSkills).filter((skillName) => skillName !== DISABLED_ALL_SKILLS_SENTINEL);

  if (configuredSkills.length === 0) {
    return new Set(canonicalSkillNames);
  }

  return new Set(configuredSkills.filter((skillName) => canonicalSkillSet.has(skillName)));
}

export function areAllSkillsEnabled(enabledSkills?: string[] | null): boolean {
  return normalizeEnabledSkillsConfig(enabledSkills).length === 0;
}

export function serializeEnabledSkillNames(
  enabledSkillNames: Iterable<string>,
  allSkillNames: Iterable<string>,
): string[] {
  const canonicalSkillNames = normalizeSkillNames(allSkillNames);
  const enabledSet = new Set(normalizeSkillNames(enabledSkillNames));
  const orderedEnabledNames = canonicalSkillNames.filter((skillName) => enabledSet.has(skillName));

  if (orderedEnabledNames.length === 0) {
    return [DISABLED_ALL_SKILLS_SENTINEL];
  }

  if (orderedEnabledNames.length === canonicalSkillNames.length) {
    return [];
  }

  return orderedEnabledNames;
}

export function enableSkillInConfig(
  skillName: string,
  enabledSkills: string[] | null | undefined,
  allSkillNames: Iterable<string>,
): string[] {
  const enabledSet = resolveEnabledSkillNames(allSkillNames, enabledSkills);
  enabledSet.add(skillName);
  return serializeEnabledSkillNames(enabledSet, allSkillNames);
}

export function disableSkillInConfig(
  skillName: string,
  enabledSkills: string[] | null | undefined,
  allSkillNames: Iterable<string>,
): string[] {
  const enabledSet = resolveEnabledSkillNames(allSkillNames, enabledSkills);
  enabledSet.delete(skillName);
  return serializeEnabledSkillNames(enabledSet, allSkillNames);
}
