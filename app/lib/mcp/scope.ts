import path from 'node:path';

import { normalizeDataScopeId, resolveUserMcpDir } from '@/app/lib/runtime-data-paths';

export type McpScope = {
  userId?: string | null;
  organizationId?: string | null;
};

export function normalizeMcpScope(scope?: McpScope | null): McpScope | null {
  const userId = scope?.userId?.trim();
  if (!userId) return null;

  return {
    userId: normalizeDataScopeId(userId, 'userId'),
    organizationId: scope?.organizationId?.trim() || null,
  };
}

export function getMcpScopeKey(scope?: McpScope | null): string {
  const normalized = normalizeMcpScope(scope);
  if (!normalized?.userId) return 'legacy';
  return `user:${normalized.organizationId || 'personal'}:${normalized.userId}`;
}

export function resolveScopedMcpDir(scope?: McpScope | null): string | null {
  const normalized = normalizeMcpScope(scope);
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
