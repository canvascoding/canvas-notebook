import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { getCommunityLicenseClaimStatus } from '@/app/lib/license/control-plane';
import { logLicenseError } from '@/app/lib/license/logging';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'license-community-claim-status',
  });
  if (!limited.ok) return limited.response;

  try {
    const claim = await getCommunityLicenseClaimStatus();
    return NextResponse.json(
      { success: true, claim },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logLicenseError('[license/community-claim/status]', 'claim status lookup failed', {}, error);
    return NextResponse.json(
      {
        success: false,
        error: 'The Community claim status is unavailable.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
