import type { IncomingMessage } from 'node:http';
import { NextRequest } from 'next/server';
import WebSocket from 'ws';
import { createLiveEventParser } from '../app/lib/live-events/sse-parser';
import { isLiveEventSubscription, LIVE_EVENT_ROUTES, type LiveEventChannel, type LiveEventServerMessage } from '../app/lib/live-events/protocol';
import { runWithRequestIdentity } from '../app/lib/security/request-identity';

export type LiveEventHandlers = Record<LiveEventChannel, (request: NextRequest) => Promise<Response>>;
type ActiveStream = { channel: LiveEventChannel; controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null;
  timeout: ReturnType<typeof setTimeout>; revalidate: ReturnType<typeof setTimeout> | null };

/** Run the actual SSE handlers in-process. No client-controlled upstream URLs or headers. */
export function attachLiveEventConnection(socket: WebSocket, incoming: IncomingMessage, handlers: LiveEventHandlers) {
  const streams = new Map<string, ActiveStream>();
  // runWithRequestIdentity strips proxy attestation headers. Each subscription
  // receives its own original handshake copy, never another subscription's copy.
  const originalHeaders = Object.fromEntries(Object.entries(incoming.headers).map(([key, value]) =>
    [key, Array.isArray(value) ? [...value] : value]));
  const diagnostic = (code: string, channel?: LiveEventChannel, status?: number) => {
    console.warn('[LiveEvents]', { code, ...(channel ? { channel } : {}), ...(status ? { status } : {}) });
  };
  let closed = false;
  let windowStarted = Date.now();
  let messages = 0;
  const stop = (id: string, entry: ActiveStream) => {
    if (streams.get(id) === entry) streams.delete(id);
    clearTimeout(entry.timeout);
    if (entry.revalidate) clearTimeout(entry.revalidate);
    entry.controller.abort();
    void entry.reader?.cancel().catch(() => undefined);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const [id, entry] of streams) stop(id, entry);
    clearTimeout(idleTimer);
  };
  const send = (value: LiveEventServerMessage) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(value);
    if (text.length > 2 * 1024 * 1024 || socket.bufferedAmount > 2 * 1024 * 1024) {
      diagnostic('BACKPRESSURE_LIMIT', streams.get(value.id)?.channel);
      cleanup(); socket.close(1013, 'Live event consumer is too slow.'); return;
    }
    socket.send(text, error => { if (error) { diagnostic('SOCKET_SEND_FAILED'); cleanup(); socket.terminate(); } });
  };
  const idleTimer = setTimeout(() => { if (!streams.size) { cleanup(); socket.close(1008, 'Subscription required.'); } }, 10_000);
  idleTimer.unref?.();
  const subscribe = async (input: Parameters<typeof isLiveEventSubscription>[0]) => {
    if (!isLiveEventSubscription(input)) { socket.close(1008, 'Invalid subscription.'); cleanup(); return; }
    if (streams.has(input.id) || streams.size >= 8) { send({ type: 'error', id: input.id, status: 429 }); return; }
    const controller = new AbortController();
    const entry: ActiveStream = { channel: input.channel, controller, reader: null, revalidate: null,
      timeout: setTimeout(() => { diagnostic('HANDLER_START_TIMEOUT', input.channel, 504); stop(input.id, entry); send({ type: 'error', id: input.id, status: 504 }); }, 10_000) };
    streams.set(input.id, entry);
    const current = () => !closed && !controller.signal.aborted && streams.get(input.id) === entry;
    try {
      const identityRequest = { headers: { ...originalHeaders }, socket: incoming.socket } as IncomingMessage;
      const response = await runWithRequestIdentity(identityRequest, async () => {
        const headers = new Headers();
        // These are the actual handshake headers, never subscription payload fields.
        for (const [name, value] of Object.entries(identityRequest.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(', '));
        }
        headers.delete('x-canvas-workspace-id');
        if (input.workspaceId) headers.set('x-canvas-workspace-id', input.workspaceId);
        if (input.lastEventId) headers.set('last-event-id', input.lastEventId);
        const url = new URL(LIVE_EVENT_ROUTES[input.channel], 'http://live-events.internal');
        url.searchParams.set('stream', '1');
        if (input.workspaceId) url.searchParams.set('workspaceId', input.workspaceId);
        return handlers[input.channel](new NextRequest(url, { headers, signal: controller.signal }));
      });
      clearTimeout(entry.timeout);
      if (!current()) { await response.body?.cancel(); return; }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
        await response.body?.cancel();
        if (response.ok || response.status >= 500) diagnostic('HANDLER_REJECTED', input.channel, response.ok ? 502 : response.status);
        send({ type: 'error', id: input.id, status: response.ok ? 502 : response.status }); return;
      }
      entry.reader = response.body.getReader();
      send({ type: 'open', id: input.id });
      // Reopen even otherwise quiet streams through their real handler, so session
      // expiry/revocation cannot leave a permanently authorized socket subscription.
      entry.revalidate = setTimeout(() => { stop(input.id, entry); send({ type: 'refresh', id: input.id }); }, 60_000);
      entry.revalidate.unref?.();
      const parser = createLiveEventParser(event => { if (current()) send({ type: 'event', id: input.id, event }); });
      while (current()) {
        const next = await entry.reader.read();
        if (!current()) return;
        if (next.done) { send({ type: 'end', id: input.id }); return; }
        parser.push(next.value);
      }
    } catch {
      if (current()) { diagnostic('HANDLER_OR_STREAM_FAILED', input.channel, 500); send({ type: 'error', id: input.id, status: 500 }); }
    } finally { stop(input.id, entry); }
  };
  socket.on('message', (data, binary) => {
    if (closed) return;
    if (Date.now() - windowStarted >= 10_000) { windowStarted = Date.now(); messages = 0; }
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
    if (binary || bytes.length > 8192 || ++messages > 32) { cleanup(); socket.close(1008, 'Live event request limit exceeded.'); return; }
    let input: unknown;
    try { input = JSON.parse(bytes.toString()); } catch { cleanup(); socket.close(1008, 'Invalid live event request.'); return; }
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const value = input as Record<string, unknown>;
      if (value.type === 'unsubscribe' && typeof value.id === 'string' && Object.keys(value).length === 2) {
        const entry = streams.get(value.id); if (entry) stop(value.id, entry); return;
      }
    }
    void subscribe(input);
  });
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  return cleanup;
}
