import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { type PiRuntimeStreamEvent } from '@/app/lib/pi/live-runtime';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';
import {
  getErrorMessage,
  getErrorStatusCode,
  prepareRuntimePrompt,
} from '@/app/lib/pi/runtime-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const payload = await request.json();
  
  // Check if this is an internal server-to-server call from the WebSocket bridge.
  // A bodyUserId is only trusted when accompanied by a valid internal token —
  // otherwise any authenticated client could impersonate any user by setting it.
  const bodyUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  const internalToken = request.headers.get('x-canvas-internal-token');
  const isTrustedInternal = bodyUserId && isValidCanvasInternalToken(internalToken);
  let userId: string;

  if (isTrustedInternal) {
    userId = bodyUserId;
    console.log('[PI Stream] Internal server call with userId:', userId);
  } else {
    // External browser call - require session auth
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    userId = session.user.id;
    
    // Rate limit only applies to external browser requests
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'pi-stream' });
    if (!limited.ok) {
      return limited.response;
    }
  }

  try {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Session ID required' }, { status: 400 });
    }

    const { runtimeInstance, promptMessage } = await prepareRuntimePrompt(sessionId, userId, payload);

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
              }, 50);
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
    return NextResponse.json({ success: false, error: getErrorMessage(error) }, { status: getErrorStatusCode(error) });
  }
}
