import { NextResponse } from 'next/server';

import { getLicenseStatus } from '@/app/lib/license';
import { codeFromLicenseStatus } from '@/app/lib/license/error-codes';
import { logLicenseInfoThrottled } from '@/app/lib/license/logging';
import { resolveTeamSeatRolloutStatus } from '@/app/lib/license/team-seat-rollout';

export async function GET() {
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
  return NextResponse.json({ success: true, ...status, code, teamSeatRollout });
}
