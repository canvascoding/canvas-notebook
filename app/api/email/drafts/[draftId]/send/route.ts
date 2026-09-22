import { NextRequest, NextResponse } from 'next/server';

import { EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import { OutboxSendError } from '@/app/lib/email/outbox-errors';

import { auth } from '@/app/lib/auth';
import { sendBrowserEmailDraft } from '@/app/lib/email/mailbox-compose';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-draft-send' });
  if (!limited.ok) return limited.response;
  try {
    const { draftId } = await params;
    const body = await request.json().catch(() => ({})) as { accountId?: string; mailboxWorkspaceId?: unknown; expectedVersion?: number };
    if (!body.accountId) throw new Error('accountId is required to send an email draft.');
    const data = await sendBrowserEmailDraft(session.user.id, draftId, { ...body, accountId: body.accountId });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof OutboxSendError) return NextResponse.json({ success: false, error: error.message, code: error.code, data: error.draft }, { status: error.status });
    const message = error instanceof Error ? error.message : 'Failed to send email draft';
    return NextResponse.json({ success: false, error: message }, { status: error instanceof EmailMailboxAccessError ? error.status : 500 });
  }
}
