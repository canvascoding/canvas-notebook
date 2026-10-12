import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { requireManagedTeamInvitationPolicy } from '@/app/lib/license/managed-team-invitation-policy';
import { resendTeamInvitationEmail, TeamInvitationEmailError } from '@/app/lib/organization/team-invitation-email';
import { isOrganizationAdminLike, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest, context: { params: Promise<{ invitationId: string }> }) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;
  const policyResponse = await requireManagedTeamInvitationPolicy();
  if (policyResponse) return policyResponse;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'admin-membership-invitation-resend' });
  if (!limited.ok) return limited.response;
  try {
    const state = await readOrganizationPermissionForUser(admin.session.user.id);
    if (!state.configured || !state.organizationId || !isOrganizationAdminLike(state.permission)) {
      return NextResponse.json({ success: false, code: 'ORGANIZATION_ADMIN_REQUIRED',
        error: 'An active organization owner or administrator is required.' }, { status: 403 });
    }
    const parsed = await readBoundedJson(request);
    if (parsed.response) return parsed.response;
    const body = (parsed.body ?? {}) as { requestId?: unknown; confirmDeliveryUnknown?: unknown; locale?: unknown };
    if (typeof body.requestId !== 'string') {
      return NextResponse.json({ success: false, code: 'INVITATION_INVALID', error: 'A UUID resend request ID is required.' }, { status: 400 });
    }
    const { invitationId } = await context.params;
    const result = await resendTeamInvitationEmail({
      organizationId: state.organizationId, invitationId, actorUserId: admin.session.user.id,
      requestId: body.requestId, confirmDeliveryUnknown: body.confirmDeliveryUnknown === true,
      locale: body.locale === 'de' ? 'de' : 'en',
    });
    return NextResponse.json({ success: true, data: {
      ...result, acceptancePath: result.token ? `/invite/team?token=${encodeURIComponent(result.token)}` : null,
    } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof TeamInvitationEmailError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, {
        status: error.status, headers: error.retryAfterSeconds !== null ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined,
      });
    }
    // Provider exceptions are persisted and reduced to safe codes in the
    // service. Unexpected failures must not expose invitation tokens or SMTP.
    return NextResponse.json({ success: false, code: 'INVITATION_EMAIL_STATUS_UNAVAILABLE',
      error: 'Could not process the invitation email request.' }, { status: 503 });
  }
}
