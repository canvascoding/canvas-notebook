import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveEventSource, LiveEventTransport } from '../app/lib/live-events/client';

class Socket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closes = 0;
  send(message: string) { this.sent.push(JSON.parse(message)); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  receive(message: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.closes++; this.readyState = 3; this.onclose?.(new Event('close')); }
}
function fixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL('http://127.0.0.1:3100/notebook') } });
  const sockets: Socket[] = [];
  const transport = new LiveEventTransport(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const sources: LiveEventSource[] = [];
  return { sockets,
    source(url: string) { const source = new LiveEventSource(url, transport); sources.push(source); return source; },
    cleanup() { sources.forEach(source => source.close()); if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); },
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('watch/presence/terminal share one socket and dispatch exact named/multiline events only to their owner', async () => {
  const f = fixture();
  try {
    const watch = f.source('/api/files/watch?workspaceId=a');
    const presence = f.source('/api/files/presence?workspaceId=a&stream=1');
    const terminal = f.source('/api/terminal/availability?stream=1');
    const received: unknown[] = [];
    watch.addEventListener('filechange', event => received.push(['watch', (event as MessageEvent).data, (event as MessageEvent).lastEventId]));
    presence.onmessage = event => received.push(['presence', event.data]);
    terminal.onmessage = event => received.push(['terminal', event.data]);
    await flush(); assert.equal(f.sockets.length, 1);
    const socket = f.sockets[0]; socket.open();
    assert.deepEqual(socket.sent.map(frame => [frame.channel, frame.workspaceId]), [['files', 'a'], ['presence', 'a'], ['terminal', undefined]]);
    socket.receive({ type: 'open', id: watch.subscription.id }); assert.equal(watch.readyState, 1);
    socket.receive({ type: 'event', id: watch.subscription.id, event: { event: 'filechange', data: 'line1\nline2', id: 'id1', retry: 2500 } });
    socket.receive({ type: 'event', id: presence.subscription.id, event: { data: 'presence' } });
    socket.receive({ type: 'event', id: terminal.subscription.id, event: { data: '' } });
    socket.receive({ type: 'event', id: 'foreign', event: { data: 'must-not-deliver' } });
    assert.deepEqual(received, [['watch', 'line1\nline2', 'id1'], ['presence', 'presence'], ['terminal', '']]);
    assert.equal(watch.retryMs, 2500);
    watch.close(); socket.receive({ type: 'event', id: watch.subscription.id, event: { event: 'filechange', data: 'late' } });
    assert.equal(received.length, 3); assert.equal(socket.closes, 0);
    presence.close(); assert.equal(socket.closes, 0); terminal.close(); assert.equal(socket.closes, 1);
  } finally { f.cleanup(); }
});

test('transport disconnect retries surviving subscriptions and ignores all late old-socket frames', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const source = f.source('/api/files/presence?workspaceId=a');
    const events: string[] = []; const statuses: number[] = [];
    source.onmessage = event => events.push(event.data);
    source.onerror = event => statuses.push(event.status ?? -1);
    await flush(); f.sockets[0].open();
    const old = f.sockets[0]; old.receive({ type: 'event', id: source.subscription.id, event: { id: 'last', data: 'one' } });
    old.close(); assert.deepEqual(statuses, [0]);
    context.mock.timers.tick(1000); await flush();
    assert.equal(f.sockets.length, 2); f.sockets[1].open();
    assert.equal(f.sockets[1].sent[0].lastEventId, 'last');
    old.receive({ type: 'event', id: source.subscription.id, event: { data: 'stale' } });
    f.sockets[1].receive({ type: 'event', id: source.subscription.id, event: { data: 'two' } });
    assert.deepEqual(events, ['one', 'two']);
  } finally { f.cleanup(); context.mock.timers.reset(); }
});

test('401/403 are visible structured terminal failures; close-before-connect never creates a socket', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const closed = f.source('/api/files/watch?workspaceId=a'); closed.close(); await flush();
    assert.equal(f.sockets.length, 0);
    const source = f.source('/api/terminal/availability'); const statuses: number[] = [];
    source.onerror = event => statuses.push(event.status!);
    await flush(); f.sockets[0].open();
    f.sockets[0].receive({ type: 'error', id: source.subscription.id, status: 401 });
    assert.deepEqual(statuses, [401]); assert.equal(source.readyState, 2);
    context.mock.timers.tick(60_000); await flush(); assert.equal(f.sockets.length, 1);
    assert.throws(() => f.source('https://other.invalid/api/files/watch?workspaceId=a'), /Unsupported/);
    assert.throws(() => f.source('/api/private?workspaceId=a'), /Unsupported/);
  } finally { f.cleanup(); context.mock.timers.reset(); }
});

test('ending streams reauthorize once without reconnecting peers or duplicating retries after socket loss', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const source = f.source('/api/files/presence?workspaceId=a'); const statuses: number[] = [];
    source.onerror = event => statuses.push(event.status!);
    await flush(); const old = f.sockets[0]; old.open();
    old.receive({ type: 'end', id: source.subscription.id }); assert.deepEqual(statuses, [0]);
    context.mock.timers.tick(500); old.close();
    context.mock.timers.tick(1000); await flush(); f.sockets[1].open();
    context.mock.timers.tick(5000); await flush();
    assert.equal(f.sockets[1].sent.length, 1, 'the previous per-stream timer cannot resubscribe again after reconnect');
    f.sockets[1].receive({ type: 'error', id: source.subscription.id, status: 503 });
    assert.deepEqual(statuses, [0, 0, 503], 'one error per failure');
    context.mock.timers.tick(1000); await flush();
    assert.equal(f.sockets[1].sent.length, 2);
  } finally { f.cleanup(); context.mock.timers.reset(); }
});

test('scheduled reauthorization leaves ready terminal state intact, while its eventual denial remains an error', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    const source = f.source('/api/terminal/availability');
    let ready = false; let enabled = false; const statuses: number[] = [];
    source.onmessage = event => { enabled = JSON.parse(event.data).terminalEnabled; ready = true; };
    source.onerror = event => { statuses.push(event.status!); enabled = false; ready = false; };
    await flush(); const socket = f.sockets[0]; socket.open();
    socket.receive({ type: 'open', id: source.subscription.id });
    socket.receive({ type: 'event', id: source.subscription.id, event: { data: JSON.stringify({ terminalEnabled: true }) } });
    socket.receive({ type: 'refresh', id: source.subscription.id });
    assert.equal(ready, true); assert.equal(enabled, true); assert.deepEqual(statuses, []);
    context.mock.timers.tick(0); await flush();
    assert.equal(socket.sent.length, 2, 'scheduled refresh calls the real handler again on the same socket');
    socket.receive({ type: 'error', id: source.subscription.id, status: 401 });
    assert.equal(ready, false); assert.equal(enabled, false); assert.deepEqual(statuses, [401]);
  } finally { f.cleanup(); context.mock.timers.reset(); }
});
