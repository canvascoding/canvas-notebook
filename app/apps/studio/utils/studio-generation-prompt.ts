import type { StudioGeneration } from '../types/generation';

const PRESET_PROMPT_HEADING = '## Preset';
const INSTRUCTIONS_HEADING = '## Instructions';

export function extractStudioUserPrompt(prompt: string | null | undefined): string {
  const value = prompt?.trim() ?? '';
  if (!value.startsWith(PRESET_PROMPT_HEADING)) {
    return value;
  }

  const instructionsIndex = value.indexOf(INSTRUCTIONS_HEADING);
  if (instructionsIndex === -1) {
    return value;
  }

  const extracted = value.slice(instructionsIndex + INSTRUCTIONS_HEADING.length).trim();
  return extracted || value;
}

export function getStudioUserPrompt(
  generation: Pick<StudioGeneration, 'prompt' | 'rawPrompt'>,
  fallback = '',
): string {
  const rawPrompt = generation.rawPrompt?.trim();
  if (rawPrompt) {
    return rawPrompt;
  }

  return extractStudioUserPrompt(generation.prompt) || fallback;
}
