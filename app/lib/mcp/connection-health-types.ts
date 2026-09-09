export type McpAuthState = 'not_authorized' | 'authorized' | 'refreshing' | 'reauth_required';
export type McpReachability = 'unknown' | 'reachable' | 'unreachable';
export type McpConnectionErrorCode = 'reauth_required' | 'insufficient_scope' | 'rate_limited' | 'provider_unavailable' | 'network_error' | 'configuration_error';

export type McpConnectionIncident = {
  id: string;
  kind: 'reauth_required' | 'unreachable';
  openedAt: string;
  updatedAt: string;
  readAt: string | null;
};

export type McpConnectionHealth = {
  version: 1;
  connectionId: string;
  authVersion: number;
  authGeneration: number;
  configHash: string;
  enabled: boolean;
  authStatus: McpAuthState;
  reachability: McpReachability;
  lastSuccessfulRequestAt: string | null;
  lastCheckedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: McpConnectionErrorCode | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  lastCountedFailureAt: string | null;
  refreshStartedAt: string | null;
  nextCheckAt: string | null;
  incident: McpConnectionIncident | null;
};

export type McpReconnectHint = { connectionId: string; serverName: string };

export function mcpConnectionSettingsHref(connectionId: string): string {
  return `/settings?tab=mcp&section=mcpConfig&connection=${encodeURIComponent(connectionId)}`;
}

export function readMcpReconnectHint(details: unknown): McpReconnectHint | null {
  if (!details || typeof details !== 'object' || !('mcpReconnect' in details)) return null;
  const value = details.mcpReconnect;
  if (!value || typeof value !== 'object' || !('connectionId' in value) || !('serverName' in value)) return null;
  if (typeof value.connectionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.connectionId)
    || typeof value.serverName !== 'string' || value.serverName.length > 200) return null;
  return { connectionId: value.connectionId, serverName: value.serverName };
}

export function mcpConnectionErrorCopy(code: McpConnectionErrorCode | null, locale: string): string {
  const copy = {
    reauth_required: ['Bitte verbinde dieses Konto erneut.', 'Reconnect this account to continue.'],
    insufficient_scope: ['Für diese Aktion ist eine zusätzliche Freigabe nötig. Verbinde das Konto erneut.', 'Additional permission is required. Reconnect this account.'],
    rate_limited: ['Der Anbieter begrenzt gerade Anfragen. Canvas versucht es später erneut.', 'The provider is limiting requests. Canvas will check again later.'],
    provider_unavailable: ['Der Anbieter ist vorübergehend nicht verfügbar. Canvas versucht es später erneut.', 'The provider is temporarily unavailable. Canvas will check again later.'],
    network_error: ['Der Server ist nicht erreichbar. Prüfe die Verbindung oder versuche es später erneut.', 'The server cannot be reached. Check the connection or try again later.'],
    configuration_error: ['Prüfe die Servereinstellungen und die hinterlegten Zugangsdaten.', 'Check the server settings and configured credentials.'],
  };
  return code ? copy[code][locale === 'de' ? 0 : 1] : '';
}
