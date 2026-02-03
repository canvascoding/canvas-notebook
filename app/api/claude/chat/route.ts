import { NextRequest, NextResponse } from 'next/server';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getWorkspacePath, ensureWorkspaceExists } from '@/app/lib/utils/workspace-manager';
import { db } from '@/app/lib/db';
import { claudeSessions, claudeMessages } from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';

const CLAUDE_CLI_PATH = 'claude';

let claudeCliAvailable: boolean | null = null;

function checkClaudeCliAvailability(): boolean {
  if (claudeCliAvailable !== null) return claudeCliAvailable;
  try {
    execSync(`which ${CLAUDE_CLI_PATH}`, { stdio: 'ignore' });
    claudeCliAvailable = true;
  } catch (error) {
    claudeCliAvailable = false;
  }
  return claudeCliAvailable;
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  if (!checkClaudeCliAvailability()) {
    return NextResponse.json({ success: false, error: 'Claude CLI not found' }, { status: 500 });
  }

  try {
    const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'claude-chat' });
    if (!limited.ok) return limited.response;

    const { message, sessionId, allowedTools: requestedAllowedTools } = await request.json();
    if (!message) return NextResponse.json({ success: false, error: 'Message required' }, { status: 400 });
    
    const userWorkspacePath = getWorkspacePath(); 
    await ensureWorkspaceExists(userWorkspacePath);

    const defaultAllowedTools = ['read', 'ls', 'bash', 'write', 'edit', 'glob', 'grep', 'Task', 'ExitPlanMode'];
    let toolsToAllow = Array.isArray(requestedAllowedTools) ? requestedAllowedTools : defaultAllowedTools;

    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--permission-mode', 'bypassPermissions',
    ];

    toolsToAllow.forEach(tool => args.push('--allowedTools', tool));
    if (sessionId) args.push('--resume', sessionId);

    console.log(`[Claude CLI] Workspace: ${userWorkspacePath}, Session: ${sessionId || 'new'}`);

    const claudeProcess = spawn(CLAUDE_CLI_PATH, args, {
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

        claudeProcess.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              if ((event.type === 'system' && event.subtype === 'init') || event.type === 'result') {
                if (event.session_id) extractedSessionId = event.session_id;
              }

              if (event.type === 'result' && event.result) {
                finalResultText = event.result;
              }

              if (!hasSentHeader) {
                push(JSON.stringify({
                  success: true,
                  sessionId: extractedSessionId || sessionId || 'new',
                  initialEvent: event
                }) + '\n');
                hasSentHeader = true;
              } else {
                push(line + '\n');
              }
            } catch (e) {
              console.log(`[Claude CLI] Non-JSON stdout: ${line}`);
            }
          }
        });

        claudeProcess.stderr.on('data', (data: Buffer) => {
          push(JSON.stringify({ type: 'error', message: data.toString() }) + '\n');
        });

        claudeProcess.on('close', async (code: number | null) => {
          try {
            let dbSessionId: number | null = null;

            if (extractedSessionId) {
              const existingSessions = await db
                .select()
                .from(claudeSessions)
                .where(eq(claudeSessions.sessionId, extractedSessionId))
                .limit(1);

              if (existingSessions.length > 0) {
                dbSessionId = existingSessions[0].id;
              } else {
                const result = await db.insert(claudeSessions).values({
                  sessionId: extractedSessionId,
                  userId: session.user.id,
                  title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                  createdAt: new Date(),
                }).returning({ id: claudeSessions.id });
                dbSessionId = result[0].id;
              }
            }

            if (dbSessionId) {
              await db.insert(claudeMessages).values({
                claudeSessionDbId: dbSessionId,
                role: 'user',
                content: message,
                createdAt: new Date(),
              });

              if (finalResultText) {
                await db.insert(claudeMessages).values({
                  claudeSessionDbId: dbSessionId,
                  role: 'assistant',
                  content: finalResultText,
                  type: 'result',
                  createdAt: new Date(),
                });
              }
            }
          } catch (dbErr) {
            console.error('[Claude CLI] DB Persistence Error:', dbErr);
          }

          if (stdoutBuffer.trim()) {
            push(stdoutBuffer + '\n');
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
    console.error('[API] Claude chat error:', error);
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}