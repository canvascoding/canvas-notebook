import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getUsageEvents, parsePage, parsePageSize, parseUsageFilters } from '@/app/lib/pi/usage-reporting';

function getErrorStatus(error: unknown): number {
  if (error instanceof Error && error.message.startsWith('FORBIDDEN_')) {
    return 403;
  }

  return 500;
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
    keyPrefix: 'usage-events',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const searchParams = new URL(request.url).searchParams;
    const filters = parseUsageFilters(searchParams);
    const page = parsePage(searchParams);
    const pageSize = parsePageSize(searchParams);
    const data = await getUsageEvents(
      filters,
      {
        id: session.user.id,
        role: session.user.role,
      },
      page,
      pageSize,
    );

    return NextResponse.json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error('[API] Failed to load usage events:', error);
    return NextResponse.json(
      { success: false, error: getErrorMessage(error) },
      { status: getErrorStatus(error) },
    );
  }
}
