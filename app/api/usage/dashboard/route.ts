import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getUsageDashboard, parseUsageFilters } from '@/app/lib/pi/usage-reporting';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function getErrorStatus(error: unknown): number {
  return error instanceof Error && error.message.startsWith('FORBIDDEN_') ? 403 : 500;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('FORBIDDEN_')) {
    return 'Forbidden';
  }

  return error instanceof Error ? error.message : 'Internal error';
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'usage-dashboard',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const data = await getUsageDashboard(parseUsageFilters(new URL(request.url).searchParams), {
      id: session.user.id,
      role: session.user.role,
    });

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error('[API] Failed to load usage dashboard:', error);
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: getErrorStatus(error) },
    );
  }
}
