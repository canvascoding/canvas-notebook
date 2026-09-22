import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

import { EmailMailboxAccessError } from '@/app/lib/email/mailbox-access';
import { OutboxSendError } from '@/app/lib/email/outbox-errors';

import { auth } from '@/app/lib/auth';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { sendBrowserEmailMessage } from '@/app/lib/email/mailbox-compose';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-send-post' });
  if (!limited.ok) return limited.response;

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let accountId = '';

  try {
    const body = await request.json().catch(() => ({}));
    accountId = typeof body.accountId === 'string' ? body.accountId : '';
    logEmailClientEvent('info', 'compose_send_requested', {
      accountId,
      operation: 'send',
      requestId,
      status: 'requested',
      userId: session.user.id,
    });

    const data = await sendBrowserEmailMessage(session.user.id, body);
    logEmailClientEvent('info', 'compose_send_succeeded', {
      accountId,
      durationMs: Date.now() - startedAt,
      operation: 'send',
      requestId,
      status: 'succeeded',
      userId: session.user.id,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof OutboxSendError) return NextResponse.json({ success: false, error: error.message, code: error.code, data: error.draft }, { status: error.status });
    logEmailClientEvent('error', 'compose_send_failed', {
      accountId,
      durationMs: Date.now() - startedAt,
      error,
      operation: 'send',
      requestId,
      status: 'failed',
      userId: session.user.id,
    });
    const message = error instanceof Error ? error.message : 'Failed to send email';
    return NextResponse.json({ success: false, error: message }, { status: error instanceof EmailMailboxAccessError ? error.status : 500 });
  }
}
