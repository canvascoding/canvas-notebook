import { NextRequest, NextResponse } from 'next/server';

import {
  WorkspaceBrandLogoError,
  readWorkspaceBrandLogo,
  removeWorkspaceBrandLogo,
  saveWorkspaceBrandLogo,
} from '@/app/lib/workspaces/brand-logo-service';
import { readBrandLogoUpload } from '@/app/lib/workspaces/brand-logo-upload-request';
import { resolveWorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile-service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'private, no-cache',
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
      error: 'Select this workspace before managing its logo.',
    },
    { status: 409, headers: responseHeaders },
  );
}

function logoError(action: 'load' | 'remove' | 'upload', error: unknown): NextResponse {
  if (error instanceof WorkspaceBrandLogoError) {
    return NextResponse.json(
      { success: false, code: 'BRAND_LOGO_ERROR', error: error.message },
      { status: error.status, headers: responseHeaders },
    );
  }
  console.error(`[API] Mobile workspace brand logo ${action} failed:`, error);
  return NextResponse.json(
    {
      success: false,
      code: 'INTERNAL_ERROR',
      error: `The workspace logo could not be ${action === 'load' ? 'loaded' : action === 'upload' ? 'uploaded' : 'removed'}.`,
    },
    { status: 500, headers: responseHeaders },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-logo-read' });
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
    const logo = await readWorkspaceBrandLogo(state.profile, { workspace: workspaceResult.workspace });
    if (!logo) {
      return NextResponse.json(
        { success: false, code: 'BRAND_LOGO_NOT_FOUND', error: 'Logo not found.' },
        { status: 404, headers: responseHeaders },
      );
    }
    return new NextResponse(new Uint8Array(logo.buffer), {
      status: 200,
      headers: {
        ...responseHeaders,
        'Content-Length': String(logo.size),
        'Content-Type': logo.mimeType,
      },
    });
  } catch (error) {
    return logoError('load', error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 12, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-logo-upload' });
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
    const upload = await readBrandLogoUpload(request);
    if (!upload.ok) return upload.response;
    const result = await saveWorkspaceBrandLogo({
      buffer: upload.buffer,
      workspaceId,
      userId: workspaceResult.session.user.id,
      fileOptions: { workspace: workspaceResult.workspace },
    });
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json(
      { success: true, ...state, asset: result.asset, canManage: true },
      { headers: responseHeaders },
    );
  } catch (error) {
    return logoError('upload', error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const limited = rateLimit(request, { limit: 12, windowMs: 60_000, keyPrefix: 'mobile-workspace-brand-logo-remove' });
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
    await removeWorkspaceBrandLogo({
      workspaceId,
      userId: workspaceResult.session.user.id,
      fileOptions: { workspace: workspaceResult.workspace },
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
    return logoError('remove', error);
  }
}
