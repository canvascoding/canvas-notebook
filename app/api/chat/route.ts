import { NextRequest, NextResponse } from 'next/server';
import { spawn, execSync } from 'child_process';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getWorkspacePath, ensureWorkspaceExists } from '@/app/lib/utils/workspace-manager';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { type AgentId } from '@/app/lib/agents/catalog';
import { getAgentRuntime, resolveAgentId } from '@/app/lib/agents/runtime';

const cliAvailability = new Map<string, boolean>();

interface ChatAttachment {
  name: string;
  path: string;
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybeAttachment = value as Record<string, unknown>;
  return typeof maybeAttachment.name === 'string' && typeof maybeAttachment.path === 'string';
}

function checkCliAvailability(command: string): boolean {
  const cached = cliAvailability.get(command);
  if (typeof cached === 'boolean') {
    return cached;
  }

  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    cliAvailability.set(command, true);
    return true;
  } catch {
    cliAvailability.set(command, false);
    return false;
  }
}

function buildPromptWithAttachments(promptText: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) {
    return promptText;
  }

  const attachmentContext = attachments
    .map((attachment) => `[Attachment: ${attachment.name} at path ${attachment.path}]`)
    .join('\n');

  return `${promptText}\n\nAttachments:\n${attachmentContext}\n\nPlease analyze the images/files at the absolute paths provided above.`.trim();
}

function createSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractOpenRouterText(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const parsed = event as {
    choices?: Array<{
      delta?: { content?: string | Array<{ text?: string } | string> };
      message?: { content?: string };
    }>;
  };

  const choice = parsed.choices?.[0];
  if (!choice) {
    return '';
  }

  if (typeof choice.delta?.content === 'string') {
    return choice.delta.content;
  }

  if (Array.isArray(choice.delta?.content)) {
    return choice.delta.content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }

  if (typeof choice.message?.content === 'string') {
    return choice.message.content;
  }

  return '';
}

async function persistChatTurn(params: {
  userId: string;
  sessionId?: string | null;
  model: AgentId;
  promptText: string;
  hasAttachments: boolean;
  assistantText: string;
}): Promise<void> {
  const { userId, sessionId, model, promptText, hasAttachments, assistantText } = params;
  if (!sessionId) {
    return;
  }

  let dbSessionId: number | null = null;

  const existingSessions = await db
    .select()
    .from(aiSessions)
    .where(and(eq(aiSessions.sessionId, sessionId), eq(aiSessions.model, model)))
    .limit(1);

  if (existingSessions.length > 0) {
    dbSessionId = existingSessions[0].id;
  } else {
    const titleSource = promptText || (hasAttachments ? 'Attachment analysis' : 'New chat');
    const result = await db
      .insert(aiSessions)
      .values({
        sessionId,
        userId,
        model,
        title: titleSource.substring(0, 40) + (titleSource.length > 40 ? '...' : ''),
        createdAt: new Date(),
      })
      .returning({ id: aiSessions.id });
    dbSessionId = result[0].id;
  }

  if (!dbSessionId) {
    return;
  }

  await db.insert(aiMessages).values({
    aiSessionDbId: dbSessionId,
    role: 'user',
    content: promptText,
    createdAt: new Date(),
  });

  if (assistantText) {
    await db.insert(aiMessages).values({
      aiSessionDbId: dbSessionId,
      role: 'assistant',
      content: assistantText,
      type: 'result',
      createdAt: new Date(),
    });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'ai-chat' });
    if (!limited.ok) return limited.response;

    const payload = await request.json();
    const promptText = typeof payload?.message === 'string' ? payload.message : '';
    const incomingModel = payload?.agentId ?? payload?.model;
    const agentId = resolveAgentId(incomingModel);
    const runtime = getAgentRuntime(agentId);
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
    const parsedAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(isChatAttachment)
      : [];
    const hasAttachments = parsedAttachments.length > 0;

    if (!promptText && !hasAttachments) {
      return NextResponse.json({ success: false, error: 'Message or attachment required' }, { status: 400 });
    }

    if (runtime.kind === 'openrouter' && hasAttachments) {
      return NextResponse.json(
        {
          success: false,
          error:
            'OpenRouter is currently configured as text-only in this app. Please remove attachments for this agent.',
        },
        { status: 400 },
      );
    }

    const userWorkspacePath = getWorkspacePath();
    await ensureWorkspaceExists(userWorkspacePath);

    const finalPrompt = buildPromptWithAttachments(promptText, parsedAttachments);

    if (runtime.kind === 'openrouter') {
      const apiKey = process.env[runtime.apiKeyEnv]?.trim() || '';
      if (!apiKey) {
        return NextResponse.json(
          {
            success: false,
            error: `${runtime.apiKeyEnv} is missing. Configure your OpenRouter API key first.`,
          },
          { status: 500 },
        );
      }

      const extractedSessionId: string | null = sessionId || createSessionId('openrouter');
      let finalResultText = '';
      let streamClosed = false;

      const encoder = new TextEncoder();
      const responseStream = new ReadableStream({
        start(controller) {
          const safeClose = () => {
            if (streamClosed) return;
            streamClosed = true;
            controller.close();
          };

          const push = (text: string) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // Stream already closed.
            }
          };

          push(
            JSON.stringify({
              success: true,
              sessionId: extractedSessionId,
              model: agentId,
            }) + '\n',
          );

          void (async () => {
            try {
              const upstream = await fetch(`${runtime.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: runtime.model,
                  stream: true,
                  messages: [
                    {
                      role: 'user',
                      content: finalPrompt,
                    },
                  ],
                }),
              });

              if (!upstream.ok) {
                const details = await upstream.text();
                throw new Error(
                  `OpenRouter request failed (${upstream.status}): ${details.slice(0, 400)}`,
                );
              }

              if (!upstream.body) {
                throw new Error('OpenRouter response body is empty.');
              }

              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              while (true) {
                const { value, done } = await reader.read();
                if (done) {
                  break;
                }

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const rawEvent of events) {
                  const dataLines = rawEvent
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith('data:'));

                  if (dataLines.length === 0) {
                    continue;
                  }

                  const data = dataLines.map((line) => line.slice(5).trim()).join('\n');
                  if (!data || data === '[DONE]') {
                    continue;
                  }

                  try {
                    const event = JSON.parse(data);
                    const textChunk = extractOpenRouterText(event);
                    if (!textChunk) {
                      continue;
                    }

                    finalResultText += textChunk;
                    push(
                      JSON.stringify({
                        type: 'assistant',
                        message: { content: [{ type: 'text', text: textChunk }] },
                        session_id: extractedSessionId,
                      }) + '\n',
                    );
                  } catch {
                    // Ignore malformed SSE chunks.
                  }
                }
              }

              await persistChatTurn({
                userId: session.user.id,
                sessionId: extractedSessionId,
                model: agentId,
                promptText,
                hasAttachments,
                assistantText: finalResultText,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              push(JSON.stringify({ type: 'error', message }) + '\n');
            } finally {
              safeClose();
            }
          })();
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
    }

    const command = runtime.command;
    const args = runtime.buildArgs({ prompt: finalPrompt, sessionId });

    if (!checkCliAvailability(command)) {
      return NextResponse.json(
        {
          success: false,
          error: `CLI backend not found (${command}). Configure the command path or choose another agent.`,
        },
        { status: 500 },
      );
    }

    console.log(`[AI Chat] Executing (${agentId}): ${command} ${args.join(' ')}`);

    const aiProcess = spawn(command, args, {
      cwd: userWorkspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let extractedSessionId: string | null = sessionId || null;
    let hasSentHeader = false;
    let stdoutBuffer = '';
    let finalResultText = '';
    let streamClosed = false;

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        const safeClose = () => {
          if (streamClosed) return;
          streamClosed = true;
          controller.close();
        };

        const push = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Stream already closed.
          }
        };

        aiProcess.on('error', (processError: Error) => {
          push(
            JSON.stringify({
              type: 'error',
              message: `${agentId} CLI failed to start: ${processError.message}`,
            }) + '\n',
          );
          safeClose();
        });

        aiProcess.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              if (runtime.parser === 'stream-json') {
                if (event.session_id) {
                  extractedSessionId = event.session_id;
                }
                if (event.type === 'result' && event.result) {
                  finalResultText = event.result;
                }
              } else {
                if ((event.type === 'thread.started' || event.type === 'thread.resumed') && event.thread_id) {
                  extractedSessionId = event.thread_id;
                }
              }

              if (!hasSentHeader) {
                push(
                  JSON.stringify({
                    success: true,
                    sessionId: extractedSessionId || sessionId || 'new',
                    model: agentId,
                    initialEvent: event,
                  }) + '\n',
                );
                hasSentHeader = true;
              }

              if (runtime.parser === 'codex-jsonl') {
                if (event.type === 'item.agentMessage.delta' && event.content?.text) {
                  finalResultText += event.content.text;
                  push(
                    JSON.stringify({
                      type: 'assistant',
                      message: { content: [{ type: 'text', text: event.content.text }] },
                      thread_id: extractedSessionId,
                    }) + '\n',
                  );
                  continue;
                }

                if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
                  if (!finalResultText) {
                    finalResultText = event.item.text;
                    push(
                      JSON.stringify({
                        type: 'assistant',
                        message: { content: [{ type: 'text', text: event.item.text }] },
                        thread_id: extractedSessionId,
                      }) + '\n',
                    );
                  }
                  continue;
                }

                if (event.type === 'error' || event.type === 'turn.failed') {
                  push(
                    JSON.stringify({
                      type: 'error',
                      message: event.message || event.error?.message || 'Codex error',
                    }) + '\n',
                  );
                }
              } else {
                push(line + '\n');
              }
            } catch {
              if (!line.trim()) {
                continue;
              }
              if (line.includes('ERROR')) {
                push(JSON.stringify({ type: 'error', message: line }) + '\n');
              } else {
                push(
                  JSON.stringify({
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: `${line}\n` }] },
                    thread_id: extractedSessionId,
                  }) + '\n',
                );
              }
            }
          }
        });

        aiProcess.stderr.on('data', (data: Buffer) => {
          const errStr = data.toString();
          if (errStr.toLowerCase().includes('error')) {
            push(JSON.stringify({ type: 'error', message: errStr }) + '\n');
          }
        });

        aiProcess.on('close', async (code: number | null) => {
          try {
            await persistChatTurn({
              userId: session.user.id,
              sessionId: extractedSessionId || sessionId,
              model: agentId,
              promptText,
              hasAttachments,
              assistantText: finalResultText,
            });
          } catch (dbErr) {
            console.error('[AI Chat] DB Persistence Error:', dbErr);
          }

          if (code !== 0 && !hasSentHeader) {
            push(JSON.stringify({ type: 'error', message: `${agentId} CLI exited with code ${String(code)}` }) + '\n');
          }
          safeClose();
        });
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
    console.error('[API] AI chat error:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
