import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { disconnectEmailAccount } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-account-delete' });
  if (!limited.ok) return limited.response;
  try {
    const { accountId } = await params;
    const data = await disconnectEmailAccount(session.user.id, accountId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to disconnect email account';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
