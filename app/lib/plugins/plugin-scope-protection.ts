import 'server-only';

import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveDataStorageScope, type UserScopedDataStorageScope } from '@/app/lib/runtime-data-paths';

/** Resolve the user's current organization; caller-provided organization hints are never authoritative. */
export async function resolveActivePluginOrganizationScope(
  scope?: UserScopedDataStorageScope | null,
): Promise<{ scopeType: 'organization'; organizationId: string } | null> {
  const resolved = resolveDataStorageScope(scope);
  if (resolved.scopeType !== 'user' || !resolved.userId) return null;
  const state = await readOrganizationPermissionForUser(resolved.userId);
  return state.organizationId && state.permission?.status === 'active'
    ? { scopeType: 'organization', organizationId: state.organizationId }
    : null;
}
