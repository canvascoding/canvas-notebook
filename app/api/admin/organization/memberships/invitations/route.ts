import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { requireManagedTeamInvitationPolicy } from '@/app/lib/license/managed-team-invitation-policy';
import { areExternalUsersEnabled } from '@/app/lib/organization/features';
import {
  createTeamMembershipInvitation,
  expireTeamMembershipInvitations,
  listTeamMembershipInvitations,
  TeamInvitationError,
} from '@/app/lib/organization/team-invitations';
import {
  listTeamInvitationEmailDeliveries,
  sendCreatedTeamInvitationEmail,
  TeamInvitationEmailError,
} from '@/app/lib/organization/team-invitation-email';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function organizationAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;
  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (
    !state.configured
    || !state.organizationId
    || !isOrganizationAdminLike(state.permission)
  ) {
    return {
      ok: false as const,
      response: NextResponse.json({
        success: false,
        code: 'ORGANIZATION_ADMIN_REQUIRED',
        error: 'An active organization owner or administrator is required.',
      }, { status: 403 }),
    };
  }
  return {
    ok: true as const,
    session: admin.session,
    organizationId: state.organizationId,
  };
}

function errorResponse(error: unknown) {
  if (error instanceof TeamInvitationError || error instanceof TeamInvitationEmailError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
    }, { status: error.status, headers: error instanceof TeamInvitationEmailError && error.retryAfterSeconds !== null
      ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined });
  }
  console.error('[admin/organization/memberships/invitations] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not process the Team invitation.',
  }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const guard = await organizationAdmin(request);
  if (!guard.ok) return guard.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  try {
    await expireTeamMembershipInvitations();
    const invitations = await listTeamMembershipInvitations({
      organizationId: guard.organizationId,
    });
    const emailDeliveries = await listTeamInvitationEmailDeliveries({ organizationId: guard.organizationId });
    return NextResponse.json({ success: true, data: {
      invitations: invitations.map(invitation => ({ ...invitation, emailDelivery: emailDeliveries[invitation.id] })),
    } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const origin = requireTrustedMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const guard = await organizationAdmin(request);
  if (!guard.ok) return guard.response;
  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const invitationPolicyResponse = await requireManagedTeamInvitationPolicy();
  if (invitationPolicyResponse) return invitationPolicyResponse;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'admin-membership-invitation-create',
  });
  if (!limited.ok) return limited.response;

  try {
    const body = await request.json().catch(() => ({})) as {
      name?: unknown;
      email?: unknown;
      role?: unknown;
      expiresInDays?: unknown;
      locale?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const role = body.role === 'admin' || body.role === 'member' || body.role === 'external'
      ? body.role
      : null;
    if (!name || !email || !role) {
      return NextResponse.json({
        success: false,
        code: 'INVITATION_INVALID',
        error: 'Name, email, and a supported organization role are required.',
      }, { status: 400 });
    }
    if (role === 'external' && !areExternalUsersEnabled()) {
      return NextResponse.json({
        success: false,
        code: 'EXTERNAL_USERS_DISABLED',
        error: 'External organization users are not enabled.',
      }, { status: 409 });
    }
    const expiresInDays = typeof body.expiresInDays === 'number'
      ? body.expiresInDays
      : 7;
    const created = await createTeamMembershipInvitation({
      organizationId: guard.organizationId,
      actorUserId: guard.session.user.id,
      email,
      displayName: name,
      role,
      ttlMs: expiresInDays * 24 * 60 * 60 * 1000,
    });
    const emailDelivery = await sendCreatedTeamInvitationEmail({
      invitation: created.invitation, token: created.token, actorUserId: guard.session.user.id,
      locale: body.locale === 'de' ? 'de' : 'en',
    });
    return NextResponse.json({
      success: true,
      data: {
        invitation: created.invitation,
        token: created.token,
        acceptancePath: `/invite/team?token=${encodeURIComponent(created.token)}`,
        emailDelivery,
      },
    }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
