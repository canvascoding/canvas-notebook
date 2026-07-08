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
  removePostgresWorkspaceMemberForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import {
  removeProjectWorkspaceMember,
  removeTeamWorkspaceMember,
  resolveWorkspaceContextById,
  WorkspaceOperationError,
} from '@/app/lib/workspaces/service';

type RouteContext = {
  params: Promise<{ id: string; userId: string }>;
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

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id, userId } = await context.params;
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
        await removePostgresWorkspaceMemberForActor(actor, id, userId);
        return NextResponse.json({ success: true });
      } catch (error) {
        if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
        return jsonServerError('[API] Workspace member delete postgres error:', error, 'Could not remove workspace member');
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
      if (!workspace.permissions.canManageWorkspace) {
        throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
      }
      if ((workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') || !workspace.organizationId) {
        throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Workspace members are only supported for team and project workspaces.', 403);
      }
      if (workspace.workspaceType === 'project') {
        if (!workspace.projectId) {
          throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project workspace project id is required.', 409);
        }
        removeProjectWorkspaceMember(sqlite, {
          organizationId: workspace.organizationId,
          workspaceId: workspace.workspaceId,
          projectId: workspace.projectId,
          userId,
        });
      } else {
        removeTeamWorkspaceMember(sqlite, {
          organizationId: workspace.organizationId,
          workspaceId: workspace.workspaceId,
          userId,
        });
      }
      sqlite.exec('COMMIT');
      return NextResponse.json({ success: true });
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
      return jsonServerError('[API] Workspace member delete sqlite error:', error, 'Could not remove workspace member');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
    return jsonServerError('[API] Workspace member delete request error:', error, 'Could not remove workspace member');
  }
}
