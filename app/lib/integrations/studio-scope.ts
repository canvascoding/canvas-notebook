import 'server-only';

import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { OrganizationPermissionSnapshot } from '@/app/lib/organization/bootstrap';

export interface StudioScope {
  actorUserId: string;
  organizationId: string | null;
  organizationWide: boolean;
  permission: OrganizationPermissionSnapshot | null;
}

type ScopedColumns = {
  userId: AnySQLiteColumn;
  organizationId: AnySQLiteColumn;
  createdByUserId: AnySQLiteColumn;
};

function isInternalActivePermission(permission: OrganizationPermissionSnapshot | null): boolean {
  if (!permission || permission.status !== 'active') return false;
  return permission.role === 'owner' || permission.role === 'admin' || permission.role === 'member';
}

export function resolveStudioScope(userId: string): StudioScope {
  const state = readOrganizationPermissionForUser(userId);
  const organizationWide = Boolean(
    state.configured &&
    state.teamFeaturesEnabled &&
    state.organizationId &&
    isInternalActivePermission(state.permission),
  );

  return {
    actorUserId: userId,
    organizationId: organizationWide ? state.organizationId : null,
    organizationWide,
    permission: state.permission,
  };
}

function creatorMatches(columns: ScopedColumns, creatorUserId?: string | null): SQL | undefined {
  const normalizedCreatorUserId = creatorUserId?.trim();
  if (!normalizedCreatorUserId) return undefined;

  return or(
    eq(columns.createdByUserId, normalizedCreatorUserId),
    and(isNull(columns.createdByUserId), eq(columns.userId, normalizedCreatorUserId)),
  );
}

function withCreator(base: SQL, columns: ScopedColumns, creatorUserId?: string | null): SQL {
  const creator = creatorMatches(columns, creatorUserId);
  return creator ? and(base, creator)! : base;
}

export function studioVisibilityCondition(
  scope: StudioScope,
  columns: ScopedColumns,
  creatorUserId?: string | null,
): SQL {
  if (scope.organizationWide && scope.organizationId) {
    const organizationVisible = withCreator(eq(columns.organizationId, scope.organizationId), columns, creatorUserId);
    // Rows that could not be backfilled into an organization remain personal-only.
    const ownLegacy = withCreator(and(isNull(columns.organizationId), eq(columns.userId, scope.actorUserId))!, columns, creatorUserId);
    return or(organizationVisible, ownLegacy)!;
  }

  return withCreator(eq(columns.userId, scope.actorUserId), columns, creatorUserId);
}

export function studioInsertScope(userId: string): {
  organizationId: string | null;
  createdByUserId: string;
  visibility: 'organization' | 'user';
} {
  const scope = resolveStudioScope(userId);
  return {
    organizationId: scope.organizationWide ? scope.organizationId : null,
    createdByUserId: userId,
    visibility: scope.organizationWide ? 'organization' : 'user',
  };
}
