import 'server-only';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { markMcpConnectionIncidentRead } from '@/app/lib/mcp/connection-health';
import { mcpConnectionErrorCopy } from '@/app/lib/mcp/connection-health-types';
import { readMcpConnectionStatus } from '@/app/lib/mcp/connection-status';
import { getUserPreferredLocale } from '@/app/lib/user-preferences';

export type McpConnectionAttentionItem = {
  id: string;
  type: 'mcp.connection_attention';
  title: string;
  detail: string;
  previewUrl: null;
  occurredAt: string;
  unread: boolean;
  priority: 'normal' | 'high';
  workspaceId: string;
  workspaceName: string | null;
  target: { kind: 'mcp'; connectionId: string };
};

export async function listMcpConnectionAttention(input: { userId: string; now?: number }): Promise<McpConnectionAttentionItem[]> {
  const scope = { userId: input.userId };
  const config = await readMcpConfig(scope);
  const locale = await getUserPreferredLocale(input.userId).catch(() => 'en');
  const result: McpConnectionAttentionItem[] = [];
  for (const [serverName, connection] of Object.entries(config.mcpServers)) {
    if (!connection.connectionId || connection.enabled === false) continue;
    const health = await readMcpConnectionStatus(serverName, connection as McpServerConfig & { connectionId: string }, scope, input.now);
    const incident = health.incident;
    if (!incident) continue;
    result.push({
      id: `mcp:${incident.id}`, type: 'mcp.connection_attention',
      title: `${connection.displayName || serverName}: ${incident.kind === 'reauth_required'
        ? locale === 'de' ? 'Erneut verbinden' : 'Reconnect required'
        : locale === 'de' ? 'Nicht erreichbar' : 'Connection unavailable'}`,
      detail: mcpConnectionErrorCopy(health.lastErrorCode, locale), previewUrl: null,
      occurredAt: incident.openedAt, unread: !incident.readAt,
      priority: incident.kind === 'reauth_required' ? 'high' : 'normal',
      workspaceId: `user:${input.userId}`, workspaceName: locale === 'de' ? 'Persönliche Verbindungen' : 'Personal connections',
      target: { kind: 'mcp', connectionId: connection.connectionId },
    });
  }
  return result;
}

export async function markMcpConnectionAttentionRead(input: { userId: string; itemId?: string }): Promise<{ updated: number; found: boolean }> {
  const scope = { userId: input.userId };
  const config = await readMcpConfig(scope);
  const items = await listMcpConnectionAttention(input);
  let updated = 0;
  let found = false;
  for (const item of items) {
    if (input.itemId && item.id !== input.itemId) continue;
    found = true;
    const connection = Object.values(config.mcpServers).find((server) => server.connectionId === item.target.connectionId);
    if (connection?.connectionId && await markMcpConnectionIncidentRead(connection as McpServerConfig & { connectionId: string }, scope, item.id.slice(4))) updated += 1;
  }
  return { updated, found };
}
