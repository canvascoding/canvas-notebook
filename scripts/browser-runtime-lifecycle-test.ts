import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { BrowserViewTicketClaims } from '../app/lib/pi/browser/view-ticket';
import type { BrowserViewResourceBudget } from '../app/lib/pi/browser/types';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let launchGate = Promise.resolve();
let pageGate = Promise.resolve();
let transferGate = Promise.resolve();
let auditGate = Promise.resolve();
let launches = 0;
let newPages = 0;
const browsers: FakeBrowser[] = [];
const clients: Client[] = [];
class Client extends EventEmitter {
  detached = false;
  constructor() { super(); clients.push(this); }
  async send(method: string) {
    if (method === 'Browser.setDownloadBehavior') await transferGate;
    return { frameTree: { frame: { id: 'frame' } }, currentIndex: 0, entries: [], targetInfo: { title: 'Test' } };
  }
  async detach() { this.detached = true; }
}
class FakePage extends EventEmitter {
  closed = false;
  pressedButtons = new Set<string>();
  mouse = {
    move: async () => {},
    down: async ({ button }: { button: string }) => { this.pressedButtons.add(button); },
    up: async ({ button }: { button: string }) => { this.pressedButtons.delete(button); },
  };
  constructor(private owner: FakeBrowser) { super(); }
  browser() { return this.owner; }
  target() { return this; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; this.emit('close'); }
  async setRequestInterception() {}
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  viewport() { return { width: 1280, height: 800 }; }
  async setViewport() {}
  async title() { return 'Test'; }
  url() { return 'about:blank'; }
  async evaluate() { return false; }
  waitForFileChooser() { return new Promise(() => {}); }
  async createCDPSession() { return new Client(); }
  async screenshot() { return Buffer.from('frame'); }
}
class FakeBrowser extends EventEmitter {
  connected = true;
  pages: FakePage[] = [];
  target() { return { createCDPSession: async () => new Client() }; }
  async newPage() { newPages++; const page = new FakePage(this); this.pages.push(page); await pageGate; return page; }
  async close() { this.connected = false; for (const page of this.pages) await page.close(); this.emit('disconnected'); }
}
const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
const original = internals._load;
let directory = '';
internals._load = (name, parent, main) => {
  if (name === 'server-only') return {};
  if (name === 'puppeteer-core') return { launch: async () => { launches++; await launchGate; const browser = new FakeBrowser(); browsers.push(browser); return browser; } };
  if (name === './chromium' && parent?.filename.endsWith('/browser/runtime.ts')) return {
    resolveBrowserUserDataDir: () => directory,
    buildBrowserLaunchSpec: ({ userDataDir }: { userDataDir: string }) => ({ userDataDir, executablePath: '/test/chrome', args: [], headless: true, pipe: true }),
  };
  if (name.endsWith('audit/audit-service')) return { recordAuditEvent: async () => { await auditGate; } };
  if (name.endsWith('pi/runtime-service')) return { getStatus: async () => ({}), control: async () => ({}) };
  if (name === './view-transfers') return { prepareBrowserDownloadStagingDirectory: async () => directory };
  return original(name, parent, main);
};

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), 'test checkpoint was not reached');
}
async function main() {
  directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-browser-lifecycle-'));
  const runtime = await import('../app/lib/pi/browser/runtime');
  const { BrowserViewService } = await import('../app/lib/pi/browser/view-service');
  const snapshots = await import('../app/lib/pi/browser/session-state');
  internals._load = original;
  const context = { userId: 'test', agentId: 'agent', sessionId: 'one', workspaceId: 'workspace', workspaceType: 'personal', organizationId: null };
  const other = { ...context, sessionId: 'two' };
  const budget = { allowed: true, fps: 4, jpegQuality: 60, viewport: { width: 1280, height: 800 } } as BrowserViewResourceBudget;
  const makeView = (viewId: string, messages: unknown[], onClosed = () => {}) => new BrowserViewService({
    ...context, schemaVersion: 1, issuedAt: Date.now(), expiresAt: Date.now() + 60000, agentSessionId: context.sessionId, authSessionId: 'auth', viewId,
    workspaceId: 'workspace', workspaceType: 'personal', organizationId: null,
  } as BrowserViewTicketClaims, budget, (message) => { messages.push(message); return true; }, onClosed);
  try {
    const launch = deferred(); launchGate = launch.promise;
    const first = runtime.ensurePage(context); const second = runtime.ensurePage(other);
    await until(() => launches > 0);
    assert.equal(launches, 1, 'shared profile preparation must reserve a single launch');
    launch.resolve(); await Promise.all([first, second]);
    assert.equal(launches, 1);
    await runtime.closeBrowserRuntime(other, 'test');

    const blocker = deferred();
    const held = runtime.withBrowserRuntimeLock(context, () => blocker.promise);
    await tick();
    let executed = false;
    const queued = runtime.withBrowserRuntimeLock(context, async () => { executed = true; await runtime.ensurePage(context); });
    const rejected = assert.rejects(queued, /Browser runtime closed/);
    await runtime.closeBrowserRuntime(context, 'explicit stop'); blocker.resolve();
    await Promise.all([held, rejected]);
    assert.equal(executed, false, 'old lock queues must not execute after an explicit stop');

    const lateLaunch = deferred(); launchGate = lateLaunch.promise;
    const pendingLaunch = runtime.ensurePage(context);
    const launchRejected = assert.rejects(pendingLaunch, /Browser runtime closed/);
    await until(() => launches === 2);
    const stoppingLaunch = runtime.closeBrowserRuntime(context, 'stop during launch');
    lateLaunch.resolve(); await Promise.all([launchRejected, stoppingLaunch]);
    assert.equal(browsers.at(-1)?.connected, false, 'late Chromium launches must be closed');
    launchGate = Promise.resolve();

    const latePage = deferred(); pageGate = latePage.promise;
    const previousPages = newPages;
    const pendingPage = runtime.ensurePage(context);
    const pageRejected = assert.rejects(pendingPage, /Browser runtime closed/);
    await until(() => newPages > previousPages);
    await runtime.closeBrowserRuntime(context, 'stop during newPage');
    latePage.resolve(); await pageRejected;
    assert.ok(browsers.at(-1)?.pages.every((page) => page.closed));
    pageGate = Promise.resolve();

    const transfer = deferred(); transferGate = transfer.promise;
    const abandonedMessages: unknown[] = [];
    const abandoned = makeView('abandoned', abandonedMessages);
    const oldClientCount = clients.length;
    const pendingStart = abandoned.start();
    const startRejected = assert.rejects(pendingStart, /Browser view closed/);
    await until(() => clients.length > oldClientCount);
    abandoned.close(); transfer.resolve(); await startRejected; await tick();
    assert.deepEqual(abandonedMessages, [], 'start completing after close must not send ready or frames');
    assert.ok(clients.every((client) => client.detached), 'late transfer clients must detach');
    transferGate = Promise.resolve();

    const messages: Array<unknown> = [];
    let closed = 0;
    const viewer = makeView('first', messages, () => { closed++; });
    const spectator = makeView('second', messages, () => { closed++; });
    await viewer.start(); await spectator.start();
    assert.equal(closed, 0);
    await viewer.requestControl('user');
    const heldDialog = deferred();
    const dialogAction = runtime.withBrowserRuntimeLock(context, () => heldDialog.promise);
    await tick();
    let answer = '';
    const activePage = browsers.at(-1)!.pages.at(-1)!;
    activePage.emit('dialog', {
      type: () => 'prompt', message: () => 'Test prompt', defaultValue: () => 'initial',
      accept: async (text: string) => { answer = text; heldDialog.resolve(); },
    });
    assert.ok(messages.some((message) => {
      const value = message as { type: string; state?: { pendingDialog?: { message?: string } } };
      return value.type === 'state' && value.state?.pendingDialog?.message === 'Test prompt';
    }), 'dialogs must be published even while their triggering action holds the lock');
    const arrivingMessages: unknown[] = [];
    const arrivingViewer = makeView('arriving', arrivingMessages);
    let arrivalDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([arrivingViewer.start(), new Promise((_, reject) => {
        arrivalDeadline = setTimeout(() => reject(new Error('Viewer arrival deadlocked behind an agent dialog')), 1000);
      })]);
      assert.ok(arrivingMessages.some((message) => (message as { type: string }).type === 'ready'));
      assert.ok(arrivingMessages.some((message) => (message as { state?: { pendingDialog?: unknown } }).state?.pendingDialog));
      viewer.close();
      await arrivingViewer.requestControl('user');
      await viewer.requestControl('user').then(() => assert.fail('closed viewer regained control'), () => undefined);
    } finally { clearTimeout(arrivalDeadline); }
    const resolveDialog = arrivingViewer.resolveDialog(true, 'user input');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([resolveDialog, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Dialog resolution deadlocked')), 1000); })]);
    } finally { clearTimeout(deadline); heldDialog.resolve(); }
    await dialogAction;
    assert.equal(answer, 'user input');
    await arrivingViewer.mouse({ action: 'down', x: 10, y: 10 });
    assert.equal(activePage.pressedButtons.size, 1);
    const pagesBeforeStop = newPages;
    await runtime.closeBrowserRuntime(context, 'agent close');
    assert.equal(activePage.pressedButtons.size, 0, 'closing a view must release held mouse buttons');
    assert.equal(closed, 2, 'a runtime stop must close every attached viewer');
    await viewer.publishState(true); viewer.heartbeat();
    await spectator.publishState(true); spectator.heartbeat();
    await assert.rejects(viewer.getState(), /Browser view closed/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(newPages, pagesBeforeStop, 'closed viewers must not recreate the browser');
    assert.equal((await runtime.getStatusDetails(context)).running, false);
    assert.equal(snapshots.getBrowserSessionSnapshot(runtime.getBrowserRuntimeContextKey(context))?.running, false);
    assert.ok(clients.every((client) => client.detached));

    const audit = deferred(); auditGate = audit.promise;
    const duringAudit = makeView('audit', []);
    const auditStart = duringAudit.start();
    const auditRejected = assert.rejects(auditStart, /Browser view closed/);
    await until(() => newPages > pagesBeforeStop);
    await tick(); duringAudit.close(); audit.resolve(); await auditRejected;
    auditGate = Promise.resolve();
    await runtime.closeBrowserRuntime(context, 'cleanup');
    console.log('browser-runtime-lifecycle-test: ok');
  } finally {
    internals._load = original;
    await runtime.closeBrowserRuntime(context, 'cleanup');
    await runtime.closeBrowserRuntime(other, 'cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
