import fs from 'node:fs/promises';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ChatRequestContext } from '@/app/lib/chat/types';

import { auth } from '@/app/lib/auth';
import { getOrCreatePiRuntime, type PiRuntimeStreamEvent } from '@/app/lib/pi/live-runtime';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { isValidCanvasInternalToken } from '@/app/lib/internal-auth';
import { getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';

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

    // Extract context — prefer nested `context` object, fall back to flat fields for
    // backwards compatibility with older clients that spread context on the root.
    const ctx: ChatRequestContext = (payload?.context && typeof payload.context === 'object')
      ? payload.context as ChatRequestContext
      : payload as ChatRequestContext;
    const userTimeZone = typeof ctx.userTimeZone === 'string' ? ctx.userTimeZone : undefined;
    const currentTime = typeof ctx.currentTime === 'string' ? ctx.currentTime : undefined;
    const activeFilePath = typeof ctx.activeFilePath === 'string' ? ctx.activeFilePath : null;
    const planningMode = ctx.planningMode === true;
    const currentPage = typeof ctx.currentPage === 'string' ? ctx.currentPage : undefined;

    const runtimeInstance = await getOrCreatePiRuntime(sessionId, userId);
    let promptMessage = resolvePromptMessage(payload);

    if (!promptMessage && !runtimeInstance.getStatus().canAbort) {
      return NextResponse.json({ success: false, error: 'Prompt message required when no run is active.' }, { status: 400 });
    }

    // Inject active studio image into the prompt message if available
    if (promptMessage && ctx.studioContext?.outputFilePath) {
      try {
        const imagePath = path.join(getStudioOutputsRoot(), ctx.studioContext.outputFilePath);
        const imageBuffer = await fs.readFile(imagePath);
        const base64Image = imageBuffer.toString('base64');

        // Determine mime type from file extension
        const ext = path.extname(ctx.studioContext.outputFilePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' :
                        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                        ext === '.webp' ? 'image/webp' :
                        ext === '.gif' ? 'image/gif' : 'image/png';

        // Create image content part
        const imageContent = {
          type: 'image' as const,
          data: base64Image,
          mimeType,
        };

        // Modify prompt message to include image
        if (typeof promptMessage.content === 'string') {
          promptMessage = {
            ...promptMessage,
            content: [
              { type: 'text' as const, text: promptMessage.content },
              imageContent,
            ],
          };
        } else if (Array.isArray(promptMessage.content)) {
          // Insert image at the end of existing content
          promptMessage = {
            ...promptMessage,
            content: [
              ...promptMessage.content,
              imageContent,
            ],
          };
        }
      } catch (imageError) {
        console.warn('[PI Stream] Failed to load studio image:', imageError);
        // Continue without image if loading fails
      }
    }

    // Set timezone context for this prompt
    if (userTimeZone && currentTime) {
      runtimeInstance.setTimeZoneContext(userTimeZone, currentTime);
    }

    // Set active file context for this prompt
    runtimeInstance.setActiveFileContext(activeFilePath);

    // Set planning mode for this prompt
    runtimeInstance.setPlanningMode(planningMode);

    // Set page context for this prompt
    runtimeInstance.setPageContext(currentPage);

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
    return NextResponse.json({ success: false, error: getErrorMessage(error) }, { status: 500 });
  }
}
