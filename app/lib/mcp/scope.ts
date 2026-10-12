import path from 'node:path';

import { normalizeDataScopeId, resolveUserMcpDir, resolveOrganizationDataRoot, type SecretDataStorageScope } from '@/app/lib/runtime-data-paths';
import type { IntegrationConnectionActor, IntegrationConnectionOperation, IntegrationConnectionRevisions, SharedIntegrationConnectionOwnership } from '@/app/lib/integration-tools/connections/contracts';

export type SharedMcpScope = {
  connectionRef: string;
  connectionId: string;
  ownership: SharedIntegrationConnectionOwnership;
  actor: IntegrationConnectionActor;
  operation: IntegrationConnectionOperation;
  revisions: IntegrationConnectionRevisions;
  authorizationRevision: string;
  toolName?: string;
};

export type McpScope = {
  userId?: string | null;
  organizationId?: string | null;
  legacy?: boolean;
  /** Issued by the shared connection service. It never identifies the requester as owner. */
  shared?: SharedMcpScope;
};

export const MCP_SYSTEM_SCOPE: McpScope = Object.freeze({ legacy: true });

export function resolveMcpSecretEnvScope(scope?: McpScope | null): SecretDataStorageScope {
  const owned = requireMcpCredentialScope(scope);
  if (owned.shared) return { secretScope: 'organization', organizationId: owned.shared.ownership.organizationId };
  return owned.userId ? { secretScope: 'user', userId: owned.userId } : { secretScope: 'system' };
}

export function normalizeMcpScope(scope?: McpScope | null): McpScope | null {
  if (scope?.shared) {
    if (scope.userId || scope.legacy) throw new Error('Shared MCP storage cannot use a personal or legacy scope.');
    const shared = structuredClone(scope.shared);
    if (!/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(shared.connectionRef)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(shared.connectionId)
      || !['organization', 'team'].includes(shared.ownership.type) || !['inspect', 'use', 'manage'].includes(shared.operation)
      || !shared.authorizationRevision?.trim() || !shared.actor.userId?.trim()
      || Object.values(shared.revisions).length !== 3
      || !Object.values(shared.revisions).every(value => Number.isSafeInteger(value) && value >= 1)) throw new Error('Invalid shared MCP scope.');
    const organizationId = normalizeDataScopeId(shared.ownership.organizationId, 'organizationId');
    if (scope.organizationId && scope.organizationId !== organizationId) throw new Error('Shared MCP organization does not match.');
    if (shared.ownership.type === 'team') normalizeDataScopeId(shared.ownership.workspaceId, 'workspaceId');
    Object.freeze(shared.actor); Object.freeze(shared.ownership); Object.freeze(shared.revisions); Object.freeze(shared);
    return { organizationId, shared };
  }
  const userId = scope?.userId?.trim();
  if (!userId) {
    if (scope?.legacy === true && !scope.organizationId) return MCP_SYSTEM_SCOPE;
    if (scope) throw new Error('MCP user scope is required.');
    return null;
  }
  if (scope?.legacy) throw new Error('Personal MCP scope cannot use legacy storage.');

  return {
    userId: normalizeDataScopeId(userId, 'userId'),
    organizationId: scope?.organizationId?.trim() ? normalizeDataScopeId(scope.organizationId.trim(), 'organizationId') : null,
  };
}

export function requireMcpCredentialScope(scope?: McpScope | null): McpScope {
  const normalized = normalizeMcpScope(scope);
  if (!normalized) throw new Error('MCP credentials require an explicit user or system scope.');
  return normalized;
}

export function getMcpScopeKey(scope?: McpScope | null): string {
  const normalized = normalizeMcpScope(scope);
  if (normalized?.shared) return `shared:${normalized.shared.ownership.organizationId}:${normalized.shared.connectionRef}:${normalized.shared.connectionId}`;
  if (!normalized?.userId) return 'legacy';
  return `user:${normalized.organizationId || 'personal'}:${normalized.userId}`;
}

export function resolveScopedMcpDir(scope?: McpScope | null): string | null {
  const normalized = normalizeMcpScope(scope);
  if (normalized?.shared) return path.join(resolveOrganizationDataRoot(normalized.shared.ownership.organizationId), 'mcp', 'shared', normalized.shared.connectionId);
  return normalized?.userId ? resolveUserMcpDir(normalized.userId) : null;
}

export function resolveScopedMcpPath(scope: McpScope | null | undefined, relativePath: string): string | null {
  const root = resolveScopedMcpDir(scope);
  if (!root) return null;
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Invalid MCP storage path.');
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid MCP storage path.');
  }
  return target;
}
