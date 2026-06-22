import 'server-only';

import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';

import type { ChatRequestContext } from '@/app/lib/chat/types';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import {
  ensureOrganizationBootstrapForUser,
} from '@/app/lib/organization/bootstrap';
import {
  LEGACY_PERSONAL_WORKSPACE_ID,
  createLegacyPersonalWorkspaceContext,
  resolveWorkspaceActor,
  resolveWorkspaceDataRoot,
} from '@/app/lib/workspaces/context';
import { assertWorkspacePermission } from '@/app/lib/workspaces/permissions';
import {
  ensureDefaultWorkspaceRecords,
  resolveDefaultWorkspaceContext,
  resolveWorkspaceContextById,
} from '@/app/lib/workspaces/service';
import type { WorkspaceContext, WorkspacePermissions, WorkspaceType } from '@/app/lib/workspaces/types';
import type { AgentExecutionContext } from './agent-execution-context';

export type WorkspacePermissionRequirement = keyof WorkspacePermissions;

export type PiSessionWorkspaceFields = {
  organizationId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  workspaceRootRelativePath: string | null;
};

type UserRow = {
  id: string;
  email: string | null;
  role: string | null;
};

type OrganizationRow = {
  organization_id: string;
  team_features_enabled: number;
};

type StoredPiSessionWorkspace = {
  workspaceId: string | null;
  workspaceType: string | null;
  workspaceName: string | null;
  workspaceRootRelativePath: string | null;
  organizationId: string | null;
};

type PiSessionWorkspaceSnapshotRow = {
  organizationId: string | null;
  workspaceId: string | null;
  workspaceType: string | null;
  workspaceName: string | null;
  workspaceRootRelativePath: string | null;
};

const DEFAULT_AGENT_SESSION_PERMISSIONS: WorkspacePermissionRequirement[] = ['canRead', 'canRunAgent'];

let workspaceContextDatabase: { sqlitePath: string; sqlite: Database.Database } | null = null;

function openWorkspaceContextDatabase(): Database.Database {
  const sqlitePath = path.join(resolveWorkspaceDataRoot(), 'sqlite.db');
  if (workspaceContextDatabase?.sqlitePath === sqlitePath && workspaceContextDatabase.sqlite.open) {
    return workspaceContextDatabase.sqlite;
  }

  if (workspaceContextDatabase?.sqlite.open) {
    workspaceContextDatabase.sqlite.close();
  }

  const sqlite = new Database(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  workspaceContextDatabase = { sqlitePath, sqlite };
  return sqlite;
}

function getUserRow(sqlite: Database.Database, userId: string): UserRow | null {
  return sqlite.prepare(`
    SELECT id, email, role
    FROM user
    WHERE id = ?
    LIMIT 1
  `).get(userId) as UserRow | undefined || null;
}

function getPrimaryOrganizationRow(sqlite: Database.Database): OrganizationRow | null {
  return sqlite.prepare(`
    SELECT organization_id, team_features_enabled
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as OrganizationRow | undefined || null;
}

function ensureWorkspaceRecordsForExistingOrganization(
  sqlite: Database.Database,
  organization: OrganizationRow,
  userId: string,
): void {
  ensureDefaultWorkspaceRecords(sqlite, {
    organizationId: organization.organization_id,
    userId,
    teamFeaturesEnabled: organization.team_features_enabled === 1,
  });
}

function assertPermissions(
  workspace: WorkspaceContext,
  requirements: WorkspacePermissionRequirement[] = DEFAULT_AGENT_SESSION_PERMISSIONS,
): void {
  for (const requirement of requirements) {
    assertWorkspacePermission(workspace.permissions, requirement);
  }
}

function normalizeWorkspaceType(value: string | null | undefined): WorkspaceType {
  if (value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeRequestedWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function requestedWorkspaceIdFromChatContext(context?: ChatRequestContext | null): string | null {
  return normalizeRequestedWorkspaceId(context?.workspace?.workspaceId);
}

export function workspaceToPiSessionFields(workspace: WorkspaceContext): PiSessionWorkspaceFields {
  return {
    organizationId: workspace.organizationId ?? null,
    workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType,
    workspaceName: workspace.displayName ?? null,
    workspaceRootRelativePath: workspace.rootRelativePath ?? null,
  };
}

export function workspaceToChatRequestWorkspace(workspace: WorkspaceContext): NonNullable<ChatRequestContext['workspace']> {
  return {
    workspaceId: workspace.workspaceId,
    workspaceType: workspace.workspaceType,
    workspaceName: workspace.displayName || (workspace.workspaceType === 'team' ? 'Team Workspace' : 'Personal Workspace'),
    organizationId: workspace.organizationId ?? null,
    canWrite: workspace.permissions.canWrite,
    canShare: workspace.permissions.canCreatePublicLinks,
  };
}

export function workspaceToAgentExecutionContext(input: {
  workspace: WorkspaceContext;
  userId: string;
  sessionId: string;
  agentId?: string | null;
}): AgentExecutionContext {
  return {
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId ?? null,
    workspaceId: input.workspace.workspaceId,
    workspaceType: input.workspace.workspaceType,
    workspaceName: input.workspace.displayName ?? null,
    organizationId: input.workspace.organizationId ?? null,
    customerId: input.workspace.customerId ?? null,
    projectId: input.workspace.projectId ?? null,
    workspaceRoot: input.workspace.rootPath,
    workspaceRootRelativePath: input.workspace.rootRelativePath ?? null,
    canWrite: input.workspace.permissions.canWrite,
    canShare: input.workspace.permissions.canCreatePublicLinks,
    legacy: input.workspace.legacy,
  };
}

function piSessionWorkspaceFieldsChanged(
  session: PiSessionWorkspaceSnapshotRow,
  fields: PiSessionWorkspaceFields,
): boolean {
  return session.organizationId !== fields.organizationId ||
    session.workspaceId !== fields.workspaceId ||
    session.workspaceType !== fields.workspaceType ||
    session.workspaceName !== fields.workspaceName ||
    session.workspaceRootRelativePath !== fields.workspaceRootRelativePath;
}

export function storedPiSessionWorkspaceToSummary(row: StoredPiSessionWorkspace | null | undefined) {
  if (!row?.workspaceId) return null;
  return {
    workspaceId: row.workspaceId,
    workspaceType: normalizeWorkspaceType(row.workspaceType),
    workspaceName: row.workspaceName || (row.workspaceType === 'team' ? 'Team Workspace' : 'Personal Workspace'),
    organizationId: row.organizationId ?? null,
    rootRelativePath: row.workspaceRootRelativePath ?? null,
    legacy: row.workspaceId === LEGACY_PERSONAL_WORKSPACE_ID,
  };
}

export async function resolveAgentSessionWorkspaceForUser(input: {
  userId: string;
  workspaceId?: string | null;
  permissions?: WorkspacePermissionRequirement[];
}): Promise<WorkspaceContext> {
  const requestedWorkspaceId = normalizeRequestedWorkspaceId(input.workspaceId);

  if (requestedWorkspaceId === LEGACY_PERSONAL_WORKSPACE_ID) {
    const legacyWorkspace = createLegacyPersonalWorkspaceContext(resolveWorkspaceActor({ id: input.userId }));
    assertPermissions(legacyWorkspace, input.permissions);
    return legacyWorkspace;
  }

  const sqlite = openWorkspaceContextDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    let organization = getPrimaryOrganizationRow(sqlite);
    if (organization) {
      ensureWorkspaceRecordsForExistingOrganization(sqlite, organization, input.userId);
    } else {
      const status = ensureOrganizationBootstrapForUser(sqlite, input.userId);
      organization = status.organizationId
        ? {
          organization_id: status.organizationId,
          team_features_enabled: status.teamFeaturesEnabled ? 1 : 0,
        }
        : null;
    }

    const userRow = getUserRow(sqlite, input.userId);
    if (!organization || !userRow) {
      sqlite.exec('ROLLBACK');
      throw new Error('Organization workspace context is not configured for this user.');
    }

    const actor = resolveWorkspaceActor({
      id: userRow.id,
      email: userRow.email,
      role: userRow.role,
    });

    const workspace = requestedWorkspaceId
      ? resolveWorkspaceContextById(sqlite, { actor, workspaceId: requestedWorkspaceId })
      : resolveDefaultWorkspaceContext(sqlite, { actor, organizationId: organization.organization_id });

    sqlite.exec('COMMIT');

    if (!workspace) {
      throw new Error('Workspace not found or inaccessible.');
    }

    assertPermissions(workspace, input.permissions);
    return workspace;
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    throw error;
  }
}

export async function ensurePiSessionWorkspaceSnapshot(input: {
  sessionId: string;
  userId: string;
  agentId?: string | null;
  requestedWorkspaceId?: string | null;
  permissions?: WorkspacePermissionRequirement[];
}): Promise<WorkspaceContext> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      ...(input.agentId ? [eq(piSessions.agentId, input.agentId)] : []),
    ),
  });

  const workspace = await resolveAgentSessionWorkspaceForUser({
    userId: input.userId,
    workspaceId: session?.workspaceId || input.requestedWorkspaceId || null,
    permissions: input.permissions,
  });

  const workspaceFields = workspaceToPiSessionFields(workspace);
  if (session && piSessionWorkspaceFieldsChanged(session, workspaceFields)) {
    await db
      .update(piSessions)
      .set({
        ...workspaceFields,
        updatedAt: new Date(),
      })
      .where(eq(piSessions.id, session.id));
  }

  return workspace;
}

export async function resolveAgentExecutionContextForSession(input: {
  sessionId: string;
  userId: string;
  agentId?: string | null;
}): Promise<AgentExecutionContext> {
  const workspace = await ensurePiSessionWorkspaceSnapshot({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
  });

  return workspaceToAgentExecutionContext({
    workspace,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId ?? null,
  });
}
