import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { MembershipIdentityError } from '@/app/lib/auth';
import {
  LicenseControlPlaneError,
} from '@/app/lib/license/control-plane';
import { TeamSeatContractError } from '@/app/lib/license/team-seat-contract';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { SeatLimitGuardError } from '@/app/lib/license/seat-limit';
import {
  executeDirectMembershipActivation,
  MembershipSeatActivationError,
} from '@/app/lib/organization/membership-seat-activation';
import { membershipSeatQuotePayload } from '@/app/lib/organization/membership-seat-quote';
import { MembershipOrchestratorError } from '@/app/lib/organization/membership-orchestrator';
import {
  isOrganizationAdminLike,
  isOrganizationBillingApprover,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{ membershipId: string }>;
};

function errorResponse(error: unknown) {
  if (
    error instanceof MembershipOrchestratorError
    || error instanceof MembershipIdentityError
    || error instanceof MembershipSeatActivationError
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
  console.error('[admin/organization/memberships/activate] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not activate the Team membership.',
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
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-seat-activate',
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
    const body = await request.json().catch(() => ({})) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    const { membershipId } = await context.params;
    const result = await executeDirectMembershipActivation({
      organizationId: state.organizationId,
      membershipId,
      actorUserId: admin.session.user.id,
      password,
    });
    return NextResponse.json({
      success: true,
      data: {
        ...membershipSeatQuotePayload(
          result.quote,
          isOrganizationBillingApprover(state.permission),
        ),
        execution: {
          status: result.execution.operation.status,
          paymentStatus: result.execution.operation.paymentStatus,
          replayed: result.execution.replayed,
          onboardingInitialized: result.onboardingInitialized,
        },
      },
    }, { status: result.quote.activation.stage === 'active' ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
