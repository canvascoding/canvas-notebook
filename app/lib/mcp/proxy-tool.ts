import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
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
const MIN_STRONG_SEARCH_SCORE = 6;
const SYNONYM_GROUPS = [
  ['create', 'creates', 'creating', 'generate', 'generates', 'generation', 'generating', 'make', 'build', 'draft', 'write', 'produce', 'erstellen', 'generieren'],
  ['search', 'find', 'lookup', 'list', 'browse', 'discover', 'suchen', 'finden', 'auflisten'],
  ['edit', 'update', 'change', 'modify', 'fix', 'translate', 'bearbeiten', 'aendern', 'aktualisieren'],
  ['delete', 'remove', 'clear', 'loeschen', 'entfernen'],
  ['image', 'picture', 'photo', 'asset', 'media', 'bild', 'foto'],
  ['document', 'doc', 'text', 'memo', 'report', 'dokument', 'bericht'],
  ['presentation', 'slides', 'deck', 'praesentation', 'folien'],
  ['poster', 'post', 'social', 'flyer', 'design', 'graphic', 'grafik', 'plakat', 'beitrag'],
];
const SYNONYMS = new Map(SYNONYM_GROUPS.flatMap((group) => group.map((token) => [token, group] as const)));

type SearchMatch = {
  server: string;
  tool: Tool;
  score: number;
  reasons: string[];
};

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

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function tokenizeSearchText(value: string): string[] {
  const seen = new Set<string>();
  const tokens = normalizeSearchText(value)
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  return tokens.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

function expandSearchTokens(tokens: string[]): string[] {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    for (const synonym of SYNONYMS.get(token) || []) {
      expanded.add(synonym);
    }
  }
  return Array.from(expanded);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function tokensContainFuzzy(tokens: Set<string>, queryToken: string): boolean {
  if (queryToken.length < 4) return false;
  for (const token of tokens) {
    if (token.length >= 4 && editDistance(token, queryToken) <= 1) {
      return true;
    }
  }
  return false;
}

function scoreMcpToolSearch(serverName: string, tool: Tool, queryTokens: string[]): SearchMatch | null {
  const expandedQueryTokens = expandSearchTokens(queryTokens);
  const serverTokens = new Set(tokenizeSearchText(serverName));
  const toolTokens = new Set(tokenizeSearchText(tool.name));
  const descriptionTokens = new Set(tokenizeSearchText(tool.description || ''));
  const fullName = normalizeSearchText(`${serverName}.${tool.name}`);
  const reasons = new Set<string>();
  let score = 0;
  let matchedOriginalTokens = 0;

  for (const token of expandedQueryTokens) {
    if (fullName === token || fullName.includes(token)) {
      score += 14;
      reasons.add(`matched tool id "${token}"`);
    }
    if (serverTokens.has(token)) {
      score += 8;
      reasons.add(`matched server "${token}"`);
    }
    if (toolTokens.has(token)) {
      score += 10;
      reasons.add(`matched tool name "${token}"`);
    } else if (tokensContainFuzzy(toolTokens, token)) {
      score += 6;
      reasons.add(`near tool-name match "${token}"`);
    }
    if (descriptionTokens.has(token)) {
      score += 3;
      reasons.add(`matched description "${token}"`);
    } else if (tokensContainFuzzy(descriptionTokens, token)) {
      score += 1;
      reasons.add(`near description match "${token}"`);
    }
  }

  for (const token of queryTokens) {
    if (serverTokens.has(token) || toolTokens.has(token) || descriptionTokens.has(token)) {
      matchedOriginalTokens += 1;
    }
  }
  if (matchedOriginalTokens > 1) {
    score += matchedOriginalTokens * 2;
    reasons.add(`matched ${matchedOriginalTokens} query terms`);
  }

  return score > 0 ? { server: serverName, tool, score, reasons: Array.from(reasons).slice(0, 4) } : null;
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

function formatToolSearchItem(match: SearchMatch): string {
  return [
    formatToolListItem(match.server, match.tool),
    `  Match: score ${match.score}${match.reasons.length > 0 ? ` (${match.reasons.join('; ')})` : ''}`,
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
  const queryTokens = tokenizeSearchText(query);
  if (queryTokens.length === 0) {
    throw new Error('search_tools requires query.');
  }

  const configuredServers = await listConfiguredMcpServers();
  const normalizedServerName = normalizeSearchText(serverName || '');
  const exactServer = configuredServers.find((server) => normalizeSearchText(server.name) === normalizedServerName);
  const serverNames = exactServer
    ? [exactServer.name]
    : configuredServers.map((server) => server.name);
  const serverWarning = serverName && !exactServer
    ? `Server "${serverName}" was not found exactly. Searching all configured servers instead.`
    : null;
  const matches: SearchMatch[] = [];
  const errors: Array<{ server: string; error: string }> = [];

  for (const currentServerName of serverNames) {
    try {
      const tools = await listMcpTools(currentServerName, { preferCache: true, signal });
      for (const tool of tools) {
        const match = scoreMcpToolSearch(currentServerName, tool, queryTokens);
        if (match) {
          matches.push(match);
        }
      }
    } catch (error) {
      errors.push({ server: currentServerName, error: getErrorMessage(error) });
    }
  }

  matches.sort((a, b) => b.score - a.score || `${a.server}.${a.tool.name}`.localeCompare(`${b.server}.${b.tool.name}`));
  const strongMatches = matches.filter((match) => match.score >= MIN_STRONG_SEARCH_SCORE);
  const visibleMatches = (strongMatches.length > 0 ? strongMatches : matches).slice(0, MAX_SEARCH_RESULTS);
  const lines = visibleMatches.map(formatToolSearchItem);
  if (errors.length > 0) {
    lines.push(...errors.map((error) => `- ${error.server}: Error: ${error.error}`));
  }

  const header = strongMatches.length > 0
    ? `Top MCP tool matches for "${query}":`
    : matches.length > 0
      ? `No strong MCP tool matches for "${query}". Closest candidates:`
      : `No MCP tools matched "${query}".`;

  return textResult(
    lines.length > 0
      ? [
          header,
          ...(serverWarning ? [serverWarning] : []),
          ...lines,
          '',
          'Next step: use describe_tool with the exact Tool value, for example { "action": "describe_tool", "tool": "Canva.generate-design" }. To execute it, use call_tool with the same Tool value and put inputs inside "arguments".',
        ].join('\n')
      : [
          header,
          ...(serverWarning ? [serverWarning] : []),
          ...errors.map((error) => `- ${error.server}: Error: ${error.error}`),
        ].join('\n'),
    {
      query,
      queryTokens,
      matches: visibleMatches,
      errors,
      truncated: matches.length > visibleMatches.length,
      searchedServers: serverNames,
      serverWarning,
    },
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
  if (!status.requiresAuth) {
    return textResult(`MCP server "${serverName}" does not require OAuth authorization.`, status);
  }
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
