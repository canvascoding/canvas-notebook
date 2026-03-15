import 'server-only';

import {
  readManagedAgentFiles,
  readPiRuntimeConfig,
} from './storage';
import {
  BASE_AGENT_SYSTEM_PROMPT,
  composeManagedAgentSystemPrompt,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';
import { loadSkillsFromDisk, getSkillsContext } from '../skills/skill-loader';

export {
  BASE_AGENT_SYSTEM_PROMPT,
  composeManagedAgentSystemPrompt,
  type ManagedPromptDiagnostics,
  type ManagedPromptFileName,
  type ManagedPromptFiles,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';

export async function loadManagedAgentSystemPrompt(): Promise<ManagedSystemPromptResult> {
  try {
    const files = await readManagedAgentFiles();
    
    // Load PI config to get enabled skills
    const piConfig = await readPiRuntimeConfig();
    
    // Load enabled skills and add their context to system prompt
    // Pass enabledSkills to filter which skills are active
    const skills = await loadSkillsFromDisk(piConfig.enabledSkills);
    const skillsContext = getSkillsContext(skills);
    
    return composeManagedAgentSystemPrompt(files, skillsContext);
  } catch {
    return {
      systemPrompt: BASE_AGENT_SYSTEM_PROMPT,
      diagnostics: {
        loadedFiles: [],
        includedFiles: [],
        emptyFiles: [],
        usedFallback: true,
        fallbackReason: 'read-failed',
      },
    };
  }
}
