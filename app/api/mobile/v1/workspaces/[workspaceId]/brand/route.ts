import { NextRequest, NextResponse } from 'next/server';

import { WorkspaceBrandProfileValidationError } from '@/app/lib/workspaces/brand-profile';
import { deleteManagedWorkspaceBrandLogoFile } from '@/app/lib/workspaces/brand-logo-service';
import {
  resolveWorkspaceBrandProfile,
  resetWorkspaceBrandProfile,
  updateWorkspaceBrandProfile,
} from '@/app/lib/workspaces/brand-profile-service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function contextMismatch(request: NextRequest, workspaceId: string): NextResponse | null {
  const selectedWorkspaceId = request.headers.get('x-canvas-workspace-id')?.trim() || '';
  if (workspaceId && selectedWorkspaceId === workspaceId) return null;
  return NextResponse.json(
    {
      success: false,
      code: 'WORKSPACE_CONTEXT_MISMATCH',
      error: 'Select this workspace before managing its brand.',
    },
    { status: 409, headers: responseHeaders },
  );
}

function internalError(action: 'load' | 'reset' | 'save', error: unknown): NextResponse {
  console.error(`[API] Mobile workspace brand ${action} failed:`, error);
  return NextResponse.json(
    {
      success: false,
      code: 'INTERNAL_ERROR',
      error: `The workspace brand could not be ${action === 'load' ? 'loaded' : action === 'save' ? 'saved' : 'reset'}.`,
    },
    { status: 500, headers: responseHeaders },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-read' });
  if (!limited.ok) return limited.response;
  const { workspaceId: rawWorkspaceId } = await context.params;
  const workspaceId = rawWorkspaceId.trim();
  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canRead',
  });
  if (workspaceResult.response) return workspaceResult.response;
  const mismatch = contextMismatch(request, workspaceId);
  if (mismatch) return mismatch;

  try {
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json(
      {
        success: true,
        ...state,
        canManage: workspaceResult.workspace.permissions.canManageWorkspace,
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    return internalError('load', error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-update' });
  if (!limited.ok) return limited.response;
  const { workspaceId: rawWorkspaceId } = await context.params;
  const workspaceId = rawWorkspaceId.trim();
  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canManageWorkspace',
  });
  if (workspaceResult.response) return workspaceResult.response;
  const mismatch = contextMismatch(request, workspaceId);
  if (mismatch) return mismatch;

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
    return NextResponse.json(
      { success: true, ...state, canManage: true },
      { headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof WorkspaceBrandProfileValidationError) {
      return NextResponse.json(
        { success: false, code: 'INVALID_BRAND_PROFILE', error: error.message },
        { status: 400, headers: responseHeaders },
      );
    }
    return internalError('save', error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-reset' });
  if (!limited.ok) return limited.response;
  const { workspaceId: rawWorkspaceId } = await context.params;
  const workspaceId = rawWorkspaceId.trim();
  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId,
    permissions: 'canManageWorkspace',
  });
  if (workspaceResult.response) return workspaceResult.response;
  const mismatch = contextMismatch(request, workspaceId);
  if (mismatch) return mismatch;

  try {
    await deleteManagedWorkspaceBrandLogoFile({ workspace: workspaceResult.workspace });
    await resetWorkspaceBrandProfile(workspaceId);
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json(
      { success: true, ...state, canManage: true },
      { headers: responseHeaders },
    );
  } catch (error) {
    return internalError('reset', error);
  }
}
