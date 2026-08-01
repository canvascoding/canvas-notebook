import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  communityLicenseClaimErrorPayload,
  LicenseControlPlaneError,
  startCommunityLicenseClaim,
} from '@/app/lib/license/control-plane';
import { TeamSeatRolloutError } from '@/app/lib/license/team-seat-rollout';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: 'license-community-claim-start',
  });
  if (!limited.ok) return limited.response;

  try {
    const claim = await startCommunityLicenseClaim();
    return NextResponse.json(
      { success: true, claim },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof LicenseControlPlaneError || error instanceof TeamSeatRolloutError) {
      return NextResponse.json(
        communityLicenseClaimErrorPayload(error),
        {
          status: error instanceof LicenseControlPlaneError ? error.status : error.statusCode,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
    console.error('[license/community-claim/start] Claim start failed without secret context:', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        error: 'The Community claim could not be started.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
