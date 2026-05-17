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
  [key: string]: unknown;
};

const MAX_SEARCH_RESULTS = 20;
const PROXY_PARAM_KEYS = new Set(['action', 'server', 'query', 'tool', 'arguments']);

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

function resolveMcpTarget(serverValue: string | undefined, toolValue: string | undefined) {
  const server = normalizeServerName(serverValue);
  const tool = normalizeToolName(toolValue);
  const separatorIndex = tool.indexOf('.');

  if (separatorIndex > 0) {
    const qualifiedServer = tool.slice(0, separatorIndex).trim();
    const qualifiedTool = tool.slice(separatorIndex + 1).trim();
    if (server && server !== qualifiedServer) {
      throw new Error(`MCP tool "${tool}" belongs to server "${qualifiedServer}", but server "${server}" was provided.`);
    }
    return { server: server || qualifiedServer, tool: qualifiedTool };
  }

  return { server, tool };
}

function formatToolListItem(serverName: string, tool: Tool): string {
  return [
    `- Tool: \`${serverName}.${tool.name}\``,
    `  Name: \`${tool.name}\``,
    `  Description: ${tool.description || 'n/a'}`,
  ].join('\n');
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
    [
      `MCP tools for "${serverName}":`,
      ...tools.map((tool) => formatToolListItem(serverName, tool)),
      '',
      `Use describe_tool with a listed Tool value like \`${serverName}.tool-name\` to inspect input fields. Then call_tool with that Tool value and arguments { ... }.`,
    ].join('\n'),
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
  const lines = visibleMatches.map(({ server, tool }) => formatToolListItem(server, tool));
  if (errors.length > 0) {
    lines.push(...errors.map((error) => `- ${error.server}: Error: ${error.error}`));
  }

  return textResult(
    lines.length > 0
      ? [
          `MCP tool search results for "${query}":`,
          ...lines,
          '',
          'Next step: use describe_tool with the exact Tool value, for example { "action": "describe_tool", "tool": "Canva.generate-design" }. To execute it, use call_tool with the same Tool value and put inputs inside "arguments".',
        ].join('\n')
      : `No MCP tools matched "${query}".`,
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

function buildCallArguments(params: McpProxyParams): Record<string, unknown> {
  const explicitArgs = params.arguments;
  if (explicitArgs !== undefined && !isPlainObject(explicitArgs)) {
    throw new Error('call_tool arguments must be a JSON object.');
  }

  const passthroughArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!PROXY_PARAM_KEYS.has(key)) {
      passthroughArgs[key] = value;
    }
  }

  if (params.query !== undefined) {
    passthroughArgs.query = params.query;
  }

  return { ...passthroughArgs, ...(explicitArgs || {}) };
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
      'Gateway to configured Model Context Protocol servers. Use search_tools or list_tools to discover tools, describe_tool to inspect input schemas, and call_tool to execute a selected tool. Tools may be addressed as "Server.tool" (for example "Canva.generate-design"). For call_tool, put MCP tool inputs inside the "arguments" object; top-level inputs such as "query" are also forwarded for compatibility.',
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
      server: Type.Optional(Type.String({ description: 'Configured MCP server name. Optional when tool is fully-qualified as "Server.tool".' })),
      query: Type.Optional(Type.String({ description: 'Search query for search_tools. For call_tool, this is forwarded as a tool argument named "query".' })),
      tool: Type.Optional(Type.String({ description: 'MCP tool name for describe_tool or call_tool. Can be plain ("generate-design") with server, or fully-qualified ("Canva.generate-design").' })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Preferred JSON arguments for call_tool, exactly matching the MCP tool input schema returned by describe_tool.' })),
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
            const { server, tool } = resolveMcpTarget(p.server, p.tool);
            if (!server) throw new Error('describe_tool requires server, or use a fully-qualified tool like "Canva.generate-design".');
            if (!tool) throw new Error('describe_tool requires tool.');
            return await handleDescribeTool(server, tool, signal);
          }
          case 'call_tool': {
            const { server, tool } = resolveMcpTarget(p.server, p.tool);
            if (!server) throw new Error('call_tool requires server, or use a fully-qualified tool like "Canva.generate-design".');
            if (!tool) throw new Error('call_tool requires tool.');
            return await handleCallTool(server, tool, buildCallArguments(p), signal);
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
