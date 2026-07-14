import { NextRequest, NextResponse } from 'next/server';

import {
  WorkspaceBrandLogoError,
  readOrganizationBrandLogo,
  removeOrganizationBrandLogo,
  saveOrganizationBrandLogo,
} from '@/app/lib/workspaces/brand-logo-service';
import { readBrandLogoUpload } from '@/app/lib/workspaces/brand-logo-upload-request';
import { requireOrganizationBrandAdmin } from '@/app/lib/workspaces/organization-brand-request';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    const logo = await readOrganizationBrandLogo(access.organizationId);
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
    console.error('[API] Organization brand logo read failed:', error);
    return NextResponse.json({ success: false, error: 'Could not load organization brand logo.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    const upload = await readBrandLogoUpload(request);
    if (!upload.ok) return upload.response;
    const result = await saveOrganizationBrandLogo({
      buffer: upload.buffer,
      organizationId: access.organizationId,
      userId: access.session.user.id,
    });
    return NextResponse.json({ success: true, ...result, canManage: true });
  } catch (error) {
    if (error instanceof WorkspaceBrandLogoError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[API] Organization brand logo upload failed:', error);
    return NextResponse.json({ success: false, error: 'Could not upload organization brand logo.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    const state = await removeOrganizationBrandLogo({
      organizationId: access.organizationId,
      userId: access.session.user.id,
    });
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    console.error('[API] Organization brand logo removal failed:', error);
    return NextResponse.json({ success: false, error: 'Could not remove organization brand logo.' }, { status: 500 });
  }
}
