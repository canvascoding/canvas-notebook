import { NextRequest, NextResponse } from 'next/server';
import { spawn, execSync } from 'child_process';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getWorkspacePath, ensureWorkspaceExists } from '@/app/lib/utils/workspace-manager';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages } from '@/app/lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { type AgentId, isAgentId } from '@/app/lib/agents/catalog';
import { enforceAiSessionRetention } from '@/app/lib/agents/session-retention';
import {
  type AgentConfigReadiness,
  type AgentProviderId,
  type AgentRuntimeConfig,
  agentIdToProviderId,
  buildAgentConfigReadiness,
  providerIdToAgentId,
  readAgentRuntimeConfig,
  resolveOllamaApiBase,
  resolveOllamaApiKey,
  resolveOpenRouterApiKey,
} from '@/app/lib/agents/storage';

const cliAvailability = new Map<string, boolean>();

interface ChatAttachment {
  name: string;
  path: string;
}

type CliParserType = 'stream-json' | 'codex-jsonl';

type CliRuntime = {
  kind: 'cli';
  command: string;
  parser: CliParserType;
  buildArgs: (params: { prompt: string; sessionId?: string | null }) => string[];
};

type OpenRouterRuntime = {
  kind: 'openrouter';
  baseUrl: string;
  model: string;
  apiKey: string;
};

type OllamaRuntime = {
  kind: 'ollama';
  baseUrl: string;
  model: string;
  apiKey: string | null;
};

type ResolvedRuntime = CliRuntime | OpenRouterRuntime | OllamaRuntime;

type ChatProviderBinding = {
  config: AgentRuntimeConfig;
  readiness: AgentConfigReadiness;
  providerId: AgentProviderId;
  agentId: AgentId;
  requestedSessionId: string | null;
};

class ChatSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'ChatSessionNotFoundError';
  }
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
  const normalizedPrefix = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'session';
  return `${normalizedPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
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

function extractOllamaText(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const parsed = event as {
    message?: {
      content?: string;
    };
  };

  if (typeof parsed.message?.content === 'string') {
    return parsed.message.content;
  }

  return '';
}

function buildCliRuntime(agentId: AgentId, config: AgentRuntimeConfig): CliRuntime {
  if (agentId === 'claude') {
    return {
      kind: 'cli',
      command: config.providers['claude-cli'].command,
      parser: 'stream-json',
      buildArgs: ({ prompt, sessionId }) => {
        const args = [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'bypassPermissions',
          '--allowedTools',
          'read',
          '--allowedTools',
          'ls',
          '--allowedTools',
          'bash',
          '--allowedTools',
          'write',
          '--allowedTools',
          'edit',
          '--allowedTools',
          'glob',
          '--allowedTools',
          'grep',
        ];
        if (sessionId) {
          args.push('--resume', sessionId);
        }
        return args;
      },
    };
  }

  return {
    kind: 'cli',
    command: config.providers['codex-cli'].command,
    parser: 'codex-jsonl',
    buildArgs: ({ prompt, sessionId }) => {
      const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
      if (sessionId) {
        args.push('resume', sessionId, prompt);
      } else {
        args.push(prompt);
      }
      return args;
    },
  };
}

function providerUnavailableError(providerId: AgentProviderId, issues: string[]): string {
  const issueDetails = issues.filter(Boolean).join(' ');
  return issueDetails
    ? `Provider not available (${providerId}). ${issueDetails}`
    : `Provider not available (${providerId}).`;
}

function resolveProviderErrorResponse(binding: ChatProviderBinding): NextResponse | null {
  const readiness = binding.readiness.providers[binding.providerId];
  if (binding.providerId === 'openrouter' || binding.providerId === 'ollama') {
    const providerConfig =
      binding.providerId === 'openrouter' ? binding.config.providers.openrouter : binding.config.providers.ollama;

    if (!providerConfig.enabled) {
      return NextResponse.json({ success: false, error: providerUnavailableError(binding.providerId, readiness.issues) }, { status: 503 });
    }

    if (!readiness.available && readiness.issues.length > 0) {
      return NextResponse.json({ success: false, error: providerUnavailableError(binding.providerId, readiness.issues) }, { status: 503 });
    }

    return null;
  }

  if (!readiness.commandExists) {
    const command = readiness.command || binding.config.providers[binding.providerId].command;
    return NextResponse.json(
      {
        success: false,
        error: `CLI not installed (${command}). Configure the provider command or install the CLI.`,
      },
      { status: 503 },
    );
  }

  if (!readiness.available) {
    return NextResponse.json({ success: false, error: providerUnavailableError(binding.providerId, readiness.issues) }, { status: 503 });
  }

  return null;
}

async function resolveChatProviderBinding(requestedSessionId: string | null): Promise<ChatProviderBinding> {
  const config = await readAgentRuntimeConfig();
  const readiness = await buildAgentConfigReadiness(config);

  if (requestedSessionId) {
    const sessions = await db
      .select({ model: aiSessions.model })
      .from(aiSessions)
      .where(eq(aiSessions.sessionId, requestedSessionId))
      .orderBy(desc(aiSessions.createdAt))
      .limit(1);

    if (sessions.length === 0) {
      throw new ChatSessionNotFoundError(requestedSessionId);
    }

    const model = sessions[0].model;
    if (!isAgentId(model)) {
      return {
        config,
        readiness,
        requestedSessionId,
        agentId: providerIdToAgentId(config.provider.id),
        providerId: config.provider.id,
      };
    }

    return {
      config,
      readiness,
      requestedSessionId,
      agentId: model,
      providerId: agentIdToProviderId(model),
    };
  }

  return {
    config,
    readiness,
    requestedSessionId: null,
    agentId: providerIdToAgentId(config.provider.id),
    providerId: config.provider.id,
  };
}

async function resolveRuntime(binding: ChatProviderBinding): Promise<{ runtime: ResolvedRuntime; errorResponse: NextResponse | null }> {
  const providerErrorResponse = resolveProviderErrorResponse(binding);
  if (providerErrorResponse) {
    return { runtime: buildCliRuntime('codex', binding.config), errorResponse: providerErrorResponse };
  }

  if (binding.providerId === 'openrouter') {
    const openRouterKey = await resolveOpenRouterApiKey(binding.config);
    if (!openRouterKey.isSet || !openRouterKey.apiKey) {
      return {
        runtime: buildCliRuntime('codex', binding.config),
        errorResponse: NextResponse.json(
          {
            success: false,
            error: 'OpenRouter key missing. Configure the key in Agent Environment or OPENROUTER_API_KEY.',
          },
          { status: 503 },
        ),
      };
    }

    return {
      runtime: {
        kind: 'openrouter',
        baseUrl: binding.config.providers.openrouter.baseUrl,
        model: binding.config.providers.openrouter.model,
        apiKey: openRouterKey.apiKey,
      },
      errorResponse: null,
    };
  }

  if (binding.providerId === 'ollama') {
    const ollamaKey = await resolveOllamaApiKey(binding.config);
    return {
      runtime: {
        kind: 'ollama',
        baseUrl: resolveOllamaApiBase(binding.config.providers.ollama.baseUrl),
        model: binding.config.providers.ollama.model,
        apiKey: ollamaKey.apiKey,
      },
      errorResponse: null,
    };
  }

  return {
    runtime: buildCliRuntime(binding.agentId, binding.config),
    errorResponse: null,
  };
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
    .select({ id: aiSessions.id })
    .from(aiSessions)
    .where(eq(aiSessions.sessionId, sessionId))
    .orderBy(desc(aiSessions.createdAt))
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
    await enforceAiSessionRetention();
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
    const requestedSessionId = parseSessionId(payload?.sessionId);
    const parsedAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(isChatAttachment)
      : [];
    const hasAttachments = parsedAttachments.length > 0;

    if (!promptText && !hasAttachments) {
      return NextResponse.json({ success: false, error: 'Message or attachment required' }, { status: 400 });
    }

    const providerBinding = await resolveChatProviderBinding(requestedSessionId);
    const { runtime, errorResponse } = await resolveRuntime(providerBinding);
    if (errorResponse) {
      return errorResponse;
    }

    if ((runtime.kind === 'openrouter' || runtime.kind === 'ollama') && hasAttachments) {
      return NextResponse.json(
        {
          success: false,
          error:
            `${runtime.kind === 'openrouter' ? 'OpenRouter' : 'Ollama'} is currently configured as text-only in this app. Please remove attachments for this provider.`,
        },
        { status: 400 },
      );
    }

    const userWorkspacePath = getWorkspacePath();
    await ensureWorkspaceExists(userWorkspacePath);

    const finalPrompt = buildPromptWithAttachments(promptText, parsedAttachments);

    if (runtime.kind === 'openrouter') {
      const resolvedSessionId = requestedSessionId || createSessionId(providerBinding.agentId);
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
              sessionId: resolvedSessionId,
              model: providerBinding.agentId,
            }) + '\n',
          );

          void (async () => {
            try {
              const upstream = await fetch(`${runtime.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${runtime.apiKey}`,
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
                throw new Error(`OpenRouter request failed with status ${upstream.status}.`);
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
                        session_id: resolvedSessionId,
                      }) + '\n',
                    );
                  } catch {
                    // Ignore malformed SSE chunks.
                  }
                }
              }

              await persistChatTurn({
                userId: session.user.id,
                sessionId: resolvedSessionId,
                model: providerBinding.agentId,
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

    if (runtime.kind === 'ollama') {
      const resolvedSessionId = requestedSessionId || createSessionId(providerBinding.agentId);
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
              sessionId: resolvedSessionId,
              model: providerBinding.agentId,
            }) + '\n',
          );

          void (async () => {
            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
              };
              if (runtime.apiKey) {
                headers.Authorization = `Bearer ${runtime.apiKey}`;
              }

              const upstream = await fetch(`${runtime.baseUrl.replace(/\/+$/, '')}/api/chat`, {
                method: 'POST',
                headers,
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
                throw new Error(`Ollama request failed with status ${upstream.status}.`);
              }

              if (!upstream.body) {
                throw new Error('Ollama response body is empty.');
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
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const rawLine of lines) {
                  const line = rawLine.trim();
                  if (!line) {
                    continue;
                  }

                  try {
                    const event = JSON.parse(line) as { error?: string; done?: boolean };
                    if (event.error) {
                      push(JSON.stringify({ type: 'error', message: event.error }) + '\n');
                      continue;
                    }

                    const textChunk = extractOllamaText(event);
                    if (!textChunk) {
                      continue;
                    }

                    finalResultText += textChunk;
                    push(
                      JSON.stringify({
                        type: 'assistant',
                        message: { content: [{ type: 'text', text: textChunk }] },
                        session_id: resolvedSessionId,
                      }) + '\n',
                    );
                  } catch {
                    // Ignore malformed chunks.
                  }
                }
              }

              if (buffer.trim()) {
                try {
                  const event = JSON.parse(buffer.trim()) as { error?: string };
                  if (event.error) {
                    push(JSON.stringify({ type: 'error', message: event.error }) + '\n');
                  } else {
                    const finalChunk = extractOllamaText(event);
                    if (finalChunk) {
                      finalResultText += finalChunk;
                      push(
                        JSON.stringify({
                          type: 'assistant',
                          message: { content: [{ type: 'text', text: finalChunk }] },
                          session_id: resolvedSessionId,
                        }) + '\n',
                      );
                    }
                  }
                } catch {
                  // Ignore trailing malformed chunk.
                }
              }

              await persistChatTurn({
                userId: session.user.id,
                sessionId: resolvedSessionId,
                model: providerBinding.agentId,
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

    const fallbackSessionId = requestedSessionId || createSessionId(providerBinding.agentId);
    const args = runtime.buildArgs({ prompt: finalPrompt, sessionId: requestedSessionId });

    if (!checkCliAvailability(runtime.command)) {
      return NextResponse.json(
        {
          success: false,
          error: `CLI not installed (${runtime.command}). Configure the provider command or install the CLI.`,
        },
        { status: 503 },
      );
    }

    console.log(
      `[AI Chat] Executing (${providerBinding.agentId}/${providerBinding.providerId}): ${runtime.command} (args=${args.length})`,
    );

    const aiProcess = spawn(runtime.command, args, {
      cwd: userWorkspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let extractedSessionId: string | null = requestedSessionId || null;
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
              message: `${providerBinding.agentId} CLI failed to start: ${processError.message}`,
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
                    sessionId: extractedSessionId || fallbackSessionId,
                    model: providerBinding.agentId,
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
                      thread_id: extractedSessionId || fallbackSessionId,
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
                        thread_id: extractedSessionId || fallbackSessionId,
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
                    thread_id: extractedSessionId || fallbackSessionId,
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
              sessionId: extractedSessionId || fallbackSessionId,
              model: providerBinding.agentId,
              promptText,
              hasAttachments,
              assistantText: finalResultText,
            });
          } catch (dbErr) {
            console.error('[AI Chat] DB Persistence Error:', dbErr);
          }

          if (code !== 0 && !hasSentHeader) {
            push(
              JSON.stringify({
                type: 'error',
                message: `${providerBinding.agentId} CLI exited with code ${String(code)}`,
              }) + '\n',
            );
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
    if (error instanceof ChatSessionNotFoundError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 404 });
    }

    console.error('[API] AI chat error:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
