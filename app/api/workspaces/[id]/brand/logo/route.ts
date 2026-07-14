import { NextRequest, NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import {
  WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES,
  WorkspaceBrandLogoError,
  readWorkspaceBrandLogo,
  removeWorkspaceBrandLogo,
  saveWorkspaceBrandLogo,
} from '@/app/lib/workspaces/brand-logo-service';
import { readWorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile-service';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

type RouteContext = {
  params: Promise<{ id: string }>;
};

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

function workspaceIdFromParams(id: string): string {
  return id.trim();
}

function contentLengthTooLarge(request: NextRequest): boolean {
  const value = Number(request.headers.get('content-length'));
  return Number.isFinite(value)
    && value > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
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
    const state = await readWorkspaceBrandProfile(workspaceId);
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

  if (contentLengthTooLarge(request)) {
    return NextResponse.json(
      { success: false, error: 'Logo file is too large. Maximum size is 1 MB.' },
      { status: 413 },
    );
  }

  try {
    const parsed = await parseMultipartFormData(request);
    if (!parsed.ok) return parsed.response;
    const files = parsed.formData.getAll('file').filter((value): value is File => value instanceof File);
    if (files.length !== 1) {
      return NextResponse.json({ success: false, error: 'Upload exactly one logo file.' }, { status: 400 });
    }
    const file = files[0];
    if (file.size > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Logo file is too large. Maximum size is 1 MB.' },
        { status: 413 },
      );
    }

    const result = await saveWorkspaceBrandLogo({
      buffer: Buffer.from(await file.arrayBuffer()),
      workspaceId,
      userId: workspaceResult.session.user.id,
      fileOptions: { workspace: workspaceResult.workspace },
    });
    return NextResponse.json({ success: true, ...result, canManage: true });
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
    const state = await removeWorkspaceBrandLogo({
      workspaceId,
      userId: workspaceResult.session.user.id,
      fileOptions: { workspace: workspaceResult.workspace },
    });
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    console.error('[API] Workspace brand logo removal failed:', error);
    return NextResponse.json({ success: false, error: 'Could not remove brand logo.' }, { status: 500 });
  }
}
