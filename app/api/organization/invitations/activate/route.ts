import { NextRequest, NextResponse } from 'next/server';

import { MembershipIdentityError } from '@/app/lib/auth';
import { LicenseControlPlaneError } from '@/app/lib/license/control-plane';
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
  acceptTeamMembershipInvitation,
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { publicRateLimit, publicResourceRateLimit } from '@/app/lib/security/public-rate-limit';
import { readBoundedJson } from '@/app/lib/api/bounded-json';

function errorResponse(error: unknown) {
  if (
    error instanceof TeamInvitationError
    || error instanceof MembershipOrchestratorError
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
  console.error('[organization/invitations/activate] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not activate the invited Team membership.',
  }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const limited = await publicRateLimit({
    limit: 10,
    globalLimit: 200,
    windowMs: 60_000,
    keyPrefix: 'membership-invitation-activate',
  });
  if (!limited.ok) return limited.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  try {
    const parsed = await readBoundedJson(request);
    if (parsed.response) return parsed.response;
    const body = (parsed.body ?? {}) as {
      token?: unknown;
      requestId?: unknown;
      password?: unknown;
    };
    if (
      typeof body.token !== 'string'
      || typeof body.requestId !== 'string'
      || typeof body.password !== 'string'
    ) {
      return NextResponse.json({
        success: false,
        code: 'INVITATION_INVALID',
        error: 'Invitation token, acceptance request ID, and password are required.',
      }, { status: 400 });
    }
    const targetLimit = await publicResourceRateLimit({ limit: 20, windowMs: 60_000, keyPrefix: 'membership-invitation-activate' }, body.token);
    if (!targetLimit.ok) return targetLimit.response;
    const accepted = await acceptTeamMembershipInvitation({
      token: body.token,
      requestId: body.requestId,
    });
    const result = await executeDirectMembershipActivation({
      organizationId: accepted.invitation.organizationId,
      membershipId: accepted.membership.id,
      actorUserId: null,
      password: body.password,
    });
    return NextResponse.json({
      success: true,
      data: {
        invitationId: accepted.invitation.id,
        email: accepted.membership.candidateEmail,
        ...membershipSeatQuotePayload(result.quote, false),
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
