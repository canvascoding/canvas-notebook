import { type AutomationJobRecord } from './types';

type BuildAutomationPromptInput = Pick<
  AutomationJobRecord,
  'name' | 'preferredSkill' | 'workspaceContextPaths' | 'prompt'
> & {
  effectiveTargetOutputPath: string;
  runArtifactDir?: string | null;
};

export function buildAutomationPrompt(input: BuildAutomationPromptInput): string {
  const sections = [
    `Automation name: ${input.name}`,
    `Preferred skill hint: ${input.preferredSkill}`,
  ];

  if (input.workspaceContextPaths.length > 0) {
    sections.push(`Relevant workspace paths:\n${input.workspaceContextPaths.map((entry) => `- ${entry}`).join('\n')}`);
  } else {
    sections.push('Relevant workspace paths:\n- none selected');
  }

  sections.push(`Write final deliverables to: ${input.effectiveTargetOutputPath}`);
  sections.push('Store logs and run metadata in the automation run folder automatically; do not duplicate them unless useful.');

  if (input.runArtifactDir) {
    sections.push(`Automation run artifact folder: ${input.runArtifactDir}`);
  }

  sections.push(`Task:\n${input.prompt}`);
  sections.push('Use workspace-relative file operations. Read the listed paths when relevant instead of assuming their contents.');

  return sections.join('\n\n');
}
