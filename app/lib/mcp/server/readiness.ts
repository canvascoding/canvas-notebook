import 'server-only';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { resolveDirectMcpOAuthConfig } from '@/app/lib/mcp/server/config';
import { createDirectMcpServer } from '@/app/lib/mcp/server/direct-server';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';
import type { DirectMcpToolId } from '@/app/lib/mcp/server/config';

export type DirectMcpReadinessStatus = 'disabled' | 'ready' | 'failed';

export type DirectMcpReadiness = {
  status: DirectMcpReadinessStatus;
  code:
    | 'MCP_DISABLED'
    | 'MCP_READY'
    | 'MCP_CONFIGURATION_INVALID'
    | 'MCP_SCHEMA_UNAVAILABLE'
    | 'MCP_OAUTH_PROVIDER_UNAVAILABLE'
    | 'MCP_TRANSPORT_UNAVAILABLE';
};

const REQUIRED_OAUTH_TABLES = [
  'jwks',
  'oauth_access_token',
  'oauth_client',
  'oauth_client_assertion',
  'oauth_client_resource',
  'oauth_consent',
  'oauth_refresh_token',
  'oauth_resource',
  'mcp_direct_grant_revocation',
  'mcp_direct_workspace_grant',
  'mcp_direct_workspace_setting',
] as const;

const REQUIRED_OAUTH_COLUMNS: Record<string, readonly string[]> = {
  oauth_client: [
    'client_id',
    'client_secret',
    'scopes',
    'redirect_uris',
    'token_endpoint_auth_method',
    'grant_types',
    'response_types',
  ],
  oauth_client_resource: ['client_id', 'resource_id'],
  oauth_resource: ['identifier', 'allowed_scopes'],
  oauth_access_token: ['client_id', 'resources', 'scopes'],
  oauth_refresh_token: ['client_id', 'resources', 'scopes'],
  oauth_consent: ['client_id', 'resources', 'scopes'],
};

async function assertDirectMcpSchemaReady(): Promise<void> {
  const database = await openDb();
  try {
    for (const table of REQUIRED_OAUTH_TABLES) {
      await database.get(`SELECT 1 FROM ${table} LIMIT 1`);
    }
    for (const [table, columns] of Object.entries(REQUIRED_OAUTH_COLUMNS)) {
      // Identifiers are fixed application constants, never request data.
      await database.get(`SELECT ${columns.join(', ')} FROM ${table} LIMIT 0`);
    }
  } finally {
    await database.close();
  }
}

export async function getDirectMcpReadiness(
  requestedSettings?: {
    enabled: boolean;
    tools: readonly DirectMcpToolId[];
  },
): Promise<DirectMcpReadiness> {
  let settings: Awaited<ReturnType<typeof getDirectMcpRuntimeSettings>>;
  try {
    settings = requestedSettings ?? await getDirectMcpRuntimeSettings();
  } catch {
    return { status: 'failed', code: 'MCP_CONFIGURATION_INVALID' };
  }
  if (!settings.enabled) return { status: 'disabled', code: 'MCP_DISABLED' };

  try {
    resolveDirectMcpOAuthConfig();
  } catch {
    return { status: 'failed', code: 'MCP_CONFIGURATION_INVALID' };
  }

  try {
    await assertDirectMcpSchemaReady();
  } catch {
    return { status: 'failed', code: 'MCP_SCHEMA_UNAVAILABLE' };
  }

  try {
    const jwks = await auth.api.getJwks();
    if (!jwks || !Array.isArray(jwks.keys)) {
      return { status: 'failed', code: 'MCP_OAUTH_PROVIDER_UNAVAILABLE' };
    }
  } catch {
    return { status: 'failed', code: 'MCP_OAUTH_PROVIDER_UNAVAILABLE' };
  }

  try {
    const server = createDirectMcpServer(settings.tools);
    await server.close();
  } catch {
    return { status: 'failed', code: 'MCP_TRANSPORT_UNAVAILABLE' };
  }

  return { status: 'ready', code: 'MCP_READY' };
}

export async function assertDirectMcpStartupReady(): Promise<void> {
  const readiness = await getDirectMcpReadiness();
  if (readiness.status === 'failed') {
    throw new Error(`Direct MCP startup readiness failed: ${readiness.code}`);
  }
}
