/**
 * File Watcher SSE API Endpoint
 *
 * Stellt einen Server-Sent Events (SSE) Stream bereit,
 * der File-System-Änderungen in Echtzeit an Clients sendet.
 *
 * GET /api/files/watch
 *
 * Event-Format:
 * {
 *   type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
 *   path: string,
 *   relativePath: string,
 *   timestamp: number
 * }
 */

import { NextRequest } from 'next/server';
import { getFileWatcher, type FileEvent } from '@/app/lib/filesystem/file-watcher';
import { auth } from '@/app/lib/auth';

// SSE-Header für EventStream
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no', // Disable Nginx buffering
};

export async function GET(request: NextRequest) {
  // Auth-Check
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Generiere eindeutige Client-ID
  const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Erstelle ReadableStream für SSE
  const stream = new ReadableStream({
    start(controller) {
      const watcher = getFileWatcher();

      // Sende initialen "connected" Event
      const connectedEvent: FileEvent = {
        type: 'change',
        path: 'connected',
        relativePath: '.',
        dir: '.',
        timestamp: Date.now(),
      };

      controller.enqueue(
        new TextEncoder().encode(
          `event: connected\ndata: ${JSON.stringify(connectedEvent)}\n\n`
        )
      );

      // Subscribe to file watcher
      const unsubscribe = watcher.subscribe({
        id: clientId,
        send: (event: FileEvent) => {
          try {
            controller.enqueue(
              new TextEncoder().encode(
                `event: filechange\ndata: ${JSON.stringify(event)}\n\n`
              )
            );
          } catch (error) {
            // Client disconnected
            console.warn(`[FileWatcher SSE] Failed to send to ${clientId}:`, error);
            unsubscribe();
          }
        },
      });

      // Heartbeat alle 30 Sekunden um Connection offen zu halten
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: heartbeat\ndata: ${Date.now()}\n\n`)
          );
        } catch {
          // Client disconnected
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      }, 30000);

      // Cleanup bei Stream-Ende
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
        console.log(`[FileWatcher SSE] Client ${clientId} disconnected`);
      });
    },

    cancel() {
      console.log(`[FileWatcher SSE] Stream cancelled for ${clientId}`);
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}

// OPTIONS für CORS
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
