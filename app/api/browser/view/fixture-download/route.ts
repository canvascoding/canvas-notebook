import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';
import { verifyBrowserFixtureTicket } from '@/app/lib/pi/browser/view-fixture-ticket';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const FIXTURE_CONTENT = 'Canvas Browser Lab controlled download fixture.\n';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  let ticketAllowed = false;
  try {
    verifyBrowserFixtureTicket(request.nextUrl.searchParams.get('access') || '');
    ticketAllowed = true;
  } catch {
    // A regular authenticated admin may also exercise the diagnostic endpoint.
  }
  if (!ticketAllowed && (!session || !isBrowserLabAllowed(session.user))) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'browser-view-fixture' });
  if (!limited.ok) return limited.response;
  return new NextResponse(FIXTURE_CONTENT, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="browser-lab-download.txt"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
