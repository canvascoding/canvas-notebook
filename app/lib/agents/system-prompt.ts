import 'server-only';

import {
  CANVAS_INHERITED_FILE_NAMES,
  DEFAULT_MANAGED_AGENT_ID,
  readRuntimeManagedAgentFiles,
  readPiRuntimeConfig,
} from './storage';
import { resolveAgentRuntimeConfig } from './effective-runtime-config';
import {
  composeManagedAgentSystemPrompt,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';
import { getAgentProfile } from './registry';
import { loadSkillsFromDisk, getSkillsContext } from '../skills/skill-loader';
import { isComposioConfigured } from '../composio/composio-client';
import { isDefaultToolsConfig, normalizeEnabledToolsConfig } from '../pi/enabled-tools';

export {
  composeManagedAgentSystemPrompt,
  type ManagedPromptDiagnostics,
  type ManagedPromptFileName,
  type ManagedPromptFiles,
  type ManagedSystemPromptResult,
} from './system-prompt-shared';

const MCP_SYSTEM_PROMPT = `## MCP — External Tool Gateway

MCP servers can expose many tools, so their full catalogs are not preloaded into the prompt. Assigned or mentioned MCP servers are priorities, not direct tool names.

Use the \`mcp\` gateway tool:
1. \`list_servers\` or \`status\` to inspect configured servers when needed
2. \`search_tools\` with a natural-language query when you do not know the exact tool
3. \`describe_tool\` to inspect the input schema before calling a tool
4. \`call_tool\` with the schema-matching arguments to execute the selected tool

Tools may be addressed as \`Server.tool\`. If you are unsure how to perform an action through MCP, search first instead of guessing.`;

const COMPOSIO_SYSTEM_PROMPT = `## Composio — External App Gateway

Composio can expose many external app actions, so the full action catalog is not preloaded into the prompt. Assigned or mentioned Composio toolkits are priorities, not direct tool names.

Use the Composio gateway tools:
1. \`COMPOSIO_SEARCH_TOOLS\` with a natural-language query, optionally filtered to relevant toolkit slugs
2. \`COMPOSIO_GET_TOOL_SCHEMAS\` for exact parameter schemas of selected action slugs
3. \`composio_execute\` with the selected action slug and schema-matching params
4. \`COMPOSIO_MANAGE_CONNECTIONS\` to check, connect, or disconnect app accounts when needed

If \`composio_execute\` returns \`auth_required\`, tell the user to connect the app in Settings -> Integrations -> Connected Apps or use the returned redirect URL. If you are unsure which action exists, search first instead of guessing.`;

function getPromptSkillsForAgent<T extends { name: string; enabled?: boolean }>(
  normalizedAgentId: string,
  skills: T[],
  relevantSkills?: string[] | null,
): T[] {
  if (normalizedAgentId === DEFAULT_MANAGED_AGENT_ID) {
    return skills;
  }
  if (!relevantSkills || relevantSkills.length === 0) {
    return [];
  }

  const relevantSet = new Set(relevantSkills);
  return skills.filter((skill) => skill.enabled && relevantSet.has(skill.name));
}

function isMcpGatewayEnabled(enabledTools?: string[] | null): boolean {
  if (isDefaultToolsConfig(enabledTools)) {
    return true;
  }
  const normalized = normalizeEnabledToolsConfig(enabledTools);
  return normalized.some((toolName) => toolName === 'mcp' || toolName.startsWith('mcp_'));
}

function isComposioGatewayEnabled(enabledTools?: string[] | null): boolean {
  if (isDefaultToolsConfig(enabledTools)) {
    return true;
  }
  const normalized = normalizeEnabledToolsConfig(enabledTools);
  return normalized.some((toolName) => toolName === 'composio_execute' || toolName.startsWith('COMPOSIO_'));
}

export async function loadManagedAgentSystemPrompt(agentId?: string | null): Promise<ManagedSystemPromptResult> {
  try {
    const normalizedAgentId = agentId?.trim().toLowerCase() || DEFAULT_MANAGED_AGENT_ID;
    const files = await readRuntimeManagedAgentFiles(normalizedAgentId);
    const agentProfile = await getAgentProfile(normalizedAgentId);
    
    // Load PI config to get enabled skills and check composio tools
    const piConfig = await readPiRuntimeConfig();
    
    // The Canvas Agent receives all globally enabled skills. Specialized agents
    // receive only their selected relevant skills, intersected with global enablement.
    const skills = await loadSkillsFromDisk(piConfig.enabledSkills);
    const promptSkills = getPromptSkillsForAgent(normalizedAgentId, skills, agentProfile?.relevantSkills);
    const skillsContext = getSkillsContext(promptSkills);
    
    const result = composeManagedAgentSystemPrompt(files, skillsContext, {
      agentId: normalizedAgentId,
      inheritedFiles: normalizedAgentId === DEFAULT_MANAGED_AGENT_ID ? [] : CANVAS_INHERITED_FILE_NAMES,
    });
    
    // Check if composio tools are enabled for the active provider
    let systemPrompt = result.systemPrompt;
    try {
      const effectiveConfig = await resolveAgentRuntimeConfig(normalizedAgentId);
      const enabledTools = effectiveConfig.enabledTools;
      if (isMcpGatewayEnabled(enabledTools)) {
        systemPrompt += '\n\n' + MCP_SYSTEM_PROMPT;
      }

      if ((await isComposioConfigured()) && isComposioGatewayEnabled(enabledTools)) {
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
