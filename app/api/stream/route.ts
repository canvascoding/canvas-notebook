import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { resolveActivePiModel, resolvePiModel } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { createAgentResponseStream } from '@/app/lib/pi/stream-proxy';
import { savePiSession } from '@/app/lib/pi/session-store';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { agentLoop, type AgentMessage, type AgentContext, type ThinkingLevel } from '@mariozechner/pi-agent-core';

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
      if (!m.role || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'toolResult')) {
        return NextResponse.json({ success: false, error: `Invalid role: ${(m as any).role}` }, { status: 400 });
      }
      if (m.content === undefined) {
        return NextResponse.json({ success: false, error: 'Message content is missing' }, { status: 400 });
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
    
    const context: AgentContext = {
      systemPrompt: 'You are an AI assistant in Canvas Notebook. You have access to the local workspace.',
      messages: messages.slice(0, -1), // Everything except the last prompt
      tools: tools,
    };

    const config = {
      model,
      thinkingLevel: (piConfig.providers[activeProviderName]?.thinking || 'none') as ThinkingLevel,
      convertToLlm: (msgs: AgentMessage[]) => msgs as any, // Simple pass-through for now
      getApiKey: resolvePiApiKey,
      sessionId,
    };

    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => {
      console.log(`[PI Stream] [${sessionId}] Request aborted by client.`);
      abortController.abort();
    });

    console.log(`[PI Stream] [${sessionId}] Starting loop with model ${model.id} and ${tools.length} tools.`);

    // The last message in the input is the new prompt
    const prompt = messages[messages.length - 1];
    const eventStream = agentLoop([prompt], context, config, abortController.signal);

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      async start(controller) {
        let finalMessages: AgentMessage[] = [...messages];
        try {
          for await (const event of eventStream) {
            console.log(`[PI Stream] [${sessionId}] Event: ${event.type}`);
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            if (event.type === 'agent_end') {
              finalMessages = event.messages;
            }
          }

          console.log(`[PI Stream] [${sessionId}] Loop finished. Persisting session.`);
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
        } catch (error: any) {
          if (error.name === 'AbortError' || abortController.signal.aborted) {
            console.log(`[PI Stream] [${sessionId}] Loop aborted successfully.`);
            return;
          }
          console.error(`[PI Stream] [${sessionId}] Loop error:`, error);
          controller.enqueue(encoder.encode(JSON.stringify({
            type: 'error',
            error: error.message || 'Unknown agent error',
          }) + '\n'));
        } finally {
          controller.close();
        }
      },
      cancel() {
        console.log(`[PI Stream] [${sessionId}] Stream cancelled by consumer.`);
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

  } catch (error: any) {
    console.error('[PI Stream] Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 });
  }
}
