import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getPiRuntimeStatus } from '@/app/lib/pi/live-runtime';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'pi-stream-status' });
  if (!limited.ok) {
    return limited.response;
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
  }

  try {
    const status = await getPiRuntimeStatus(sessionId, session.user.id);
    if (!status) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, status });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load runtime status.' },
      { status: 500 },
    );
  }
}
