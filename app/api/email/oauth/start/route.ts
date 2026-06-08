import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { startEmailOAuth } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'email-oauth-start' });
  if (!limited.ok) return limited.response;
  try {
    const body = await request.json().catch(() => ({})) as { provider?: string; returnUrl?: string };
    const origin = getPublicRequestOrigin(request);
    const returnUrl = body.returnUrl || `${origin}/settings?tab=integrations`;
    const data = await startEmailOAuth(session.user.id, { provider: body.provider || 'google', requestOrigin: origin, returnUrl });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start email OAuth';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
