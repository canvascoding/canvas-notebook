import 'server-only';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { resolveDirectMcpOAuthConfig } from '@/app/lib/mcp/server/config';
import { createDirectMcpServer } from '@/app/lib/mcp/server/direct-server';
import { getDirectMcpRuntimeSettings } from '@/app/lib/mcp/server/runtime-settings';

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
] as const;

async function assertDirectMcpSchemaReady(): Promise<void> {
  const database = await openDb();
  try {
    for (const table of REQUIRED_OAUTH_TABLES) {
      await database.get(`SELECT 1 FROM ${table} LIMIT 1`);
    }
  } finally {
    await database.close();
  }
}

export async function getDirectMcpReadiness(): Promise<DirectMcpReadiness> {
  let settings: Awaited<ReturnType<typeof getDirectMcpRuntimeSettings>>;
  try {
    settings = await getDirectMcpRuntimeSettings();
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
