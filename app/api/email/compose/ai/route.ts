import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

import { auth } from '@/app/lib/auth';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { generateEmailComposeBody } from '@/app/lib/email/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'email-compose-ai-post' });
  if (!limited.ok) return limited.response;

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let accountId = '';
  let messageId = '';
  let mode = '';

  try {
    const body = await request.json().catch(() => ({}));
    accountId = typeof body.accountId === 'string' ? body.accountId : '';
    messageId = typeof body.messageId === 'string' ? body.messageId : '';
    mode = typeof body.mode === 'string' ? body.mode : '';
    logEmailClientEvent('info', 'compose_ai_requested', {
      accountId,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'requested',
      userId: session.user.id,
    });

    const data = await generateEmailComposeBody(session.user.id, body, { enforceReadPolicy: false });
    logEmailClientEvent('info', 'compose_ai_succeeded', {
      accountId,
      durationMs: Date.now() - startedAt,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'succeeded',
      userId: session.user.id,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logEmailClientEvent('error', 'compose_ai_failed', {
      accountId,
      durationMs: Date.now() - startedAt,
      error,
      messageId,
      mode,
      operation: 'compose-ai',
      requestId,
      status: 'failed',
      userId: session.user.id,
    });
    const message = error instanceof Error ? error.message : 'Failed to generate email text';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
