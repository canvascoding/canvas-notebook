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
  deletePostgresWorkspaceForActor,
  getPostgresWorkspaceState,
} from '@/app/lib/workspaces/postgres-runtime';
import {
  deleteWorkspaceRecord,
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

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const workspaceId = id.trim();
    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: 'Workspace id is required.', code: 'WORKSPACE_ID_REQUIRED' },
        { status: 400 },
      );
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

        await deletePostgresWorkspaceForActor(actor, workspaceId);
        return NextResponse.json({ success: true });
      } catch (error) {
        if (error instanceof WorkspaceOperationError) {
          return workspaceOperationErrorResponse(error);
        }
        return jsonServerError('[API] Workspace delete postgres error:', error, 'Could not delete workspace');
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

      deleteWorkspaceRecord(sqlite, { actor, workspaceId });
      sqlite.exec('COMMIT');
      return NextResponse.json({ success: true });
    } catch (error) {
      if (sqlite.inTransaction) {
        sqlite.exec('ROLLBACK');
      }
      if (error instanceof WorkspaceOperationError) {
        return workspaceOperationErrorResponse(error);
      }
      return jsonServerError('[API] Workspace delete sqlite error:', error, 'Could not delete workspace');
    } finally {
      sqlite.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return workspaceOperationErrorResponse(error);
    }
    return jsonServerError('[API] Workspace delete request error:', error, 'Could not delete workspace');
  }
}
