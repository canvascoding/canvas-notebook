import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';

import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';

type McpAction =
  | 'list_servers'
  | 'status'
  | 'list_tools'
  | 'search_tools'
  | 'describe_tool'
  | 'call_tool';

type McpProxyParams = {
  action: McpAction;
  server?: string;
  query?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
};

type McpServerRuntime = {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  close: () => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 20_000;
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

function getServerTransport(config: McpServerConfig): 'stdio' | 'http' | 'unsupported' {
  if (typeof config.command === 'string' && config.command.trim()) {
    return 'stdio';
  }
  if (typeof config.url === 'string' && config.url.trim()) {
    return 'http';
  }
  if (config.transport === 'stdio' || config.transport === 'http') {
    return 'unsupported';
  }
  return 'unsupported';
}

function formatToolSummary(tool: Tool): string {
  const description = tool.description ? `: ${tool.description}` : '';
  return `- ${tool.name}${description}`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error('MCP operation aborted.'));
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP operation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('MCP operation aborted.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function readAvailableEnv(): Promise<Record<string, string>> {
  const [integrations, agents] = await Promise.all([
    readScopedEnvState('integrations'),
    readScopedEnvState('agents'),
  ]);

  const env: Record<string, string> = {};
  for (const entry of [...integrations.entries, ...agents.entries]) {
    if (entry.key && entry.value !== undefined) {
      env[entry.key] = entry.value;
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && env[key] === undefined) {
      env[key] = value;
    }
  }

  return env;
}

function expandEnvValue(value: string, availableEnv: Record<string, string>, missing: Set<string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const replacement = availableEnv[key];
    if (replacement === undefined) {
      missing.add(key);
      return '';
    }
    return replacement;
  });
}

async function resolveServerEnv(config: McpServerConfig): Promise<Record<string, string> | undefined> {
  if (!config.env) {
    return undefined;
  }

  const availableEnv = await readAvailableEnv();
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== 'string') {
      continue;
    }
    resolved[key] = expandEnvValue(value, availableEnv, missing);
  }

  if (missing.size > 0) {
    throw new Error(
      `Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=integrations.`,
    );
  }

  return resolved;
}

async function connectServer(
  serverName: string,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<McpServerRuntime> {
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.trunc(config.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: 'canvas-notebook-mcp-proxy', version: '1.0.0' });
  const transportType = getServerTransport(config);

  if (transportType === 'stdio') {
    const command = config.command?.trim();
    if (!command) {
      throw new Error(`MCP server "${serverName}" is missing command.`);
    }

    const transport = new StdioClientTransport({
      command,
      args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: await resolveServerEnv(config),
      cwd: typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd : undefined,
      stderr: 'pipe',
    });
    await withTimeout(client.connect(transport), timeoutMs, signal);
    return {
      serverName,
      config,
      client,
      close: () => client.close(),
    };
  }

  if (transportType === 'http') {
    const url = config.url?.trim();
    if (!url) {
      throw new Error(`MCP server "${serverName}" is missing url.`);
    }

    const transport = new StreamableHTTPClientTransport(new URL(url));
    await withTimeout(client.connect(transport), timeoutMs, signal);
    return {
      serverName,
      config,
      client,
      close: () => client.close(),
    };
  }

  throw new Error(`MCP server "${serverName}" must define a stdio command or unauthenticated HTTP url.`);
}

async function withServer<T>(
  serverName: string,
  fn: (runtime: McpServerRuntime) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const config = await readMcpConfig();
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) {
    throw new Error(`Unknown MCP server "${serverName}".`);
  }

  const runtime = await connectServer(serverName, serverConfig, signal);
  try {
    return await fn(runtime);
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

async function listToolsForServer(serverName: string, signal?: AbortSignal): Promise<Tool[]> {
  return withServer(serverName, async (runtime) => {
    const timeoutMs = typeof runtime.config.timeoutMs === 'number' ? Math.max(1000, Math.trunc(runtime.config.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    const result = await withTimeout(runtime.client.listTools(), timeoutMs, signal);
    return result.tools;
  }, signal);
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
  const config = await readMcpConfig();
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    return textResult('No MCP servers configured.', { servers: [] });
  }

  const servers = entries.map(([name, serverConfig]) => ({
    name,
    transport: getServerTransport(serverConfig),
    configured: true,
  }));

  return textResult(
    ['Configured MCP servers:', ...servers.map((server) => `- ${server.name}: ${server.transport}`)].join('\n'),
    { servers },
  );
}

async function handleStatus(serverName?: string): Promise<AgentToolResult<unknown>> {
  const config = await readMcpConfig();
  const entries = Object.entries(config.mcpServers).filter(([name]) => !serverName || name === serverName);
  if (serverName && entries.length === 0) {
    throw new Error(`Unknown MCP server "${serverName}".`);
  }

  const servers = entries.map(([name, serverConfig]) => ({
    name,
    transport: getServerTransport(serverConfig),
    configured: true,
    connected: false,
  }));

  return textResult(
    servers.length === 0
      ? 'No MCP servers configured.'
      : ['MCP runtime status:', ...servers.map((server) => `- ${server.name}: configured (${server.transport}), not connected`)].join('\n'),
    { servers, configPath: '/data/canvas-agent/mcp.json' },
  );
}

async function handleListTools(serverName: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  const tools = await listToolsForServer(serverName, signal);
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

  const config = await readMcpConfig();
  const serverNames = serverName ? [serverName] : Object.keys(config.mcpServers);
  const matches: Array<{ server: string; tool: Tool }> = [];
  const errors: Array<{ server: string; error: string }> = [];

  for (const currentServerName of serverNames) {
    if (!config.mcpServers[currentServerName]) {
      throw new Error(`Unknown MCP server "${currentServerName}".`);
    }
    try {
      const tools = await listToolsForServer(currentServerName, signal);
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
  const tools = await listToolsForServer(serverName, signal);
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
    if (block.type === 'text') {
      return block.text;
    }
    if (block.type === 'image') {
      return `[image ${block.mimeType}]`;
    }
    if (block.type === 'audio') {
      return `[audio ${block.mimeType}]`;
    }
    if (block.type === 'resource') {
      return `[resource ${block.resource.uri}]`;
    }
    if (block.type === 'resource_link') {
      return `[resource link ${block.uri}]`;
    }
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

  return withServer(serverName, async (runtime) => {
    const timeoutMs = typeof runtime.config.timeoutMs === 'number' ? Math.max(1000, Math.trunc(runtime.config.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    const result = await withTimeout(
      runtime.client.callTool({ name: toolName, arguments: args }),
      timeoutMs,
      signal,
    ) as CallToolResult;
    const text = summarizeMcpContent(result);
    return textResult(
      result.isError ? `MCP tool "${serverName}.${toolName}" returned an error:\n${text}` : text,
      { server: serverName, tool: toolName, result },
    );
  }, signal);
}

export function createMcpProxyTool(): AgentTool {
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
          default:
            return errorResult(`Unsupported MCP action "${String((p as { action?: unknown }).action)}".`);
        }
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  };
}
