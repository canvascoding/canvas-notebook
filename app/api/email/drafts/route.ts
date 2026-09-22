import { NextRequest, NextResponse } from 'next/server';

import { EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import { OutboxSendError } from '@/app/lib/email/outbox-errors';

import { auth } from '@/app/lib/auth';
import { createBrowserEmailDraft } from '@/app/lib/email/mailbox-compose';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'email-drafts-post' });
  if (!limited.ok) return limited.response;
  try {
    const body = await request.json().catch(() => ({}));
    const data = await createBrowserEmailDraft(session.user.id, body);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof OutboxSendError) return NextResponse.json({ success: false, error: error.message, code: error.code, data: error.draft }, { status: error.status });
    const message = error instanceof Error ? error.message : 'Failed to create email draft';
    return NextResponse.json({ success: false, error: message }, { status: error instanceof EmailMailboxAccessError ? error.status : 500 });
  }
}
