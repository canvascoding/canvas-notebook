import 'server-only';

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeDataScopeId, resolveOrganizationMcpTemplatesDir } from '@/app/lib/runtime-data-paths';
import { parseAndValidateMcpConfig, type McpServerConfig } from './config';
import { hashMcpLegacyConfig, validateMcpConnectionId } from './connection-identity';
import { assertMcpHttpUrlAllowed } from './network-policy';
import { withMcpStorageLock } from './storage-lock';
import { MCP_SYSTEM_SCOPE } from './scope';
import type { McpServerDefinition } from './server-definition-types';

const CONFIG_KEYS = ['url', 'auth', 'oauth', 'transport', 'timeoutMs', 'directTools'] as const;
const IDENTITY_KEYS = new Set(['schemaVersion', 'connectionId', 'ownerUserId', 'organizationId', 'serverDefinitionId', 'displayName', 'authVersion', 'enabled', 'legacyOAuthName', 'legacyOAuthAmbiguous', 'legacyConfigHash', 'iconUrl']);
const OAUTH_KEYS = new Set(['issuer', 'resourceMetadataUrl', 'authorizationUrl', 'tokenUrl', 'registrationUrl', 'revocationUrl', 'clientId', 'scopes']);

export class McpDefinitionError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'MCP_DEFINITION_INVALID') {
    super(message);
    this.name = 'McpDefinitionError';
  }
}

/** Shared definitions contain public HTTP/OAuth metadata only. */
export function publicMcpDefinitionConfig(config: McpServerConfig): McpServerConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key as typeof CONFIG_KEYS[number]) && !IDENTITY_KEYS.has(key)) {
      throw new McpDefinitionError(`Shared MCP definitions cannot contain ${key}. Use personal OAuth credentials.`);
    }
  }
  if (typeof config.url !== 'string' || !config.url) throw new McpDefinitionError('Only HTTP servers can be shared.');
  const checkUrl = (value: unknown) => {
    if (typeof value !== 'string') throw new McpDefinitionError('Definition URLs must be strings.');
    let url: URL;
    try { url = new URL(value); } catch { throw new McpDefinitionError('Invalid definition URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new McpDefinitionError('Shared server URLs must not contain credentials, query parameters or fragments.');
    }
  };
  checkUrl(config.url);
  if (config.oauth !== undefined) {
    if (!config.oauth || typeof config.oauth !== 'object' || Array.isArray(config.oauth)) throw new McpDefinitionError('Invalid OAuth definition.');
    for (const [key, value] of Object.entries(config.oauth)) {
      if (!OAUTH_KEYS.has(key)) throw new McpDefinitionError(`Shared OAuth definitions cannot contain ${key}.`);
      if (key.endsWith('Url') || key === 'issuer') checkUrl(value);
    }
  }
  const selected = Object.fromEntries(CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
  return parseAndValidateMcpConfig(JSON.stringify({ mcpServers: { shared: selected } })).mcpServers.shared;
}

export function matchesMcpServerDefinition(connection: McpServerConfig, definition: McpServerDefinition): boolean {
  try {
    return hashMcpLegacyConfig(publicMcpDefinitionConfig(connection)) === hashMcpLegacyConfig(definition.config);
  } catch { return false; }
}

function definitionPath(organizationId: string): string {
  normalizeDataScopeId(organizationId, 'organizationId');
  return path.join(resolveOrganizationMcpTemplatesDir(organizationId), 'approved-servers.json');
}

export async function listMcpServerDefinitions(organizationId: string): Promise<McpServerDefinition[]> {
  const file = definitionPath(organizationId);
  let raw: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new McpDefinitionError('Invalid MCP definition storage.', 503);
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const record = JSON.parse(raw) as { version: number; definitions: McpServerDefinition[] };
  if (record.version !== 1 || !Array.isArray(record.definitions) || record.definitions.length > 100) throw new McpDefinitionError('Invalid MCP definitions.', 503);
  for (const definition of record.definitions) {
    validateMcpConnectionId(definition.id);
    if (definition.organizationId !== organizationId || definition.version !== 1 || typeof definition.enabled !== 'boolean') throw new McpDefinitionError('MCP definition scope does not match.', 503);
    publicMcpDefinitionConfig(definition.config);
  }
  return record.definitions;
}

async function writeDefinitions(organizationId: string, definitions: McpServerDefinition[]): Promise<void> {
  if (definitions.length > 100) throw new McpDefinitionError('An organization can approve up to 100 MCP servers.');
  const target = definitionPath(organizationId);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, definitions }));
      await file.sync();
    } finally { await file.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Caller must have verified organization administration. No account/token data is copied. */
export async function publishMcpServerDefinition(organizationId: string, name: string, config: McpServerConfig, id?: string): Promise<McpServerDefinition> {
  const publicConfig = publicMcpDefinitionConfig(config);
  await assertMcpHttpUrlAllowed(publicConfig.url!, 'Shared MCP server URL');
  if (!name.trim() || name.trim().length > 120) throw new McpDefinitionError('A server name of 1–120 characters is required.');
  if (id) { try { validateMcpConnectionId(id); } catch { throw new McpDefinitionError('Invalid MCP definition ID.'); } }
  return withMcpStorageLock(`definitions-${organizationId}`, MCP_SYSTEM_SCOPE, async () => {
    const definitions = await listMcpServerDefinitions(organizationId);
    const previous = id ? definitions.find((item) => item.id === id) : undefined;
    if (id && !previous) throw new McpDefinitionError('MCP definition not found.', 404);
    const definition: McpServerDefinition = {
      version: 1, id: id || crypto.randomUUID(), organizationId, name: name.trim(), enabled: true,
      revision: (previous?.revision || 0) + 1, config: publicConfig, updatedAt: new Date().toISOString(),
    };
    await writeDefinitions(organizationId, [...definitions.filter((item) => item.id !== definition.id), definition]);
    return definition;
  });
}

export async function setMcpServerDefinitionEnabled(organizationId: string, id: string, enabled: boolean): Promise<void> {
  try { validateMcpConnectionId(id); } catch { throw new McpDefinitionError('Invalid MCP definition ID.'); }
  await withMcpStorageLock(`definitions-${organizationId}`, MCP_SYSTEM_SCOPE, async () => {
    const definitions = await listMcpServerDefinitions(organizationId);
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new McpDefinitionError('MCP definition not found.', 404);
    definition.enabled = enabled;
    definition.updatedAt = new Date().toISOString();
    await writeDefinitions(organizationId, definitions);
  });
}
