import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  communityLicenseClaimErrorPayload,
  getCommunityTeamUpgradePreflight,
  LicenseControlPlaneError,
} from '@/app/lib/license/control-plane';
import { getCommunityTeamManagementUrl } from '@/app/lib/license/instance';
import {
  resolveTeamSeatRolloutStatus,
  TeamSeatRolloutError,
} from '@/app/lib/license/team-seat-rollout';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 12,
    windowMs: 60_000,
    keyPrefix: 'license-community-team-preflight',
  });
  if (!limited.ok) return limited.response;

  try {
    const result = await getCommunityTeamUpgradePreflight();
    const localRollout = resolveTeamSeatRolloutStatus({
      observedProtocolVersion: result.protocolVersion,
    });
    const localUpgradeEnabled = localRollout.membershipMutations.effective;
    const blockers = [
      ...result.blockers,
      ...(!localUpgradeEnabled
        ? [{
            code: localRollout.membershipMutations.blocker === 'protocol_unsupported'
              || localRollout.membershipMutations.blocker === 'protocol_unchecked'
              ? 'TEAM_SEAT_PROTOCOL_UNSUPPORTED'
              : 'TEAM_SEAT_FEATURE_DISABLED',
            message: 'Team upgrades are not enabled for this Notebook rollout yet.',
          }]
        : []),
    ];
    const ready = result.ready && localUpgradeEnabled;
    return NextResponse.json(
      {
        success: true,
        preflight: {
          connected: true,
          accountVerified: result.license.claimed,
          ready,
          nextAction: ready ? result.nextAction : 'resolve_blockers',
          hostingMode: result.license.hostingMode,
          runtime: result.runtime,
          team: {
            active: result.team.active,
            billingStatus: result.team.billingStatus,
            licensedQuantity: result.team.licensedQuantity,
            nonBillable: result.team.nonBillable,
          },
          blockers,
          managementUrl: ready ? getCommunityTeamManagementUrl() : null,
        },
      },
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
    console.error('[license/community-team/preflight] Preflight failed without secret context:', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      {
        success: false,
        error: 'The Community Team preflight is unavailable.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
