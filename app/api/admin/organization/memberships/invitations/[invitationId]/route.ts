import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  revokeTeamMembershipInvitation,
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{ invitationId: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-invitation-revoke',
  });
  if (!limited.ok) return limited.response;

  try {
    const state = await readOrganizationPermissionForUser(admin.session.user.id);
    if (
      !state.configured
      || !state.organizationId
      || !isOrganizationAdminLike(state.permission)
    ) {
      return NextResponse.json({
        success: false,
        code: 'ORGANIZATION_ADMIN_REQUIRED',
        error: 'An active organization owner or administrator is required.',
      }, { status: 403 });
    }
    const { invitationId } = await context.params;
    const invitation = await revokeTeamMembershipInvitation({
      organizationId: state.organizationId,
      invitationId,
      actorUserId: admin.session.user.id,
    });
    return NextResponse.json({ success: true, data: { invitation } });
  } catch (error) {
    if (error instanceof TeamInvitationError) {
      return NextResponse.json({
        success: false,
        code: error.code,
        error: error.message,
      }, { status: error.status });
    }
    console.error('[admin/organization/memberships/invitations/revoke] Request failed:', error);
    return NextResponse.json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'Could not revoke the Team invitation.',
    }, { status: 500 });
  }
}
