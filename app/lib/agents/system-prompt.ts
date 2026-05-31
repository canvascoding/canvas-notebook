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
import {
  isDefaultToolsConfig,
  normalizeEnabledToolsConfig,
  resolveEnabledToolNames,
} from '../pi/enabled-tools';
import type { PiToolMetadata } from '../pi/tool-registry';

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

function formatEnabledToolLine(tool: PiToolMetadata): string {
  const label = tool.label && tool.label !== tool.name ? ` (${tool.label})` : '';
  const description = tool.description ? `: ${tool.description}` : '';
  const notes = tool.notes.length > 0 ? ` Notes: ${tool.notes.join(' ')}` : '';
  return `- \`${tool.name}\`${label} [${tool.group}]${description}${notes}`;
}

function formatConnectorToolHint(tool: PiToolMetadata): string | null {
  if (tool.group === 'MCP' || tool.name === 'mcp' || tool.name.startsWith('mcp_')) {
    if (tool.name === 'mcp') {
      return '- MCP gateway: use `mcp` with `search_tools` when the exact external tool is unclear, `describe_tool` for schemas, and `call_tool` for execution.';
    }
    return `- Direct MCP tool \`${tool.name}\`: if the direct tool does not expose enough context or parameters are unclear, use the \`mcp\` gateway search/describe flow when available.`;
  }

  if (tool.group === 'Composio' || tool.name === 'composio_execute' || tool.name.startsWith('COMPOSIO_')) {
    if (tool.name === 'COMPOSIO_SEARCH_TOOLS') {
      return '- Composio discovery: use `COMPOSIO_SEARCH_TOOLS` with a natural-language query and toolkit filters when the target app/toolkit is known.';
    }
    if (tool.name === 'COMPOSIO_GET_TOOL_SCHEMAS') {
      return '- Composio schemas: use `COMPOSIO_GET_TOOL_SCHEMAS` before executing unfamiliar action slugs.';
    }
    if (tool.name === 'composio_execute') {
      return '- Composio execution: use `composio_execute` only after discovering the action slug and checking the schema.';
    }
    if (tool.name === 'COMPOSIO_MANAGE_CONNECTIONS') {
      return '- Composio connections: use `COMPOSIO_MANAGE_CONNECTIONS` to check connection status or start an app connection flow.';
    }
    return `- Composio tool \`${tool.name}\`: if the exact action or params are unclear, use the Composio search/schema flow when available.`;
  }

  return null;
}

async function buildSpecializedAgentToolsContext(params: {
  normalizedAgentId: string;
  enabledTools: string[];
  toolsOverride: boolean;
}): Promise<string> {
  if (params.normalizedAgentId === DEFAULT_MANAGED_AGENT_ID || !params.toolsOverride) {
    return '';
  }

  const { getPiToolMetadata } = await import('../pi/tool-registry');
  const tools = await getPiToolMetadata();
  const allToolNames = tools.map((tool) => tool.name);
  const enabledSet = isDefaultToolsConfig(params.enabledTools)
    ? new Set(tools.filter((tool) => tool.defaultEnabled).map((tool) => tool.name))
    : resolveEnabledToolNames(allToolNames, params.enabledTools);
  const enabledTools = tools.filter((tool) => enabledSet.has(tool.name));

  if (enabledTools.length === 0) {
    return [
      '## Agent-Enabled Runtime Tools',
      '',
      'This specialized agent has an explicit tool override, but no runtime tools are enabled for it.',
    ].join('\n');
  }

  const connectorHints = enabledTools
    .map(formatConnectorToolHint)
    .filter((hint): hint is string => Boolean(hint));

  const blocks = [
    '## Agent-Enabled Runtime Tools',
    '',
    'This specialized agent has an explicit tool override. The following runtime tools are enabled for this agent:',
    '',
    ...enabledTools.map(formatEnabledToolLine),
  ];

  if (connectorHints.length > 0) {
    blocks.push(
      '',
      '### Connector Discovery Hints',
      '',
      ...connectorHints,
    );
  }

  return blocks.join('\n');
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
      const specializedToolsContext = await buildSpecializedAgentToolsContext({
        normalizedAgentId,
        enabledTools,
        toolsOverride: effectiveConfig.overrideState.tools,
      });
      if (specializedToolsContext) {
        systemPrompt += '\n\n' + specializedToolsContext;
      }

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
