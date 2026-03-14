import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function requireAutomationSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

export function applyAutomationRateLimit(
  request: NextRequest,
  keyPrefix: string,
  limit = 60,
  windowMs = 60_000,
) {
  return rateLimit(request, {
    limit,
    windowMs,
    keyPrefix,
  });
}
