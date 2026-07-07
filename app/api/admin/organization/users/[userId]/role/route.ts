import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { areExternalUsersEnabled } from '@/app/lib/organization/features';
import {
  OrganizationPermissionMutationError,
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

    const user = await updateOrganizationRole({
      actorUserId: session.user.id,
      targetUserId: userId,
      role,
      externalUsersEnabled: areExternalUsersEnabled(),
    });
    return NextResponse.json({
      success: true,
      user,
      externalUsersEnabled: areExternalUsersEnabled(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
