import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getWorkspacePath, ensureWorkspaceExists } from '@/app/lib/utils/workspace-manager';
import { db } from '@/app/lib/db';
import { aiSessions, aiMessages } from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'ai-chat' });
    if (!limited.ok) return limited.response;

    const { message, sessionId, model = 'claude' } = await request.json();
    if (!message) return NextResponse.json({ success: false, error: 'Message required' }, { status: 400 });
    
    const userWorkspacePath = getWorkspacePath(); 
    await ensureWorkspaceExists(userWorkspacePath);

    let command = '';
    let args: string[] = [];

    if (model === 'claude') {
      command = 'claude';
      args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--permission-mode', 'bypassPermissions',
        '--allowedTools', 'read', '--allowedTools', 'ls', '--allowedTools', 'bash', 
        '--allowedTools', 'write', '--allowedTools', 'edit', '--allowedTools', 'glob', 
        '--allowedTools', 'grep'
      ];
      if (sessionId) args.push('--resume', sessionId);
    } else if (model === 'gemini') {
      command = 'gemini';
      args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--verbose',
        '--yolo',
        '--approval-mode', 'yolo'
      ];
      if (sessionId) args.push('--resume', sessionId);
    } else if (model === 'codex') {
      command = 'codex';
      // We don't specify model to let it use the server default for ChatGPT accounts
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
      ];
      
      if (sessionId) {
        args.push('resume', sessionId, message);
      } else {
        args.push(message);
      }
    } else {
      return NextResponse.json({ success: false, error: 'Invalid model' }, { status: 400 });
    }

    console.log(`[AI Chat] Executing: ${command} ${args.join(' ')}`);

    const aiProcess = spawn(command, args, {
      cwd: userWorkspacePath,
      stdio: ['ignore', 'pipe', 'pipe'], 
    });

    let extractedSessionId: string | null = sessionId || null;
    let hasSentHeader = false;
    let stdoutBuffer = '';
    let finalResultText = '';

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        const push = (text: string) => {
          try { controller.enqueue(encoder.encode(text)); } catch {}
        };

        aiProcess.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            console.log(`[${model} STDOUT] ${line}`);
            try {
              const event = JSON.parse(line);

              // 1. Session Extraction
              if (model === 'claude' || model === 'gemini') {
                if (event.session_id) {
                  extractedSessionId = event.session_id;
                  console.log(`[${model}] Captured session_id: ${extractedSessionId}`);
                }
                if (event.type === 'result' && event.result) finalResultText = event.result;
              } else if (model === 'codex') {
                if ((event.type === 'thread.started' || event.type === 'thread.resumed') && event.thread_id) {
                  extractedSessionId = event.thread_id;
                  console.log(`[Codex] Captured thread_id: ${extractedSessionId}`);
                }
              }

              // 2. Initial Success Header
              if (!hasSentHeader) {
                const header = JSON.stringify({
                  success: true,
                  sessionId: extractedSessionId || sessionId || 'new',
                  model,
                  initialEvent: event
                });
                console.log(`[${model}] Sending initial header: ${header}`);
                push(header + '\n');
                hasSentHeader = true;
              }

              // 3. Mapping Codex events to Claude-like format for the UI
              if (model === 'codex') {
                if (event.type === 'item.agentMessage.delta' && event.content?.text) {
                  finalResultText += event.content.text;
                  push(JSON.stringify({ 
                    type: 'assistant', 
                    message: { content: [{ type: 'text', text: event.content.text }] },
                    thread_id: extractedSessionId
                  }) + '\n');
                  continue; 
                }
                if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
                  if (!finalResultText) {
                    finalResultText = event.item.text;
                    push(JSON.stringify({ 
                      type: 'assistant', 
                      message: { content: [{ type: 'text', text: event.item.text }] },
                      thread_id: extractedSessionId
                    }) + '\n');
                  }
                  continue;
                }
                if (event.type === 'error' || event.type === 'turn.failed') {
                   push(JSON.stringify({ type: 'error', message: event.message || event.error?.message || 'Codex error' }) + '\n');
                }
              } else {
                // For Claude/Gemini, just push original events
                push(line + '\n');
              }
            } catch (e) {
              // Handle potential raw text (progress indicators etc)
              if (line.trim()) {
                console.log(`[${model} RAW] ${line}`);
                // If it looks like an error, treat it as one
                if (line.includes('ERROR')) {
                   push(JSON.stringify({ type: 'error', message: line }) + '\n');
                } else {
                   // Otherwise stream as text delta
                   push(JSON.stringify({ 
                     type: 'assistant', 
                     message: { content: [{ type: 'text', text: line + '\n' }] },
                     thread_id: extractedSessionId
                   }) + '\n');
                }
              }
            }
          }
        });

        aiProcess.stderr.on('data', (data: Buffer) => {
          const errStr = data.toString();
          console.error(`[${model} STDERR] ${errStr}`);
          // Many CLI tools write progress/warnings to stderr
          if (errStr.toLowerCase().includes('error')) {
            push(JSON.stringify({ type: 'error', message: errStr }) + '\n');
          }
        });

        aiProcess.on('close', async (code: number | null) => {
          console.log(`[${model} PROCESS] Closed with code ${code}`);
          try {
            let dbSessionId: number | null = null;
            const targetSessionId = extractedSessionId || sessionId;
            console.log(`[${model}] Final persistence check. targetSessionId: ${targetSessionId}, model: ${model}`);
            
            if (targetSessionId) {
              const existingSessions = await db
                .select()
                .from(aiSessions)
                .where(and(eq(aiSessions.sessionId, targetSessionId), eq(aiSessions.model, model)))
                .limit(1);

              if (existingSessions.length > 0) {
                dbSessionId = existingSessions[0].id;
                console.log(`[${model}] Found existing session in DB: ${dbSessionId}`);
              } else {
                console.log(`[${model}] Creating NEW session in DB for ID: ${targetSessionId}`);
                const result = await db.insert(aiSessions).values({
                  sessionId: targetSessionId,
                  userId: session.user.id,
                  model: model,
                  title: message.substring(0, 40) + (message.length > 40 ? '...' : ''),
                  createdAt: new Date(),
                }).returning({ id: aiSessions.id });
                dbSessionId = result[0].id;
              }
            }

            if (dbSessionId) {
              console.log(`[${model}] Saving user message to DB session ${dbSessionId}`);
              await db.insert(aiMessages).values({
                aiSessionDbId: dbSessionId,
                role: 'user',
                content: message,
                createdAt: new Date(),
              });

              if (finalResultText) {
                console.log(`[${model}] Saving assistant message to DB (length: ${finalResultText.length})`);
                await db.insert(aiMessages).values({
                  aiSessionDbId: dbSessionId,
                  role: 'assistant',
                  content: finalResultText,
                  type: 'result',
                  createdAt: new Date(),
                });
              }
            }
          } catch (dbErr) {
            console.error('[AI Chat] DB Persistence Error:', dbErr);
          }
          controller.close();
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
