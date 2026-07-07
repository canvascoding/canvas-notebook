import { NextRequest, NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  getPostgresWorkspaceState,
  listPostgresWorkspaceMembersForActor,
  upsertPostgresWorkspaceMemberForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import {
  listProjectWorkspaceMembers,
  listTeamWorkspaceMembers,
  listWorkspaceMemberCandidates,
  resolveWorkspaceContextById,
  upsertProjectWorkspaceMember,
  upsertTeamWorkspaceMember,
  WorkspaceOperationError,
} from '@/app/lib/workspaces/service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function requireTeamRuntimeIfEnabled(status: { teamFeaturesEnabled: boolean }) {
  if (!status.teamFeaturesEnabled) return null;
  try {
    await requireTeamRuntimeLicense();
    return null;
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode });
    }
    throw error;
  }
}

function workspaceOperationErrorResponse(error: WorkspaceOperationError) {
  return NextResponse.json(
    { success: false, error: error.message, code: error.code },
    { status: error.status },
  );
}

function assertManageableMemberWorkspace(
  workspace: NonNullable<ReturnType<typeof resolveWorkspaceContextById>>,
) {
  if (!workspace.permissions.canManageWorkspace) {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
  }
  if (workspace.workspaceType === 'personal') {
    throw new WorkspaceOperationError('WORKSPACE_PERSONAL_NO_MEMBERS', 'Personal workspaces do not have members.', 403);
  }
  if (workspace.workspaceType === 'organization') {
    throw new WorkspaceOperationError(
      'WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG',
      'Organization workspace access is managed through organization users.',
      403,
    );
  }
  if (workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') {
    throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Workspace members are only supported for team and project workspaces.', 403);
  }
  if (workspace.workspaceType === 'project' && !workspace.projectId) {
    throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project workspace project id is required.', 409);
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const actor = resolveWorkspaceActor({
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });

    if (getDatabaseProvider() === 'postgres') {
      try {
        const state = await getPostgresWorkspaceState(actor);
        const licenseResponse = await requireTeamRuntimeIfEnabled(state.status);
        if (licenseResponse) return licenseResponse;
        const result = await listPostgresWorkspaceMembersForActor(actor, id);
        return NextResponse.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
        return jsonServerError('[API] Workspace members postgres error:', error, 'Could not load workspace members');
      }
    }

    const sqlite = openOrganizationBootstrapDatabase();
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
      const licenseResponse = await requireTeamRuntimeIfEnabled(status);
      if (licenseResponse) {
        sqlite.exec('ROLLBACK');
        return licenseResponse;
      }
      const workspace = resolveWorkspaceContextById(sqlite, { actor, workspaceId: id });
      if (!workspace) {
        throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
      }
      assertManageableMemberWorkspace(workspace);
      const members = workspace.workspaceType === 'project' && workspace.organizationId && workspace.projectId
        ? listProjectWorkspaceMembers(sqlite, {
            workspaceId: workspace.workspaceId,
            organizationId: workspace.organizationId,
            projectId: workspace.projectId,
          })
        : listTeamWorkspaceMembers(sqlite, workspace.workspaceId);
      const candidates = workspace.organizationId
        ? listWorkspaceMemberCandidates(sqlite, workspace.organizationId)
        : [];
      sqlite.exec('COMMIT');
      return NextResponse.json({ success: true, workspace, members, candidates });
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
      return jsonServerError('[API] Workspace members sqlite error:', error, 'Could not load workspace members');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
    return jsonServerError('[API] Workspace members request error:', error, 'Could not load workspace members');
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const actor = resolveWorkspaceActor({
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });

    if (getDatabaseProvider() === 'postgres') {
      try {
        const state = await getPostgresWorkspaceState(actor);
        const licenseResponse = await requireTeamRuntimeIfEnabled(state.status);
        if (licenseResponse) return licenseResponse;
        const member = await upsertPostgresWorkspaceMemberForActor(actor, id, {
          userId: payload.userId,
          role: payload.role,
          canRead: payload.canRead,
          canWrite: payload.canWrite,
          canManage: payload.canManage,
        });
        return NextResponse.json({ success: true, member });
      } catch (error) {
        if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
        return jsonServerError('[API] Workspace member update postgres error:', error, 'Could not update workspace member');
      }
    }

    const sqlite = openOrganizationBootstrapDatabase();
    try {
      sqlite.exec('BEGIN IMMEDIATE');
      const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
      const licenseResponse = await requireTeamRuntimeIfEnabled(status);
      if (licenseResponse) {
        sqlite.exec('ROLLBACK');
        return licenseResponse;
      }
      const workspace = resolveWorkspaceContextById(sqlite, { actor, workspaceId: id });
      if (!workspace) {
        throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
      }
      assertManageableMemberWorkspace(workspace);
      if (!workspace.organizationId) {
        throw new WorkspaceOperationError('WORKSPACE_ORGANIZATION_REQUIRED', 'Workspace organization is required.', 409);
      }
      const member = workspace.workspaceType === 'project'
        ? upsertProjectWorkspaceMember(sqlite, {
            actor,
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            projectId: workspace.projectId!,
            userId: payload.userId,
            role: payload.role,
            canRead: payload.canRead,
            canWrite: payload.canWrite,
            canManage: payload.canManage,
          })
        : upsertTeamWorkspaceMember(sqlite, {
            actor,
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            userId: payload.userId,
            role: payload.role,
            canRead: payload.canRead,
            canWrite: payload.canWrite,
            canManage: payload.canManage,
          });
      sqlite.exec('COMMIT');
      return NextResponse.json({ success: true, member });
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
      return jsonServerError('[API] Workspace member update sqlite error:', error, 'Could not update workspace member');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
    return jsonServerError('[API] Workspace member update request error:', error, 'Could not update workspace member');
  }
}
