import 'server-only';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import { getMcpOAuthStatus } from '@/app/lib/mcp/oauth';
import { readMcpConnectionHealth, recordMcpConnectionObservation } from '@/app/lib/mcp/connection-health';
import type { McpConnectionHealth } from '@/app/lib/mcp/connection-health-types';
import type { McpScope } from '@/app/lib/mcp/scope';

/** Local status reconciliation does not create an HTTP client or call a provider. */
export async function readMcpConnectionStatus(serverName: string, connection: McpServerConfig & { connectionId: string }, scope: McpScope, now = Date.now()): Promise<McpConnectionHealth> {
  let health = await readMcpConnectionHealth(connection, scope);
  if (!health.enabled) return health;
  const oauth = await getMcpOAuthStatus(serverName, undefined, scope);
  if (oauth.requiresAuth) {
    const needsLogin = oauth.authStatus === 'reauth_required'
      || (oauth.authStatus === 'not_authorized' && !oauth.reason && (health.authStatus === 'authorized' || health.authStatus === 'refreshing'));
    if (needsLogin && (health.authStatus !== 'reauth_required' || health.incident?.kind !== 'reauth_required')) {
      await recordMcpConnectionObservation(connection, scope, { kind: 'failure', code: 'reauth_required' }, { now, generation: health.authGeneration });
      health = await readMcpConnectionHealth(connection, scope);
    } else if (oauth.authorized && (health.authStatus === 'not_authorized'
      || (health.authStatus === 'refreshing' && (!health.refreshStartedAt || now - Date.parse(health.refreshStartedAt) > 120_000)))) {
      await recordMcpConnectionObservation(connection, scope, { kind: 'authorized' }, { now, generation: health.authGeneration });
      health = await readMcpConnectionHealth(connection, scope);
    }
  }
  return health;
}
