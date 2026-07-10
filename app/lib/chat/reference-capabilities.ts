export type AgentScopedSkill = {
  name: string;
  enabled?: boolean;
  core?: boolean;
};

export function filterSkillsForAgent<T extends AgentScopedSkill>(
  skills: T[],
  options: {
    agentId: string;
    defaultAgentId: string;
    relevantSkillNames?: string[] | null;
  },
): T[] {
  const enabledSkills = skills.filter((skill) => skill.enabled !== false);
  if (options.agentId === options.defaultAgentId || options.relevantSkillNames == null) {
    return enabledSkills;
  }

  const relevantNames = new Set(options.relevantSkillNames);
  return enabledSkills.filter((skill) => skill.core || relevantNames.has(skill.name));
}
