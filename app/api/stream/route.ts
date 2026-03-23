import { NextRequest, NextResponse } from 'next/server';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

import { auth } from '@/app/lib/auth';
import { getOrCreatePiRuntime, type PiRuntimeStreamEvent } from '@/app/lib/pi/live-runtime';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const runtime = 'nodejs';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

function isValidUserMessage(message: unknown): message is Extract<AgentMessage, { role: 'user' }> {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as AgentMessage;
  if (candidate.role !== 'user') {
    return false;
  }

  return typeof candidate.content === 'string' || Array.isArray(candidate.content);
}

function resolvePromptMessage(payload: unknown): Extract<AgentMessage, { role: 'user' }> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if ('message' in payload && isValidUserMessage(payload.message)) {
    return payload.message;
  }

  if (!('messages' in payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }

  const lastMessage = payload.messages[payload.messages.length - 1];
  return isValidUserMessage(lastMessage) ? lastMessage : null;
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'pi-stream' });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = await request.json();
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    // Extract timezone info from client
    const userTimeZone = typeof payload?.userTimeZone === 'string' ? payload.userTimeZone : undefined;
    const currentTime = typeof payload?.currentTime === 'string' ? payload.currentTime : undefined;
    const activeFilePath = typeof payload?.activeFilePath === 'string' ? payload.activeFilePath : null;

    const runtimeInstance = await getOrCreatePiRuntime(sessionId, session.user.id);
    const promptMessage = resolvePromptMessage(payload);

    if (!promptMessage && !runtimeInstance.getStatus().canAbort) {
      return NextResponse.json({ success: false, error: 'Prompt message required when no run is active.' }, { status: 400 });
    }

    // Set timezone context for this prompt
    if (userTimeZone && currentTime) {
      runtimeInstance.setTimeZoneContext(userTimeZone, currentTime);
    }

    // Set active file context for this prompt
    runtimeInstance.setActiveFileContext(activeFilePath);

    const encoder = new TextEncoder();

    const responseStream = new ReadableStream({
      start(controller) {
        let hasSeenBusyState = runtimeInstance.getStatus().phase !== 'idle';
        let closed = false;
        let closeTimer: ReturnType<typeof setTimeout> | null = null;

        const flushEvent = (event: PiRuntimeStreamEvent) => {
          if (closed) {
            return;
          }

          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));

          if (event.type === 'runtime_status') {
            if (event.status.phase !== 'idle') {
              hasSeenBusyState = true;
              if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
              }
              return;
            }

            if (hasSeenBusyState && !runtimeInstance.hasPendingReplace()) {
              if (closeTimer) {
                clearTimeout(closeTimer);
              }
              closeTimer = setTimeout(() => {
                if (closed) {
                  return;
                }
                closed = true;
                unsubscribe();
                controller.close();
              }, 200);
            }
          }
        };

        const unsubscribe = runtimeInstance.subscribe(flushEvent);

        flushEvent({
          type: 'runtime_status',
          status: runtimeInstance.getStatus(),
        });

        if (promptMessage) {
          runtimeInstance.startPrompt(promptMessage);
        }

        request.signal.addEventListener('abort', () => {
          if (closeTimer) {
            clearTimeout(closeTimer);
          }
          if (!closed) {
            closed = true;
            unsubscribe();
            controller.close();
          }
        });
      },
      cancel() {
        // Client disconnected; runtime continues server-side.
      },
    });

    return new NextResponse(responseStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    console.error('[PI Stream] Error:', error);
    return NextResponse.json({ success: false, error: getErrorMessage(error) }, { status: 500 });
  }
}
