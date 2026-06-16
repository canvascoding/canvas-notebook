import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

import { auth } from '@/app/lib/auth';
import { logEmailClientEvent } from '@/app/lib/email/logging';
import { runEmailWorkspaceComposeAgent } from '@/app/lib/email/compose-agent/runner';
import type { EmailComposeAgentStreamEvent } from '@/app/lib/email/compose-agent/types';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  return session;
}

function encodeEvent(event: EmailComposeAgentStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  const limited = rateLimit(request, { limit: 12, windowMs: 60_000, keyPrefix: 'email-compose-agent-post' });
  if (!limited.ok) return limited.response;

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const body = await request.json().catch(() => ({}));
  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const mode = typeof body.mode === 'string' ? body.mode : '';

  logEmailClientEvent('info', 'compose_agent_requested', {
    accountId,
    messageId,
    mode,
    operation: 'compose-agent',
    requestId,
    status: 'requested',
    userId: session.user.id,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: EmailComposeAgentStreamEvent) => {
        controller.enqueue(encodeEvent(event));
      };

      try {
        await runEmailWorkspaceComposeAgent(session.user.id, body, emit, request.signal);
        logEmailClientEvent('info', 'compose_agent_succeeded', {
          accountId,
          durationMs: Date.now() - startedAt,
          messageId,
          mode,
          operation: 'compose-agent',
          requestId,
          status: 'succeeded',
          userId: session.user.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Workspace Agent failed to generate email text';
        emit({ type: 'error', message });
        logEmailClientEvent('error', 'compose_agent_failed', {
          accountId,
          durationMs: Date.now() - startedAt,
          error,
          messageId,
          mode,
          operation: 'compose-agent',
          requestId,
          status: 'failed',
          userId: session.user.id,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}
