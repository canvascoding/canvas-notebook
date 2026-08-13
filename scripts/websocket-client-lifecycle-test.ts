import assert from 'node:assert/strict';
import { WebSocketClient, calculateReconnectDelay } from '../app/lib/websocket/client';

type CloseHandler = ((event: CloseEvent) => void) | null;

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: CloseHandler = null;
  sent: Array<Record<string, unknown>> = [];

  send(serialized: string): void {
    this.sent.push(JSON.parse(serialized) as Record<string, unknown>);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  serverClose(code: number, reason: string): CloseHandler {
    this.readyState = WebSocket.CLOSED;
    const handler = this.onclose;
    handler?.({ code, reason, wasClean: code !== 1006 } as CloseEvent);
    return handler;
  }

  close(code = 1000, reason = ''): void {
    this.serverClose(code, reason);
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

async function nextTimer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function main(): Promise<void> {
assert.equal(calculateReconnectDelay(0, 1_000, 30_000, () => 0), 800);
assert.equal(calculateReconnectDelay(2, 1_000, 30_000, () => 0.5), 4_000);
assert.equal(calculateReconnectDelay(20, 1_000, 30_000, () => 1), 30_000);

const sockets: FakeSocket[] = [];
const client = new WebSocketClient('ws://example.test/ws/chat', {
  createSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return asWebSocket(socket);
  },
  random: () => 0.5,
  reconnectBaseDelayMs: 0,
  reconnectMaxDelayMs: 0,
  disconnectGraceMs: 0,
});

const firstLease = client.acquireConnection();
const secondLease = client.acquireConnection();
assert.equal(sockets.length, 1, 'concurrent consumers must share one connection attempt');
sockets[0].open();
sockets[0].receive({ type: 'auth_success', userId: 'user-1' });
await Promise.all([firstLease, secondLease]);
assert.equal(client.isConnected(), true);

const firstSubscription = client.subscribe('session-a');
const secondSubscription = client.subscribe('session-a');
await Promise.resolve();
const subscribeMessages = sockets[0].sent.filter((message) => message.type === 'subscribe_session');
assert.equal(subscribeMessages.length, 1, 'shared session consumers must share one server subscription');
sockets[0].receive({
  type: 'subscribe_result',
  requestId: subscribeMessages[0].requestId,
  sessionId: 'session-a',
  success: true,
});
await Promise.all([firstSubscription, secondSubscription]);

client.unsubscribe('session-a');
assert.equal(
  sockets[0].sent.filter((message) => message.type === 'unsubscribe_session').length,
  0,
  'first release must keep a shared subscription alive',
);
client.unsubscribe('session-a');
assert.equal(
  sockets[0].sent.filter((message) => message.type === 'unsubscribe_session').length,
  1,
  'last release must unsubscribe at the server',
);

const staleMessageHandler = sockets[0].onmessage;
sockets[0].serverClose(1012, 'Service restart');
await nextTimer();
assert.equal(sockets.length, 2, 'service restart must schedule a reconnect');
sockets[1].open();
staleMessageHandler?.({ data: JSON.stringify({ type: 'auth_error', error: 'stale' }) } as MessageEvent);
sockets[1].receive({ type: 'auth_success', userId: 'user-1' });
await nextTimer();
assert.equal(client.isConnected(), true, 'stale callbacks must not corrupt the replacement socket');

const ambiguousSend = client.request('send_message', {
  sessionId: 'session-a',
  message: { role: 'user', content: 'do not replay me' },
});
await Promise.resolve();
assert.equal(sockets[1].sent.filter((message) => message.type === 'send_message').length, 1);
sockets[1].serverClose(1006, 'Network lost');
await assert.rejects(ambiguousSend, /disconnected/u);
await nextTimer();
assert.equal(sockets.length, 3);
sockets[2].open();
sockets[2].receive({ type: 'auth_success', userId: 'user-1' });
await nextTimer();
assert.equal(
  sockets[2].sent.filter((message) => message.type === 'send_message').length,
  0,
  'state-changing requests must never be replayed after an ambiguous disconnect',
);

client.releaseConnection();
client.releaseConnection();
await nextTimer();
assert.equal(client.isConnected(), false);
const socketCountAfterRelease = sockets.length;
await nextTimer();
assert.equal(sockets.length, socketCountAfterRelease, 'manual disconnect must cancel reconnect timers');

console.log('WebSocket client lifecycle tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
