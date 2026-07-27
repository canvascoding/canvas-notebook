import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { countMobileUnreadMessages } from '@/app/lib/mobile/inbox';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-inbox-badge-get',
  });
  if (!limited.ok) return limited.response;

  try {
    const count = await countMobileUnreadMessages(session.user.id);
    return NextResponse.json({ success: true, count }, { headers: responseHeaders });
  } catch (error) {
    console.error('[API] Mobile app badge count failed:', error);
    return NextResponse.json(
      { success: false, error: 'App badge count could not be loaded.', code: 'BADGE_COUNT_FAILED' },
      { status: 500, headers: responseHeaders },
    );
  }
}
