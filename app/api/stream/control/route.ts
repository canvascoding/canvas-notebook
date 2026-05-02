import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  control,
  getErrorMessage,
  getErrorStatusCode,
  type ControlAction,
} from '@/app/lib/pi/runtime-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'pi-stream-control' });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    const action = typeof payload?.action === 'string' ? (payload.action as ControlAction) : null;
    const message = payload?.message;

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    if (!action) {
      return NextResponse.json({ success: false, error: 'Action required' }, { status: 400 });
    }

    const status = await control(sessionId, session.user.id, action, message);

    return NextResponse.json({ success: true, status });
  } catch (error) {
    const message = getErrorMessage(error);
    const serviceStatusCode = getErrorStatusCode(error);
    const statusCode = serviceStatusCode !== 500
      ? serviceStatusCode
      : message.includes('No active agent run') || message.includes('Cannot compact while')
      ? 409
      : 500;
    return NextResponse.json({ success: false, error: message }, { status: statusCode });
  }
}
