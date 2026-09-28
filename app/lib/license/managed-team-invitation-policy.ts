import 'server-only';

import { NextResponse } from 'next/server';

import { getDeploymentMode } from '@/app/lib/organization/config';
import { getLicenseInstanceId } from './instance';
import { readManagedTeamAccessPolicy } from './managed-team-access-policy';

export async function requireManagedTeamInvitationPolicy(): Promise<NextResponse | null> {
  if (getDeploymentMode() !== 'managed-team') return null;

  const policy = await readManagedTeamAccessPolicy(getLicenseInstanceId());
  if (policy?.state === 'active' && policy.allowNewMembers === true) return null;

  const error = policy?.state === 'grace'
    ? 'The Team license has expired. New invitations are paused during the grace period until a new grant is issued in Control Plane.'
    : policy?.state === 'restricted'
      ? 'The Team license has ended or been revoked. A new grant in Control Plane is required before inviting members.'
      : 'The Team license policy has not synchronized yet. Retry after the instance has connected to Control Plane.';
  return NextResponse.json({
    success: false,
    code: 'MANAGED_TEAM_INVITATIONS_PAUSED',
    error,
  }, { status: 409 });
}
