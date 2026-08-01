import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { requireTeamRuntimeRoute } from '@/app/lib/license/team-route-guard';
import { areExternalUsersEnabled } from '@/app/lib/organization/features';
import {
  getOrganizationUserPermissionDetails,
  ORGANIZATION_PERMISSION_KEYS,
  OrganizationPermissionMutationError,
  revokeOrganizationPermissionSessions,
  updateOrganizationPermissions,
  type OrganizationPermissionPatch,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

function errorResponse(error: unknown) {
  if (error instanceof OrganizationPermissionMutationError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }

  console.error('[admin/organization/users/permissions] Request failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'Could not process permission request.' },
    { status: 500 },
  );
}

function parsePermissionPatch(body: Record<string, unknown>): OrganizationPermissionPatch {
  const patch: OrganizationPermissionPatch = {};
  for (const key of ORGANIZATION_PERMISSION_KEYS) {
    if (typeof body[key] === 'boolean') {
      patch[key] = body[key];
    }
  }
  return patch;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'admin-user-permissions-read',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const user = await getOrganizationUserPermissionDetails(userId, session.user.id);
    return NextResponse.json({
      success: true,
      user,
      externalUsersEnabled: areExternalUsersEnabled(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const licenseResponse = await requireTeamRuntimeRoute();
  if (licenseResponse) return licenseResponse;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'admin-user-permissions-update',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const permissions = parsePermissionPatch(body);
    const before = await getOrganizationUserPermissionDetails(userId, session.user.id);
    const user = await updateOrganizationPermissions({
      actorUserId: session.user.id,
      targetUserId: userId,
      permissions,
    });
    const changedPermissions = ORGANIZATION_PERMISSION_KEYS.filter((key) => before.permissions[key] !== user.permissions[key]);
    const sessionsRevoked = userId === session.user.id ? 0 : await revokeOrganizationPermissionSessions(userId);

    await recordAuditEvent({
      organizationId: user.organizationId,
      userId: session.user.id,
      source: 'admin',
      eventType: 'admin',
      entityType: 'user',
      entityId: userId,
      action: 'organization.permissions.update',
      status: 'success',
      summary: `Organization permissions updated for ${userId}.`,
      metadata: {
        targetUserId: userId,
        changedPermissions,
        before: Object.fromEntries(changedPermissions.map((key) => [key, before.permissions[key]])),
        after: Object.fromEntries(changedPermissions.map((key) => [key, user.permissions[key]])),
        sessionsRevoked,
      },
    });

    return NextResponse.json({ success: true, user, sessionsRevoked });
  } catch (error) {
    return errorResponse(error);
  }
}
