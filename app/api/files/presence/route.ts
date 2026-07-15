import { NextRequest, NextResponse } from 'next/server';

import {
  getWorkspacePresenceSnapshot,
  subscribeWorkspacePresence,
} from '@/app/lib/collaboration/presence';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const workspaceId = workspaceResult.workspace.workspaceId;
  if (request.nextUrl.searchParams.get('stream') !== '1') {
    return NextResponse.json(getWorkspacePresenceSnapshot(workspaceId), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      send({ type: 'snapshot', ...getWorkspacePresenceSnapshot(workspaceId) });
      unsubscribe = subscribeWorkspacePresence(workspaceId, send);
      let revalidating = false;
      heartbeat = setInterval(() => {
        if (revalidating) return;
        revalidating = true;
        void requireRequestWorkspace(request, { workspaceId, permissions: 'canRead' }).then((current) => {
          if (current.response) {
            unsubscribe();
            if (heartbeat) clearInterval(heartbeat);
            try { controller.close(); } catch {}
            return;
          }
          send({ type: 'snapshot', ...getWorkspacePresenceSnapshot(workspaceId) });
        }).catch(() => {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch {}
        }).finally(() => { revalidating = false; });
      }, 20_000);
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }, { once: true });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
