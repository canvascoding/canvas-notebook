import path from 'path';
import { promises as fs } from 'fs';

import { resolveAgentStorageDir } from '@/app/lib/runtime-data-paths';

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

export class McpConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigValidationError';
  }
}

export function resolveMcpConfigPath(): string {
  return path.join(resolveAgentStorageDir(), MCP_CONFIG_FILE);
}

function formatDefaultConfig(): string {
  return `${JSON.stringify(DEFAULT_MCP_CONFIG, null, 2)}\n`;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseAndValidateMcpConfig(rawContent: string): unknown {
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
  }

  return parsed;
}

export async function ensureMcpConfigExists(): Promise<{ filePath: string; created: boolean }> {
  const filePath = resolveMcpConfigPath();

  try {
    await fs.access(filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
    return { filePath, created: false };
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  await ensureParentDirectory(filePath);
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, formatDefaultConfig(), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);

  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      await fs.chmod(filePath, 0o600).catch(() => undefined);
      return { filePath, created: false };
    }
    throw error;
  }

  return { filePath, created: true };
}

export async function readMcpConfigState(): Promise<McpConfigState> {
  const { filePath, created } = await ensureMcpConfigExists();
  const rawContent = await fs.readFile(filePath, 'utf8');

  return {
    path: filePath,
    exists: !created,
    rawContent,
  };
}

export async function writeMcpConfigRaw(rawContent: string): Promise<McpConfigState> {
  parseAndValidateMcpConfig(rawContent);

  const filePath = resolveMcpConfigPath();
  await ensureParentDirectory(filePath);

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const content = rawContent.endsWith('\n') || rawContent.length === 0 ? rawContent : `${rawContent}\n`;
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);

  return readMcpConfigState();
}
