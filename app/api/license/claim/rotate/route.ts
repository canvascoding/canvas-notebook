import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  communityLicenseClaimErrorPayload,
  LicenseControlPlaneError,
  rotateCommunityLicenseConnection,
} from '@/app/lib/license/control-plane';
import { TeamSeatRolloutError } from '@/app/lib/license/team-seat-rollout';
import { CommunityInstanceTokenStorageError } from '@/app/lib/license/storage';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 5,
    windowMs: 60_000,
    keyPrefix: 'license-community-token-rotate',
  });
  if (!limited.ok) return limited.response;

  try {
    const claim = await rotateCommunityLicenseConnection();
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
    if (error instanceof CommunityInstanceTokenStorageError) {
      return NextResponse.json(
        {
          success: false,
          error: 'The Community connection could not be rotated safely.',
          code: error.code,
          retryable: false,
        },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    console.error('[license/community-claim/rotate] Rotation failed without secret context:', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        error: 'The Community connection could not be rotated.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
