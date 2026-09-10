import crypto from 'node:crypto';
import { requireMcpUserAccess } from './access';
import type { Tool } from '@modelcontextprotocol/client';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { callMcpToolWithCurrentMetadata, listMcpTools, readCachedTools, hashMcpServerConfig } from '@/app/lib/mcp/manager';
import { prepareMcpToolInvocation } from '@/app/lib/mcp/tool-result';
import { filterMcpToolsForModel } from '@/app/lib/mcp/apps-metadata';
import { mcpReconnectDetails } from '@/app/lib/mcp/connection-health';
import { isMcpServerEnabled, readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import type { McpScope } from '@/app/lib/mcp/scope';

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

export function createDirectMcpToolName(serverName: string, toolName: string, connectionId?: string): string {
  if (connectionId) return `mcp_${connectionId.replace(/-/gu, '')}_${sanitizeToolSegment(toolName).slice(0, 17)}_${crypto.createHash('sha256').update(toolName).digest('hex').slice(0, 8)}`;
  const server = sanitizeToolSegment(serverName);
  const tool = sanitizeToolSegment(toolName);
  return `mcp_${server}_${tool}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP direct tool error';
}

function makeDirectTool(serverName: string, tool: Tool, directName: string, scope?: McpScope | null, connection?: McpServerConfig): AgentTool {
  const identity = connection?.connectionId || serverName;
  return {
    name: directName,
    label: `MCP ${connection?.displayName || serverName}.${tool.name}`,
    description: tool.description || `Direct MCP tool ${tool.name} from server ${serverName}.`,
    parameters: tool.inputSchema as AgentTool['parameters'],
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
      try {
        const invocation = await callMcpToolWithCurrentMetadata(identity, tool.name, params as Record<string, unknown>, signal, scope);
        return await prepareMcpToolInvocation(serverName, tool.name, invocation, params as Record<string, unknown>, _toolCallId);
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message, server: serverName, tool: tool.name, ...await mcpReconnectDetails(identity, scope, error).catch(() => ({})) },
        };
      }
    },
  };
}

export async function buildDirectMcpTools(scope?: McpScope | null, options: { cacheOnly?: boolean } = {}): Promise<DirectMcpToolBuildResult> {
  await requireMcpUserAccess(scope);
  const config = await readMcpConfig(scope);
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
      if (options.cacheOnly) {
        const cached = await readCachedTools(serverName, hashMcpServerConfig(serverConfig), scope);
        if (!cached) {
          warnings.push({ server: serverName, message: 'Test this connection to load its tools.' });
          continue;
        }
        remoteTools = filterMcpToolsForModel(cached);
      } else {
        remoteTools = filterMcpToolsForModel(await listMcpTools(serverName, { preferCache: true, scope }));
      }
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

      const directName = createDirectMcpToolName(serverName, remoteTool.name, serverConfig.connectionId);
      if (!/^mcp_[A-Za-z0-9_]+$/u.test(directName)) {
        warnings.push({ server: serverName, tool: remoteTool.name, message: `Invalid generated direct MCP tool name: ${directName}` });
        continue;
      }
      if (usedNames.has(directName)) {
        warnings.push({ server: serverName, tool: remoteTool.name, message: `Direct MCP tool name collision: ${directName}` });
        continue;
      }

      usedNames.add(directName);
      tools.push(makeDirectTool(serverName, remoteTool, directName, scope, serverConfig));
    }
  }

  return { tools, warnings };
}
