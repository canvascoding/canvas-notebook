import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { areExternalUsersEnabled } from '@/app/lib/organization/features';
import {
  getOrganizationUserPermissionDetails,
  OrganizationPermissionMutationError,
  revokeOrganizationPermissionSessions,
  updateOrganizationRole,
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

  console.error('[admin/organization/users/role] Request failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'Could not process role request.' },
    { status: 500 },
  );
}

function normalizeRequestedRole(value: unknown): 'admin' | 'member' | 'external' | null {
  if (value === 'admin' || value === 'member' || value === 'external') return value;
  return null;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'admin-user-role-update',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const body = await request.json().catch(() => ({})) as { role?: unknown };
    const role = normalizeRequestedRole(body.role);
    if (!role) {
      return NextResponse.json(
        { success: false, code: 'INVALID_ROLE', error: 'Invalid role.' },
        { status: 400 },
      );
    }

    const before = await getOrganizationUserPermissionDetails(userId, session.user.id);
    const externalUsersEnabled = areExternalUsersEnabled();
    const user = await updateOrganizationRole({
      actorUserId: session.user.id,
      targetUserId: userId,
      role,
      externalUsersEnabled,
    });
    const changedPermissions = Object.keys(user.permissions).filter((key) => {
      const permissionKey = key as keyof typeof user.permissions;
      return before.permissions[permissionKey] !== user.permissions[permissionKey];
    });
    const sessionsRevoked = userId === session.user.id ? 0 : await revokeOrganizationPermissionSessions(userId);

    await recordAuditEvent({
      organizationId: user.organizationId,
      userId: session.user.id,
      source: 'admin',
      eventType: 'admin',
      entityType: 'user',
      entityId: userId,
      action: 'organization.role.update',
      status: 'success',
      summary: `Organization role updated for ${userId}.`,
      metadata: {
        targetUserId: userId,
        beforeRole: before.role,
        afterRole: user.role,
        changedPermissions,
        sessionsRevoked,
      },
    });

    return NextResponse.json({
      success: true,
      user,
      externalUsersEnabled,
      sessionsRevoked,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
