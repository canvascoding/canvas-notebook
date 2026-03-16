import { NextRequest, NextResponse } from 'next/server';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { auth } from '@/app/lib/auth';
import { getOrCreatePiRuntime, type PiRuntimeStatus } from '@/app/lib/pi/live-runtime';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const runtime = 'nodejs';

type ControlAction = 'follow_up' | 'steer' | 'abort' | 'replace' | 'compact';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

function isUserMessage(message: unknown): message is Extract<AgentMessage, { role: 'user' }> {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as AgentMessage;
  return candidate.role === 'user' && (typeof candidate.content === 'string' || Array.isArray(candidate.content));
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'pi-stream-control' });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    const action = typeof payload?.action === 'string' ? (payload.action as ControlAction) : null;
    const message = payload?.message;

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    if (!action) {
      return NextResponse.json({ success: false, error: 'Action required' }, { status: 400 });
    }

    const runtimeInstance = await getOrCreatePiRuntime(sessionId, session.user.id);
    let status: PiRuntimeStatus;

    switch (action) {
      case 'follow_up':
        if (!isUserMessage(message)) {
          return NextResponse.json({ success: false, error: 'User message required for follow_up.' }, { status: 400 });
        }
        status = await runtimeInstance.queueFollowUp(message);
        break;
      case 'steer':
        if (!isUserMessage(message)) {
          return NextResponse.json({ success: false, error: 'User message required for steer.' }, { status: 400 });
        }
        status = await runtimeInstance.queueSteering(message);
        break;
      case 'replace':
        if (!isUserMessage(message)) {
          return NextResponse.json({ success: false, error: 'User message required for replace.' }, { status: 400 });
        }
        status = await runtimeInstance.replace(message);
        break;
      case 'abort':
        status = await runtimeInstance.abort();
        break;
      case 'compact':
        status = await runtimeInstance.compactNow();
        break;
      default:
        return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({ success: true, status });
  } catch (error) {
    const message = getErrorMessage(error);
    const statusCode = message.includes('No active agent run') || message.includes('Cannot compact while')
      ? 409
      : 500;
    return NextResponse.json({ success: false, error: message }, { status: statusCode });
  }
}
