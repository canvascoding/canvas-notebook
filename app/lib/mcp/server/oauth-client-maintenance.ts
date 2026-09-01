import 'server-only';

import { openDb } from '@/app/lib/db';
import { resolveDirectMcpOAuthConfig } from '@/app/lib/mcp/server/config';

export const DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_DAYS = 7;
export const DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_PRUNE_LIMIT = 100;

const DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_MS = (
  DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
);

function changesFromRunResult(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const changes = (result as { changes?: unknown }).changes;
  return typeof changes === 'number' && Number.isFinite(changes) ? changes : 0;
}

/**
 * Removes only anonymous public clients that are linked to this Direct MCP
 * resource and never received a consent or token. Public-client status is
 * derived from no client secret plus the `none` token auth method; the legacy
 * `public` column is deliberately ignored because deployed schemas represent
 * it as boolean, integer, bigint, or null. A client that was ever used remains
 * intact; this is intentionally not a general OAuth cleanup.
 */
export async function pruneUnusedDirectMcpDynamicClients(
  now = Date.now(),
): Promise<number> {
  const cutoff = now - DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_RETENTION_MS;
  const { resource } = resolveDirectMcpOAuthConfig();
  const database = await openDb();
  try {
    const result = await database.run(`
      DELETE FROM oauth_client
      WHERE client_id IN (
        SELECT stale_client.client_id
        FROM oauth_client stale_client
        INNER JOIN oauth_client_resource direct_resource
          ON direct_resource.client_id = stale_client.client_id
        WHERE direct_resource.resource_id = ?
          AND stale_client.created_at IS NOT NULL
          AND stale_client.created_at < ?
          AND stale_client.user_id IS NULL
          AND stale_client.client_secret IS NULL
          AND stale_client.token_endpoint_auth_method = 'none'
          AND NOT EXISTS (
            SELECT 1
            FROM oauth_consent consent
            WHERE consent.client_id = stale_client.client_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oauth_access_token access_token
            WHERE access_token.client_id = stale_client.client_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM oauth_refresh_token refresh_token
            WHERE refresh_token.client_id = stale_client.client_id
          )
        ORDER BY stale_client.created_at ASC
        LIMIT ?
      )
    `, [resource, cutoff, DIRECT_MCP_UNUSED_DYNAMIC_CLIENT_PRUNE_LIMIT]);
    return changesFromRunResult(result);
  } finally {
    await database.close();
  }
}
