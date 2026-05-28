import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { searchEmail } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return null;
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-search-post' });
  if (!limited.ok) return limited.response;
  try {
    const body = await request.json().catch(() => ({}));
    const data = await searchEmail(body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to search email';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
