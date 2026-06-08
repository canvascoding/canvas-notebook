import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

import { auth } from '@/app/lib/auth';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { sendEmailMessage } from '@/app/lib/email/service';
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

    const data = await sendEmailMessage(session.user.id, body);
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
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
