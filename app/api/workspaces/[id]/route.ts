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
  changePostgresWorkspaceTypeForActor,
  deletePostgresWorkspaceForActor,
  getPostgresWorkspaceState,
  updatePostgresWorkspaceForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import { WorkspaceOperationError } from '@/app/lib/workspaces/contracts';

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
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return workspaceOperationErrorResponse(error);
    }
    return jsonServerError('[API] Workspace delete request error:', error, 'Could not delete workspace');
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
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

        const workspace = Object.hasOwn(payload, 'type')
          ? await changePostgresWorkspaceTypeForActor(actor, workspaceId, {
              type: payload.type,
              projectId: payload.projectId,
            })
          : await updatePostgresWorkspaceForActor(actor, workspaceId, {
              name: payload.name,
              description: payload.description,
              icon: payload.icon,
              color: payload.color,
            });
        return NextResponse.json({ success: true, workspace });
    } catch (error) {
        if (error instanceof WorkspaceOperationError) {
          return workspaceOperationErrorResponse(error);
        }
        return jsonServerError('[API] Workspace type change postgres error:', error, 'Could not change workspace type');
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return workspaceOperationErrorResponse(error);
    }
    return jsonServerError('[API] Workspace type change request error:', error, 'Could not change workspace type');
  }
}
