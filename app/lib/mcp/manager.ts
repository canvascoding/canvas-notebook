import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { readMcpConfig, resolveMcpConfigPath, type McpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { getValidMcpAccessToken } from '@/app/lib/mcp/oauth';
import { resolveAgentStorageDir } from '@/app/lib/runtime-data-paths';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
const CACHE_FILE = 'mcp-cache.json';

type TransportType = 'stdio' | 'http' | 'unsupported';

type ManagedConnection = {
  key: string;
  serverName: string;
  configHash: string;
  transport: TransportType;
  config: McpServerConfig;
  client?: Client;
  connecting?: Promise<Client>;
  activeCalls: number;
  lastUsedAt: number;
  lastSuccessfulToolListAt?: number;
  lastError?: string;
  processPid?: number | null;
};

type McpCacheFile = {
  version: 1;
  updatedAt: string;
  servers: Record<string, {
    configHash: string;
    tools: Tool[];
    lastRefreshedAt: string;
  }>;
};

type McpManagerStore = {
  entries: Map<string, ManagedConnection>;
  cleanupStarted: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __canvasMcpManagerStore?: McpManagerStore;
};

function getStore(): McpManagerStore {
  if (!globalStore.__canvasMcpManagerStore) {
    globalStore.__canvasMcpManagerStore = {
      entries: new Map(),
      cleanupStarted: false,
    };
  }
  return globalStore.__canvasMcpManagerStore;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP error';
}

function logMcp(level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown> = {}): void {
  const payload = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
  console[level](`[MCP] ${message}${payload}`);
}

function summarizeCommand(config: McpServerConfig): { command?: string; args?: string[]; cwd?: string } {
  return {
    command: config.command,
    args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
    cwd: typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd : undefined,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashMcpServerConfig(config: McpServerConfig): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex');
}

export function getServerTransport(config: McpServerConfig): TransportType {
  if (typeof config.command === 'string' && config.command.trim()) return 'stdio';
  if (typeof config.url === 'string' && config.url.trim()) return 'http';
  return 'unsupported';
}

function getEntryKey(serverName: string, configHash: string): string {
  return `${serverName}:${configHash}`;
}

function getTimeoutMs(config: McpServerConfig): number {
  return typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.trunc(config.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
}

function getIdleTimeoutMs(config: McpConfig): number {
  const minutes = typeof config.settings?.idleTimeout === 'number' && Number.isFinite(config.settings.idleTimeout)
    ? config.settings.idleTimeout
    : DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.max(0, minutes) * 60_000;
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
    if (entry.key && entry.value !== undefined) env[entry.key] = entry.value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && env[key] === undefined) env[key] = value;
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
  if (!config.env) return undefined;
  const availableEnv = await readAvailableEnv();
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value === 'string') {
      resolved[key] = expandEnvValue(value, availableEnv, missing);
    }
  }
  if (missing.size > 0) {
    throw new Error(`Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=integrations.`);
  }
  return resolved;
}

async function createClient(entry: ManagedConnection, signal?: AbortSignal): Promise<Client> {
  const client = new Client({ name: 'canvas-notebook-mcp-proxy', version: '1.0.0' });
  const timeoutMs = getTimeoutMs(entry.config);

  if (entry.transport === 'stdio') {
    const command = entry.config.command?.trim();
    if (!command) throw new Error(`MCP server "${entry.serverName}" is missing command.`);
    logMcp('info', 'Starting stdio server', {
      server: entry.serverName,
      timeoutMs,
      ...summarizeCommand(entry.config),
    });
    const transport = new StdioClientTransport({
      command,
      args: Array.isArray(entry.config.args) ? entry.config.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: await resolveServerEnv(entry.config),
      cwd: typeof entry.config.cwd === 'string' && entry.config.cwd.trim() ? entry.config.cwd : undefined,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const trimmed = text.trim();
      if (trimmed) {
        logMcp('warn', 'Server stderr', { server: entry.serverName, pid: transport.pid, message: trimmed });
      }
    });
    await withTimeout(client.connect(transport), timeoutMs, signal);
    entry.processPid = transport.pid;
    logMcp('info', 'Connected stdio server', { server: entry.serverName, pid: transport.pid });
    return client;
  }

  if (entry.transport === 'http') {
    const url = entry.config.url?.trim();
    if (!url) throw new Error(`MCP server "${entry.serverName}" is missing url.`);
    logMcp('info', 'Connecting HTTP server', { server: entry.serverName, url, timeoutMs });
    const accessToken = await getValidMcpAccessToken(entry.serverName, entry.config, entry.configHash);
    await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(url), accessToken ? {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    } : undefined)), timeoutMs, signal);
    logMcp('info', 'Connected HTTP server', { server: entry.serverName, url, authenticated: Boolean(accessToken) });
    return client;
  }

  throw new Error(`MCP server "${entry.serverName}" must define a stdio command or unauthenticated HTTP url.`);
}

async function getManagedConnection(serverName: string, signal?: AbortSignal): Promise<ManagedConnection> {
  const config = await readMcpConfig();
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) throw new Error(`Unknown MCP server "${serverName}".`);

  const configHash = hashMcpServerConfig(serverConfig);
  const key = getEntryKey(serverName, configHash);
  const store = getStore();
  let entry = store.entries.get(key);

  if (!entry) {
    entry = {
      key,
      serverName,
      configHash,
      transport: getServerTransport(serverConfig),
      config: serverConfig,
      activeCalls: 0,
      lastUsedAt: Date.now(),
    };
    store.entries.set(key, entry);
    logMcp('info', 'Registered server config', { server: serverName, transport: entry.transport, configHash });
  }

  entry.lastUsedAt = Date.now();
  if (!entry.client) {
    entry.connecting ??= createClient(entry, signal)
      .then((client) => {
        entry.client = client;
        entry.lastError = undefined;
        return client;
      })
      .catch((error) => {
        entry.lastError = getErrorMessage(error);
        logMcp('error', 'Connection failed', {
          server: entry.serverName,
          transport: entry.transport,
          error: entry.lastError,
        });
        throw error;
      })
      .finally(() => {
        entry.connecting = undefined;
      });
    await entry.connecting;
  }

  return entry;
}

async function withManagedConnection<T>(
  serverName: string,
  fn: (entry: ManagedConnection, client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const entry = await getManagedConnection(serverName, signal);
  if (!entry.client) throw new Error(`MCP server "${serverName}" is not connected.`);

  entry.activeCalls += 1;
  entry.lastUsedAt = Date.now();
  try {
    const result = await fn(entry, entry.client);
    entry.lastError = undefined;
    return result;
  } catch (error) {
    entry.lastError = getErrorMessage(error);
    throw error;
  } finally {
    entry.activeCalls = Math.max(0, entry.activeCalls - 1);
    entry.lastUsedAt = Date.now();
  }
}

function resolveCachePath(): string {
  return path.join(resolveAgentStorageDir(), CACHE_FILE);
}

async function readCache(): Promise<McpCacheFile> {
  const cachePath = resolveCachePath();
  try {
    return JSON.parse(await fs.readFile(cachePath, 'utf8')) as McpCacheFile;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
  }
}

async function writeCache(cache: McpCacheFile): Promise<void> {
  const cachePath = resolveCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, cachePath);
  await fs.chmod(cachePath, 0o600).catch(() => undefined);
}

export async function readCachedTools(serverName: string, configHash: string): Promise<Tool[] | null> {
  const cache = await readCache();
  const entry = cache.servers[serverName];
  return entry?.configHash === configHash ? entry.tools : null;
}

async function writeCachedTools(serverName: string, configHash: string, tools: Tool[]): Promise<void> {
  const cache = await readCache();
  cache.version = 1;
  cache.updatedAt = new Date().toISOString();
  cache.servers[serverName] = {
    configHash,
    tools,
    lastRefreshedAt: new Date().toISOString(),
  };
  await writeCache(cache);
}

export async function listConfiguredMcpServers() {
  const config = await readMcpConfig();
  return Object.entries(config.mcpServers).map(([name, serverConfig]) => ({
    name,
    transport: getServerTransport(serverConfig),
    configHash: hashMcpServerConfig(serverConfig),
    configured: true,
  }));
}

export async function listMcpTools(serverName: string, options: { preferCache?: boolean; signal?: AbortSignal } = {}): Promise<Tool[]> {
  const config = await readMcpConfig();
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) throw new Error(`Unknown MCP server "${serverName}".`);
  const configHash = hashMcpServerConfig(serverConfig);

  if (options.preferCache) {
    const cached = await readCachedTools(serverName, configHash);
    if (cached) return cached;
  }

  return withManagedConnection(serverName, async (entry, client) => {
    logMcp('info', 'Listing tools', { server: serverName });
    const result = await withTimeout(client.listTools(), getTimeoutMs(entry.config), options.signal);
    entry.lastSuccessfulToolListAt = Date.now();
    await writeCachedTools(serverName, entry.configHash, result.tools);
    logMcp('info', 'Listed tools', { server: serverName, count: result.tools.length });
    return result.tools;
  }, options.signal);
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  return withManagedConnection(serverName, async (entry, client) => {
    logMcp('info', 'Calling tool', { server: serverName, tool: toolName });
    const result = await withTimeout(client.callTool({ name: toolName, arguments: args }), getTimeoutMs(entry.config), signal) as CallToolResult;
    logMcp(result.isError ? 'warn' : 'info', 'Tool call finished', { server: serverName, tool: toolName, isError: Boolean(result.isError) });
    return result;
  }, signal);
}

export async function cleanupIdleMcpServers(now = Date.now()): Promise<number> {
  const config = await readMcpConfig();
  const idleTimeoutMs = getIdleTimeoutMs(config);
  const store = getStore();
  let closed = 0;

  for (const [key, entry] of store.entries) {
    if (!entry.client || entry.activeCalls > 0) continue;
    if (idleTimeoutMs > 0 && now - entry.lastUsedAt < idleTimeoutMs) continue;
    logMcp('info', 'Closing idle server', { server: entry.serverName, transport: entry.transport, pid: entry.processPid });
    await entry.client.close().catch(() => undefined);
    entry.client = undefined;
    entry.processPid = undefined;
    store.entries.delete(key);
    closed += 1;
  }

  return closed;
}

export async function closeAllMcpServers(): Promise<void> {
  const store = getStore();
  for (const entry of store.entries.values()) {
    logMcp('info', 'Closing server', { server: entry.serverName, transport: entry.transport, pid: entry.processPid });
    await entry.client?.close().catch(() => undefined);
  }
  store.entries.clear();
}

export function startMcpIdleCleanup(): void {
  const store = getStore();
  if (store.cleanupStarted) return;
  store.cleanupStarted = true;
  setInterval(() => {
    void cleanupIdleMcpServers().catch(() => undefined);
  }, 60_000).unref?.();
}

export async function getMcpRuntimeStatus(serverName?: string) {
  const config = await readMcpConfig();
  const cache = await readCache();
  const store = getStore();
  const entries = Object.entries(config.mcpServers)
    .filter(([name]) => !serverName || name === serverName)
    .map(([name, serverConfig]) => {
      const configHash = hashMcpServerConfig(serverConfig);
      const managed = store.entries.get(getEntryKey(name, configHash));
      const cached = cache.servers[name]?.configHash === configHash ? cache.servers[name] : undefined;
      return {
        name,
        transport: getServerTransport(serverConfig),
        configHash,
        connected: Boolean(managed?.client),
        activeCalls: managed?.activeCalls || 0,
        lastUsedAt: managed?.lastUsedAt ? new Date(managed.lastUsedAt).toISOString() : null,
        lastSuccessfulToolListAt: managed?.lastSuccessfulToolListAt ? new Date(managed.lastSuccessfulToolListAt).toISOString() : null,
        lastError: managed?.lastError || null,
        cachedToolCount: cached?.tools.length || 0,
        cacheRefreshedAt: cached?.lastRefreshedAt || null,
      };
    });

  return {
    configPath: resolveMcpConfigPath(),
    cachePath: resolveCachePath(),
    servers: entries,
  };
}
