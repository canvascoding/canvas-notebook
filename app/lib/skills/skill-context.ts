type SkillContextEntry = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
};

/**
 * Build compact PI Agent skill context.
 *
 * Keep this module side-effect free so prompt tests can import it without
 * pulling in server-only storage code.
 */
export function getSkillsContext(skills: SkillContextEntry[]): string {
  const enabledSkills = skills.filter(s => s.enabled);

  if (enabledSkills.length === 0) {
    return '';
  }

  let context = '\n\n# Enabled Skills\n\n';
  context += 'Only descriptions are listed here. Read the skill file before using a skill.\n\n';
  context += 'If the user explicitly mentions one or more skills with the syntax /skill-name, ';
  context += 'treat that as a strong preference to use those enabled skills when they are relevant and available.\n\n';

  for (const skill of enabledSkills) {
    context += `## Skill: ${skill.name}\n\n`;
    context += `Description: ${skill.description}\n`;
    context += `Path: ${skill.path}\n\n`;
  }

  return context;
}
