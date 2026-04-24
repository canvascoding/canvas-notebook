import { type AutomationJobRecord } from './types';

type BuildAutomationPromptInput = Pick<
  AutomationJobRecord,
  'name' | 'workspaceContextPaths' | 'prompt'
> & {
  effectiveTargetOutputPath: string;
  runArtifactDir?: string | null;
};

export function buildAutomationPrompt(input: BuildAutomationPromptInput): string {
  const sections = [
    'AUTOMATION EXECUTION CONTEXT',
    '─────────────────────────────────',
    'This automation is being EXECUTED now (not created).',
    'The user has already configured this automation. Your task is to execute the prompt below.',
    'DO NOT create a new automation - execute the task as described.',
    '',
    `Automation name: ${input.name}`,
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
