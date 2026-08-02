import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  beginDirectMembershipActivation,
  MembershipOrchestratorError,
} from '@/app/lib/organization/membership-orchestrator';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function errorResponse(error: unknown) {
  if (error instanceof MembershipOrchestratorError || error instanceof TeamMembershipError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: error.status });
  }
  console.error('[admin/organization/memberships] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not start membership activation.',
  }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-create',
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

    const body = await request.json().catch(() => ({})) as {
      name?: unknown;
      email?: unknown;
      role?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const role = body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : null;
    if (!name || !email || !role) {
      return NextResponse.json({
        success: false,
        code: 'INVALID_MEMBERSHIP_CANDIDATE',
        error: 'Name, email, and a supported organization role are required.',
      }, { status: 400 });
    }

    const activation = await beginDirectMembershipActivation({
      organizationId: state.organizationId,
      actorUserId: admin.session.user.id,
      email,
      displayName: name,
      role,
    });
    return NextResponse.json({
      success: true,
      data: {
        stage: activation.stage,
        membershipId: activation.membership.id,
        operationId: activation.prepareOperation.operationId,
        desiredQuantity: activation.desiredQuantity,
        observedQuantity: activation.observedQuantity,
        replayed: activation.replayed,
      },
    }, { status: activation.replayed ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
