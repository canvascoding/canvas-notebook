import { NextRequest, NextResponse } from 'next/server';

import { WorkspaceBrandProfileValidationError } from '@/app/lib/workspaces/brand-profile';
import { deleteManagedOrganizationBrandLogoFile } from '@/app/lib/workspaces/brand-logo-service';
import {
  readOrganizationBrandProfile,
  resetOrganizationBrandProfile,
  updateOrganizationBrandProfile,
} from '@/app/lib/workspaces/brand-profile-service';
import { requireOrganizationBrandAdmin } from '@/app/lib/workspaces/organization-brand-request';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    const state = await readOrganizationBrandProfile(access.organizationId);
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    console.error('[API] Organization brand profile read failed:', error);
    return NextResponse.json({ success: false, error: 'Could not load organization brand profile.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    const body = await request.json().catch(() => null) as { profile?: unknown } | null;
    const state = await updateOrganizationBrandProfile({
      organizationId: access.organizationId,
      userId: access.session.user.id,
      profile: body?.profile,
    });
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    if (error instanceof WorkspaceBrandProfileValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('[API] Organization brand profile update failed:', error);
    return NextResponse.json({ success: false, error: 'Could not save organization brand profile.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const access = await requireOrganizationBrandAdmin(request, id);
  if (!access.ok) return access.response;

  try {
    await deleteManagedOrganizationBrandLogoFile(access.organizationId);
    const state = await resetOrganizationBrandProfile(access.organizationId);
    return NextResponse.json({ success: true, ...state, canManage: true });
  } catch (error) {
    console.error('[API] Organization brand profile reset failed:', error);
    return NextResponse.json({ success: false, error: 'Could not reset organization brand profile.' }, { status: 500 });
  }
}
