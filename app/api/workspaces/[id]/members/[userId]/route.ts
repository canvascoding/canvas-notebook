import { NextRequest, NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  getPostgresWorkspaceState,
  removePostgresWorkspaceMemberForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import { WorkspaceOperationError } from '@/app/lib/workspaces/contracts';

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
  } catch (error) {
    if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
    return jsonServerError('[API] Workspace member delete request error:', error, 'Could not remove workspace member');
  }
}
