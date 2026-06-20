import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getBraveSearchStatus } from '@/app/lib/integrations/brave-search-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true as const, session };
}

export async function GET(request: NextRequest) {
  const authResult = await requireSession(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'integrations-search-status',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const status = await getBraveSearchStatus({ userId: authResult.session.user.id });
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load search integration status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
