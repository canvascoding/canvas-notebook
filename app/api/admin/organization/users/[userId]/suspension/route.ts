import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  MembershipSuspensionError,
  suspendTeamMembershipUser,
} from '@/app/lib/organization/membership-suspension';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

function errorResponse(error: unknown) {
  if (
    error instanceof MembershipSuspensionError
    || error instanceof TeamMembershipError
    || error instanceof TeamSeatOutboxError
  ) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: error.status });
  }
  console.error('[admin/organization/users/suspension] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not suspend the Team membership.',
  }, { status: 500 });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'admin-team-membership-suspend',
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
    const { userId } = await context.params;
    const body = await request.json().catch(() => ({})) as { reason?: unknown };
    const result = await suspendTeamMembershipUser({
      organizationId: state.organizationId,
      targetUserId: userId,
      actorUserId: admin.session.user.id,
      reason: typeof body.reason === 'string' ? body.reason : null,
    });
    await recordAuditEvent({
      organizationId: state.organizationId,
      userId: admin.session.user.id,
      source: 'admin',
      eventType: 'admin',
      entityType: 'user',
      entityId: userId,
      action: 'organization.membership.suspend',
      status: 'success',
      summary: `Team membership suspended for ${userId}.`,
      metadata: {
        targetUserId: userId,
        membershipId: result.membership.id,
        sessionsRevoked: result.sessionsRevoked,
        replayed: result.replayed,
      },
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
