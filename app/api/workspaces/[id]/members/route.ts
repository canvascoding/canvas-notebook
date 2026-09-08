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
  listPostgresWorkspaceMembersForActor,
  upsertPostgresWorkspaceMemberForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';

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
  } catch (error) {
    if (error instanceof WorkspaceOperationError) return workspaceOperationErrorResponse(error);
    return jsonServerError('[API] Workspace member update request error:', error, 'Could not update workspace member');
  }
}
