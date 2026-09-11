import { NextRequest, NextResponse } from 'next/server';
import { getFileWatcher, type FileEvent } from '@/app/lib/filesystem/file-watcher';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Next route bundles and the in-process live-event WebSocket bridge must share
// the same ownership registry, including the existing HTTP syncDirs endpoint.
const watcherRuntime = globalThis as typeof globalThis & {
  __canvasFileWatcherConnections?: Map<string, { userId: string; workspaceId: string }>;
};
const activeConnections = watcherRuntime.__canvasFileWatcherConnections ??= new Map<string, { userId: string; workspaceId: string }>();

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;

  const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const { session, workspace } = workspaceResult;
  activeConnections.set(clientId, { userId: session.user.id, workspaceId: workspace.workspaceId });
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const watcher = getFileWatcher();

      const connectedEvent: FileEvent = {
        type: 'change',
        workspaceId: workspace.workspaceId,
        path: 'connected',
        relativePath: '.',
        dir: '.',
        timestamp: Date.now(),
      };

      controller.enqueue(
        new TextEncoder().encode(
          `event: connected\ndata: ${JSON.stringify({ ...connectedEvent, clientId })}\n\n`
        )
      );

      const unsubscribe = watcher.subscribe({
        id: clientId,
        workspaceId: workspace.workspaceId,
        workspace,
        send: (event: FileEvent) => {
          if (closed) return;
          try {
            watcher.touchClient(clientId);
            controller.enqueue(
              new TextEncoder().encode(
                `event: filechange\ndata: ${JSON.stringify(event)}\n\n`
              )
            );
          } catch {
            console.warn('[FileWatcher SSE]', { code: 'STREAM_SEND_FAILED' });
            cleanup?.();
          }
        },
      });

      const heartbeatInterval = setInterval(() => {
        if (closed) return;
        try {
          watcher.touchClient(clientId);
          controller.enqueue(
            new TextEncoder().encode(`event: heartbeat\ndata: ${Date.now()}\n\n`)
          );
        } catch {
          console.warn('[FileWatcher SSE]', { code: 'STREAM_HEARTBEAT_FAILED' });
          cleanup?.();
        }
      }, 30000);

      cleanup = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener('abort', cleanup!);
        clearInterval(heartbeatInterval);
        unsubscribe();
        activeConnections.delete(clientId);
        try { controller.close(); } catch { /* Already canceled by the reader. */ }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
      if (request.signal.aborted) cleanup();
    },

    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const { session, workspace } = workspaceResult;

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

    const connection = activeConnections.get(clientId);
    if (!connection || connection.userId !== session.user.id || connection.workspaceId !== workspace.workspaceId) {
      return NextResponse.json({ success: false, error: 'Unknown watcher connection' }, { status: 403 });
    }

    const watcher = getFileWatcher();
    await watcher.syncDirs(clientId, dirs);

    return NextResponse.json({ success: true, watchedDirs: watcher.getSubscribedDirs(workspace.workspaceId) });
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
