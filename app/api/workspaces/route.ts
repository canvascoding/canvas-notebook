import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { jsonServerError } from '@/app/lib/api/route-helpers';
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
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  createPostgresWorkspaceForActor,
  getPostgresWorkspaceState,
} from '@/app/lib/workspaces/postgres-runtime';
import {
  createWorkspaceRecord,
  listWorkspaceContextsForUser,
  resolveDefaultWorkspaceContext,
  WorkspaceOperationError,
} from '@/app/lib/workspaces/service';
import type { WorkspaceContext, WorkspaceType } from '@/app/lib/workspaces/types';

function serializeWorkspace(workspace: WorkspaceContext) {
  return {
    id: workspace.workspaceId,
    type: workspace.workspaceType,
    name: workspace.displayName || workspace.workspaceType,
    organizationId: workspace.organizationId,
    customerId: workspace.customerId,
    projectId: workspace.projectId,
    ownerUserId: workspace.ownerUserId,
    rootRelativePath: workspace.rootRelativePath,
    icon: workspace.icon,
    status: workspace.status || 'active',
    isDefault: Boolean(workspace.isDefault),
    permissions: workspace.permissions,
    legacy: workspace.legacy,
  };
}

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

function normalizeRequestedWorkspaceType(value: unknown): WorkspaceType {
  if (value === 'personal' || value === 'organization' || value === 'team' || value === 'project') {
    return value;
  }
  return 'personal';
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

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
        return NextResponse.json({
          success: true,
          organizationId: state.status.organizationId,
          teamFeaturesEnabled: state.status.teamFeaturesEnabled,
          projectFeaturesEnabled: areProjectFeaturesEnabled(),
          databaseProvider: state.status.databaseProvider,
          activeWorkspaceId: state.defaultWorkspace?.workspaceId || null,
          defaultWorkspace: state.defaultWorkspace ? serializeWorkspace(state.defaultWorkspace) : null,
          workspaces: state.workspaces.map(serializeWorkspace),
          warnings: state.status.warnings,
        });
      } catch (error) {
        return jsonServerError('[API] Workspaces postgres error:', error, 'Could not resolve workspaces');
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
      if (!status.organizationId) {
        sqlite.exec('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }

      const defaultWorkspace = resolveDefaultWorkspaceContext(sqlite, {
        actor,
        organizationId: status.organizationId,
      });
      const workspaces = listWorkspaceContextsForUser(sqlite, {
        actor,
        organizationId: status.organizationId,
      });
      sqlite.exec('COMMIT');

      return NextResponse.json({
        success: true,
        organizationId: status.organizationId,
        teamFeaturesEnabled: status.teamFeaturesEnabled,
        projectFeaturesEnabled: areProjectFeaturesEnabled(),
        databaseProvider: status.databaseProvider,
        activeWorkspaceId: defaultWorkspace?.workspaceId || null,
        defaultWorkspace: defaultWorkspace ? serializeWorkspace(defaultWorkspace) : null,
        workspaces: workspaces.map(serializeWorkspace),
        warnings: status.warnings,
      });
    } catch (error) {
      if (sqlite.inTransaction) {
        sqlite.exec('ROLLBACK');
      }
      return jsonServerError('[API] Workspaces sqlite error:', error, 'Could not resolve workspaces');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return jsonServerError('[API] Workspaces request error:', error, 'Could not resolve workspaces');
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const actor = resolveWorkspaceActor({
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });
    const type = normalizeRequestedWorkspaceType(payload.type);
    const projectId = typeof payload.projectId === 'string' ? payload.projectId.trim() || null : null;

    if (getDatabaseProvider() === 'postgres') {
      try {
        const state = await getPostgresWorkspaceState(actor);
        const licenseResponse = await requireTeamRuntimeIfEnabled(state.status);
        if (licenseResponse) return licenseResponse;

        const workspace = await createPostgresWorkspaceForActor(actor, {
          type,
          name: payload.name,
          icon: payload.icon,
          projectFeaturesEnabled: areProjectFeaturesEnabled(),
          projectId,
        });
        return NextResponse.json({ success: true, workspace: serializeWorkspace(workspace) }, { status: 201 });
      } catch (error) {
        if (error instanceof WorkspaceOperationError) {
          return workspaceOperationErrorResponse(error);
        }
        return jsonServerError('[API] Workspace create postgres error:', error, 'Could not create workspace');
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
      if (!status.organizationId) {
        sqlite.exec('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
      }

      const workspace = createWorkspaceRecord(sqlite, {
        actor,
        organizationId: status.organizationId,
        type,
        name: payload.name,
        icon: payload.icon,
        teamFeaturesEnabled: status.teamFeaturesEnabled,
        projectFeaturesEnabled: areProjectFeaturesEnabled(),
        projectId,
      });
      sqlite.exec('COMMIT');

      return NextResponse.json({ success: true, workspace: serializeWorkspace(workspace) }, { status: 201 });
    } catch (error) {
      if (sqlite.inTransaction) {
        sqlite.exec('ROLLBACK');
      }
      if (error instanceof WorkspaceOperationError) {
        return workspaceOperationErrorResponse(error);
      }
      return jsonServerError('[API] Workspace create sqlite error:', error, 'Could not create workspace');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return workspaceOperationErrorResponse(error);
    }
    return jsonServerError('[API] Workspaces create request error:', error, 'Could not create workspace');
  }
}
