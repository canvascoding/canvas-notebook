import { NextRequest, NextResponse } from 'next/server';

import {
  createOffboardingPreflight,
  offboardUser,
  OffboardingError,
} from '@/app/lib/organization/offboarding';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type RouteContext = {
  params: Promise<{
    userId: string;
  }>;
};

function errorResponse(error: unknown) {
  if (error instanceof OffboardingError) {
    return NextResponse.json({
      success: false,
      code: error.code,
      error: error.message,
      preflight: error.preflight,
    }, { status: error.status });
  }

  console.error('[admin/organization/users/offboarding] Request failed:', error);
  return NextResponse.json({
    success: false,
    code: 'INTERNAL_ERROR',
    error: 'Could not process offboarding request.',
  }, { status: 500 });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireOrganizationPermission(request, 'canRecoverWorkspaces', {
    errorMessage: 'Only owners or administrators with recovery permission can run offboarding preflight checks.',
  });
  if (!guard.ok) return guard.response;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'admin-user-offboarding-preflight',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const preflight = await createOffboardingPreflight(userId, guard.session.user.id);
    return NextResponse.json({ success: true, data: preflight });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireOrganizationPermission(request, 'canRecoverWorkspaces', {
    errorMessage: 'Only owners or administrators with recovery permission can offboard users.',
  });
  if (!guard.ok) return guard.response;

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'admin-user-offboarding-apply',
  });
  if (!limited.ok) return limited.response;

  try {
    const { userId } = await context.params;
    const body = await request.json().catch(() => ({})) as {
      reason?: unknown;
      acknowledgeWarnings?: unknown;
    };
    const result = await offboardUser({
      targetUserId: userId,
      requestedByUserId: guard.session.user.id,
      reason: typeof body.reason === 'string' ? body.reason : null,
      acknowledgeWarnings: body.acknowledgeWarnings === true,
    });
    return NextResponse.json({
      success: true,
      data: {
        preflight: result.preflight,
        appliedAt: result.appliedAt,
        actions: result.actions,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
