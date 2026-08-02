import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { MembershipIdentityError } from '@/app/lib/auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { TeamSeatContractError } from '@/app/lib/license/team-seat-contract';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  executeTeamMembershipReactivation,
  prepareTeamMembershipReactivation,
} from '@/app/lib/organization/membership-reactivation';
import { MembershipSeatActivationError } from '@/app/lib/organization/membership-seat-activation';
import { membershipSeatQuotePayload } from '@/app/lib/organization/membership-seat-quote';
import { MembershipOrchestratorError } from '@/app/lib/organization/membership-orchestrator';
import {
  isOrganizationAdminLike,
  isOrganizationBillingApprover,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

function errorResponse(error: unknown) {
  if (
    error instanceof MembershipIdentityError
    || error instanceof MembershipOrchestratorError
    || error instanceof MembershipSeatActivationError
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
  console.error('[admin/organization/users/reactivation] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not reactivate the Team membership.',
  }, { status: 500 });
}

async function requireReactivationAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return { ok: false as const, response: licenseResponse };
  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (
    !state.configured
    || !state.organizationId
    || !isOrganizationAdminLike(state.permission)
  ) {
    return {
      ok: false as const,
      response: NextResponse.json({
        success: false,
        code: 'ORGANIZATION_ADMIN_REQUIRED',
        error: 'An active organization owner or administrator is required.',
      }, { status: 403 }),
    };
  }
  return {
    ok: true as const,
    admin,
    state,
    organizationId: state.organizationId,
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const access = await requireReactivationAdmin(request);
  if (!access.ok) return access.response;
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'admin-team-membership-reactivate-prepare',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const quote = await prepareTeamMembershipReactivation({
      organizationId: access.organizationId,
      userId,
      actorUserId: access.admin.session.user.id,
    });
    return NextResponse.json({
      success: true,
      data: membershipSeatQuotePayload(
        quote,
        isOrganizationBillingApprover(access.state.permission),
      ),
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const access = await requireReactivationAdmin(request);
  if (!access.ok) return access.response;
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'admin-team-membership-reactivate-execute',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const result = await executeTeamMembershipReactivation({
      organizationId: access.organizationId,
      userId,
      actorUserId: access.admin.session.user.id,
    });
    await recordAuditEvent({
      organizationId: access.organizationId,
      userId: access.admin.session.user.id,
      source: 'admin',
      eventType: 'admin',
      entityType: 'user',
      entityId: userId,
      action: 'organization.membership.reactivate',
      status: 'success',
      summary: `Team membership reactivation processed for ${userId}.`,
      metadata: {
        targetUserId: userId,
        membershipId: result.quote.activation.membership.id,
        stage: result.quote.activation.stage,
        operationStatus: result.execution.operation.status,
        paymentStatus: result.execution.operation.paymentStatus,
      },
    });
    return NextResponse.json({
      success: true,
      data: {
        ...membershipSeatQuotePayload(
          result.quote,
          isOrganizationBillingApprover(access.state.permission),
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
