import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';

export function selectPromptSkillsForAgent<T extends { name: string; enabled?: boolean }>(
  normalizedAgentId: string,
  skills: Array<T & { core?: boolean }>,
  relevantSkills?: string[] | null,
  requiredSkillNames: Iterable<string> = [],
): Array<T & { core?: boolean }> {
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return skills;
  }

  const requiredSet = new Set(requiredSkillNames);
  const coreSkills = skills.filter((skill) => skill.enabled && (skill.core || requiredSet.has(skill.name)));

  if (relevantSkills === null || relevantSkills === undefined) {
    return skills;
  }

  if (relevantSkills.length === 0) {
    return coreSkills;
  }

  const relevantSet = new Set(relevantSkills);
  return skills.filter((skill) => (
    skill.enabled
    && (skill.core || requiredSet.has(skill.name) || relevantSet.has(skill.name))
  ));
}
