import 'server-only';

import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { assertUserOrganizationAdmin, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { readMcpConfig, type McpServerConfig } from './config';
import { requireMcpCredentialScope, type McpScope } from './scope';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from './server-definitions';

export type McpActor = { userId: string; organizationId: string | null; canManageDefinitions: boolean };

export class McpAccessError extends Error {
  constructor(message: string, public readonly status = 403, public readonly code = 'MCP_ACCESS_DENIED') {
    super(message);
    this.name = 'McpAccessError';
  }
}

export async function requireMcpUserAccess(scope?: McpScope | null): Promise<McpActor | null> {
  if (!scope?.userId && scope?.legacy !== true) throw new McpAccessError('Sign in to use MCP connections.', 401);
  let normalized: McpScope;
  try { normalized = requireMcpCredentialScope(scope); } catch { throw new McpAccessError('An explicit MCP user or system scope is required.', 401); }
  if (normalized.legacy) return null;
  const userId = normalized.userId!;
  const seat = await assertUserSeatAccess({ userId }).catch((error: unknown) => {
    if ((error as { status?: number })?.status === 403) throw new McpAccessError('An active account and seat are required.');
    throw error;
  });
  const state = await readOrganizationPermissionForUser(userId);
  if (state.configured && (state.permission?.status !== 'active' || state.permission.role === 'external')) throw new McpAccessError('An active organization membership is required.');
  if (state.configured && seat.mode === 'team' && seat.organizationId !== state.organizationId) throw new McpAccessError('The active seat belongs to another organization.');
  let canManageDefinitions = state.permission?.role === 'owner' || state.permission?.role === 'admin';
  if (!state.configured) {
    try { await assertUserOrganizationAdmin(userId); } catch { throw new McpAccessError('An active organization membership is required.'); }
    canManageDefinitions = true;
  }
  return { userId, organizationId: state.organizationId, canManageDefinitions };
}

export async function assertMcpConnectionAccess(
  serverNameOrId: string, scope?: McpScope | null,
  options: { allowDisabled?: boolean; management?: boolean; actor?: McpActor | null } = {},
): Promise<{ serverName: string; connection: McpServerConfig; actor: McpActor | null }> {
  const actor = options.actor === undefined ? await requireMcpUserAccess(scope) : options.actor;
  const normalized = requireMcpCredentialScope(scope);
  if (normalized.userId && (!actor || actor.userId !== normalized.userId)) throw new McpAccessError('MCP actor does not match the connection owner.');
  if (normalized.organizationId && actor && normalized.organizationId !== actor.organizationId) throw new McpAccessError('The requested organization is no longer active.');
  const config = await readMcpConfig(normalized);
  const selected = Object.entries(config.mcpServers).find(([name, item]) => item.connectionId === serverNameOrId || name === serverNameOrId);
  if (!selected) throw new McpAccessError('MCP connection not found.', 404, 'MCP_CONNECTION_NOT_FOUND');
  const [serverName, connection] = selected;
  if (actor && connection.ownerUserId !== actor.userId) throw new McpAccessError('MCP connection belongs to another user.');
  if (!options.allowDisabled && connection.enabled === false) throw new McpAccessError('MCP connection is disabled.', 409, 'MCP_CONNECTION_DISABLED');
  if (options.management) return { serverName, connection, actor };
  if (actor && connection.organizationId && connection.organizationId !== actor.organizationId) throw new McpAccessError('This connection belongs to another organization.');
  if (actor && connection.serverDefinitionId) {
    if (!connection.organizationId || connection.organizationId !== actor.organizationId) throw new McpAccessError('The server approval belongs to another organization.');
    const definition = (await listMcpServerDefinitions(connection.organizationId)).find((item) => item.id === connection.serverDefinitionId);
    if (!definition?.enabled || !matchesMcpServerDefinition(connection, definition)) throw new McpAccessError('The server approval was removed or changed. Choose an approved server in Settings.');
  } else if (actor && !actor.canManageDefinitions) {
    throw new McpAccessError('Members can use only organization-approved HTTP servers.');
  }
  return { serverName, connection, actor };
}

export function mcpErrorStatus(error: unknown, fallback = 500): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}
