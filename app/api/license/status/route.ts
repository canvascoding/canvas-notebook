import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { getLicenseStatus } from '@/app/lib/license';
import { getCommunityLicenseClaimStatus } from '@/app/lib/license/control-plane';
import { codeFromLicenseStatus } from '@/app/lib/license/error-codes';
import { logLicenseError, logLicenseInfoThrottled } from '@/app/lib/license/logging';
import { publicLicenseStatus } from '@/app/lib/license/status-response';
import { buildTeamSeatHealth } from '@/app/lib/license/team-seat-health';
import { readTeamSeatSyncDiagnostics } from '@/app/lib/license/team-seat-outbox';
import { resolveTeamSeatRolloutStatus } from '@/app/lib/license/team-seat-rollout';
import {
  isOrganizationBillingApprover,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';

export async function GET(request: NextRequest) {
  const status = await getLicenseStatus();
  const code = codeFromLicenseStatus(status);
  const teamSeatRollout = resolveTeamSeatRolloutStatus();
  logLicenseInfoThrottled('[license/status/api]', 'returning license status', {
    licensed: status.licensed,
    plan: status.plan,
    source: status.source,
    instanceId: status.instanceId,
    expiresAt: status.expiresAt,
    error: status.error,
    code,
  });

  let ownerHealth: Record<string, unknown> = {};
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    try {
      const organization = await readOrganizationPermissionForUser(session.user.id);
      if (
        organization.organizationId
        && isOrganizationBillingApprover(organization.permission)
      ) {
        const database = await openDb();
        try {
          const [diagnostics, claim] = await Promise.all([
            readTeamSeatSyncDiagnostics(database, organization.organizationId),
            getCommunityLicenseClaimStatus(),
          ]);
          ownerHealth = {
            teamSeatHealth: buildTeamSeatHealth({
              organizationId: organization.organizationId,
              diagnostics,
              claim,
              licenseStatus: status,
            }),
          };
        } finally {
          await database.close();
        }
      }
    } catch (error) {
      logLicenseError('[license/status/api]', 'owner Team Seat health unavailable', {
        hasSession: true,
      }, error);
      ownerHealth = {
        teamSeatHealth: null,
        teamSeatHealthError: {
          code: 'TEAM_SEAT_HEALTH_UNAVAILABLE',
          retryable: true,
        },
      };
    }
  }

  return NextResponse.json(
    {
      success: true,
      ...publicLicenseStatus(status, code),
      runtimeDatabaseProvider: getDatabaseProvider(),
      teamSeatRollout,
      ...ownerHealth,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
