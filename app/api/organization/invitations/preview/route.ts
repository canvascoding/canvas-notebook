import { NextRequest, NextResponse } from 'next/server';

import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  previewTeamMembershipInvitation,
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'membership-invitation-preview',
  });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => ({})) as { token?: unknown };
    if (typeof body.token !== 'string') {
      return NextResponse.json({
        success: false,
        code: 'INVITATION_INVALID',
        error: 'Invitation token is required.',
      }, { status: 400 });
    }
    const preview = await previewTeamMembershipInvitation({
      token: body.token,
    });
    const invitation = preview.invitation;
    return NextResponse.json({
      success: true,
      data: {
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        requestId: preview.resumeRequestId,
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
    console.error('[organization/invitations/preview] Request failed:', error);
    return NextResponse.json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'Could not preview the Team invitation.',
    }, { status: 500 });
  }
}
