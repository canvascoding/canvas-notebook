import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import {
  listTeamLicenseEmailReviews,
  resolveTeamLicenseEmailReview,
  type TeamLicenseEmailReviewDecision,
} from '@/app/lib/license/team-license-email-review';
import { isOrganizationBillingApprover, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type OwnerAccess =
  | { ok: true; organizationId: string; userId: string }
  | { ok: false; response: NextResponse };

async function authorizedOwner(request: NextRequest): Promise<OwnerAccess> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  try {
    const organization = await readOrganizationPermissionForUser(session.user.id);
    if (organization.organizationId && isOrganizationBillingApprover(organization.permission)) {
      return { ok: true, organizationId: organization.organizationId, userId: session.user.id };
    }
    return { ok: false, response: NextResponse.json({ success: false, error: 'Organization owner required' }, { status: 403 }) };
  } catch {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Authorization unavailable' }, { status: 503 }) };
  }
}

export async function GET(request: NextRequest) {
  const owner = await authorizedOwner(request);
  if (!owner.ok) return owner.response;
  const database = await openDb();
  try {
    const data = await listTeamLicenseEmailReviews(database, owner.organizationId);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ success: false, error: 'License email review unavailable' }, { status: 503 });
  } finally {
    await database.close();
  }
}

export async function PATCH(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const owner = await authorizedOwner(request);
  if (!owner.ok) return owner.response;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000,
    keyPrefix: `team-license-email-review:${owner.userId}` });
  if (!limited.ok) return limited.response;
  const payload = await request.json().catch(() => null) as { jobId?: unknown; decision?: unknown } | null;
  const decisions: TeamLicenseEmailReviewDecision[] = ['confirmed_delivered', 'confirmed_not_delivered', 'do_not_send'];
  if (typeof payload?.jobId !== 'string' || payload.jobId.length < 1 || payload.jobId.length > 250
    || !decisions.includes(payload.decision as TeamLicenseEmailReviewDecision)) {
    return NextResponse.json({ success: false, error: 'Invalid review decision' }, { status: 400 });
  }
  const database = await openDb();
  try {
    const updated = await resolveTeamLicenseEmailReview(database, {
      organizationId: owner.organizationId, jobId: payload.jobId, actorUserId: owner.userId,
      decision: payload.decision as TeamLicenseEmailReviewDecision,
    });
    if (!updated) return NextResponse.json({ success: false, error: 'Review state changed; reload before acting' }, { status: 409 });
    return NextResponse.json({ success: true, status: payload.decision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ success: false, error: 'License email review unavailable' }, { status: 503 });
  } finally {
    await database.close();
  }
}
