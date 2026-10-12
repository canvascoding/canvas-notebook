import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM, VirtualConsole } from 'jsdom';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { NotificationSummary } from '../app/components/notifications/notification-summary';
import type { OpenChatSessionEventDetail } from '../app/lib/chat/open-chat-session-event';

let redirectAttempts = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (error.message.includes('navigation')) { redirectAttempts++; return; }
  throw error;
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://canvas.test/en/notebook', virtualConsole,
});
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'SVGElement', 'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true,
    value: dom.window[key] ?? (key === 'PointerEvent' ? dom.window.MouseEvent : undefined) });
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true, value: class { observe() {} unobserve() {} disconnect() {} },
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
  Object.defineProperty(dom.window.HTMLElement.prototype, method, { configurable: true,
    value: method === 'hasPointerCapture' ? () => false : () => {} });
}

// Invoke the real 30-second polling callback without waiting or replacing the
// component implementation. Other async work keeps real Promise/DOM semantics.
const intervals = new Map<number, () => void>();
let intervalId = 0;
window.setInterval = ((callback: TimerHandler) => {
  assert.equal(typeof callback, 'function');
  const id = ++intervalId;
  intervals.set(id, () => { (callback as () => void)(); });
  return id;
}) as typeof window.setInterval;
window.clearInterval = (id: Parameters<typeof window.clearInterval>[0]) => {
  if (typeof id === 'number') intervals.delete(id);
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function summary(title: string, count = 1): NotificationSummary {
  const item = { id: `chat:${title}`, type: 'chat.response' as const, title,
    detail: null, occurredAt: '2026-10-12T12:00:00.000Z', unread: true,
    priority: 'normal' as const, workspaceId: `workspace-${title}`, workspaceName: `Workspace ${title}`,
    target: { kind: 'chat' as const, sessionId: `chat-${title}` } };
  return { unreadCount: count, counts: { unread: count, chat: count, todos: 0,
    todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
    items: [item], sections: { notifications: [item], todos: [], todoAttention: [], emailAttention: [] } };
}
const success = (title: string, count = 1) => Response.json({ success: true, data: summary(title, count) });
const unauthorized = () => Response.json({ success: false, error: 'Session expired' }, { status: 401 });

async function main() {
  let groups = 0;
  const originalFetch = globalThis.fetch;
  let sessionData: unknown = null;
  type Call = { init: RequestInit | undefined; url: URL };
  let reads: Call[] = [];
  let patches: Call[] = [];
  let readHandler: (call: Call) => Promise<Response> = async () => success('initial');
  let patchHandler: (call: Call) => Promise<Response> = async () => Response.json({ success: true });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Response.json(sessionData);
    assert.equal(url.pathname, '/api/notifications/summary', `Unexpected request: ${url.pathname}`);
    const call = { init, url };
    if (init?.method === 'PATCH') { patches.push(call); return patchHandler(call); }
    reads.push(call);
    return readHandler(call);
  };
  const { authClient } = await import('../app/lib/auth-client');
  const { NotificationBell } = await import('../app/components/notifications/NotificationBell');
  const { openedDocumentAuthScope } = await import('../app/lib/collaboration/opened-document-registry');
  const { getNotebookQueryClient } = await import('../app/lib/queries/client');
  const { fireEvent, render } = await import('@testing-library/react');
  const sessionAtom = authClient.$store.atoms.session;
  const initialSession = sessionAtom.get();
  type SessionData = NonNullable<ReturnType<typeof sessionAtom.get>['data']>;
  const makeSession = (userId: string, sessionId: string): SessionData => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    return { user: { id: userId, name: userId, email: `${userId}@example.test`,
      emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: sessionId, userId, token: 'synthetic-browser-session', createdAt: now,
      updatedAt: now, expiresAt: new Date('2099-01-01T00:00:00.000Z') } } as SessionData;
  };
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {},
    hmrRefresh() {}, bfcacheId: 'test-router' };
  let screen: ReturnType<typeof render> | null = null;
  let navigationEvents = 0;
  let historyWrites = 0;
  const originalPushState = window.history.pushState.bind(window.history);
  window.history.pushState = (...args) => { historyWrites++; originalPushState(...args); };
  const interceptChat = (event: Event) => {
    navigationEvents++;
    (event as CustomEvent<OpenChatSessionEventDetail>).detail.handled = true;
  };
  window.addEventListener('canvas:open-chat-session', interceptChat);

  const tick = async (delay = 20) => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
  });
  const setAuth = async (data: SessionData | null, pending = false) => {
    sessionData = data;
    await act(async () => { sessionAtom.set({ ...sessionAtom.get(), data,
      error: null, isPending: pending, isRefetching: false }); });
    await tick();
  };
  const reset = async (userId: string | null = 'alice', sessionId = 'session-a') => {
    if (screen) { screen.unmount(); screen = null; }
    assert.equal(intervals.size, 0, 'Bell unmount must clear polling timers');
    reads = []; patches = []; historyWrites = 0; navigationEvents = 0;
    readHandler = async () => success('initial');
    patchHandler = async () => Response.json({ success: true });
    await setAuth(userId ? makeSession(userId, sessionId) : null);
    getNotebookQueryClient().clear();
    screen = render(<AppRouterContext.Provider value={router}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <NotificationBell />
      </NextIntlClientProvider>
    </AppRouterContext.Provider>);
    await tick();
  };
  const open = async () => {
    assert.ok(screen);
    fireEvent.click(screen.getByTestId('notification-bell'));
    await tick();
  };
  const poll = async () => {
    await act(async () => { for (const callback of intervals.values()) callback(); });
    await tick();
  };
  const settle = async (pending: ReturnType<typeof deferred<Response>>, response: Response) => {
    await act(async () => { pending.resolve(response); });
    await tick();
  };
  const events = async () => {
    await act(async () => {
      for (const name of ['session_updated', 'todo_updated', 'notification_summary_updated']) {
        window.dispatchEvent(new CustomEvent(name));
      }
      window.dispatchEvent(new CustomEvent('chat-active-session-changed', {
        detail: { sessionId: 'visible-chat', isVisible: true },
      }));
    });
    await tick(130);
  };

  try {
    await reset(null);
    assert.equal(screen!.queryByTestId('notification-bell'), null);
    await setAuth(null, true);
    await events(); await poll();
    assert.equal(reads.length, 0, 'unresolved and anonymous sessions do not poll private summaries');
    assert.equal(intervals.size, 0);
    groups++;

    await reset('alice', 'normal-session');
    assert.equal(reads.length, 1);
    assert.equal(intervals.size, 1);
    assert.equal(reads[0].init?.credentials, 'include');
    assert.equal(reads[0].init?.cache, 'no-store');
    assert.ok(reads[0].init?.signal);
    await open();
    assert.ok(screen!.getByRole('button', { name: /initial/u }));
    assert.equal(reads.length, 2);
    await poll(); await events();
    assert.ok(reads.length > 3, 'authenticated interval and event refresh remain functional');
    groups++;

    await reset('alice', 'overlap-session');
    const olderRefresh = deferred<Response>();
    readHandler = async () => olderRefresh.promise;
    await open();
    const olderCall = reads.at(-1)!;
    readHandler = async () => success('newest-refresh', 3);
    await poll();
    assert.equal(olderCall.init?.signal?.aborted, true);
    await settle(olderRefresh, success('obsolete-refresh', 9));
    assert.ok(screen!.getByRole('button', { name: /newest-refresh/u }));
    assert.equal(screen!.queryByRole('button', { name: /obsolete-refresh/u }), null);
    assert.match(screen!.getByTestId('notification-bell').getAttribute('aria-label') ?? '', /3/u);
    groups++;

    // A 200 and a 401 from an earlier login must both be ignored, even though
    // the controlled transport intentionally resolves despite its abort.
    for (const status of [200, 401]) {
      await reset('alice', `old-${status}`);
      const late = deferred<Response>();
      readHandler = async () => late.promise;
      await open();
      const oldCall = reads.at(-1)!;
      readHandler = async () => success('bob-private', 2);
      await setAuth(makeSession('bob', `new-${status}`));
      assert.equal(oldCall.init?.signal?.aborted, true);
      assert.equal(screen!.queryByRole('button', { name: /initial/u }), null, 'old open popup closes at the auth boundary');
      const bobScope = openedDocumentAuthScope();
      getNotebookQueryClient().setQueryData(['bob-private-cache'], { owned: true });
      await open();
      await settle(late, status === 401 ? unauthorized() : success('alice-private', 9));
      assert.equal(openedDocumentAuthScope(), bobScope);
      assert.deepEqual(getNotebookQueryClient().getQueryData(['bob-private-cache']), { owned: true });
      assert.ok(screen!.getByRole('button', { name: /bob-private/u }));
      assert.equal(screen!.queryByRole('button', { name: /alice-private/u }), null);
      assert.match(screen!.getByTestId('notification-bell').getAttribute('aria-label') ?? '', /2/u);
    }
    groups++;

    await reset('alice', 'old-body-session');
    const lateBody = deferred<{ success: true; data: NotificationSummary }>();
    let bodyReads = 0;
    readHandler = async () => {
      const response = success('old-body');
      response.json = async () => { bodyReads++; return lateBody.promise; };
      return response;
    };
    await open();
    assert.equal(bodyReads, 1, 'the old HTTP response must reach its deferred JSON body');
    readHandler = async () => success('new-user-after-body');
    await setAuth(makeSession('bob', 'new-body-session'));
    const bodyScope = openedDocumentAuthScope();
    await open();
    await act(async () => { lateBody.resolve({ success: true, data: summary('old-user-body', 9) }); });
    await tick();
    assert.equal(openedDocumentAuthScope(), bodyScope);
    assert.ok(screen!.getByRole('button', { name: /new-user-after-body/u }));
    assert.equal(screen!.queryByRole('button', { name: /old-user-body/u }), null);
    groups++;

    await reset('alice', 'same-user-old-session');
    await open();
    readHandler = async () => success('same-user-new-login', 4);
    await setAuth(makeSession('alice', 'same-user-new-session'));
    assert.equal(screen!.queryByRole('button', { name: /initial/u }), null);
    await open();
    assert.ok(screen!.getByRole('button', { name: /same-user-new-login/u }));
    groups++;

    await reset('alice', 'expired-session');
    await open();
    const previousPolls = [...intervals.values()];
    getNotebookQueryClient().setQueryData(['private-before-expiry'], { owned: true });
    readHandler = async () => unauthorized();
    const redirectsBeforeExpiry = redirectAttempts;
    await poll();
    assert.equal(screen!.queryByTestId('notification-bell'), null);
    assert.equal(screen!.queryByRole('button', { name: /initial/u }), null);
    assert.equal(intervals.size, 0);
    assert.equal(redirectAttempts, redirectsBeforeExpiry + 1, 'current expiry requests one login navigation');
    assert.equal(getNotebookQueryClient().getQueryData(['private-before-expiry']), undefined);
    const readsAfterExpiry = reads.length;
    await events();
    await act(async () => { for (const callback of previousPolls) callback(); });
    await tick();
    assert.equal(reads.length, readsAfterExpiry, 'expiry blocks interval, events and captured old callbacks');
    await setAuth(null, true);
    await setAuth(makeSession('alice', 'expired-session'));
    await events();
    assert.equal(screen!.queryByTestId('notification-bell'), null, 'rehydrating the expired session cannot resume polling');
    assert.equal(reads.length, readsAfterExpiry);
    assert.equal(redirectAttempts, redirectsBeforeExpiry + 1, 'same expired session does not repeat navigation');
    readHandler = async () => success('new-login-after-expiry');
    await setAuth(makeSession('alice', 'fresh-session-after-expiry'));
    await open();
    assert.ok(screen!.getByRole('button', { name: /new-login-after-expiry/u }));
    assert.equal(intervals.size, 1);
    groups++;

    for (const status of [403, 503, 'network'] as const) {
      await reset('alice', `transient-${status}`);
      const scope = openedDocumentAuthScope();
      getNotebookQueryClient().setQueryData(['transient-cache'], 'retained');
      readHandler = async () => {
        if (status === 'network') throw new Error('Controlled network interruption');
        return Response.json({ success: false, error: 'Temporary summary failure' }, { status });
      };
      await poll();
      assert.ok(screen!.getByTestId('notification-bell'));
      assert.equal(openedDocumentAuthScope(), scope);
      assert.equal(getNotebookQueryClient().getQueryData(['transient-cache']), 'retained');
      readHandler = async () => success('recovered-same-session');
      await open();
      assert.ok(screen!.getByRole('button', { name: /recovered-same-session/u }));
    }
    groups++;

    await reset('alice', 'unmount-session');
    const afterUnmount = deferred<Response>();
    readHandler = async () => afterUnmount.promise;
    await poll();
    const unmountedCall = reads.at(-1)!;
    const unmountedScope = openedDocumentAuthScope();
    screen!.unmount(); screen = null;
    assert.equal(unmountedCall.init?.signal?.aborted, true);
    await settle(afterUnmount, unauthorized());
    assert.equal(openedDocumentAuthScope(), unmountedScope, 'an aborted unmounted read cannot expire the session');
    groups++;

    // Exercise the actual PATCH and the actual Bell handler across a login
    // change; late completion must not navigate to the previous user's chat.
    for (const status of [200, 401]) {
      await reset('alice', `patch-old-${status}`);
      await open();
      const patch = deferred<Response>();
      patchHandler = async () => patch.promise;
      fireEvent.click(screen!.getByRole('button', { name: /initial/u }));
      await tick();
      assert.equal(patches.length, 1);
      readHandler = async () => success('new-user-after-patch');
      await setAuth(makeSession('bob', `patch-new-${status}`));
      const freshScope = openedDocumentAuthScope();
      await settle(patch, status === 401 ? unauthorized() : Response.json({ success: true }));
      assert.equal(openedDocumentAuthScope(), freshScope);
      assert.equal(historyWrites, 0);
      assert.equal(navigationEvents, 0);
      await open();
      assert.ok(screen!.getByRole('button', { name: /new-user-after-patch/u }));
      assert.equal(screen!.queryByRole('button', { name: /initial/u }), null);
    }
    groups++;

    await reset('alice', 'patch-current-expiry');
    await open();
    patchHandler = async () => unauthorized();
    readHandler = async () => unauthorized();
    fireEvent.click(screen!.getByRole('button', { name: /initial/u }));
    await tick();
    assert.equal(screen!.queryByTestId('notification-bell'), null);
    assert.equal(historyWrites, 0);
    assert.equal(navigationEvents, 0);
    const expiredPatchReads = reads.length;
    await events();
    assert.equal(reads.length, expiredPatchReads);
    groups++;

    for (const action of ['mark-all-read', 'dismiss'] as const) {
      await reset('alice', `${action}-current-expiry`);
      if (action === 'dismiss') {
        const dismissSummary = summary('dismissable-private-studio');
        const item = { ...dismissSummary.items[0], type: 'studio.completed' as const,
          target: { kind: 'studio' as const, generationId: 'synthetic-generation' } };
        dismissSummary.items = [item];
        dismissSummary.sections.notifications = [item];
        dismissSummary.counts.chat = 0;
        dismissSummary.counts.studio = 1;
        readHandler = async () => Response.json({ success: true, data: dismissSummary });
      }
      await open();
      patchHandler = async () => unauthorized();
      const unhandled: unknown[] = [];
      const captureUnhandled = (failure: unknown) => { unhandled.push(failure); };
      process.on('unhandledRejection', captureUnhandled);
      try {
        fireEvent.click(screen!.getByRole('button', { name: action === 'dismiss' ? /^Remove from notifications$/u : /Mark all read/u }));
        await tick(); await tick();
        assert.equal(screen!.queryByTestId('notification-bell'), null);
        assert.equal(unhandled.length, 0, `an expected expiry during ${action} cannot escape as an unhandled UI rejection`);
      } finally {
        process.off('unhandledRejection', captureUnhandled);
      }
    }
    groups++;

    await reset('alice', 'current-mutation-error');
    await open();
    const errorScope = openedDocumentAuthScope();
    patchHandler = async () => Response.json({ success: false, error: 'Controlled current mutation failure' }, { status: 503 });
    const currentFailures: unknown[] = [];
    const captureCurrentFailure = (failure: unknown) => { currentFailures.push(failure); };
    process.on('unhandledRejection', captureCurrentFailure);
    try {
      fireEvent.click(screen!.getByRole('button', { name: /Mark all read/u }));
      await tick(); await tick();
      assert.equal(openedDocumentAuthScope(), errorScope);
      assert.ok(screen!.getByTestId('notification-bell'));
      assert.equal(currentFailures.length, 1, 'a genuine failure for the current session must still propagate');
      assert.ok(currentFailures[0] instanceof Error);
      assert.equal(currentFailures[0].message, 'Controlled current mutation failure');
    } finally {
      process.off('unhandledRejection', captureCurrentFailure);
    }
    groups++;

    console.log(`PASS ${groups} notification Bell authenticated-session race groups`);
  } finally {
    if (screen) screen.unmount();
    window.removeEventListener('canvas:open-chat-session', interceptChat);
    window.history.pushState = originalPushState;
    sessionAtom.set(initialSession);
    getNotebookQueryClient().clear();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
