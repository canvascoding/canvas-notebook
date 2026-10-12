import { NextRequest, NextResponse } from 'next/server';

import { openDb } from '@/app/lib/db';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import {
  getMemberSeatReductionStatuses,
  MAX_MEMBER_SEAT_REDUCTION_STATUS_USERS,
} from '@/app/lib/organization/member-seat-reduction-status';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const guard = await requireOrganizationPermission(request, 'canRecoverWorkspaces', {
    legacyAdminFallback: false,
    errorMessage: 'Organization recovery permission is required to read offboarding status.',
  });
  if (!guard.ok) return guard.response;
  if (!guard.state.organizationId) {
    return NextResponse.json({ success: false, error: 'Organization is not configured.' }, { status: 403 });
  }
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;
  const limited = rateLimit(request, {
    limit: 60, windowMs: 60_000, keyPrefix: 'admin-user-seat-reductions',
  });
  if (!limited.ok) return limited.response;
  const userIds = request.nextUrl.searchParams.getAll('userId');
  if (userIds.length > MAX_MEMBER_SEAT_REDUCTION_STATUS_USERS
    || userIds.some((userId) => !userId || userId.length > 200)) {
    return NextResponse.json({ success: false, error: 'Invalid user selection.' }, { status: 400 });
  }
  const database = await openDb();
  try {
    const reductions = await getMemberSeatReductionStatuses(database, {
      organizationId: guard.state.organizationId, userIds,
    });
    return NextResponse.json({ success: true, data: { reductions } });
  } catch (error) {
    console.error('[admin/user-seat-reductions] Status read failed', error);
    return NextResponse.json({ success: false, error: 'Could not read Seat reduction status.' }, { status: 500 });
  } finally {
    await database.close();
  }
}
