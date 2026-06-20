import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getEmailOAuthStatus } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-oauth-status' });
  if (!limited.ok) return limited.response;

  try {
    const data = await getEmailOAuthStatus({ userId: session.user.id, requestOrigin: getPublicRequestOrigin(request) });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load email OAuth status';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
