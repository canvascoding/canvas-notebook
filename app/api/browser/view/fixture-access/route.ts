import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';
import { issueBrowserFixtureTicket } from '@/app/lib/pi/browser/view-fixture-ticket';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !isBrowserLabAllowed(session.user)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }
  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'browser-view-fixture-access',
  });
  if (!limited.ok) return limited.response;

  return NextResponse.json({
    success: true,
    data: { access: issueBrowserFixtureTicket(session.user.id) },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
