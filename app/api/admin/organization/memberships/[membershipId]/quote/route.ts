import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  getCommunityTeamSeatQuoteStatus,
  LicenseControlPlaneError,
} from '@/app/lib/license/control-plane';
import { TeamSeatContractError } from '@/app/lib/license/team-seat-contract';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  dispatchDirectMembershipSeatPreparation,
  membershipSeatQuotePayload,
  refreshDirectMembershipSeatAuthorization,
} from '@/app/lib/organization/membership-seat-quote';
import {
  beginDirectMembershipSeatRequote,
  getDirectMembershipSeatQuote,
  MembershipOrchestratorError,
  recordDirectMembershipSeatAuthorizationStatus,
} from '@/app/lib/organization/membership-orchestrator';
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
  if (error instanceof MembershipOrchestratorError || error instanceof TeamMembershipError) {
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
  console.error('[admin/organization/memberships/quote] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not load the membership Seat quote.',
  }, { status: 500 });
}

async function requireMembershipAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) {
    return { ok: false as const, response: licenseResponse };
  }
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

export async function GET(request: NextRequest, context: RouteContext) {
  const access = await requireMembershipAdmin(request);
  if (!access.ok) return access.response;
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-seat-quote-status',
  });
  if (!limited.ok) return limited.response;

  try {
    const { membershipId } = await context.params;
    const current = await refreshDirectMembershipSeatAuthorization({
      organizationId: access.organizationId,
      membershipId,
      actorUserId: access.admin.session.user.id,
    });
    return NextResponse.json({
      success: true,
      data: membershipSeatQuotePayload(
        current,
        isOrganizationBillingApprover(access.state.permission),
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireMembershipAdmin(request);
  if (!access.ok) return access.response;
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-seat-quote-refresh',
  });
  if (!limited.ok) return limited.response;

  try {
    const { membershipId } = await context.params;
    const stored = await getDirectMembershipSeatQuote({
      organizationId: access.organizationId,
      membershipId,
    });
    const currentResponse = await getCommunityTeamSeatQuoteStatus(
      stored.preparation.quote.quoteId,
      { operationId: stored.activation.prepareOperation.operationId },
    );
    const current = await recordDirectMembershipSeatAuthorizationStatus({
      organizationId: access.organizationId,
      membershipId,
      response: currentResponse,
      actorUserId: access.admin.session.user.id,
    });
    if (current.preparation.authorization.status === 'approved') {
      return NextResponse.json({
        success: true,
        data: membershipSeatQuotePayload(
          current,
          isOrganizationBillingApprover(access.state.permission),
        ),
      });
    }
    const activation = await beginDirectMembershipSeatRequote({
      organizationId: access.organizationId,
      membershipId,
      staleQuoteId: stored.preparation.quote.quoteId,
      currentResponse,
      actorUserId: access.admin.session.user.id,
    });
    const prepared = await dispatchDirectMembershipSeatPreparation({
      activation,
      actorUserId: access.admin.session.user.id,
    });
    return NextResponse.json({
      success: true,
      data: membershipSeatQuotePayload(
        prepared,
        isOrganizationBillingApprover(access.state.permission),
      ),
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
