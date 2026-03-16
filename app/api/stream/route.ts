import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { resolveActivePiModel, resolvePiModel, modelSupportsVision } from '@/app/lib/pi/model-resolver';
import { resolvePiApiKey } from '@/app/lib/pi/api-key-resolver';
import { getPiTools } from '@/app/lib/pi/tool-registry';
import { readPiRuntimeConfig } from '@/app/lib/agents/storage';
import { loadManagedAgentSystemPrompt } from '@/app/lib/agents/system-prompt';
import { normalizePiMessagesForLlm, filterImagesForNonVisionModel } from '@/app/lib/pi/message-normalization';
import { savePiSession, loadPiSessionWithSummary } from '@/app/lib/pi/session-store';
import { composePiHistoryForLlm, type PiSessionSummaryState } from '@/app/lib/pi/history-budget';
import { preparePiHistoryContext } from '@/app/lib/pi/session-summary';
import { runPiStreamWithOverflowRetry } from '@/app/lib/pi/stream-runner';
import { persistPiUsageEvents } from '@/app/lib/pi/usage-events';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { agentLoop, type AgentMessage, type AgentContext, type ThinkingLevel } from '@mariozechner/pi-agent-core';

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

    const tools = await getPiTools();
    const activeProviderName = providerName || piConfig.activeProvider;
    const logSessionId = sessionId ?? 'no-session';
    
    // Check if model supports vision
    const visionSupported = modelSupportsVision(model.id) || (model.input?.includes('image') ?? false);
    
    if (!visionSupported) {
      // Filter out image content from messages for non-vision models
      const filteredMessages = filterImagesForNonVisionModel(messages);
      
      // Check if any images were filtered
      let imagesFiltered = 0;
      for (let i = 0; i < messages.length; i++) {
        const originalContent = messages[i].content;
        const filteredContent = filteredMessages[i].content;
        if (Array.isArray(originalContent) && Array.isArray(filteredContent)) {
          imagesFiltered += originalContent.length - filteredContent.length;
        }
      }
      
      if (imagesFiltered > 0) {
        console.log(`[PI Stream] [${logSessionId}] Filtered out ${imagesFiltered} image(s) - model ${model.id} doesn't support vision`);
      }
      
      // Replace messages array contents
      messages.splice(0, messages.length, ...filteredMessages);
    } else {
      console.log(`[PI Stream] [${logSessionId}] Model ${model.id} supports vision - processing images`);
    }
    
    const { systemPrompt, diagnostics } = await loadManagedAgentSystemPrompt();

    if (diagnostics.usedFallback) {
      console.warn(
        `[PI Stream] [${logSessionId}] Falling back to base system prompt (${diagnostics.fallbackReason || 'unknown'}).`
      );
    }

    // The last message is the new prompt from the user
    const prompt = messages[messages.length - 1];

    // Load server-stored history when a session exists (source of truth)
    let storedSummary: PiSessionSummaryState = {
      summaryText: null,
      summaryUpdatedAt: null,
      summaryThroughTimestamp: null,
    };
    let historyMessages: AgentMessage[];

    if (sessionId) {
      const stored = await loadPiSessionWithSummary(sessionId, session.user.id);
      if (stored) {
        historyMessages = stored.messages;
        storedSummary = stored.summary;
      } else {
        historyMessages = messages.slice(0, -1);
      }
    } else {
      historyMessages = messages.slice(0, -1);
    }

    // Build context with history budgeting (may trigger summarization)
    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => {
      console.log(`[PI Stream] [${logSessionId}] Request aborted by client.`);
      abortController.abort();
    });

    const { summary: updatedSummary, composition } = await preparePiHistoryContext({
      messages: historyMessages,
      summary: storedSummary,
      systemPrompt,
      model,
      toolCount: tools.length,
      sessionId,
      signal: abortController.signal,
    });

    const config = {
      model,
      thinkingLevel: (piConfig.providers[activeProviderName]?.thinking || 'none') as ThinkingLevel,
      convertToLlm: async (msgs: AgentMessage[]) => normalizePiMessagesForLlm(msgs),
      getApiKey: resolvePiApiKey,
      sessionId,
    };

    console.log(
      `[PI Stream] [${logSessionId}] Starting loop with model ${model.id}, ${tools.length} tools, ` +
      `${historyMessages.length} stored messages → ${composition.llmMessages.length} LLM messages` +
      (composition.includedSummary ? ' (with summary)' : '') + '.',
    );

    // Track how many LLM context messages were used so we can extract new turn messages
    let usedLlmContextLength = composition.llmMessages.length;

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      async start(controller) {
        let finalMessages: AgentMessage[] = [];
        try {
          const result = await runPiStreamWithOverflowRetry({
            runAttempt: (aggressive) => {
              let llmMessages = composition.llmMessages;

              if (aggressive) {
                const aggressiveComposition = composePiHistoryForLlm({
                  messages: historyMessages,
                  summary: updatedSummary,
                  systemPrompt,
                  contextWindow: model.contextWindow,
                  modelMaxTokens: model.maxTokens,
                  toolCount: tools.length,
                  aggressive: true,
                });
                llmMessages = aggressiveComposition.llmMessages;
                usedLlmContextLength = llmMessages.length;
              }

              const context: AgentContext = {
                systemPrompt,
                messages: llmMessages,
                tools,
              };

              return agentLoop([prompt], context, config, abortController.signal);
            },
            forwardEvent: async (event) => {
              controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            },
            contextWindow: model.contextWindow,
          });

          finalMessages = result.finalMessages;

          if (result.retriedForOverflow) {
            console.log(`[PI Stream] [${logSessionId}] Retried once after context overflow.`);
          }

          // finalMessages = [llmContextMessages..., prompt, new agent messages...]
          // Extract only the new turn messages and append to the full stored history
          const newTurnMessages = finalMessages.slice(usedLlmContextLength);
          const fullHistory = [...historyMessages, ...newTurnMessages];

          console.log(`[PI Stream] [${logSessionId}] Loop finished. Persisting ${fullHistory.length} messages.`);

          if (sessionId) {
            await savePiSession(
              sessionId,
              session.user.id,
              activeProviderName,
              model.id,
              fullHistory,
              updatedSummary,
            );
            await persistPiUsageEvents({
              sessionId,
              userId: session.user.id,
              messages: newTurnMessages,
            });
          }
        } catch (error: unknown) {
          if ((error instanceof Error && error.name === 'AbortError') || abortController.signal.aborted) {
            console.log(`[PI Stream] [${logSessionId}] Loop aborted successfully.`);
            // Still save any messages that were generated before abort
            if (sessionId && finalMessages.length > usedLlmContextLength) {
              const newTurnMessages = finalMessages.slice(usedLlmContextLength);
              const fullHistory = [...historyMessages, ...newTurnMessages];
              console.log(`[PI Stream] [${logSessionId}] Persisting ${fullHistory.length} messages after abort.`);
              await savePiSession(
                sessionId,
                session.user.id,
                activeProviderName,
                model.id,
                fullHistory,
                updatedSummary,
              );
              await persistPiUsageEvents({
                sessionId,
                userId: session.user.id,
                messages: newTurnMessages,
              });
            }
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
