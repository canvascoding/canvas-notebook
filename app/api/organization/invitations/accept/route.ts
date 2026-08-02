import { NextRequest, NextResponse } from 'next/server';

import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  acceptTeamMembershipInvitation,
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
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
    };
    if (typeof body.token !== 'string' || typeof body.requestId !== 'string') {
      return NextResponse.json({
        success: false,
        code: 'INVITATION_INVALID',
        error: 'Invitation token and acceptance request ID are required.',
      }, { status: 400 });
    }
    const accepted = await acceptTeamMembershipInvitation({
      token: body.token,
      requestId: body.requestId,
    });
    return NextResponse.json({
      success: true,
      data: {
        invitationId: accepted.invitation.id,
        membershipId: accepted.membership.id,
        email: accepted.membership.candidateEmail,
        role: accepted.membership.role,
        stage: accepted.membership.status,
        replayed: accepted.replayed,
      },
    });
  } catch (error) {
    if (error instanceof TeamInvitationError) {
      return NextResponse.json({
        success: false,
        code: error.code,
        error: error.message,
      }, { status: error.status });
    }
    console.error('[organization/invitations/accept] Request failed:', error);
    return NextResponse.json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'Could not accept the Team invitation.',
    }, { status: 500 });
  }
}
