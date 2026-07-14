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
    const logo = await readWorkspaceBrandLogo(state.profile, { workspace: workspaceResult.workspace });
    if (!logo) {
      return NextResponse.json({ success: false, error: 'Logo not found.' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(logo.buffer), {
      status: 200,
      headers: {
        'Content-Type': logo.mimeType,
        'Content-Length': String(logo.size),
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[API] Workspace brand logo read failed:', error);
    return NextResponse.json({ success: false, error: 'Could not load brand logo.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
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
    return NextResponse.json({ success: true, ...state, asset: result.asset, canManage: true });
  } catch (error) {
    if (error instanceof WorkspaceBrandLogoError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[API] Workspace brand logo upload failed:', error);
    return NextResponse.json({ success: false, error: 'Could not upload brand logo.' }, { status: 500 });
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
    await removeWorkspaceBrandLogo({
      workspaceId,
      userId: workspaceResult.session.user.id,
      fileOptions: { workspace: workspaceResult.workspace },
    });
    const state = await resolveWorkspaceBrandProfile(
      workspaceId,
      workspaceResult.workspace.organizationId,
    );
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    if (error instanceof WorkspaceBrandLogoError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[API] Workspace brand logo removal failed:', error);
    return NextResponse.json({ success: false, error: 'Could not remove brand logo.' }, { status: 500 });
  }
}
