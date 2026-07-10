import { resolveScopedMcpDir, type McpScope } from '@/app/lib/mcp/scope';
import {
  readMcpTextFileIfExists,
  resolveMcpStoragePath,
  writeMcpTextFileAtomic,
} from '@/app/lib/mcp/storage';

export const MCP_CONFIG_FILE = 'mcp.json';
export const USER_MCP_CONFIG_FILE = 'config.json';
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

function getMcpConfigFile(scope?: McpScope | null): string {
  return resolveScopedMcpDir(scope) ? USER_MCP_CONFIG_FILE : MCP_CONFIG_FILE;
}

export function resolveMcpConfigPath(scope?: McpScope | null): string {
  return resolveMcpStoragePath(getMcpConfigFile(scope), scope);
}

function formatDefaultConfig(): string {
  return `${JSON.stringify(DEFAULT_MCP_CONFIG, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidEnvKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function isSecretLikeKey(value: string): boolean {
  return /(authorization|token|secret|password|api[_-]?key|credential)/iu.test(value);
}

function isEnvReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value);
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
    if (serverConfig.envPassthrough !== undefined && (!Array.isArray(serverConfig.envPassthrough) || !serverConfig.envPassthrough.every(isValidEnvKey))) {
      throw new McpConfigValidationError(`MCP server "${serverName}" field "envPassthrough" must contain environment variable names only.`);
    }
    if (serverConfig.bearerTokenEnv !== undefined && !isValidEnvKey(serverConfig.bearerTokenEnv)) {
      throw new McpConfigValidationError(`MCP server "${serverName}" field "bearerTokenEnv" must be an environment variable name.`);
    }
    for (const field of ['env', 'headers', 'headersFromEnv'] as const) {
      const values = serverConfig[field];
      if (values === undefined) continue;
      if (!isPlainObject(values)) {
        throw new McpConfigValidationError(`MCP server "${serverName}" field "${field}" must be an object.`);
      }
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') {
          throw new McpConfigValidationError(`MCP server "${serverName}" field "${field}.${key}" must be a string.`);
        }
        if (field === 'headersFromEnv' && !isValidEnvKey(value)) {
          throw new McpConfigValidationError(`MCP server "${serverName}" field "headersFromEnv.${key}" must reference an environment variable name.`);
        }
        if (field !== 'headersFromEnv' && isSecretLikeKey(key) && !isEnvReference(value)) {
          throw new McpConfigValidationError(`MCP server "${serverName}" must reference secret header or environment values via \${ENV_VAR}.`);
        }
      }
    }
    if (isPlainObject(serverConfig.oauth) && 'clientSecret' in serverConfig.oauth) {
      throw new McpConfigValidationError(`MCP server "${serverName}" must not store oauth.clientSecret in MCP config.`);
    }
  }

  return parsed as McpConfig;
}

export async function ensureMcpConfigExists(scope?: McpScope | null): Promise<{ filePath: string; created: boolean }> {
  const configFile = getMcpConfigFile(scope);
  const existing = await readMcpTextFileIfExists(configFile, scope);
  if (existing.content !== null) {
    return { filePath: existing.filePath, created: false };
  }

  const filePath = await writeMcpTextFileAtomic(configFile, formatDefaultConfig(), scope);
  return { filePath, created: true };
}

export async function readMcpConfigState(scope?: McpScope | null): Promise<McpConfigState> {
  const { created } = await ensureMcpConfigExists(scope);
  const state = await readMcpTextFileIfExists(getMcpConfigFile(scope), scope);

  return {
    path: state.filePath,
    exists: !created,
    rawContent: state.content ?? formatDefaultConfig(),
  };
}

export async function readMcpConfig(scope?: McpScope | null): Promise<McpConfig> {
  const state = await readMcpConfigState(scope);
  return parseAndValidateMcpConfig(state.rawContent);
}

export async function writeMcpConfigRaw(rawContent: string, scope?: McpScope | null): Promise<McpConfigState> {
  parseAndValidateMcpConfig(rawContent);

  await writeMcpTextFileAtomic(getMcpConfigFile(scope), rawContent, scope);

  return readMcpConfigState(scope);
}

export async function setMcpServerEnabled(serverName: string, enabled: boolean, scope?: McpScope | null): Promise<McpConfigState> {
  const state = await readMcpConfigState(scope);
  const config = parseAndValidateMcpConfig(state.rawContent);
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) {
    throw new McpConfigValidationError(`Unknown MCP server "${serverName}".`);
  }

  config.mcpServers[serverName] = {
    ...serverConfig,
    enabled,
  };

  return writeMcpConfigRaw(JSON.stringify(config, null, 2), scope);
}
