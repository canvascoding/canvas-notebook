import 'server-only';

import { getDatabaseProvider } from '@/app/lib/db/provider';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { serializeMobileWorkspace, type MobileWorkspaceSummary } from '@/app/lib/mobile/bootstrap';
import {
  createPostgresWorkspaceForActor,
  getPostgresWorkspaceState,
  listPostgresWorkspaceMembersForActor,
  updatePostgresWorkspaceForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import {
  createWorkspaceRecord,
  listProjectWorkspaceMembers,
  listTeamWorkspaceMembers,
  resolveWorkspaceContextById,
  updateWorkspaceRecord,
  WorkspaceOperationError,
  type WorkspaceMemberRecord,
} from '@/app/lib/workspaces/service';
import type { WorkspaceActor, WorkspaceType } from '@/app/lib/workspaces/types';

export type MobileWorkspaceMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: 'owner' | 'admin' | 'member' | 'external';
  status: 'active' | 'archived' | 'disabled' | 'recovery_locked';
  access: 'manage' | 'edit' | 'read';
};

type MobileWorkspaceMutationContext = {
  actor: WorkspaceActor;
};

function normalizeCreateType(value: unknown): WorkspaceType {
  if (value === 'team' || value === 'project') return value;
  throw new WorkspaceOperationError(
    'WORKSPACE_TYPE_INVALID',
    'Mobile can create team or project workspaces.',
    400,
  );
}

async function requireLicenseWhenEnabled(status: { teamFeaturesEnabled: boolean }): Promise<void> {
  if (status.teamFeaturesEnabled) await requireTeamRuntimeLicense();
}

export function serializeMobileWorkspaceMember(member: WorkspaceMemberRecord): MobileWorkspaceMember {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    access: member.canManage ? 'manage' : member.canWrite ? 'edit' : 'read',
  };
}

export async function createMobileWorkspace(
  input: MobileWorkspaceMutationContext & {
    type: unknown;
    name: unknown;
    description: unknown;
    icon?: unknown;
    color?: unknown;
    projectId?: unknown;
  },
): Promise<MobileWorkspaceSummary> {
  const type = normalizeCreateType(input.type);
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() || null : null;
  if (getDatabaseProvider() === 'postgres') {
    const state = await getPostgresWorkspaceState(input.actor);
    await requireLicenseWhenEnabled(state.status);
    const workspace = await createPostgresWorkspaceForActor(input.actor, {
      type,
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      projectFeaturesEnabled: areProjectFeaturesEnabled(),
      projectId,
    });
    return serializeMobileWorkspace(workspace);
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForUser(sqlite, input.actor.userId);
    await requireLicenseWhenEnabled(status);
    if (!status.organizationId) {
      throw new WorkspaceOperationError('WORKSPACE_ORGANIZATION_REQUIRED', 'Organization is not configured.', 409);
    }
    const workspace = createWorkspaceRecord(sqlite, {
      actor: input.actor,
      organizationId: status.organizationId,
      type,
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      teamFeaturesEnabled: status.teamFeaturesEnabled,
      projectFeaturesEnabled: areProjectFeaturesEnabled(),
      projectId,
    });
    sqlite.exec('COMMIT');
    return serializeMobileWorkspace(workspace);
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}

export async function updateMobileWorkspace(
  input: MobileWorkspaceMutationContext & {
    workspaceId: string;
    name: unknown;
    description: unknown;
    color?: unknown;
  },
): Promise<MobileWorkspaceSummary> {
  if (getDatabaseProvider() === 'postgres') {
    const state = await getPostgresWorkspaceState(input.actor);
    await requireLicenseWhenEnabled(state.status);
    const workspace = await updatePostgresWorkspaceForActor(input.actor, input.workspaceId, {
      name: input.name,
      description: input.description,
      color: input.color,
    });
    return serializeMobileWorkspace(workspace);
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForUser(sqlite, input.actor.userId);
    await requireLicenseWhenEnabled(status);
    const workspace = updateWorkspaceRecord(sqlite, {
      actor: input.actor,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      color: input.color,
    });
    sqlite.exec('COMMIT');
    return serializeMobileWorkspace(workspace);
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}

export async function listMobileWorkspaceMembers(input: MobileWorkspaceMutationContext & {
  workspaceId: string;
}): Promise<{ workspace: MobileWorkspaceSummary; members: MobileWorkspaceMember[] }> {
  if (getDatabaseProvider() === 'postgres') {
    const state = await getPostgresWorkspaceState(input.actor);
    await requireLicenseWhenEnabled(state.status);
    const result = await listPostgresWorkspaceMembersForActor(input.actor, input.workspaceId, {
      requireManage: false,
      includeCandidates: false,
    });
    return {
      workspace: serializeMobileWorkspace(result.workspace),
      members: result.members.map(serializeMobileWorkspaceMember),
    };
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN');
    const status = ensureOrganizationBootstrapForUser(sqlite, input.actor.userId);
    await requireLicenseWhenEnabled(status);
    const workspace = resolveWorkspaceContextById(sqlite, {
      actor: input.actor,
      workspaceId: input.workspaceId,
    });
    if (!workspace || !workspace.permissions.canRead) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') {
      throw new WorkspaceOperationError(
        'WORKSPACE_MEMBERS_UNSUPPORTED',
        'Member lists are available for team and project workspaces.',
        409,
      );
    }
    if (!workspace.organizationId || (workspace.workspaceType === 'project' && !workspace.projectId)) {
      throw new WorkspaceOperationError('WORKSPACE_CONTEXT_INVALID', 'Workspace membership is unavailable.', 409);
    }
    const members = workspace.workspaceType === 'project'
      ? listProjectWorkspaceMembers(sqlite, {
          workspaceId: workspace.workspaceId,
          organizationId: workspace.organizationId,
          projectId: workspace.projectId!,
        })
      : listTeamWorkspaceMembers(sqlite, workspace.workspaceId);
    sqlite.exec('COMMIT');
    return {
      workspace: serializeMobileWorkspace(workspace),
      members: members.map(serializeMobileWorkspaceMember),
    };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}
