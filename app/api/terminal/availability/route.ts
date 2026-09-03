import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readTerminalAvailability, subscribeTerminalAvailability } from '@/app/lib/terminal-policy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.nextUrl.searchParams.get('stream') !== '1') {
    return NextResponse.json({ success: true, data: readTerminalAvailability() }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', cleanup);
        try { controller.close(); } catch { /* The reader may already be closed. */ }
      };
      const send = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); }
      };
      unsubscribe = subscribeTerminalAvailability(state => send(`data: ${JSON.stringify(state)}\n\n`));
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15000);
      request.signal.addEventListener('abort', cleanup, { once: true });
      if (request.signal.aborted) cleanup();
      else send(`data: ${JSON.stringify(readTerminalAvailability())}\n\n`);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
