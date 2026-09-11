import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import type { ChatRequestContext } from '@/app/lib/chat/types';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { db, openDb } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import {
  resolveEffectiveSkillReadRoots,
  resolvePersonalSkillReadRoots,
} from '@/app/lib/skills/effective-skill-read-roots';
import {
  LEGACY_PERSONAL_WORKSPACE_ID,
  resolveWorkspaceActor,
} from '@/app/lib/workspaces/context';
import { resolveLegacyWorkspaceRecovery } from '@/app/lib/workspaces/legacy-recovery';
import { assertWorkspacePermission } from '@/app/lib/workspaces/permissions';
import {
  getPostgresWorkspaceState,
  findPostgresUserById,
  resolvePostgresWorkspaceForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext, WorkspacePermissions, WorkspaceType } from '@/app/lib/workspaces/types';
import { getWorkspaceBrandPromptBlock } from '@/app/lib/agents/workspace-brand-context';
import type { AgentExecutionContext } from './agent-execution-context';

export type WorkspacePermissionRequirement = keyof WorkspacePermissions;

export type PiSessionWorkspaceFields = {
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceName: string | null;
  workspaceRootRelativePath: string | null;
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
  customerId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  workspaceType: string | null;
  workspaceName: string | null;
  workspaceRootRelativePath: string | null;
};

const DEFAULT_AGENT_SESSION_PERMISSIONS: WorkspacePermissionRequirement[] = ['canRead', 'canRunAgent'];

function assertPermissions(
  workspace: WorkspaceContext,
  requirements: WorkspacePermissionRequirement[] = DEFAULT_AGENT_SESSION_PERMISSIONS,
): void {
  for (const requirement of requirements) {
    assertWorkspacePermission(workspace.permissions, requirement);
  }
}

function normalizeWorkspaceType(value: string | null | undefined): WorkspaceType {
  if (value === 'organization' || value === 'team' || value === 'project') return value;
  return 'personal';
}

function getDefaultWorkspaceName(workspaceType: WorkspaceType): string {
  if (workspaceType === 'organization') return 'Organization Workspace';
  if (workspaceType === 'team') return 'Team Workspace';
  if (workspaceType === 'project') return 'Project Workspace';
  return 'Personal Workspace';
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
    customerId: workspace.customerId ?? null,
    projectId: workspace.projectId ?? null,
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
    workspaceName: workspace.displayName || getDefaultWorkspaceName(workspace.workspaceType),
    workspaceDescription: workspace.description || undefined,
    organizationId: workspace.organizationId ?? null,
    canWrite: workspace.permissions.canWrite,
    canDelete: workspace.permissions.canDelete,
    canShare: workspace.permissions.canCreatePublicLinks,
    brandContext: workspace.brandContext,
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
    workspaceDescription: input.workspace.description ?? null,
    organizationId: input.workspace.organizationId ?? null,
    customerId: input.workspace.customerId ?? null,
    projectId: input.workspace.projectId ?? null,
    workspaceRoot: input.workspace.rootPath,
    workspaceRootRelativePath: input.workspace.rootRelativePath ?? null,
    skillReadRoots: [],
    canWrite: input.workspace.permissions.canWrite,
    canDelete: input.workspace.permissions.canDelete,
    canShare: input.workspace.permissions.canCreatePublicLinks,
    legacy: input.workspace.legacy,
    brandContext: input.workspace.brandContext,
  };
}

/**
 * Rebuild the workspace value required by lower-level services from an
 * execution context that was resolved for the current request. Keeping this
 * conversion here prevents collaboration code from recreating an authority
 * snapshot with subtly different permissions.
 */
export function workspaceFromAgentExecutionContext(executionContext: AgentExecutionContext): WorkspaceContext {
  return {
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    rootPath: executionContext.workspaceRoot,
    rootRelativePath: executionContext.workspaceRootRelativePath ?? undefined,
    displayName: executionContext.workspaceName ?? undefined,
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    permissions: {
      canRead: true,
      canWrite: executionContext.canWrite,
      canDelete: executionContext.canDelete,
      canCreatePublicLinks: executionContext.canShare,
      canManageWorkspace: false,
      canRunAgent: true,
    },
    legacy: executionContext.legacy,
  };
}

export async function addEffectiveSkillReadRoots(
  executionContext: AgentExecutionContext,
): Promise<AgentExecutionContext> {
  if (!executionContext.organizationId) {
    try {
      const skillReadRoots = await resolvePersonalSkillReadRoots({
        userId: executionContext.userId,
        agentId: executionContext.agentId,
      });
      return { ...executionContext, skillReadRoots };
    } catch (error) {
      console.warn('[AgentExecutionContext] Failed to resolve personal skill read roots:', error);
      return { ...executionContext, skillReadRoots: [] };
    }
  }

  try {
    const skillReadRoots = await resolveEffectiveSkillReadRoots({
      organizationId: executionContext.organizationId,
      userId: executionContext.userId,
      workspaceId: executionContext.workspaceId,
      projectId: executionContext.projectId,
      agentId: executionContext.agentId,
    });
    return { ...executionContext, skillReadRoots };
  } catch (error) {
    console.warn('[AgentExecutionContext] Failed to resolve effective skill read roots:', error);
    return { ...executionContext, skillReadRoots: [] };
  }
}

function piSessionWorkspaceFieldsChanged(
  session: PiSessionWorkspaceSnapshotRow,
  fields: PiSessionWorkspaceFields,
): boolean {
  return session.organizationId !== fields.organizationId ||
    session.customerId !== fields.customerId ||
    session.projectId !== fields.projectId ||
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
    workspaceName: row.workspaceName || getDefaultWorkspaceName(normalizeWorkspaceType(row.workspaceType)),
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
  let requestedWorkspaceId = normalizeRequestedWorkspaceId(input.workspaceId);

  if (requestedWorkspaceId === LEGACY_PERSONAL_WORKSPACE_ID) {
    if (!await resolveLegacyWorkspaceRecovery(input.userId)) {
      throw new Error('Workspace not found or inaccessible.');
    }
    // Old owner sessions continue in the persisted personal workspace after
    // the non-destructive legacy import, never with ambient DATA/workspace access.
    requestedWorkspaceId = null;
  }

  const database = await openDb();
  let user: Awaited<ReturnType<typeof findPostgresUserById>>;
  try {
    user = await findPostgresUserById(database, input.userId);
  } finally {
    await database.close();
  }

  if (!user) {
    throw new Error('Workspace not found or inaccessible.');
  }

  const actor = resolveWorkspaceActor({
    id: user.id,
    email: user.email,
    role: user.role,
  });
  const workspace = requestedWorkspaceId
    ? await resolvePostgresWorkspaceForActor(actor, requestedWorkspaceId)
    : (await getPostgresWorkspaceState(actor)).defaultWorkspace;
  if (!workspace) {
    throw new Error('Workspace not found or inaccessible.');
  }
  assertPermissions(workspace, input.permissions);
  return workspace;
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

  const brandContext = await getWorkspaceBrandPromptBlock(workspace.workspaceId);
  return brandContext ? { ...workspace, brandContext } : workspace;
}

export async function resolveAgentExecutionContextForSession(input: {
  sessionId: string;
  userId: string;
  agentId?: string | null;
  permissions?: WorkspacePermissionRequirement[];
}): Promise<AgentExecutionContext> {
  const workspace = await ensurePiSessionWorkspaceSnapshot({
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    permissions: input.permissions,
  });
  await requireAgentAccess(input.userId, input.agentId || DEFAULT_MANAGED_AGENT_ID, 'canUse', {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
  });

  return addEffectiveSkillReadRoots(workspaceToAgentExecutionContext({
    workspace,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId ?? null,
  }));
}

/**
 * Resolve an authority context for a persisted agent operation. Unlike the
 * runtime bootstrap helper, this must never fall back to a default workspace:
 * a queued operation is only valid while its original PI session still belongs
 * to the initiating user and agent.
 */
export async function resolveAgentExecutionContextForStoredSession(input: {
  sessionId: string;
  userId: string;
  agentId: string;
  permissions?: WorkspacePermissionRequirement[];
}): Promise<AgentExecutionContext> {
  const session = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, input.sessionId),
      eq(piSessions.userId, input.userId),
      eq(piSessions.agentId, input.agentId),
      isNull(piSessions.archivedAt),
    ),
  });
  if (!session) {
    throw new Error('The agent session is no longer available for this collaboration operation.');
  }

  return resolveAgentExecutionContextForSession(input);
}
