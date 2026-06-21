import 'server-only';

import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { OrganizationPermissionSnapshot } from '@/app/lib/organization/bootstrap';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type KnowledgeStore = 'personal_user' | 'team_workspace' | 'organization';
export type KnowledgeVisibility = 'private' | 'team' | 'organization';
export type KnowledgeScanStatus = 'pending' | 'clean' | 'flagged' | 'quarantined' | 'blocked';
export type KnowledgePolicyDecision = 'allow' | 'redact' | 'quarantine' | 'metadata-only' | 'block';
export type KnowledgeEmbeddingIndexStatus = 'disabled' | 'pending' | 'indexed' | 'requires_reindex' | 'revoked';

export interface KnowledgeSourceScope {
  organizationId: string | null;
  workspaceId: string | null;
  userId: string | null;
  knowledgeStore: KnowledgeStore;
  visibility: KnowledgeVisibility;
}

export interface KnowledgeRetrievalScope {
  actorUserId: string;
  personalUserIds: string[];
  teamWorkspaceIds: string[];
  organizationIds: string[];
  organizationKnowledgeIds: string[];
}

type RetrievalColumns = {
  organizationId: AnySQLiteColumn;
  workspaceId: AnySQLiteColumn;
  userId: AnySQLiteColumn;
  knowledgeStore: AnySQLiteColumn;
  scanStatus: AnySQLiteColumn;
  policyDecision: AnySQLiteColumn;
  embeddingIndexStatus: AnySQLiteColumn;
  revokedAt: AnySQLiteColumn;
};

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function persistedWorkspaceId(workspace: WorkspaceContext): string | null {
  return workspace.legacy ? null : workspace.workspaceId;
}

function assertReadableWorkspace(workspace: WorkspaceContext): void {
  if (!workspace.permissions.canRead || workspace.status === 'archived' || workspace.status === 'disabled' || workspace.status === 'recovery_locked') {
    throw new Error('Workspace is not readable for knowledge retrieval');
  }
}

export function knowledgeSourceScopeForWorkspace(workspace: WorkspaceContext): KnowledgeSourceScope {
  assertReadableWorkspace(workspace);

  if (workspace.workspaceType === 'personal') {
    const ownerUserId = workspace.ownerUserId ?? workspace.actor?.userId ?? null;
    if (!ownerUserId) {
      throw new Error('Personal knowledge sources require an owner user');
    }

    return {
      organizationId: workspace.organizationId ?? null,
      workspaceId: persistedWorkspaceId(workspace),
      userId: ownerUserId,
      knowledgeStore: 'personal_user',
      visibility: 'private',
    };
  }

  if (workspace.workspaceType === 'team' || workspace.workspaceType === 'project') {
    if (!workspace.organizationId) {
      throw new Error('Shared knowledge sources require an organization');
    }

    return {
      organizationId: workspace.organizationId,
      workspaceId: persistedWorkspaceId(workspace),
      userId: null,
      knowledgeStore: 'team_workspace',
      visibility: 'team',
    };
  }

  throw new Error(`Unsupported workspace type for knowledge retrieval: ${workspace.workspaceType}`);
}

function canUseOrganizationKnowledge(permission?: OrganizationPermissionSnapshot | null): boolean {
  return permission?.status === 'active' && (permission.role === 'owner' || permission.role === 'admin');
}

export function resolveKnowledgeRetrievalScope(input: {
  actorUserId: string;
  workspaces: WorkspaceContext[];
  organizationPermission?: OrganizationPermissionSnapshot | null;
  includeOrganizationKnowledge?: boolean;
}): KnowledgeRetrievalScope {
  const personalUserIds: string[] = [];
  const teamWorkspaceIds: string[] = [];
  const organizationIds: string[] = [];

  for (const workspace of input.workspaces) {
    if (!workspace.permissions.canRead || workspace.status === 'archived' || workspace.status === 'disabled' || workspace.status === 'recovery_locked') {
      continue;
    }

    if (workspace.organizationId) {
      organizationIds.push(workspace.organizationId);
    }

    if (workspace.workspaceType === 'personal') {
      const ownerUserId = workspace.ownerUserId ?? workspace.actor?.userId ?? null;
      if (ownerUserId === input.actorUserId) {
        personalUserIds.push(ownerUserId);
      }
      continue;
    }

    if ((workspace.workspaceType === 'team' || workspace.workspaceType === 'project') && workspace.organizationId) {
      const workspaceId = persistedWorkspaceId(workspace);
      if (workspaceId) {
        teamWorkspaceIds.push(workspaceId);
      }
    }
  }

  const readableOrganizationIds = unique(organizationIds);
  const organizationKnowledgeIds = input.includeOrganizationKnowledge && canUseOrganizationKnowledge(input.organizationPermission)
    ? readableOrganizationIds
    : [];

  return {
    actorUserId: input.actorUserId,
    personalUserIds: unique(personalUserIds),
    teamWorkspaceIds: unique(teamWorkspaceIds),
    organizationIds: readableOrganizationIds,
    organizationKnowledgeIds,
  };
}

export function knowledgeRetrievalCondition(scope: KnowledgeRetrievalScope, columns: RetrievalColumns): SQL {
  const scopeConditions: SQL[] = [];

  if (scope.personalUserIds.length > 0) {
    scopeConditions.push(and(
      eq(columns.knowledgeStore, 'personal_user'),
      inArray(columns.userId, scope.personalUserIds),
    )!);
  }

  if (scope.teamWorkspaceIds.length > 0 && scope.organizationIds.length > 0) {
    scopeConditions.push(and(
      eq(columns.knowledgeStore, 'team_workspace'),
      inArray(columns.organizationId, scope.organizationIds),
      inArray(columns.workspaceId, scope.teamWorkspaceIds),
    )!);
  }

  if (scope.organizationKnowledgeIds.length > 0) {
    scopeConditions.push(and(
      eq(columns.knowledgeStore, 'organization'),
      inArray(columns.organizationId, scope.organizationKnowledgeIds),
    )!);
  }

  if (scopeConditions.length === 0) {
    return sql`0 = 1`;
  }

  return and(
    isNull(columns.revokedAt),
    inArray(columns.policyDecision, ['allow', 'redact'] satisfies KnowledgePolicyDecision[]),
    inArray(columns.scanStatus, ['clean', 'flagged'] satisfies KnowledgeScanStatus[]),
    ne(columns.embeddingIndexStatus, 'revoked' satisfies KnowledgeEmbeddingIndexStatus),
    or(...scopeConditions)!,
  )!;
}
