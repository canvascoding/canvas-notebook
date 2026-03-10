import 'server-only';

import {
  readManagedAgentFiles,
} from './storage';
import {
  BASE_AGENT_SYSTEM_PROMPT,
  composeManagedAgentSystemPrompt,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';

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
    return composeManagedAgentSystemPrompt(files);
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
