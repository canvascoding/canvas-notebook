/**
 * GET /api/terminal/[id]/stream
 * SSE Stream für Terminal-Output
 */

import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import * as net from 'net';
import * as fs from 'fs';

const SOCKET_PATH = process.env.CANVAS_TERMINAL_SOCKET || '/tmp/canvas-terminal.sock';
const TCP_PORT = parseInt(process.env.CANVAS_TERMINAL_PORT || '3457', 10);
const AUTH_TOKEN = process.env.CANVAS_TERMINAL_TOKEN || '';
const USE_UNIX_SOCKET = fs.existsSync(SOCKET_PATH);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth check
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { id: sessionId } = await params;

    // Create SSE stream
    const stream = new ReadableStream({
      start(controller) {
        // Connect to terminal service
        const socket = new net.Socket();
        const encoder = new TextEncoder();
        let buffer = '';
        let isClosed = false;

        const handleAbort = () => {
          closeStream();
        };

        const closeStream = () => {
          if (isClosed) {
            return;
          }

          isClosed = true;
          request.signal.removeEventListener('abort', handleAbort);

          if (!socket.destroyed) {
            socket.destroy();
          }

          try {
            controller.close();
          } catch {
            // Stream already closed
          }
        };

        const sendEvent = (data: Record<string, unknown>) => {
          if (isClosed) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            closeStream();
          }
        };

        socket.on('connect', () => {
          if (isClosed) {
            return;
          }

          // Authenticate
          const authMsg = JSON.stringify({
            id: 'auth',
            method: 'auth',
            params: { token: AUTH_TOKEN }
          }) + '\n';
          socket.write(authMsg);
        });

        socket.on('data', (data) => {
          if (isClosed) {
            return;
          }

          buffer += data.toString();

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);

            if (line.trim()) {
              try {
                const message = JSON.parse(line);

                // Handle auth response
                if (message.id === 'auth') {
                  if (message.error) {
                    sendEvent({ type: 'error', error: 'Authentication failed' });
                    closeStream();
                    return;
                  }

                  // Attach to session
                  const attachMsg = JSON.stringify({
                    id: 'attach',
                    method: 'attach',
                    params: { sessionId }
                  }) + '\n';
                  socket.write(attachMsg);
                  return;
                }

                // Handle attach response
                if (message.id === 'attach') {
                  if (message.error) {
                    sendEvent({ type: 'error', error: String(message.error.message) });
                    closeStream();
                    return;
                  }
                  sendEvent({ type: 'ready', sessionId });
                  return;
                }

                // Forward terminal events
                if (message.type === 'output') {
                  sendEvent({ type: 'output', data: message.data });
                } else if (message.type === 'exit') {
                  sendEvent({ type: 'exit', exitCode: message.exitCode });
                }
              } catch {
                // Invalid JSON, ignore
              }
            }
          }
        });

        socket.on('error', (err) => {
          sendEvent({ type: 'error', error: err.message });
          closeStream();
        });

        socket.on('close', () => {
          closeStream();
        });

        if (request.signal.aborted) {
          closeStream();
          return;
        }

        request.signal.addEventListener('abort', handleAbort, { once: true });

        // Connect
        if (USE_UNIX_SOCKET) {
          socket.connect(SOCKET_PATH);
        } else {
          socket.connect(TCP_PORT, '127.0.0.1');
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error: unknown) {
    console.error('[Terminal API] Stream error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
