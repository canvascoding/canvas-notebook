import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';

import {
  callMcpTool,
  getMcpRuntimeStatus,
  listConfiguredMcpServers,
  listMcpTools,
  startMcpIdleCleanup,
} from '@/app/lib/mcp/manager';
import { clearMcpOAuth, getMcpOAuthStatus, startMcpOAuth } from '@/app/lib/mcp/oauth';

type McpAction =
  | 'list_servers'
  | 'status'
  | 'list_tools'
  | 'search_tools'
  | 'describe_tool'
  | 'call_tool'
  | 'auth_status'
  | 'auth_start'
  | 'auth_clear';

type McpProxyParams = {
  action: McpAction;
  server?: string;
  query?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
};

const MAX_SEARCH_RESULTS = 20;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP error';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeServerName(value: string | undefined): string {
  return value?.trim() || '';
}

function normalizeToolName(value: string | undefined): string {
  return value?.trim() || '';
}

function formatToolSummary(tool: Tool): string {
  const description = tool.description ? `: ${tool.description}` : '';
  return `- ${tool.name}${description}`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function errorResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    details: isPlainObject(details) ? { error: message, ...details } : { error: message, details },
  };
}

async function handleListServers(): Promise<AgentToolResult<unknown>> {
  const servers = await listConfiguredMcpServers();
  if (servers.length === 0) {
    return textResult('No MCP servers configured.', { servers: [] });
  }

  return textResult(
    ['Configured MCP servers:', ...servers.map((server) => `- ${server.name}: ${server.transport}`)].join('\n'),
    { servers },
  );
}

async function handleStatus(serverName?: string): Promise<AgentToolResult<unknown>> {
  const status = await getMcpRuntimeStatus(serverName);
  if (serverName && status.servers.length === 0) {
    throw new Error(`Unknown MCP server "${serverName}".`);
  }

  return textResult(
    status.servers.length === 0
      ? 'No MCP servers configured.'
      : [
          'MCP runtime status:',
          ...status.servers.map((server) => {
            const state = server.connected ? 'connected' : 'not connected';
            const cache = server.cachedToolCount > 0 ? `, ${server.cachedToolCount} cached tools` : '';
            const error = server.lastError ? `, last error: ${server.lastError}` : '';
            return `- ${server.name}: configured (${server.transport}), ${state}${cache}${error}`;
          }),
        ].join('\n'),
    status,
  );
}

async function handleListTools(serverName: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  const tools = await listMcpTools(serverName, { signal });
  if (tools.length === 0) {
    return textResult(`MCP server "${serverName}" exposes no tools.`, { server: serverName, tools: [] });
  }

  return textResult(
    [`MCP tools for "${serverName}":`, ...tools.map(formatToolSummary)].join('\n'),
    { server: serverName, tools },
  );
}

async function handleSearchTools(query: string, serverName?: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new Error('search_tools requires query.');
  }

  const configuredServers = await listConfiguredMcpServers();
  const serverNames = serverName ? [serverName] : configuredServers.map((server) => server.name);
  const configuredSet = new Set(configuredServers.map((server) => server.name));
  const matches: Array<{ server: string; tool: Tool }> = [];
  const errors: Array<{ server: string; error: string }> = [];

  for (const currentServerName of serverNames) {
    if (!configuredSet.has(currentServerName)) {
      throw new Error(`Unknown MCP server "${currentServerName}".`);
    }
    try {
      const tools = await listMcpTools(currentServerName, { preferCache: true, signal });
      for (const tool of tools) {
        const haystack = `${tool.name}\n${tool.description || ''}`.toLowerCase();
        if (haystack.includes(normalizedQuery)) {
          matches.push({ server: currentServerName, tool });
        }
      }
    } catch (error) {
      errors.push({ server: currentServerName, error: getErrorMessage(error) });
    }
  }

  const visibleMatches = matches.slice(0, MAX_SEARCH_RESULTS);
  const lines = visibleMatches.map(({ server, tool }) => `- ${server}.${formatToolSummary(tool).slice(2)}`);
  if (errors.length > 0) {
    lines.push(...errors.map((error) => `- ${error.server}: Error: ${error.error}`));
  }

  return textResult(
    lines.length > 0 ? [`MCP tool search results for "${query}":`, ...lines].join('\n') : `No MCP tools matched "${query}".`,
    { query, matches: visibleMatches, errors, truncated: matches.length > visibleMatches.length },
  );
}

async function handleDescribeTool(serverName: string, toolName: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  const tools = await listMcpTools(serverName, { preferCache: true, signal });
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Unknown MCP tool "${toolName}" on server "${serverName}".`);
  }

  return textResult(
    [
      `MCP tool "${serverName}.${tool.name}"`,
      tool.description ? `Description: ${tool.description}` : 'Description: n/a',
      '',
      'Input schema:',
      formatJson(tool.inputSchema),
    ].join('\n'),
    { server: serverName, tool },
  );
}

function summarizeMcpContent(result: CallToolResult): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    return formatJson(result);
  }

  const blocks = result.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image ${block.mimeType}]`;
    if (block.type === 'audio') return `[audio ${block.mimeType}]`;
    if (block.type === 'resource') return `[resource ${block.resource.uri}]`;
    if (block.type === 'resource_link') return `[resource link ${block.uri}]`;
    return formatJson(block);
  });

  return blocks.join('\n') || '(empty MCP tool result)';
}

async function handleCallTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  if (!isPlainObject(args)) {
    throw new Error('call_tool arguments must be a JSON object.');
  }

  const result = await callMcpTool(serverName, toolName, args, signal);
  const text = summarizeMcpContent(result);
  return textResult(
    result.isError ? `MCP tool "${serverName}.${toolName}" returned an error:\n${text}` : text,
    { server: serverName, tool: toolName, result },
  );
}

async function handleAuthStatus(serverName: string): Promise<AgentToolResult<unknown>> {
  const status = await getMcpOAuthStatus(serverName);
  return textResult(
    status.authorized
      ? `MCP server "${serverName}" is authorized${status.expiresAt ? ` until ${status.expiresAt}` : ''}.`
      : `MCP server "${serverName}" is not authorized${status.reason ? `: ${status.reason}` : '.'}`,
    status,
  );
}

async function handleAuthStart(serverName: string): Promise<AgentToolResult<unknown>> {
  const started = await startMcpOAuth(serverName);
  return textResult(
    [
      `Open this URL to authorize MCP server "${serverName}":`,
      started.authorizationUrl,
      '',
      `Redirect URI: ${started.redirectUri}`,
    ].join('\n'),
    { server: serverName, ...started },
  );
}

async function handleAuthClear(serverName: string): Promise<AgentToolResult<unknown>> {
  await clearMcpOAuth(serverName);
  return textResult(`OAuth credentials cleared for MCP server "${serverName}".`, { server: serverName, cleared: true });
}

export function createMcpProxyTool(): AgentTool {
  startMcpIdleCleanup();

  return {
    name: 'mcp',
    label: 'Using MCP',
    description:
      'Gateway to configured Model Context Protocol servers. Use search_tools or list_tools to discover MCP tools, describe_tool to inspect schemas, and call_tool to execute a selected MCP tool.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list_servers'),
        Type.Literal('status'),
        Type.Literal('list_tools'),
        Type.Literal('search_tools'),
        Type.Literal('describe_tool'),
        Type.Literal('call_tool'),
        Type.Literal('auth_status'),
        Type.Literal('auth_start'),
        Type.Literal('auth_clear'),
      ], { description: 'MCP proxy action to perform.' }),
      server: Type.Optional(Type.String({ description: 'Configured MCP server name.' })),
      query: Type.Optional(Type.String({ description: 'Search query for search_tools.' })),
      tool: Type.Optional(Type.String({ description: 'MCP tool name for describe_tool or call_tool.' })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'JSON arguments for call_tool.' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params, signal) => {
      const p = params as McpProxyParams;
      try {
        switch (p.action) {
          case 'list_servers':
            return await handleListServers();
          case 'status':
            return await handleStatus(normalizeServerName(p.server) || undefined);
          case 'list_tools': {
            const server = normalizeServerName(p.server);
            if (!server) throw new Error('list_tools requires server.');
            return await handleListTools(server, signal);
          }
          case 'search_tools':
            return await handleSearchTools(p.query || '', normalizeServerName(p.server) || undefined, signal);
          case 'describe_tool': {
            const server = normalizeServerName(p.server);
            const tool = normalizeToolName(p.tool);
            if (!server) throw new Error('describe_tool requires server.');
            if (!tool) throw new Error('describe_tool requires tool.');
            return await handleDescribeTool(server, tool, signal);
          }
          case 'call_tool': {
            const server = normalizeServerName(p.server);
            const tool = normalizeToolName(p.tool);
            if (!server) throw new Error('call_tool requires server.');
            if (!tool) throw new Error('call_tool requires tool.');
            return await handleCallTool(server, tool, p.arguments || {}, signal);
          }
          case 'auth_status': {
            const server = normalizeServerName(p.server);
            if (!server) throw new Error('auth_status requires server.');
            return await handleAuthStatus(server);
          }
          case 'auth_start': {
            const server = normalizeServerName(p.server);
            if (!server) throw new Error('auth_start requires server.');
            return await handleAuthStart(server);
          }
          case 'auth_clear': {
            const server = normalizeServerName(p.server);
            if (!server) throw new Error('auth_clear requires server.');
            return await handleAuthClear(server);
          }
          default:
            return errorResult(`Unsupported MCP action "${String((p as { action?: unknown }).action)}".`);
        }
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  };
}
