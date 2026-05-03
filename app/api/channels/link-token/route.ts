import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { generateLinkToken } from '@/app/lib/channels/telegram/link-token';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 10, windowMs: 60_000, keyPrefix: 'channels-link-token' });
  if (!limited.ok) return limited.response;

  try {
    const token = await generateLinkToken(session.user.id);
    return NextResponse.json({ success: true, token });
  } catch (error) {
    console.error('[API] channels/link-token error:', error);
    return NextResponse.json({ success: false, error: 'Failed to generate link token' }, { status: 500 });
  }
}