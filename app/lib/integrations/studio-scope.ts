import 'server-only';

import { and, eq, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { StudioStorageScope } from '@/app/lib/integrations/studio-workspace';

export interface StudioScope {
  actorUserId: string;
  organizationId: string;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  storage: StudioStorageScope;
}

type ScopedColumns = {
  workspaceId: AnySQLiteColumn;
  createdByUserId?: AnySQLiteColumn;
};

export function createStudioScope(userId: string, workspace: WorkspaceContext): StudioScope {
  if (!workspace.permissions.canRead) {
    throw new Error('Studio workspace is not readable.');
  }
  const organizationId = workspace.organizationId?.trim();
  if (!organizationId) {
    throw new Error('Studio requires a persisted workspace with an organization.');
  }

  return {
    actorUserId: userId,
    organizationId,
    customerId: workspace.customerId ?? null,
    projectId: workspace.projectId ?? null,
    workspaceId: workspace.workspaceId,
    storage: {
      organizationId,
      workspaceId: workspace.workspaceId,
    },
  };
}

export function createPersistedStudioScope(input: {
  actorUserId: string;
  organizationId: string;
  customerId?: string | null;
  projectId?: string | null;
  workspaceId: string;
}): StudioScope {
  return {
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    customerId: input.customerId ?? null,
    projectId: input.projectId ?? null,
    workspaceId: input.workspaceId,
    storage: {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    },
  };
}

export function studioVisibilityCondition(
  scope: StudioScope,
  columns: ScopedColumns,
  creatorUserId?: string | null,
): SQL {
  const conditions: SQL[] = [eq(columns.workspaceId, scope.workspaceId)];
  const normalizedCreatorUserId = creatorUserId?.trim();
  if (normalizedCreatorUserId && columns.createdByUserId) {
    conditions.push(eq(columns.createdByUserId, normalizedCreatorUserId));
  }
  return conditions.length === 1 ? conditions[0] : and(...conditions)!;
}

export function studioInsertScope(scope: StudioScope): {
  organizationId: string;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  createdByUserId: string;
  visibility: 'workspace';
} {
  return {
    organizationId: scope.organizationId,
    customerId: scope.customerId,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    createdByUserId: scope.actorUserId,
    visibility: 'workspace',
  };
}
