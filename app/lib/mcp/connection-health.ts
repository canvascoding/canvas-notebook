import 'server-only';

import crypto from 'node:crypto';
import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { readMcpOAuthLifecycle } from '@/app/lib/mcp/oauth-lifecycle';
import { requireMcpCredentialScope, type McpScope } from '@/app/lib/mcp/scope';
import { readMcpTextFileIfExists, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';
import type { McpConnectionErrorCode, McpConnectionHealth, McpReconnectHint } from './connection-health-types';

type Connection = McpServerConfig & { connectionId: string };
export type McpConnectionObservation =
  | { kind: 'success' | 'authorized' | 'refreshing' | 'disconnect' | 'activation' }
  | { kind: 'failure'; code: McpConnectionErrorCode };
const CHECK_INTERVAL_MS = 5 * 60_000;
const INCIDENT_DELAY_MS = 5 * 60_000;

function healthPath(connectionId: string): string {
  return `connections/${connectionId}/health.json`;
}

function hasOAuth(connection: McpServerConfig): boolean {
  return connection.auth === 'oauth' || Boolean(connection.oauth);
}

function initialHealth(connection: Connection, generation: number): McpConnectionHealth {
  return {
    version: 1, connectionId: connection.connectionId, authVersion: connection.authVersion || 1,
    authGeneration: generation, configHash: hashMcpAuthConfig(connection), enabled: connection.enabled !== false,
    authStatus: 'not_authorized', reachability: 'unknown', lastSuccessfulRequestAt: null,
    lastCheckedAt: null, lastErrorAt: null, lastErrorCode: null, consecutiveFailures: 0,
    firstFailureAt: null, lastCountedFailureAt: null, refreshStartedAt: null, nextCheckAt: null, incident: null,
  };
}

async function readHealthFile(connection: Connection, generation: number, scope: McpScope): Promise<McpConnectionHealth> {
  const raw = (await readMcpTextFileIfExists(healthPath(connection.connectionId), scope)).content;
  if (!raw) return initialHealth(connection, generation);
  const stored = JSON.parse(raw) as McpConnectionHealth;
  if (stored.version !== 1 || stored.connectionId !== connection.connectionId || stored.authVersion !== (connection.authVersion || 1)
    || stored.authGeneration !== generation || stored.configHash !== hashMcpAuthConfig(connection)) return initialHealth(connection, generation);
  return { ...stored, enabled: connection.enabled !== false, ...(connection.enabled === false ? { incident: null } : {}) };
}

export async function readMcpConnectionHealth(connection: Connection, scope: McpScope): Promise<McpConnectionHealth> {
  const ownedScope = requireMcpCredentialScope(scope);
  if (!ownedScope.userId || connection.ownerUserId !== ownedScope.userId
    || (connection.organizationId || null) !== (ownedScope.organizationId || null)) throw new Error('MCP connection owner does not match.');
  return readHealthFile(connection, (await readMcpOAuthLifecycle(connection.connectionId, ownedScope)).generation, ownedScope);
}

/** Store only allowlisted codes. Provider responses and exception text are never persisted. */
export function classifyMcpConnectionFailure(error: unknown): McpConnectionErrorCode | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; status?: unknown; name?: string; message?: string };
  if (candidate.code === 'mcp_auth_renewed' || candidate.name === 'AbortError') return null;
  if (candidate.code === 'insufficient_scope' || candidate.name === 'InsufficientScopeError') return 'insufficient_scope';
  if (['reauth_required', 'invalid_grant', 'invalid_token'].includes(String(candidate.code)) || candidate.status === 401) return 'reauth_required';
  if (candidate.code === 'rate_limited' || candidate.status === 429) return 'rate_limited';
  if (candidate.code === 'provider_unavailable' || (typeof candidate.status === 'number' && candidate.status >= 500)) return 'provider_unavailable';
  if (candidate.code === 'network_error' || /^(?:ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET)/u.test(String(candidate.code))
    || /timed out|fetch failed|socket hang up/iu.test(candidate.message || '')) return 'network_error';
  if (/Missing MCP environment variable|settings\?tab=integrations|blocked|not allowed/iu.test(candidate.message || '')) return 'configuration_error';
  return null;
}

export function applyMcpConnectionObservation(health: McpConnectionHealth, connection: Connection, observation: McpConnectionObservation, now: number): McpConnectionHealth {
  const timestamp = new Date(now).toISOString();
  const next = { ...health, enabled: connection.enabled !== false };
  if (!next.enabled || observation.kind === 'activation' || observation.kind === 'disconnect') {
    return { ...next, authStatus: observation.kind === 'disconnect' ? 'not_authorized' : next.authStatus,
      reachability: 'unknown', consecutiveFailures: 0, firstFailureAt: null, nextCheckAt: null,
      lastCountedFailureAt: null, refreshStartedAt: null, lastErrorCode: null, incident: null };
  }
  if (observation.kind === 'refreshing') return { ...next, authStatus: 'refreshing', refreshStartedAt: timestamp };
  if (observation.kind === 'authorized') {
    const authError = next.lastErrorCode === 'reauth_required' || next.lastErrorCode === 'insufficient_scope';
    return { ...next, authStatus: 'authorized', refreshStartedAt: null,
      incident: next.incident?.kind === 'reauth_required' ? null : next.incident,
      lastErrorCode: authError ? null : next.lastErrorCode, nextCheckAt: timestamp };
  }
  if (observation.kind === 'success') {
    const needsAdditionalPermission = next.authStatus === 'reauth_required' && next.lastErrorCode === 'insufficient_scope';
    return { ...next, authStatus: needsAdditionalPermission ? 'reauth_required' : hasOAuth(connection) ? 'authorized' : 'not_authorized',
      reachability: 'reachable', lastSuccessfulRequestAt: timestamp, lastCheckedAt: timestamp,
      consecutiveFailures: 0, firstFailureAt: null,
      lastErrorCode: needsAdditionalPermission ? next.lastErrorCode : null,
      incident: needsAdditionalPermission ? next.incident : null,
      lastCountedFailureAt: null, refreshStartedAt: null,
      nextCheckAt: new Date(now + CHECK_INTERVAL_MS).toISOString() };
  }
  if (observation.kind !== 'failure') return next;
  const code = observation.code;
  const authFailure = code === 'reauth_required' || code === 'insufficient_scope';
  const networkFailure = code === 'rate_limited' || code === 'provider_unavailable' || code === 'network_error';
  next.lastCheckedAt = timestamp;
  next.lastErrorAt = timestamp;
  next.lastErrorCode = code;
  if (next.authStatus === 'refreshing') next.authStatus = 'authorized';
  next.refreshStartedAt = null;
  if (authFailure) {
    next.authStatus = 'reauth_required';
    next.nextCheckAt = null;
  } else if (networkFailure) {
    // Bursts of concurrent failed tool calls count as one failed check window.
    const separateCheck = !health.lastCountedFailureAt || now - Date.parse(health.lastCountedFailureAt) >= 30_000;
    next.consecutiveFailures += separateCheck ? 1 : 0;
    if (separateCheck) next.lastCountedFailureAt = timestamp;
    next.firstFailureAt ||= timestamp;
    next.reachability = 'unreachable';
    next.nextCheckAt = new Date(now + Math.min(60 * 60_000, 150_000 * 2 ** Math.min(next.consecutiveFailures - 1, 5))).toISOString();
  } else {
    next.nextCheckAt = new Date(now + 30 * 60_000).toISOString();
  }
  const incidentKind = authFailure ? 'reauth_required'
    : networkFailure && next.consecutiveFailures >= 3 && now - Date.parse(next.firstFailureAt!) >= INCIDENT_DELAY_MS ? 'unreachable' : null;
  if (incidentKind && next.incident?.kind !== incidentKind) {
    next.incident = { id: crypto.randomUUID(), kind: incidentKind, openedAt: timestamp, updatedAt: timestamp, readAt: null };
  } else if (incidentKind && next.incident) {
    next.incident = { ...next.incident, updatedAt: timestamp };
  }
  return next;
}

export async function recordMcpConnectionObservation(
  connection: McpServerConfig, scope: McpScope | null | undefined, observation: McpConnectionObservation,
  options: { now?: number; generation?: number } = {},
): Promise<void> {
  if (!scope?.userId || !connection.connectionId) return;
  const ownedScope = requireMcpCredentialScope(scope);
  await withMcpStorageLock(`health-${connection.connectionId}`, ownedScope, async () => {
    const current = Object.values((await readMcpConfig(ownedScope)).mcpServers).find((item) => item.connectionId === connection.connectionId);
    if (!current?.connectionId || hashMcpAuthConfig(current) !== hashMcpAuthConfig(connection)
      || current.authVersion !== connection.authVersion) return;
    const generation = (await readMcpOAuthLifecycle(current.connectionId, ownedScope)).generation;
    if (options.generation !== undefined && options.generation !== generation) return;
    const bound = current as Connection;
    const next = applyMcpConnectionObservation(await readHealthFile(bound, generation, ownedScope), bound, observation, options.now ?? Date.now());
    await writeMcpTextFileAtomic(healthPath(current.connectionId), JSON.stringify(next), ownedScope);
  });
}

/** Reserve the next probe before doing network I/O, including across processes. */
export async function claimMcpConnectionProbe(connection: Connection, scope: McpScope, now = Date.now()): Promise<boolean> {
  return withMcpStorageLock(`health-${connection.connectionId}`, scope, async () => {
    const current = Object.values((await readMcpConfig(scope)).mcpServers).find((item) => item.connectionId === connection.connectionId);
    if (!current?.connectionId || current.authVersion !== connection.authVersion || hashMcpAuthConfig(current) !== hashMcpAuthConfig(connection)) return false;
    const health = await readMcpConnectionHealth(current as Connection, scope);
    if (!health.enabled || health.authStatus === 'reauth_required' || (health.nextCheckAt && Date.parse(health.nextCheckAt) > now)) return false;
    await writeMcpTextFileAtomic(healthPath(connection.connectionId), JSON.stringify({ ...health, nextCheckAt: new Date(now + CHECK_INTERVAL_MS).toISOString() }), scope);
    return true;
  });
}

export async function markMcpConnectionIncidentRead(connection: Connection, scope: McpScope, incidentId: string, now = Date.now()): Promise<boolean> {
  return withMcpStorageLock(`health-${connection.connectionId}`, scope, async () => {
    const current = Object.values((await readMcpConfig(scope)).mcpServers).find((item) => item.connectionId === connection.connectionId);
    if (!current?.connectionId) return false;
    const health = await readMcpConnectionHealth(current as Connection, scope);
    if (health.incident?.id !== incidentId || health.incident.readAt) return false;
    await writeMcpTextFileAtomic(healthPath(connection.connectionId), JSON.stringify({ ...health, incident: { ...health.incident, readAt: new Date(now).toISOString() } }), scope);
    return true;
  });
}

export async function mcpReconnectDetails(serverName: string, scope: McpScope | null | undefined, error: unknown): Promise<{ mcpReconnect?: McpReconnectHint; code?: McpConnectionErrorCode }> {
  const code = classifyMcpConnectionFailure(error);
  if (!code) return {};
  if (!scope?.userId || (code !== 'reauth_required' && code !== 'insufficient_scope')) return { code };
  const config = await readMcpConfig(scope);
  const connection = config.mcpServers[serverName] || Object.values(config.mcpServers).find((item) => item.connectionId === serverName);
  return connection?.connectionId && hasOAuth(connection) ? { code, mcpReconnect: { connectionId: connection.connectionId, serverName } } : { code };
}
