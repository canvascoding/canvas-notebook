import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { callMcpTool, listMcpTools } from '@/app/lib/mcp/manager';
import { isMcpServerEnabled, readMcpConfig } from '@/app/lib/mcp/config';

export type DirectMcpToolWarning = {
  server: string;
  tool?: string;
  message: string;
};

export type DirectMcpToolBuildResult = {
  tools: AgentTool[];
  warnings: DirectMcpToolWarning[];
};

function sanitizeToolSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function createDirectMcpToolName(serverName: string, toolName: string): string {
  const server = sanitizeToolSegment(serverName);
  const tool = sanitizeToolSegment(toolName);
  return `mcp_${server}_${tool}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP direct tool error';
}

function summarizeContent(result: Awaited<ReturnType<typeof callMcpTool>>): string {
  if (!Array.isArray(result.content)) {
    return JSON.stringify(result, null, 2);
  }
  return result.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image ${block.mimeType}]`;
    if (block.type === 'audio') return `[audio ${block.mimeType}]`;
    if (block.type === 'resource') return `[resource ${block.resource.uri}]`;
    if (block.type === 'resource_link') return `[resource link ${block.uri}]`;
    return JSON.stringify(block);
  }).join('\n') || '(empty MCP tool result)';
}

function makeDirectTool(serverName: string, tool: Tool, directName: string): AgentTool {
  return {
    name: directName,
    label: `MCP ${serverName}.${tool.name}`,
    description: tool.description || `Direct MCP tool ${tool.name} from server ${serverName}.`,
    parameters: tool.inputSchema as AgentTool['parameters'],
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
      try {
        const result = await callMcpTool(serverName, tool.name, params as Record<string, unknown>, signal);
        return {
          content: [{ type: 'text', text: summarizeContent(result) }],
          details: { server: serverName, tool: tool.name, result },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message, server: serverName, tool: tool.name },
        };
      }
    },
  };
}

export async function buildDirectMcpTools(): Promise<DirectMcpToolBuildResult> {
  const config = await readMcpConfig();
  const tools: AgentTool[] = [];
  const warnings: DirectMcpToolWarning[] = [];
  const usedNames = new Set<string>();

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (!isMcpServerEnabled(serverConfig)) continue;
    const directTools = Array.isArray(serverConfig.directTools)
      ? serverConfig.directTools.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (directTools.length === 0) continue;

    let remoteTools: Tool[];
    try {
      remoteTools = await listMcpTools(serverName, { preferCache: true });
    } catch (error) {
      warnings.push({ server: serverName, message: `Could not load direct MCP tools: ${getErrorMessage(error)}` });
      continue;
    }

    for (const remoteToolName of directTools) {
      const remoteTool = remoteTools.find((candidate) => candidate.name === remoteToolName);
      if (!remoteTool) {
        warnings.push({ server: serverName, tool: remoteToolName, message: 'Configured direct MCP tool was not found on the server.' });
        continue;
      }

      const directName = createDirectMcpToolName(serverName, remoteTool.name);
      if (!/^mcp_[A-Za-z0-9_]+$/u.test(directName)) {
        warnings.push({ server: serverName, tool: remoteTool.name, message: `Invalid generated direct MCP tool name: ${directName}` });
        continue;
      }
      if (usedNames.has(directName)) {
        warnings.push({ server: serverName, tool: remoteTool.name, message: `Direct MCP tool name collision: ${directName}` });
        continue;
      }

      usedNames.add(directName);
      tools.push(makeDirectTool(serverName, remoteTool, directName));
    }
  }

  return { tools, warnings };
}
