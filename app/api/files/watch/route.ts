import { NextRequest, NextResponse } from 'next/server';
import { getFileWatcher, type FileEvent } from '@/app/lib/filesystem/file-watcher';
import { auth } from '@/app/lib/auth';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const clientIds = new Map<Request, string>();

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  clientIds.set(request, clientId);

  const stream = new ReadableStream({
    start(controller) {
      const watcher = getFileWatcher();

      const connectedEvent: FileEvent = {
        type: 'change',
        path: 'connected',
        relativePath: '.',
        dir: '.',
        timestamp: Date.now(),
      };

      const clientIdPayload = JSON.stringify({ clientId });

      controller.enqueue(
        new TextEncoder().encode(
          `event: connected\ndata: ${JSON.stringify({ ...connectedEvent, clientId })}\n\n`
        )
      );

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
            console.warn(`[FileWatcher SSE] Failed to send to ${clientId}:`, error);
            unsubscribe();
          }
        },
      });

      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: heartbeat\ndata: ${Date.now()}\n\n`)
          );
        } catch {
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      }, 30000);

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
        clientIds.delete(request);
        console.log(`[FileWatcher SSE] Client ${clientId} disconnected`);
      });
    },

    cancel() {
      console.log(`[FileWatcher SSE] Stream cancelled for ${clientId}`);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { clientId, dirs } = body as { clientId?: string; dirs?: string[] };

    if (!clientId) {
      return NextResponse.json(
        { success: false, error: 'clientId is required' },
        { status: 400 }
      );
    }

    if (!Array.isArray(dirs)) {
      return NextResponse.json(
        { success: false, error: 'dirs must be an array of strings' },
        { status: 400 }
      );
    }

    const watcher = getFileWatcher();
    watcher.syncDirs(clientId, dirs);

    return NextResponse.json({ success: true, watchedDirs: watcher.getSubscribedDirs() });
  } catch (error) {
    console.error('[FileWatcher SSE] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}