import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { installOwnedCollaborationOutage } from '../tests/helpers/owned-collaboration-outage';

type BrowserSocket = { socket: globalThis.WebSocket; opened: boolean; closed: boolean; code: number | null;
  messages: Array<string | number[]>; errors: number };
type BrowserFixture = { [key: string]: BrowserSocket };

async function bounded<T>(operation: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned outage test timed out: ${label}.`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function openSocket(page: Page, url: string, name: string): Promise<'open' | 'closed'> {
  return bounded(page.evaluate(({ url, name }) => new Promise<'open' | 'closed'>(resolve => {
    const scope = window as unknown as { ownedOutageFixture?: BrowserFixture };
    const fixture = scope.ownedOutageFixture ??= {};
    if (fixture[name]) throw new Error('Duplicate owned socket.');
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const record: BrowserSocket = { socket, opened: false, closed: false, code: null, messages: [], errors: 0 };
    fixture[name] = record;
    socket.onopen = () => { record.opened = true; resolve('open'); };
    socket.onclose = event => { record.closed = true; record.code = event.code; resolve('closed'); };
    socket.onerror = () => { record.errors += 1; };
    socket.onmessage = event => {
      if (record.messages.length >= 8) throw new Error('Owned echo fixture exceeded its message bound.');
      record.messages.push(typeof event.data === 'string' ? event.data : Array.from(new Uint8Array(event.data)));
    };
  }), { url, name }), `open ${name}`);
}

async function echo(page: Page, name: string, message: string | number[]) {
  await page.evaluate(({ name, message }) => {
    const scope = window as unknown as { ownedOutageFixture: BrowserFixture };
    scope.ownedOutageFixture[name].socket.send(typeof message === 'string' ? message : Uint8Array.from(message));
  }, { name, message });
  await page.waitForFunction(({ name, message }) => {
    const scope = window as unknown as { ownedOutageFixture: BrowserFixture };
    return scope.ownedOutageFixture[name].messages.some(value => JSON.stringify(value) === JSON.stringify(message));
  }, { name, message }, { timeout: 5000 });
}

async function main() {
  const clients = new Set<ServerSocket>();
  const received: Array<{ binary: boolean; bytes: number }> = [];
  let accepted = 0, closed = 0, serverFailure: Error | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><body>Owned WebSocket outage fixture</body></html>');
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('error', error => { serverFailure ??= error; });
  sockets.on('error', error => { serverFailure ??= error; });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws/collaboration') { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  });
  sockets.on('connection', socket => {
    accepted += 1;
    clients.add(socket);
    socket.on('error', error => { serverFailure ??= error; });
    socket.on('close', () => { closed += 1; clients.delete(socket); });
    socket.on('message', (data, binary) => {
      if (received.length >= 8) { serverFailure ??= new Error('Owned server message bound exceeded.'); socket.terminate(); return; }
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      received.push({ binary, bytes: bytes.length });
      socket.send(bytes, { binary });
    });
  });

  let browser: Browser | undefined, context: BrowserContext | undefined;
  let outage: Awaited<ReturnType<typeof installOwnedCollaborationOutage>> | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await bounded(new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)), 'loopback listen');
    const address = server.address();
    assert(address && typeof address !== 'string' && address.address === '127.0.0.1' && address.port > 0);
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `ws://127.0.0.1:${address.port}/ws/collaboration`;
    browser = await bounded(chromium.launch({ headless: true, timeout: 10000 }), 'owned Chromium launch', 12000);
    context = await browser.newContext();
    outage = await installOwnedCollaborationOutage(context);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.name); });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });

    assert.equal(await openSocket(page, url, 'initial'), 'open');
    await echo(page, 'initial', 'initial passthrough');
    assert.equal(accepted, 1);
    assert.equal(clients.size, 1);
    assert.deepEqual(received, [{ binary: false, bytes: Buffer.byteLength('initial passthrough') }]);

    const initialUpstreamClosed = Promise.all([...clients].map(socket =>
      new Promise<void>(resolve => { socket.once('close', () => resolve()); })));
    await outage.block();
    await page.waitForFunction(() => (window as unknown as { ownedOutageFixture: BrowserFixture })
      .ownedOutageFixture.initial.closed, undefined, { timeout: 5000 });
    await bounded(initialUpstreamClosed, 'actual first upstream close');
    assert.equal(clients.size, 0);
    assert.equal(closed, 1);
    for (const name of ['blocked-one', 'blocked-two', 'blocked-three']) {
      assert.equal(await openSocket(page, url, name), 'closed');
    }
    assert.equal(accepted, 1, 'Denied reconnects must not create a real server connection.');
    assert.equal(clients.size, 0);
    assert.equal(received.length, 1, 'The outage must not forward or replay a client message.');

    outage.restore();
    assert.equal(await openSocket(page, url, 'restored'), 'open');
    await echo(page, 'restored', 'fresh connection');
    await echo(page, 'restored', [0, 1, 2, 255]);
    assert.equal(accepted, 2);
    assert.equal(clients.size, 1);
    assert.equal(received.length, 3);
    assert.deepEqual(received[2], { binary: true, bytes: 4 });

    const restoredUpstreamClosed = Promise.all([...clients].map(socket =>
      new Promise<void>(resolve => { socket.once('close', () => resolve()); })));
    await outage.dispose();
    await bounded(restoredUpstreamClosed, 'actual restored upstream close');
    await outage.dispose();
    await page.waitForFunction(() => (window as unknown as { ownedOutageFixture: BrowserFixture })
      .ownedOutageFixture.restored.closed, undefined, { timeout: 5000 });
    assert.equal(await openSocket(page, url, 'after-dispose'), 'closed');
    assert.equal(accepted, 2, 'Disposed routes remain blocked until the owning context closes.');
    assert.equal(clients.size, 0);
    assert.equal(closed, 2);
    assert.throws(() => outage!.restore(), /OWNED_COLLABORATION_OUTAGE_NOT_RESTORABLE/u);
    assert.deepEqual(pageErrors, []);
    if (serverFailure) throw serverFailure;
  } catch (error) { primaryFailure = error; }
  finally {
    // Close the helper while the page is alive so both real close receipts can
    // still arrive. Every remaining resource belongs to this one loopback run.
    try { await bounded(outage?.dispose() ?? Promise.resolve(), 'outage cleanup'); }
    catch (error) { cleanupFailures.push(error); }
    try { await bounded(context?.close() ?? Promise.resolve(), 'owned context cleanup'); }
    catch (error) { cleanupFailures.push(error); }
    try { await bounded(browser?.close() ?? Promise.resolve(), 'owned browser cleanup', 10000); }
    catch (error) { cleanupFailures.push(error); }
    for (const socket of clients) socket.terminate();
    const closedSockets = new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    const closedServer = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const results = await Promise.allSettled([bounded(closedSockets, 'owned WebSocket server cleanup'),
      bounded(closedServer, 'owned HTTP server cleanup')]);
    for (const result of results) if (result.status === 'rejected') cleanupFailures.push(result.reason);
    if (clients.size !== 0) cleanupFailures.push(new Error('Owned WebSocket clients remain.'));
    if (serverFailure && primaryFailure === undefined) cleanupFailures.push(serverFailure);
  }
  if (primaryFailure !== undefined || cleanupFailures.length) {
    throw new AggregateError(primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      'Owned collaboration outage regression failed.');
  }
  console.info('Owned outage: real Chromium loopback text/binary echo, both closes, three denied reconnects, genuine new connection and idempotent disposal passed; owned resources closed.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
