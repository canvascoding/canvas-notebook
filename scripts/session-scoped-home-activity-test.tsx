import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';

import {
  observeOpenedDocumentAuth,
  openedDocumentAuthScope,
  type OpenedDocumentAuthScope,
} from '../app/lib/collaboration/opened-document-registry';
import type { NotificationSummary } from '../app/components/notifications/notification-summary';

// Real consumers, registry, expiry latch, and summary transport guards. Only
// authentication observations, HTTP, redirect delivery, and JSDOM's untrusted
// event boundary are controlled. No server/database/provider module is loaded.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent',
  'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originalGlobals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const redirects: string[] = [];
const location = { pathname: '/en/notebook', replace: (url: string) => { redirects.push(url); } };
const browserWindow = new Proxy(dom.window, {
  get(target, property) {
    if (property === 'location') return location;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
for (const key of globals) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true,
    value: key === 'window' ? browserWindow : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] });
}
Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

type Timer = { callback: () => void; delay: number };
const timeouts = new Map<number, Timer>();
const intervals = new Map<number, Timer>();
let nextTimerId = 0;
const originalTimers = { setTimeout: dom.window.setTimeout, clearTimeout: dom.window.clearTimeout,
  setInterval: dom.window.setInterval, clearInterval: dom.window.clearInterval };
const timer = (collection: Map<number, Timer>, handler: TimerHandler, delay = 0, args: unknown[]) => {
  assert.equal(typeof handler, 'function', 'The consumers schedule functions, never evaluated timer strings.');
  const id = ++nextTimerId;
  collection.set(id, { delay, callback: () => (handler as (...parameters: unknown[]) => void)(...args) });
  return id;
};
dom.window.setTimeout = (handler, delay, ...args) => timer(timeouts, handler, delay, args);
dom.window.clearTimeout = id => { if (id !== undefined) timeouts.delete(id); };
dom.window.setInterval = (handler, delay, ...args) => timer(intervals, handler, delay, args);
dom.window.clearInterval = id => { if (id !== undefined) intervals.delete(id); };

const homeEvents = ['session_updated', 'todo_updated', 'notification_summary_updated'];
const activityEvents = ['pointerdown', 'keydown', 'touchstart'];
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
const originalWindowAdd = dom.window.addEventListener.bind(dom.window);
const originalWindowRemove = dom.window.removeEventListener.bind(dom.window);
const originalDocumentAdd = dom.window.document.addEventListener.bind(dom.window.document);
const originalDocumentRemove = dom.window.document.removeEventListener.bind(dom.window.document);
function track(type: string, listener: EventListenerOrEventListenerObject | null, adding: boolean) {
  if (!listener || ![...homeEvents, ...activityEvents].includes(type)) return;
  const set = listeners.get(type) ?? new Set();
  if (adding) set.add(listener); else set.delete(listener);
  listeners.set(type, set);
}
dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) => {
  if (!listener) return;
  if (homeEvents.includes(type)) track(type, listener, true);
  originalWindowAdd(type, listener, options);
}) as typeof dom.window.addEventListener;
dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
  if (!listener) return;
  if (homeEvents.includes(type)) track(type, listener, false);
  originalWindowRemove(type, listener, options);
}) as typeof dom.window.removeEventListener;
dom.window.document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) => {
  if (!listener) return;
  if (activityEvents.includes(type) && typeof options === 'object' && options.passive) track(type, listener, true);
  originalDocumentAdd(type, listener, options);
}) as typeof dom.window.document.addEventListener;
dom.window.document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
  if (!listener) return;
  if (activityEvents.includes(type)) track(type, listener, false);
  originalDocumentRemove(type, listener, options);
}) as typeof dom.window.document.removeEventListener;

type AuthState = { scope: OpenedDocumentAuthScope | null; active: boolean; sessionExpired: boolean };
type AuthObservation = {
  isPending: boolean;
  data: { user: { id: string }; session: { id: string } } | null;
  error: { status: number } | null;
};
let authMode: 'authenticated' | 'pending' | 'anonymous' = 'anonymous';
let authObservation: AuthObservation = { isPending: true, data: null, error: null };
const authSessionListeners = new Set<(value: AuthObservation) => void>();
const authListeners = new Set<() => void>();
let authSnapshot: AuthState = { scope: null, active: false, sessionExpired: false };
let expiry: typeof import('../app/lib/auth/session-expiry');
function authSnapshotForConsumer(): AuthState {
  const state = expiry.getSessionExpirySnapshot();
  const active = authMode === 'authenticated' && state.scope !== null && !state.sessionExpired;
  if (authSnapshot.scope !== state.scope || authSnapshot.active !== active || authSnapshot.sessionExpired !== state.sessionExpired) {
    authSnapshot = { scope: state.scope, active, sessionExpired: state.sessionExpired };
  }
  return authSnapshot;
}
function subscribeAuth(listener: () => void) {
  authListeners.add(listener);
  const unsubscribeExpiry = expiry.subscribeSessionExpiry(listener);
  return () => { authListeners.delete(listener); unsubscribeExpiry(); };
}
const notifyCalls: string[] = [];
const trustedInputs: boolean[] = [];
const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === '@/app/components/auth/AuthenticatedSessionBoundary') {
    return { useAuthenticatedRequestScope: () => useSyncExternalStore(subscribeAuth, authSnapshotForConsumer, authSnapshotForConsumer) };
  }
  if (request === '@/app/lib/auth-client') {
    return { authClient: { $store: {
      atoms: { session: {
        get: () => authObservation,
        listen: (listener: (value: AuthObservation) => void) => {
          authSessionListeners.add(listener);
          return () => { authSessionListeners.delete(listener); };
        },
      } },
      notify: (signal: string) => { notifyCalls.push(signal); },
    } } };
  }
  if (request === '@/app/lib/instance/human-activity-policy') {
    const policy = originalLoad(request, parent, isMain) as typeof import('../app/lib/instance/human-activity-policy');
    return { ...policy, shouldReportHumanActivity: (input: Parameters<typeof policy.shouldReportHumanActivity>[0]) => {
      trustedInputs.push(input.trusted);
      // JSDOM cannot synthesize isTrusted. The separate human-activity-test and
      // browser acceptance prove the trusted-event policy; this tests transport.
      return policy.shouldReportHumanActivity({ ...input, trusted: true });
    } };
  }
  if (request === 'server-only' || request === '@/app/lib/auth' || /(?:^|\/)app\/lib\/db(?:\/|$)/u.test(request)) {
    throw new Error('A server/database module escaped the client-only fixture.');
  }
  return originalLoad(request, parent, isMain);
};

type FetchCall = { path: string; init?: RequestInit };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse('2030-01-01T00:00:00Z');
Date.now = () => now;
let calls: FetchCall[] = [];
let responseHandler: (call: FetchCall) => Promise<Response>;
let unexpectedHttpCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'https://canvas.test');
  if (url.origin !== 'https://canvas.test'
    || !['/api/notifications/summary', '/api/instance/human-activity'].includes(url.pathname)) {
    unexpectedHttpCalls += 1;
    throw new Error(`Unexpected transport path: ${url.pathname}`);
  }
  const call = { path: url.pathname, init };
  calls.push(call);
  return responseHandler(call);
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function summary(title: string): NotificationSummary {
  const item = { id: title, type: 'chat.response' as const, title, detail: null,
    occurredAt: '2030-01-01T00:00:00Z', unread: true, priority: 'normal' as const,
    workspaceId: 'personal-home-test', workspaceName: 'Home', target: { kind: 'chat' as const, sessionId: title } };
  return { unreadCount: 1, counts: { unread: 1, chat: 1, todos: 0, todoAttention: 0,
    emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 }, items: [item],
  sections: { notifications: [item], todos: [], todoAttention: [], emailAttention: [] } };
}
const summaryResponse = (title: string) => Response.json({ success: true, data: summary(title) });

async function flush() {
  await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
}
async function fireTimeouts(delay: number) {
  const due = [...timeouts].filter(([, value]) => value.delay === delay);
  await act(async () => {
    for (const [id, value] of due) { timeouts.delete(id); value.callback(); }
  });
  await flush();
}
async function fireIntervals() {
  await act(async () => { for (const value of [...intervals.values()]) value.callback(); });
  await flush();
}
async function dispatch(type: string) {
  await act(async () => {
    if (activityEvents.includes(type)) document.dispatchEvent(new Event(type));
    else window.dispatchEvent(new Event(type));
  });
  await flush();
}
async function resolve<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => { pending.resolve(value); });
  await flush();
}
async function setAuth(mode: typeof authMode, sessionId = 'home-session', userId = 'home-user') {
  await act(async () => {
    authMode = mode;
    authObservation = { isPending: mode === 'pending', error: null,
      data: mode === 'anonymous' ? null : { user: { id: userId }, session: { id: sessionId } } };
    // Match auth-client.ts: the registry observes the current atom first, then
    // expiry receives that exact stable value, not a recreated get() object.
    observeOpenedDocumentAuth(authObservation);
    for (const listener of authSessionListeners) listener(authObservation);
    for (const listener of authListeners) listener();
  });
  await flush();
}
function assertNoWork() {
  assert.equal(timeouts.size, 0, 'No initial/debounced timer survives inactivity or unmount.');
  assert.equal(intervals.size, 0, 'No polling interval survives inactivity or unmount.');
  for (const type of [...homeEvents, ...activityEvents]) {
    assert.equal(listeners.get(type)?.size ?? 0, 0, `No ${type} listener survives inactivity or unmount.`);
  }
}

async function main() {
  expiry = await import('../app/lib/auth/session-expiry');
  const { useHomeNotificationSummary } = await import('../app/components/home/useHomeNotificationSummary');
  const { HumanActivityRecorder } = await import('../app/components/HumanActivityRecorder');
  const { createRoot } = await import('react-dom/client');
  let root: ReturnType<typeof createRoot> | null = null;
  let fixture = 0;
  let cases = 0;
  let scenarioFailed = false;
  function HomeHarness() {
    const state = useHomeNotificationSummary();
    return <output data-home data-active={String(state.active)} data-loading={String(state.isLoadingSummary)}>
      {state.summary?.items.map(item => item.title).join(',') ?? ''}
    </output>;
  }
  async function mount(home = true, human = true) {
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(<>{home && <HomeHarness />}{human && <HumanActivityRecorder />}</>); });
    await flush();
  }
  async function unmount() {
    if (root) {
      const mounted = root; root = null;
      await act(async () => { mounted.unmount(); });
    }
    await flush();
  }
  const text = () => document.querySelector('[data-home]')?.textContent ?? '';
  const loading = () => document.querySelector('[data-home]')?.getAttribute('data-loading');
  async function reset(clearPreviousExpiry = true) {
    await unmount();
    assertNoWork();
    // Initial anonymous/pending fixtures must never have a previous valid login.
    // Later fixtures release an old latch through a genuinely new atom identity.
    if (clearPreviousExpiry) await setAuth('authenticated', `reset-${++fixture}`);
    await setAuth('anonymous');
    calls = []; redirects.length = 0; notifyCalls.length = 0; trustedInputs.length = 0;
    now += 120_000;
    responseHandler = async call => call.path === '/api/notifications/summary'
      ? summaryResponse('Current private notification') : Response.json({ success: true });
  }
  try {
    for (const mode of ['anonymous', 'pending'] as const) {
      await reset(false);
      if (mode === 'pending') await setAuth('pending', 'unresolved-session');
      await mount();
      assertNoWork();
      for (const event of [...homeEvents, ...activityEvents]) await dispatch(event);
      assert.equal(calls.length, 0, `${mode} authentication never polls or reports activity.`);
      assert.equal(redirects.length, 0);
      assert.equal(expiry.getSessionExpirySnapshot().sessionExpired, false, 'Initial anonymity/pending is not expiry.');
      assert.equal(loading(), 'false');
      cases++;
    }

    await reset();
    await setAuth('authenticated', 'before-settled-anonymous');
    await mount();
    await fireTimeouts(0);
    assert.equal(text(), 'Current private notification');
    await dispatch('pointerdown');
    const pendingHome = deferred<Response>();
    const pendingHuman = deferred<Response>();
    responseHandler = call => call.path === '/api/notifications/summary' ? pendingHome.promise : pendingHuman.promise;
    await fireIntervals();
    const homeSignal: AbortSignal = calls.at(-1)!.init!.signal!;
    now += 60_000;
    await dispatch('keydown');
    const activitySignal: AbortSignal = calls.at(-1)!.init!.signal!;
    await dispatch('todo_updated');
    const queuedBeforeAnonymous = [...timeouts.values()].find(value => value.delay === 100)!.callback;
    await setAuth('anonymous');
    assert.equal(openedDocumentAuthScope(), null);
    assert.equal(expiry.getSessionExpirySnapshot().sessionExpired, true, 'A validated login becoming settled anonymous expires private consumers.');
    assert.equal(text(), '');
    assert.equal(loading(), 'false');
    assert.equal(homeSignal.aborted, true);
    assert.equal(activitySignal.aborted, true);
    assertNoWork();
    assert.deepEqual(redirects, ['/en/login']);
    assert.deepEqual(notifyCalls, [], 'Authoritative settled anonymity needs no additional auth refetch.');
    const afterSettledAnonymous = calls.length;
    await act(async () => { queuedBeforeAnonymous(); });
    for (const event of [...homeEvents, ...activityEvents]) await dispatch(event);
    assert.equal(calls.length, afterSettledAnonymous);
    await resolve(pendingHome, summaryResponse('Previous login response'));
    await resolve(pendingHuman, Response.json({}, { status: 401 }));
    assert.equal(text(), '');
    assert.deepEqual(redirects, ['/en/login'], 'Late transport cannot repeat the settled-anonymous redirect.');
    responseHandler = async call => call.path === '/api/notifications/summary'
      ? summaryResponse('Fresh after settled anonymous') : Response.json({ recorded: true });
    await setAuth('authenticated', 'after-settled-anonymous');
    await fireTimeouts(0);
    assert.equal(text(), 'Fresh after settled anonymous');
    await dispatch('pointerdown');
    assert.equal(calls.length, afterSettledAnonymous + 2, 'A new validated login restarts both consumers.');
    cases++;

    await reset();
    await setAuth('authenticated', 'home-current');
    const firstResponse = summaryResponse('Home private A');
    responseHandler = async () => firstResponse;
    await mount(true, false);
    assert.equal(calls.length, 0, 'Initial read is queued, not sent during render.');
    await fireTimeouts(0);
    assert.equal(text(), 'Home private A');
    assert.equal(loading(), 'false');
    assert.equal(firstResponse.bodyUsed, true, 'Successful summary JSON is actually consumed.');
    assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(intervals.size, 1);
    for (const event of homeEvents) await dispatch(event);
    assert.equal([...timeouts.values()].filter(value => value.delay === 100).length, 1, 'Summary updates coalesce.');
    responseHandler = async () => summaryResponse('Home private updated');
    await fireTimeouts(100);
    assert.equal(calls.length, 2);
    assert.equal(text(), 'Home private updated');
    cases++;

    const expiredRequest = deferred<Response>();
    responseHandler = () => expiredRequest.promise;
    await fireIntervals();
    const expiredSignal = calls.at(-1)!.init!.signal!;
    await dispatch('notification_summary_updated');
    const queuedUpdate = [...timeouts.values()].find(value => value.delay === 100)!.callback;
    const oldInterval = [...intervals.values()][0].callback;
    await resolve(expiredRequest, Response.json({ success: false }, { status: 401 }));
    assert.equal(text(), '', 'Definitive current-session 401 hides the cached Home summary.');
    assert.equal(loading(), 'false');
    assert.equal(expiredSignal.aborted, true);
    assertNoWork();
    assert.deepEqual(redirects, ['/en/login']);
    assert.deepEqual(notifyCalls, ['$sessionSignal']);
    const callsAfterExpiry = calls.length;
    await act(async () => { queuedUpdate(); oldInterval(); });
    for (const event of homeEvents) await dispatch(event);
    await fireTimeouts(100);
    assert.equal(calls.length, callsAfterExpiry, 'Captured callbacks and new events cannot restart expired polling.');
    await setAuth('authenticated', 'home-current');
    assertNoWork();
    assert.equal(text(), '', 'Reobserving the same revoked session cannot release the expiry latch.');
    responseHandler = async () => summaryResponse('Home new login');
    await setAuth('authenticated', 'home-new-login');
    await fireTimeouts(0);
    assert.equal(text(), 'Home new login');
    cases++;

    for (const status of [200, 401]) {
      await reset();
      await setAuth('authenticated', `home-old-${status}`);
      const oldResponse = deferred<Response>();
      responseHandler = () => oldResponse.promise;
      await mount(true, false);
      await fireTimeouts(0);
      const oldSignal: AbortSignal = calls[0].init!.signal!;
      // Same user, new auth session: shared workspace/user identity is insufficient.
      await setAuth('authenticated', `home-new-${status}`);
      assert.equal(oldSignal.aborted, true);
      assert.equal(text(), '');
      responseHandler = async () => summaryResponse('New login private title');
      await fireTimeouts(0);
      await resolve(oldResponse, status === 200 ? summaryResponse('Old login private title')
        : Response.json({ success: false }, { status }));
      assert.equal(text(), 'New login private title', `Old ${status} cannot replace the new login's summary.`);
      assert.equal(redirects.length, 0, `Old ${status} cannot expire the new session.`);
      assert.equal(expiry.getSessionExpirySnapshot().sessionExpired, false);
      cases++;
    }

    await reset();
    await setAuth('authenticated', 'body-old');
    const oldBody = deferred<{ success: boolean; data: NotificationSummary }>();
    const responseBeforeBody = summaryResponse('Unused transport body');
    Object.defineProperty(responseBeforeBody, 'json', { value: () => oldBody.promise });
    responseHandler = async () => responseBeforeBody;
    await mount(true, false);
    await fireTimeouts(0);
    await setAuth('authenticated', 'body-new', 'another-user');
    responseHandler = async () => summaryResponse('New user after body boundary');
    await fireTimeouts(0);
    await resolve(oldBody, { success: true, data: summary('Old user deferred body') });
    assert.equal(text(), 'New user after body boundary', 'A scope switch during response.json cannot repopulate the old summary.');
    assert.equal(redirects.length, 0);
    cases++;

    for (const status of [200, 401]) {
      await reset();
      await setAuth('authenticated', `unmount-home-${status}`);
      const late = deferred<Response>();
      responseHandler = () => late.promise;
      await mount(true, false);
      await fireTimeouts(0);
      await dispatch('todo_updated');
      const signal: AbortSignal = calls[0].init!.signal!;
      await unmount();
      assert.equal(signal.aborted, true);
      assertNoWork();
      await resolve(late, status === 200 ? summaryResponse('Unmounted private title') : Response.json({}, { status }));
      assert.equal(document.querySelector('[data-home]'), null);
      assert.equal(redirects.length, 0, 'Late responses after unmount never deliver a redirect.');
      cases++;
    }

    await reset();
    await setAuth('authenticated', 'queued-before-unmount');
    await mount(true, false);
    const initialCallback = [...timeouts.values()][0].callback;
    await unmount();
    assertNoWork();
    await act(async () => { initialCallback(); });
    assert.equal(calls.length, 0, 'A cancelled initial callback cannot start a request after unmount.');
    cases++;

    await reset();
    await setAuth('authenticated', 'human-current');
    const humanSuccess = Response.json({ recorded: true });
    responseHandler = async () => humanSuccess;
    await mount(false, true);
    assert.equal(calls.length, 0, 'Mounting the activity recorder never reports background activity.');
    await dispatch('pointerdown');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/instance/human-activity');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(humanSuccess.bodyUsed, true, 'Activity success response is drained.');
    assert.deepEqual(trustedInputs, [false], 'Only the explicit JSDOM trust seam enables synthetic events.');
    await dispatch('touchstart');
    assert.equal(calls.length, 1, 'The actual policy still throttles transport attempts.');
    now += 60_000;
    responseHandler = async () => Response.json({ error: 'Origin denied' }, { status: 403 });
    await dispatch('keydown');
    assert.equal(calls.length, 2);
    assert.equal(redirects.length, 0, 'A CSRF/scoped 403 does not imply authentication expiry.');
    now += 60_000;
    const humanExpired = deferred<Response>();
    responseHandler = () => humanExpired.promise;
    const capturedActivity = [...listeners.get('pointerdown')!][0] as EventListener;
    await dispatch('pointerdown');
    const humanSignal = calls.at(-1)!.init!.signal!;
    const human401 = Response.json({ error: 'Unauthorized' }, { status: 401 });
    await resolve(humanExpired, human401);
    assert.equal(human401.bodyUsed, true);
    assert.equal(humanSignal.aborted, true);
    assertNoWork();
    assert.deepEqual(redirects, ['/en/login']);
    const beforeFurtherActivity = calls.length;
    now += 60_000;
    await act(async () => { capturedActivity(new Event('pointerdown')); });
    for (const event of activityEvents) await dispatch(event);
    assert.equal(calls.length, beforeFurtherActivity, 'Expired activity listeners and captured callbacks remain stopped.');
    await setAuth('authenticated', 'human-relogin');
    const reloginSuccess = Response.json({ recorded: true });
    responseHandler = async () => reloginSuccess;
    await dispatch('keydown');
    assert.equal(calls.length, beforeFurtherActivity + 1);
    assert.equal(reloginSuccess.bodyUsed, true);
    cases++;

    await reset();
    await setAuth('authenticated', 'human-old');
    const oldHuman = deferred<Response>();
    responseHandler = () => oldHuman.promise;
    await mount(false, true);
    await dispatch('pointerdown');
    const oldHumanSignal = calls[0].init!.signal!;
    await setAuth('authenticated', 'human-new');
    assert.equal(oldHumanSignal.aborted, true);
    const newHuman = Response.json({ recorded: true });
    responseHandler = async () => newHuman;
    await dispatch('pointerdown');
    const oldHuman401 = Response.json({}, { status: 401 });
    await resolve(oldHuman, oldHuman401);
    assert.equal(oldHuman401.bodyUsed, true, 'Even ignored late activity responses are drained.');
    assert.equal(newHuman.bodyUsed, true);
    assert.equal(redirects.length, 0, 'An old activity 401 cannot expire the new login.');
    assert.equal(expiry.getSessionExpirySnapshot().sessionExpired, false);
    cases++;

    await reset();
    await setAuth('authenticated', 'human-unmount');
    const unmountedHuman = deferred<Response>();
    responseHandler = () => unmountedHuman.promise;
    await mount(false, true);
    await dispatch('keydown');
    const unmountedSignal = calls[0].init!.signal!;
    await unmount();
    assert.equal(unmountedSignal.aborted, true);
    assertNoWork();
    const unmounted401 = Response.json({}, { status: 401 });
    await resolve(unmountedHuman, unmounted401);
    assert.equal(unmounted401.bodyUsed, true);
    assert.equal(redirects.length, 0);
    cases++;
    assert.equal(unexpectedHttpCalls, 0, 'No external/canonical HTTP transport is allowed.');
    console.log(`session-scoped-home-activity-test: ok (${cases} React/JSDOM cases; real expiry/registry, isolated transport)`);
  } catch (error) {
    scenarioFailed = true;
    throw error;
  } finally {
    await unmount();
    if (!scenarioFailed) assertNoWork();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  moduleInternals._load = originalLoad;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  Object.assign(dom.window, originalTimers);
  dom.window.addEventListener = originalWindowAdd;
  dom.window.removeEventListener = originalWindowRemove;
  dom.window.document.addEventListener = originalDocumentAdd;
  dom.window.document.removeEventListener = originalDocumentRemove;
  dom.window.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
