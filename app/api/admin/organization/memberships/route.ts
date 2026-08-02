import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { TeamSeatContractError } from '@/app/lib/license/team-seat-contract';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  assertOrganizationSeatProjectionNotOverLimit,
  SeatLimitGuardError,
} from '@/app/lib/license/seat-limit';
import {
  dispatchDirectMembershipSeatPreparation,
  membershipSeatQuotePayload,
} from '@/app/lib/organization/membership-seat-quote';
import {
  beginDirectMembershipActivation,
  MembershipOrchestratorError,
} from '@/app/lib/organization/membership-orchestrator';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import {
  isOrganizationAdminLike,
  isOrganizationBillingApprover,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function errorResponse(error: unknown) {
  if (
    error instanceof MembershipOrchestratorError
    || error instanceof SeatLimitGuardError
    || error instanceof TeamMembershipError
  ) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: error.status });
  }
  if (error instanceof LicenseControlPlaneError || error instanceof TeamSeatOutboxError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: error.status });
  }
  if (error instanceof TeamSeatContractError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: 502 });
  }
  console.error('[admin/organization/memberships] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not start membership activation.',
  }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

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
    await assertOrganizationSeatProjectionNotOverLimit({
      organizationId: state.organizationId,
    });

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
    const prepared = await dispatchDirectMembershipSeatPreparation({
      activation,
      actorUserId: admin.session.user.id,
    });
    return NextResponse.json({
      success: true,
      data: membershipSeatQuotePayload(
        prepared,
        isOrganizationBillingApprover(state.permission),
      ),
    }, { status: prepared.activation.replayed ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
