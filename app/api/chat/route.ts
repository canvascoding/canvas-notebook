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
        '--yolo', // Automatically accept all actions for headless mode
        '--approval-mode', 'yolo'
      ];
      if (sessionId) args.push('--resume', sessionId);
    } else if (model === 'codex') {
      command = 'codex';
      args = [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        message
      ];
      // Codex resume logic might differ, for now we just pass the prompt
    } else {
      return NextResponse.json({ success: false, error: 'Invalid model' }, { status: 400 });
    }

    console.log(`[AI Chat] Model: ${model}, Workspace: ${userWorkspacePath}, Session: ${sessionId || 'new'}`);

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
            try {
              const event = JSON.parse(line);

              // Extract Session ID for Claude and Gemini
              if (model === 'claude' || model === 'gemini') {
                if ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') {
                  if (event.session_id) extractedSessionId = event.session_id;
                }
                if (event.type === 'result' && event.result) {
                  finalResultText = event.result;
                }
              } 
              // Extract for Codex
              else if (model === 'codex') {
                // Codex JSONL events might differ, we need to map them to a common format
                // For now, if it's text, we collect it
                if (event.type === 'message' && event.message?.content) {
                   // Map codex message to common format
                }
                if (event.type === 'final_response' || event.type === 'success') {
                    finalResultText = event.content || event.message || finalResultText;
                }
              }

              if (!hasSentHeader) {
                push(JSON.stringify({
                  success: true,
                  sessionId: extractedSessionId || sessionId || 'new',
                  model,
                  initialEvent: event
                }) + '\n');
                hasSentHeader = true;
              } else {
                push(line + '\n');
              }
            } catch (e) {
              // Non-JSON output (maybe progress indicators)
              push(JSON.stringify({ type: 'text', content: line }) + '\n');
            }
          }
        });

        aiProcess.stderr.on('data', (data: Buffer) => {
          push(JSON.stringify({ type: 'error', message: data.toString() }) + '\n');
        });

        aiProcess.on('close', async (code: number | null) => {
          try {
            let dbSessionId: number | null = null;

            if (extractedSessionId) {
              const existingSessions = await db
                .select()
                .from(aiSessions)
                .where(and(eq(aiSessions.sessionId, extractedSessionId), eq(aiSessions.model, model)))
                .limit(1);

              if (existingSessions.length > 0) {
                dbSessionId = existingSessions[0].id;
              } else {
                const result = await db.insert(aiSessions).values({
                  sessionId: extractedSessionId,
                  userId: session.user.id,
                  model: model,
                  title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                  createdAt: new Date(),
                }).returning({ id: aiSessions.id });
                dbSessionId = result[0].id;
              }
            }

            if (dbSessionId) {
              await db.insert(aiMessages).values({
                aiSessionDbId: dbSessionId,
                role: 'user',
                content: message,
                createdAt: new Date(),
              });

              if (finalResultText) {
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

          if (stdoutBuffer.trim()) {
            push(JSON.stringify({ type: 'text', content: stdoutBuffer }) + '\n');
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
