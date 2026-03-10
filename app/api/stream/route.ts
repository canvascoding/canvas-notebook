import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { resolveActivePiModel, resolvePiModel } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { savePiSession } from '@/app/lib/pi/session-store';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { agentLoop, type AgentMessage, type AgentContext, type ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { Message } from '@mariozechner/pi-ai';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'pi-stream' });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json();
    
    // Basic validation
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid payload' }, { status: 400 });
    }

    const messages: AgentMessage[] = payload.messages || [];
    const sessionId: string | undefined = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ success: false, error: 'Messages array required' }, { status: 400 });
    }

    // Validate message structure
    for (const m of messages) {
      const role = m.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') {
        return NextResponse.json({ success: false, error: `Invalid role: ${String(role)}` }, { status: 400 });
      }
      if (m.content === undefined) {
        return NextResponse.json({ success: false, error: 'Message content is missing' }, { status: 400 });
      }
      if (m.role === 'user' && typeof m.content !== 'string' && !Array.isArray(m.content)) {
        return NextResponse.json({ success: false, error: 'User message content must be a string or content array' }, { status: 400 });
      }
      if (m.role === 'assistant' && !Array.isArray(m.content)) {
        return NextResponse.json({ success: false, error: 'Assistant message content must be a content array' }, { status: 400 });
      }
      if (m.role === 'toolResult' && !Array.isArray(m.content)) {
        return NextResponse.json({ success: false, error: 'Tool result content must be a content array' }, { status: 400 });
      }
    }

    const piConfig = await readPiRuntimeConfig();
    let model;
    let providerName;

    // Check if session has a pinned model
    if (sessionId) {
      const pinned = await db.query.piSessions.findFirst({
        where: and(eq(piSessions.sessionId, sessionId), eq(piSessions.userId, session.user.id))
      });
      if (pinned) {
        model = await resolvePiModel(pinned.provider, pinned.model);
        providerName = pinned.provider;
      }
    }

    if (!model) {
      model = await resolveActivePiModel();
      providerName = piConfig.activeProvider;
    }

    const tools = getPiTools();
    const activeProviderName = providerName || piConfig.activeProvider;
    const logSessionId = sessionId ?? 'no-session';
    const { systemPrompt, diagnostics } = await loadManagedAgentSystemPrompt();

    if (diagnostics.usedFallback) {
      console.warn(
        `[PI Stream] [${logSessionId}] Falling back to base system prompt (${diagnostics.fallbackReason || 'unknown'}).`
      );
    }
    
    const context: AgentContext = {
      systemPrompt,
      messages: messages.slice(0, -1), // Everything except the last prompt
      tools: tools,
    };

    const config = {
      model,
      thinkingLevel: (piConfig.providers[activeProviderName]?.thinking || 'none') as ThinkingLevel,
      convertToLlm: async (msgs: AgentMessage[]) => msgs as Message[],
      getApiKey: resolvePiApiKey,
      sessionId,
    };

    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => {
      console.log(`[PI Stream] [${logSessionId}] Request aborted by client.`);
      abortController.abort();
    });

    console.log(`[PI Stream] [${logSessionId}] Starting loop with model ${model.id} and ${tools.length} tools.`);

    // The last message in the input is the new prompt
    const prompt = messages[messages.length - 1];
    const eventStream = agentLoop([prompt], context, config, abortController.signal);

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      async start(controller) {
        let finalMessages: AgentMessage[] = [...messages];
        try {
          for await (const event of eventStream) {
            console.log(`[PI Stream] [${logSessionId}] Event: ${event.type}`);
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            if (event.type === 'agent_end') {
              finalMessages = event.messages;
            }
          }

          console.log(`[PI Stream] [${logSessionId}] Loop finished. Persisting session.`);
          // Persist the session after completion
          if (sessionId) {
            await savePiSession(
              sessionId, 
              session.user.id, 
              activeProviderName, 
              model.id, 
              finalMessages
            );
          }
        } catch (error: unknown) {
          if ((error instanceof Error && error.name === 'AbortError') || abortController.signal.aborted) {
            console.log(`[PI Stream] [${logSessionId}] Loop aborted successfully.`);
            return;
          }
          console.error(`[PI Stream] [${logSessionId}] Loop error:`, error);
          controller.enqueue(encoder.encode(JSON.stringify({
            type: 'error',
            error: getErrorMessage(error),
          }) + '\n'));
        } finally {
          controller.close();
        }
      },
      cancel() {
        console.log(`[PI Stream] [${logSessionId}] Stream cancelled by consumer.`);
        abortController.abort();
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

  } catch (error: unknown) {
    console.error('[PI Stream] Error:', error);
    return NextResponse.json({ success: false, error: getErrorMessage(error) }, { status: 500 });
  }
}
