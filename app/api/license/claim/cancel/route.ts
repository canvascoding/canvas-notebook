import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  cancelCommunityLicenseClaim,
  communityLicenseClaimErrorPayload,
  LicenseControlPlaneError,
} from '@/app/lib/license/control-plane';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'license-community-claim-cancel',
  });
  if (!limited.ok) return limited.response;

  const body = await request.json().catch(() => ({})) as { claimId?: unknown };
  const claimId = typeof body.claimId === 'string' ? body.claimId.trim() : '';
  if (!/^community-claim-[A-Za-z0-9-]{20,100}$/u.test(claimId)) {
    return NextResponse.json(
      {
        success: false,
        error: 'A valid Community claim ID is required.',
        code: 'TEAM_SEAT_INVALID_REQUEST',
        retryable: false,
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const claim = await cancelCommunityLicenseClaim(claimId);
    return NextResponse.json(
      { success: true, claim },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof LicenseControlPlaneError) {
      return NextResponse.json(
        communityLicenseClaimErrorPayload(error),
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    console.error('[license/community-claim/cancel] Claim cancellation failed without secret context:', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        error: 'The Community claim could not be canceled.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
