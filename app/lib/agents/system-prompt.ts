import 'server-only';

import {
  readManagedAgentFiles,
  readPiRuntimeConfig,
} from './storage';
import {
  composeManagedAgentSystemPrompt,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';
import { loadSkillsFromDisk, getSkillsContext } from '../skills/skill-loader';
import { isComposioConfigured } from '../composio/composio-client';
import { resolveEnabledToolNames, isDefaultToolsConfig } from '../pi/enabled-tools';

export {
  composeManagedAgentSystemPrompt,
  type ManagedPromptDiagnostics,
  type ManagedPromptFileName,
  type ManagedPromptFiles,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';

const COMPOSIO_SYSTEM_PROMPT = `## Composio — External App Integration

You have access to external apps through Composio Meta Tools. Workflow:

1. **Discover:** Use \`COMPOSIO_SEARCH_TOOLS\` with a natural language query to find relevant actions
2. **Learn:** Use \`COMPOSIO_GET_TOOL_SCHEMAS\` to get exact parameter definitions for the actions you need
3. **Execute:** Use \`composio_execute\` to run the action with the required parameters
4. **Auth:** If \`composio_execute\` returns \`auth_required\`, inform the user they need to connect the app first and provide the redirect URL or direct them to Settings → Integrations → Connected Apps

Always search before executing — don't guess action names.`;

export async function loadManagedAgentSystemPrompt(): Promise<ManagedSystemPromptResult> {
  try {
    const files = await readManagedAgentFiles();
    
    // Load PI config to get enabled skills and check composio tools
    const piConfig = await readPiRuntimeConfig();
    
    // Load enabled skills and add their context to system prompt
    const skills = await loadSkillsFromDisk(piConfig.enabledSkills);
    const skillsContext = getSkillsContext(skills);
    
    const result = composeManagedAgentSystemPrompt(files, skillsContext);
    
    // Check if composio tools are enabled for the active provider
    let systemPrompt = result.systemPrompt;
    try {
      const activeProvider = piConfig.providers[piConfig.activeProvider];
      const enabledTools = activeProvider?.enabledTools;
      const composioToolNames = ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute', 'COMPOSIO_MANAGE_CONNECTIONS'];
      
      let composioEnabled = false;
      if (await isComposioConfigured()) {
        if (enabledTools && enabledTools.length > 0 && !isDefaultToolsConfig(enabledTools)) {
          const enabledSet = resolveEnabledToolNames(composioToolNames, enabledTools);
          composioEnabled = composioToolNames.some(name => enabledSet.has(name));
        } else {
          // Default config: composio tools are disabled by default
          composioEnabled = false;
        }
      }
      
      if (composioEnabled) {
        systemPrompt += '\n\n' + COMPOSIO_SYSTEM_PROMPT;
      }
    } catch {
      // If we can't check composio config, don't add the prompt section
    }
    
    return { ...result, systemPrompt };
  } catch {
    return {
      systemPrompt: '',
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
