import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { jsonServerError } from '@/app/lib/api/route-helpers';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { serializeWorkspaceContext } from '@/app/lib/workspaces/client-serialization';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  loadWorkspaceListingForActor,
  WorkspaceListingError,
} from '@/app/lib/workspaces/listing-action';
import {
  createPostgresWorkspaceForActor,
  getPostgresWorkspaceState,
} from '@/app/lib/workspaces/postgres-runtime';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';
import type { WorkspaceType } from '@/app/lib/workspaces/types';

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

    const listing = await loadWorkspaceListingForActor(actor);
    return NextResponse.json({
      success: true,
      ...listing,
      defaultWorkspace: listing.defaultWorkspace
        ? serializeWorkspaceContext(listing.defaultWorkspace)
        : null,
      workspaces: listing.workspaces.map(serializeWorkspaceContext),
    });
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode });
    }
    if (error instanceof WorkspaceListingError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
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

    try {
        const state = await getPostgresWorkspaceState(actor);
        const licenseResponse = await requireTeamRuntimeIfEnabled(state.status);
        if (licenseResponse) return licenseResponse;

        const workspace = await createPostgresWorkspaceForActor(actor, {
          type,
          name: payload.name,
          description: payload.description,
          icon: payload.icon,
          color: payload.color,
          projectFeaturesEnabled: areProjectFeaturesEnabled(),
          projectId,
        });
        return NextResponse.json({ success: true, workspace: serializeWorkspaceContext(workspace) }, { status: 201 });
    } catch (error) {
        if (error instanceof WorkspaceOperationError) {
          return workspaceOperationErrorResponse(error);
        }
        return jsonServerError('[API] Workspace create postgres error:', error, 'Could not create workspace');
    }
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return workspaceOperationErrorResponse(error);
    }
    return jsonServerError('[API] Workspaces create request error:', error, 'Could not create workspace');
  }
}
