import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readEmailMessage } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ accountId: string; messageId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'email-message-get' });
  if (!limited.ok) return limited.response;
  try {
    const { accountId, messageId } = await params;
    const folder = request.nextUrl.searchParams.get('folder') || undefined;
    const data = await readEmailMessage(session.user.id, accountId, messageId, folder, { enforceReadPolicy: false });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read email message';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
