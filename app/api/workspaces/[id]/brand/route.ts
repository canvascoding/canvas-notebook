import { NextRequest, NextResponse } from 'next/server';

import {
  WorkspaceBrandProfileValidationError,
} from '@/app/lib/workspaces/brand-profile';
import { deleteManagedWorkspaceBrandLogoFile } from '@/app/lib/workspaces/brand-logo-service';
import {
  resolveWorkspaceBrandProfile,
  resetWorkspaceBrandProfile,
  updateWorkspaceBrandProfile,
} from '@/app/lib/workspaces/brand-profile-service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function workspaceIdFromParams(id: string): string {
  return id.trim();
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const workspaceId = workspaceIdFromParams(id);
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: 'Workspace id is required.' }, { status: 400 });
  }

  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canRead',
  });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json({
      success: true,
      ...state,
      canManage: workspaceResult.workspace.permissions.canManageWorkspace,
    });
  } catch (error) {
    console.error('[API] Workspace brand profile read failed:', error);
    return NextResponse.json({ success: false, error: 'Could not load brand profile.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const workspaceId = workspaceIdFromParams(id);
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: 'Workspace id is required.' }, { status: 400 });
  }

  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canManageWorkspace',
  });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const body = await request.json().catch(() => null) as { profile?: unknown } | null;
    await updateWorkspaceBrandProfile({
      workspaceId,
      userId: workspaceResult.session.user.id,
      profile: body?.profile,
    });
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    if (error instanceof WorkspaceBrandProfileValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('[API] Workspace brand profile update failed:', error);
    return NextResponse.json({ success: false, error: 'Could not save brand profile.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const workspaceId = workspaceIdFromParams(id);
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: 'Workspace id is required.' }, { status: 400 });
  }

  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canManageWorkspace',
  });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    await deleteManagedWorkspaceBrandLogoFile({ workspace: workspaceResult.workspace });
    await resetWorkspaceBrandProfile(workspaceId);
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    console.error('[API] Workspace brand profile reset failed:', error);
    return NextResponse.json({ success: false, error: 'Could not reset brand profile.' }, { status: 500 });
  }
}
