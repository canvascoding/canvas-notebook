import { NextRequest, NextResponse } from 'next/server';

import { LicenseControlPlaneError } from '@/app/lib/license/control-plane';
import { TeamSeatContractError } from '@/app/lib/license/team-seat-contract';
import { TeamSeatOutboxError } from '@/app/lib/license/team-seat-outbox';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  prepareAcceptedInvitationSeat,
} from '@/app/lib/organization/invitation-seat-activation';
import { membershipSeatQuotePayload } from '@/app/lib/organization/membership-seat-quote';
import { MembershipOrchestratorError } from '@/app/lib/organization/membership-orchestrator';
import {
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
import { TeamMembershipError } from '@/app/lib/organization/team-membership';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'membership-invitation-accept',
  });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => ({})) as {
      token?: unknown;
      requestId?: unknown;
      refreshQuote?: unknown;
    };
    if (typeof body.token !== 'string' || typeof body.requestId !== 'string') {
      return NextResponse.json({
        success: false,
        code: 'INVITATION_INVALID',
        error: 'Invitation token and acceptance request ID are required.',
      }, { status: 400 });
    }
    const accepted = await prepareAcceptedInvitationSeat({
      token: body.token,
      requestId: body.requestId,
      refreshQuote: body.refreshQuote === true,
    });
    return NextResponse.json({
      success: true,
      data: {
        invitationId: accepted.invitation.id,
        email: accepted.quote.activation.membership.candidateEmail,
        role: accepted.quote.activation.membership.role,
        quote: membershipSeatQuotePayload(accepted.quote, false),
        replayed: accepted.replayed,
      },
    }, { status: 202 });
  } catch (error) {
    if (
      error instanceof TeamInvitationError
      || error instanceof MembershipOrchestratorError
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
    console.error('[organization/invitations/accept] Request failed:', error);
    return NextResponse.json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'Could not accept the Team invitation.',
    }, { status: 500 });
  }
}
