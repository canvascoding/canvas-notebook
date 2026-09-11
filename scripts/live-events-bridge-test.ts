import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server';
import type WebSocket from 'ws';
import { attachLiveEventConnection, type LiveEventHandlers } from '../server/live-events-connection';
import { createLiveEventParser } from '../app/lib/live-events/sse-parser';
import { isLiveEventSubscription } from '../app/lib/live-events/protocol';

async function compile<T>(file: string, mocks: Record<string, unknown>, intervals: Array<() => void> = []) {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const exports = {};
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', compiled)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
    (callback: () => void) => { intervals.push(callback); return 1; }, () => undefined,
  );
  return exports as T;
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Array<Record<string, unknown>> = [];
  code: number | null = null;
  send(text: string, callback?: (error?: Error) => void) { this.frames.push(JSON.parse(text)); callback?.(); }
  close(code = 1000) { this.code = code; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
function handshake(cookie = 'session-good'): IncomingMessage {
  return { headers: { cookie, origin: 'http://127.0.0.1:3100' }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
}
function subscription(id: string, channel = 'files', workspaceId = 'workspace') {
  return { type: 'subscribe', id, channel, ...(channel !== 'terminal' ? { workspaceId } : {}) };
}

async function actualRoutes() {
  const intervals: Array<() => void> = [];
  const controls = { allowed: true, subscriptions: 0, unsubscribed: 0, synced: 0, touches: 0, requests: [] as NextRequest[] };
  let sendFile: ((value: unknown) => void) | null = null;
  let sendTerminal: ((value: unknown) => void) | null = null;
  const workspace = { workspaceId: 'workspace', rootPath: '/fixture' };
  const requestWorkspace = async (request: NextRequest) => {
    controls.requests.push(request);
    const status = request.headers.get('cookie') !== 'session-good' ? 401
      : !controls.allowed || request.nextUrl.searchParams.get('workspaceId') !== 'workspace' ? 403 : 0;
    return status ? { response: NextResponse.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status }) }
      : { response: null, workspace, session: { user: { id: 'user' } } };
  };
  const watcher = {
    subscribe(input: { send: (value: unknown) => void }) { controls.subscriptions++; sendFile = input.send; return () => controls.unsubscribed++; },
    touchClient() { controls.touches++; },
    async syncDirs() { controls.synced++; }, getSubscribedDirs() { return ['.']; },
  };
  const mocks = {
    '@/app/lib/workspaces/request': { requireRequestWorkspace: requestWorkspace },
    '@/app/lib/filesystem/file-watcher': { getFileWatcher: () => watcher },
    '@/app/lib/collaboration/presence': { getWorkspacePresenceSnapshot: () => ({ workspaceId: 'workspace', entries: [] }),
      subscribeWorkspacePresence: () => { let active = true; return () => { if (active) { active = false; controls.unsubscribed++; } }; } },
    '@/app/lib/auth': { auth: { api: { getSession: async ({ headers }: { headers: Headers }) =>
      controls.allowed && headers.get('cookie') === 'session-good' ? { user: { id: 'user' } } : null } } },
    '@/app/lib/terminal-policy': { readTerminalAvailability: () => ({ terminalEnabled: true, terminalUpdatedAt: null }),
      subscribeTerminalAvailability: (listener: (value: unknown) => void) => { sendTerminal = listener; return () => controls.unsubscribed++; } },
  };
  const watch = await compile<{ GET: LiveEventHandlers['files']; POST: (request: NextRequest) => Promise<Response> }>('app/api/files/watch/route.ts', mocks, intervals);
  const watchOtherBundle = await compile<typeof watch>('app/api/files/watch/route.ts', mocks, intervals);
  const presence = await compile<{ GET: LiveEventHandlers['presence'] }>('app/api/files/presence/route.ts', mocks, intervals);
  const terminal = await compile<{ GET: LiveEventHandlers['terminal'] }>('app/api/terminal/availability/route.ts', mocks, intervals);
  return { handlers: { files: watch.GET, presence: presence.GET, terminal: terminal.GET }, controls, intervals, watchOtherBundle,
    emitFile(value: unknown) { sendFile?.(value); }, emitTerminal(value: unknown) { sendTerminal?.(value); } };
}

test('SSE parser preserves split UTF-8, CRLF, multiline and empty data, event/id/retry; rejects unbounded input', () => {
  const frames: unknown[] = [];
  const parser = createLiveEventParser(frame => frames.push(frame));
  const bytes = new TextEncoder().encode('\uFEFF: comment\r\nevent: filechange\r\nid: token\r\nretry: 2500\r\ndata: Grüße\r\ndata: second\r\n\r\ndata:\n\nid: reset\nretry: 3000\n\n');
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  assert.deepEqual(frames, [{ event: 'filechange', id: 'token', retry: 2500, data: 'Grüße\nsecond' }, { data: '' }, { id: 'reset', retry: 3000 }]);
  assert.throws(() => createLiveEventParser(() => {}, 20).push(new TextEncoder().encode('data: '.repeat(10))), /limit/);
});

test('only bounded exact subscriptions are accepted; payload headers, routes and identity are rejected', () => {
  assert.equal(isLiveEventSubscription(subscription('a')), true);
  assert.equal(isLiveEventSubscription({ type: 'subscribe', id: 'default', channel: 'files' }), true, 'watch retains the existing authorized default workspace resolution');
  for (const value of [null, [], { ...subscription('a'), url: 'https://evil.invalid' }, { ...subscription('a'), headers: { cookie: 'forged' } },
    { ...subscription('a'), workspaceId: '../private' }, { ...subscription('a'), id: 'x'.repeat(65) },
    { ...subscription('a'), lastEventId: 'header\r\ninjection' }, { ...subscription('a'), channel: '__proto__' }]) {
    assert.equal(isLiveEventSubscription(value), false);
  }
});

test('actual watch/presence/terminal GET handlers retain scope; cross-bundle HTTP syncDirs and cancel work', async () => {
  const fixture = await actualRoutes();
  const socket = new Socket();
  const close = attachLiveEventConnection(socket as unknown as WebSocket, handshake(), fixture.handlers);
  try {
    socket.message(subscription('watch')); socket.message(subscription('presence', 'presence')); socket.message(subscription('terminal', 'terminal'));
    await flush();
    assert.equal(socket.frames.filter(frame => frame.type === 'open').length, 3);
    fixture.emitFile({ type: 'rename', workspaceId: 'workspace', relativePath: 'old', newRelativePath: 'new' });
    fixture.emitTerminal({ terminalEnabled: false, terminalUpdatedAt: 'now' }); await flush();
    const watchEvent = socket.frames.find(frame => frame.type === 'event' && frame.id === 'watch' && (frame.event as { event?: string }).event === 'connected');
    const connected = JSON.parse((watchEvent!.event as { data: string }).data);
    const post = await fixture.watchOtherBundle.POST(new NextRequest('http://localhost/api/files/watch?workspaceId=workspace', {
      method: 'POST', headers: { cookie: 'session-good', 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: connected.clientId, dirs: ['.'] }),
    }));
    assert.equal(post.status, 200, 'a separately compiled Next POST sees ownership created in the WS GET module');
    assert.equal(fixture.controls.synced, 1);
    const denied = await fixture.watchOtherBundle.POST(new NextRequest('http://localhost/api/files/watch?workspaceId=other', {
      method: 'POST', headers: { cookie: 'session-good', 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: connected.clientId, dirs: ['.'] }),
    }));
    assert.equal(denied.status, 403); assert.equal(fixture.controls.synced, 1);
    assert.ok(socket.frames.some(frame => frame.type === 'event' && JSON.stringify(frame).includes('newRelativePath')));
    socket.message({ type: 'unsubscribe', id: 'watch' }); await flush();
    assert.equal(fixture.controls.unsubscribed, 1);
    const afterClose = socket.frames.length;
    fixture.emitFile({ type: 'change', relativePath: 'late' }); await flush();
    assert.equal(socket.frames.length, afterClose, 'late watch callbacks cannot reach a canceled subscription');
  } finally { close(); }
  assert.equal(fixture.controls.unsubscribed, 3);
});

test('actual handler auth failure is structured without raw errors; revoked presence closes and rechecks', async () => {
  const fixture = await actualRoutes();
  const unauthorized = new Socket();
  const cleanup = attachLiveEventConnection(unauthorized as unknown as WebSocket, handshake('bad-cookie'), fixture.handlers);
  unauthorized.message(subscription('a')); await flush();
  assert.deepEqual(unauthorized.frames, [{ type: 'error', id: 'a', status: 401 }]); cleanup();
  assert.equal(JSON.stringify(unauthorized.frames).includes('PRIVATE_AUTH_DETAIL'), false);
  const foreign = new Socket();
  const cleanupForeign = attachLiveEventConnection(foreign as unknown as WebSocket, handshake(), fixture.handlers);
  foreign.message(subscription('a', 'files', 'other')); await flush();
  assert.deepEqual(foreign.frames, [{ type: 'error', id: 'a', status: 403 }]); cleanupForeign();
  const socket = new Socket();
  const close = attachLiveEventConnection(socket as unknown as WebSocket, handshake(), fixture.handlers);
  socket.message(subscription('a', 'presence')); await flush();
  fixture.controls.allowed = false;
  for (const interval of fixture.intervals) interval(); await flush();
  assert.ok(socket.frames.some(frame => frame.type === 'end' && frame.id === 'a'));
  socket.message(subscription('a', 'presence')); await flush();
  assert.deepEqual(socket.frames.at(-1), { type: 'error', id: 'a', status: 403 }); close();
});

test('socket close aborts a pending real handler result, then cancels its late body without sending', async () => {
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  let canceled = 0;
  const handler = (request: NextRequest) => { signal = request.signal; return new Promise<Response>(resolve => { finish = resolve; }); };
  const socket = new Socket();
  attachLiveEventConnection(socket as unknown as WebSocket, handshake(), { files: handler, presence: handler, terminal: handler });
  socket.message(subscription('a')); await flush(); socket.close();
  assert.equal(signal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { canceled++; } }), { headers: { 'content-type': 'text/event-stream' } }));
  await flush(); assert.equal(canceled, 1); assert.deepEqual(socket.frames, []);
});

test('slow consumers and malformed messages are bounded and close their readers', async () => {
  const fixture = await actualRoutes();
  const socket = new Socket();
  attachLiveEventConnection(socket as unknown as WebSocket, handshake(), fixture.handlers);
  socket.message(subscription('a')); await flush();
  socket.bufferedAmount = 3 * 1024 * 1024;
  fixture.emitFile({ type: 'change', relativePath: 'a' }); await flush();
  assert.equal(socket.code, 1013); assert.equal(fixture.controls.unsubscribed, 1);
  const invalid = new Socket();
  attachLiveEventConnection(invalid as unknown as WebSocket, handshake(), fixture.handlers);
  invalid.message({ ...subscription('b'), headers: { cookie: 'forged' } }); await flush();
  assert.equal(invalid.code, 1008);
});

test('every subscription retains the authenticated proxy address with fresh isolated request identity', async () => {
  const { deriveProxyIdentityToken } = await import('../app/lib/security/proxy-identity');
  const { getRequestRateLimitIdentity, rememberVerifiedRateLimitUser } = await import('../app/lib/security/request-identity');
  const originalKey = process.env.CANVAS_INTERNAL_API_KEY;
  process.env.CANVAS_INTERNAL_API_KEY = 'live-events-test-only-proxy-secret-'.repeat(2);
  const incoming = handshake();
  incoming.headers['x-canvas-proxy-token'] = deriveProxyIdentityToken(process.env.CANVAS_INTERNAL_API_KEY)!;
  incoming.headers['x-canvas-proxy-client-ip'] = '198.51.100.17';
  const originalHeaders = { ...incoming.headers };
  const identities: unknown[] = [];
  const handler = async (request: NextRequest) => {
    await Promise.resolve();
    identities.push({ identity: { ...getRequestRateLimitIdentity() }, address: request.headers.get('x-forwarded-for'),
      attestation: request.headers.get('x-canvas-proxy-token') });
    rememberVerifiedRateLimitUser(request.nextUrl.pathname);
    return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  };
  const socket = new Socket();
  const close = attachLiveEventConnection(socket as unknown as WebSocket, incoming, { files: handler, presence: handler, terminal: handler });
  try {
    socket.message(subscription('a')); socket.message(subscription('b', 'presence')); socket.message(subscription('c', 'terminal'));
    await flush();
    assert.equal(identities.length, 3);
    assert.deepEqual(identities, Array.from({ length: 3 }, () => ({ identity: { clientAddress: '198.51.100.17', verifiedUserId: null },
      address: '198.51.100.17', attestation: null })));
    assert.deepEqual(incoming.headers, originalHeaders, 'the shared handshake is immutable across channels');
    assert.equal(getRequestRateLimitIdentity(), undefined);
  } finally { close(); if (originalKey === undefined) delete process.env.CANVAS_INTERNAL_API_KEY; else process.env.CANVAS_INTERNAL_API_KEY = originalKey; }
});

test('upgrade accepts only the dedicated route, configured origin and versioned protocol, and unregisters on shutdown', async () => {
  const { createServer } = await import('node:http');
  const { LIVE_EVENTS_PROTOCOL } = await import('../app/lib/live-events/protocol');
  const originalOrigin = process.env.BETTER_AUTH_BASE_URL;
  process.env.BETTER_AUTH_BASE_URL = 'http://127.0.0.1:3100';
  let attached = 0;
  let upgrades = 0;
  class ServerSocket extends Socket { ping() {} }
  class Wss {
    clients = new Set<ServerSocket>();
    handleUpgrade(_request: unknown, _socket: unknown, _head: unknown, callback: (socket: ServerSocket) => void) {
      upgrades++; const socket = new ServerSocket(); this.clients.add(socket); callback(socket);
    }
    close(callback: () => void) { callback(); }
  }
  const bridgeModule = await compile<typeof import('../server/live-events-server')>('server/live-events-server.ts', {
    ws: { __esModule: true, default: {}, WebSocketServer: Wss },
    '../app/api/files/watch/route': {}, '../app/api/files/presence/route': {}, '../app/api/terminal/availability/route': {},
    './live-events-connection': { attachLiveEventConnection() { attached++; } },
  });
  const server = createServer(); // No listening port or background application is started.
  const bridge = bridgeModule.createLiveEventsServer(server);
  const upgrade = (url: string, origin: string, protocol: string) => {
    let denied = false;
    server.emit('upgrade', { url, headers: { origin, 'sec-websocket-protocol': protocol } }, { end() { denied = true; } }, Buffer.alloc(0));
    return denied;
  };
  try {
    assert.equal(upgrade('/ws/live-events', 'https://untrusted.invalid', LIVE_EVENTS_PROTOCOL), true);
    assert.equal(upgrade('/ws/live-events', 'http://127.0.0.1:3100', 'unknown'), true);
    assert.equal(upgrade('/ws/live-events?url=/api/private', 'http://127.0.0.1:3100', LIVE_EVENTS_PROTOCOL), false);
    assert.equal(attached, 0);
    assert.equal(upgrade('/ws/live-events', 'http://127.0.0.1:3100', LIVE_EVENTS_PROTOCOL), false);
    assert.equal(upgrades, 1); assert.equal(attached, 1);
  } finally { await bridge.close(); if (originalOrigin === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = originalOrigin; }
  assert.equal(server.listenerCount('upgrade'), 0);
});

test('separately compiled file mutations and rename wrappers target the shared global watcher', async () => {
  type WatcherModule = typeof import('../app/lib/filesystem/file-watcher');
  const runtime = globalThis as typeof globalThis & { __canvasFileWatcherService?: unknown };
  const original = runtime.__canvasFileWatcherService;
  const events: unknown[] = []; const renames: unknown[] = [];
  const shared = {
    publishMutation: (value: unknown) => events.push(value),
    withRename: async (workspace: unknown, mutation: unknown, run: () => Promise<unknown>) => {
      renames.push({ workspace, mutation }); return run();
    },
  };
  runtime.__canvasFileWatcherService = shared;
  const mocks = {
    '@/app/lib/collaboration/presence': {},
    '@/app/lib/utils/file-tree-cache': { clearSubtreeCache() { throw new Error('The shared watcher should receive the mutation.'); } },
    '@/app/lib/filesystem/file-reference-cache': {},
    '@/app/lib/filesystem/workspace-files': {},
  };
  try {
    const moduleA = await compile<WatcherModule>('app/lib/filesystem/file-watcher.ts', mocks);
    const moduleB = await compile<WatcherModule>('app/lib/filesystem/file-watcher.ts', mocks);
    assert.equal(moduleA.getFileWatcher(), shared); assert.equal(moduleB.getFileWatcher(), shared);
    const workspace = { workspaceId: 'workspace' } as Parameters<WatcherModule['publishWorkspaceFileMutation']>[0]['workspace'];
    moduleB.publishWorkspaceFileMutation({ workspace, type: 'change', relativePath: './folder/document.md' });
    assert.deepEqual(events, [{ workspace, type: 'change', relativePath: 'folder/document.md' }]);
    const mutation = { oldPath: 'folder', newPath: 'renamed' } as Parameters<WatcherModule['withWorkspacePathRenameEvent']>[1];
    assert.equal(await moduleA.withWorkspacePathRenameEvent(workspace, mutation, async () => 'renamed'), 'renamed');
    assert.deepEqual(renames, [{ workspace, mutation }]);
  } finally { if (original === undefined) delete runtime.__canvasFileWatcherService; else runtime.__canvasFileWatcherService = original; }
});
