import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import Module from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages: Array<{ type: string; code?: string }> = [];
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() {}
  subscribe(ticket: string) { this.emit('message', Buffer.from(JSON.stringify({ type: 'view_subscribe', ticket }))); }
}
let authGate = Promise.resolve();
let scopeGate = Promise.resolve();
let startGate = Promise.resolve();
let created = 0;
let live = 0;
let releaseDialogAction = () => {};
let dialogResolved = false;
const stopListeners = new Set<() => void>();
class Service {
  closed = false;
  constructor(readonly claims: { viewId: string }, _budget: unknown, private send: (value: unknown) => void, private onClosed: () => void) { created++; live++; }
  async start() { await startGate; if (!this.closed) this.send({ type: 'ready' }); }
  async navigate() { await new Promise<void>((resolve) => { releaseDialogAction = resolve; }); }
  async resolveDialog() { dialogResolved = true; releaseDialogAction(); }
  close() { if (this.closed) return; this.closed = true; live--; this.onClosed(); }
}
const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const original = internals._load;
internals._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  if (name.endsWith('websocket-auth')) return { authenticateWebSocketConnection: async () => { await authGate; return { userId: 'user', sessionId: 'auth', isAuthenticated: true }; } };
  if (name.endsWith('mobile/browser-view-ticket')) return { consumeMobileBrowserViewTicket: () => null, hasPendingMobileBrowserViewTicket: () => false };
  if (name.endsWith('session-runtime-access')) return { assertUnambiguousOwnedPiSessionForRuntime: async () => { await scopeGate; return { sessionId: 'session', agentId: 'agent' }; } };
  if (name.endsWith('session-workspace-context')) return { resolveAgentExecutionContextForSession: async () => ({ workspaceId: 'ws', workspaceType: 'personal', organizationId: null }) };
  if (name.endsWith('browser/settings-service')) return { assertBrowserRuntimeAvailable: async () => {} };
  if (name.endsWith('browser/view-resource-budget')) return { resolveBrowserViewResourceBudget: async () => ({ allowed: true, maxConcurrentViews: 1 }) };
  if (name.endsWith('browser/view-service')) return { BrowserViewService: Service };
  if (name.endsWith('browser/runtime')) return { subscribeBrowserRuntimeClosed: (_context: unknown, listener: () => void) => {
    stopListeners.add(listener);
    return () => stopListeners.delete(listener);
  } };
  if (name.endsWith('browser/view-ticket')) return { verifyBrowserViewTicket: (viewId: string) => ({ userId: 'user', authSessionId: 'auth', agentId: 'agent', agentSessionId: 'session', workspaceId: 'ws', workspaceType: 'personal', organizationId: null, viewId }) };
  if (name.endsWith('security/trusted-origins')) return { isConfiguredTrustedOrigin: () => true };
  return original(name, parent, main);
};

async function main() {
  const { createBrowserViewServer } = await import('../server/browser-view-server');
  internals._load = original;
  const wss = createBrowserViewServer(http.createServer());
  const connect = async () => {
    const socket = new Socket();
    wss.emit('connection', socket, { headers: {} });
    await tick();
    return socket;
  };
  try {
    const auth = deferred(); authGate = auth.promise;
    const abandoned = await connect(); abandoned.close(); auth.resolve(); await tick();
    assert.deepEqual(abandoned.messages, [], 'closed sockets must not be registered after authentication');
    authGate = Promise.resolve();

    const scope = deferred(); scopeGate = scope.promise;
    const first = await connect(); first.subscribe('same'); await tick();
    const duplicate = await connect(); duplicate.subscribe('same'); await tick();
    assert.equal(duplicate.messages.some((m) => m.code === 'VIEW_CONFLICT'), true, 'ticket reservation must precede async authorization');
    first.close(); scope.resolve(); await tick(); await tick();
    assert.equal(created, 0, 'closing during authorization must not create a service');
    const stoppedScope = deferred(); scopeGate = stoppedScope.promise;
    const stopped = await connect(); stopped.subscribe('stopped'); await tick();
    for (const listener of [...stopListeners]) listener();
    stoppedScope.resolve(); await tick(); await tick();
    assert.equal(created, 0, 'a runtime stop during authorization must cancel the pending subscription');
    assert.equal(stopped.messages.some((m) => m.code === 'SESSION_CLOSED'), true);
    assert.equal(stopListeners.size, 0);
    scopeGate = Promise.resolve();

    const start = deferred(); startGate = start.promise;
    const pending = await connect(); pending.subscribe('pending'); await tick();
    assert.equal(live, 1);
    pending.subscribe('queued'); pending.close();
    assert.equal(live, 0);
    start.resolve(); await tick(); await tick();
    assert.equal(created, 1, 'queued subscriptions must not resurrect a closed connection');
    assert.equal(pending.messages.some((m) => m.type === 'ready'), false);
    startGate = Promise.resolve();

    // A leaked reservation/service/connection would block this retry or exhaust capacity.
    const retry = await connect(); retry.subscribe('same'); await tick();
    assert.equal(retry.messages.some((m) => m.type === 'ready'), true);
    retry.emit('message', Buffer.from(JSON.stringify({ type: 'navigate', url: 'about:blank' })));
    await tick();
    retry.emit('message', Buffer.from(JSON.stringify({ type: 'dialog_resolve', accept: true })));
    await tick();
    assert.equal(dialogResolved, true, 'dialog answers must bypass the action waiting for that answer');
    assert.equal(live, 1); retry.close(); assert.equal(live, 0);

    const stalledStart = deferred(); startGate = stalledStart.promise;
    const stalled = await connect();
    const timedOut = new Promise<void>((resolve) => stalled.once('close', resolve));
    stalled.subscribe('stalled'); await tick();
    assert.equal(live, 1);
    await timedOut;
    assert.equal(stalled.messages.some((m) => m.code === 'TICKET_EXPIRED'), true, 'the subscription deadline must cover service startup');
    assert.equal(live, 0, 'a stalled startup must release its capacity slot');
    assert.equal(stopListeners.size, 0, 'a timed-out subscription must release its runtime listener');
    stalledStart.resolve(); await tick(); await tick();
    assert.equal(stalled.messages.some((m) => m.type === 'ready'), false);
    console.log('browser-server-lifecycle-test: ok');
  } finally { wss.close(); internals._load = original; }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
