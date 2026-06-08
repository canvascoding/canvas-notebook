import {
  readSettingsTextFileIfExists,
  resolveSettingsStoragePath,
  writeSettingsTextFileAtomic,
} from '@/app/lib/settings-storage';

export const MCP_CONFIG_FILE = 'mcp.json';
export const DEFAULT_MCP_CONFIG = {
  settings: {
    toolPrefix: 'server',
    idleTimeout: 10,
  },
  mcpServers: {},
} as const;

export interface McpConfigState {
  path: string;
  exists: boolean;
  rawContent: string;
}

export type McpServerConfig = {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envPassthrough?: string[];
  cwd?: string;
  url?: string;
  iconUrl?: string;
  auth?: 'oauth' | 'none' | string;
  bearerTokenEnv?: string;
  headers?: Record<string, string>;
  headersFromEnv?: Record<string, string>;
  transport?: string;
  timeoutMs?: number;
  [key: string]: unknown;
};

export type McpConfig = {
  settings?: {
    toolPrefix?: string;
    idleTimeout?: number;
    [key: string]: unknown;
  };
  mcpServers: Record<string, McpServerConfig>;
  [key: string]: unknown;
};

export class McpConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigValidationError';
  }
}

export function isMcpServerEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

export function resolveMcpConfigPath(): string {
  return resolveSettingsStoragePath(MCP_CONFIG_FILE);
}

function formatDefaultConfig(): string {
  return `${JSON.stringify(DEFAULT_MCP_CONFIG, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseAndValidateMcpConfig(rawContent: string): McpConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new McpConfigValidationError('MCP config must be valid JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw new McpConfigValidationError('MCP config must be a JSON object.');
  }

  const settings = parsed.settings;
  if (settings !== undefined) {
    if (!isPlainObject(settings)) {
      throw new McpConfigValidationError('MCP config field "settings" must be an object.');
    }
    if (settings.toolPrefix !== undefined && typeof settings.toolPrefix !== 'string') {
      throw new McpConfigValidationError('MCP config field "settings.toolPrefix" must be a string.');
    }
    if (
      settings.idleTimeout !== undefined &&
      (typeof settings.idleTimeout !== 'number' || !Number.isFinite(settings.idleTimeout) || settings.idleTimeout < 0)
    ) {
      throw new McpConfigValidationError('MCP config field "settings.idleTimeout" must be a non-negative number.');
    }
  }

  if (!isPlainObject(parsed.mcpServers)) {
    throw new McpConfigValidationError('MCP config field "mcpServers" must be an object.');
  }

  for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
    if (!serverName.trim()) {
      throw new McpConfigValidationError('MCP server names must be non-empty strings.');
    }
    if (!isPlainObject(serverConfig)) {
      throw new McpConfigValidationError(`MCP server "${serverName}" must be an object.`);
    }
    if ('enabled' in serverConfig && typeof serverConfig.enabled !== 'boolean') {
      throw new McpConfigValidationError(`MCP server "${serverName}" field "enabled" must be a boolean.`);
    }
    if ('auth' in serverConfig && serverConfig.auth !== 'oauth' && serverConfig.auth !== 'none') {
      throw new McpConfigValidationError(`MCP server "${serverName}" field "auth" must be "oauth" or "none".`);
    }
  }

  return parsed as McpConfig;
}

export async function ensureMcpConfigExists(): Promise<{ filePath: string; created: boolean }> {
  const existing = await readSettingsTextFileIfExists(MCP_CONFIG_FILE);
  if (existing.content !== null) {
    return { filePath: existing.filePath, created: false };
  }

  const filePath = await writeSettingsTextFileAtomic(MCP_CONFIG_FILE, formatDefaultConfig());
  return { filePath, created: true };
}

export async function readMcpConfigState(): Promise<McpConfigState> {
  const { created } = await ensureMcpConfigExists();
  const state = await readSettingsTextFileIfExists(MCP_CONFIG_FILE);

  return {
    path: state.filePath,
    exists: !created,
    rawContent: state.content ?? formatDefaultConfig(),
  };
}

export async function readMcpConfig(): Promise<McpConfig> {
  const state = await readMcpConfigState();
  return parseAndValidateMcpConfig(state.rawContent);
}

export async function writeMcpConfigRaw(rawContent: string): Promise<McpConfigState> {
  parseAndValidateMcpConfig(rawContent);

  await writeSettingsTextFileAtomic(MCP_CONFIG_FILE, rawContent);

  return readMcpConfigState();
}

export async function setMcpServerEnabled(serverName: string, enabled: boolean): Promise<McpConfigState> {
  const state = await readMcpConfigState();
  const config = parseAndValidateMcpConfig(state.rawContent);
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) {
    throw new McpConfigValidationError(`Unknown MCP server "${serverName}".`);
  }

  config.mcpServers[serverName] = {
    ...serverConfig,
    enabled,
  };

  return writeMcpConfigRaw(JSON.stringify(config, null, 2));
}
