import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import React, { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';

import type { NotificationSummary } from '../app/components/notifications/notification-summary';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { AISession } from '../app/lib/chat/types';
import {
  findOpenedLiveDocument,
  invalidateOpenedDocumentAuth,
  observeOpenedDocumentAuth,
  openedDocumentAuthScope,
  rememberOpenedLiveDocument,
  subscribeOpenedDocumentAuthInvalidation,
  validateOpenedLiveDocumentSession,
} from '../app/lib/collaboration/opened-document-registry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-session-expiry-'));
  const environmentKeys = ['DATA', 'CANVAS_DATA_ROOT', 'DATABASE_URL', 'POSTGRES_URL', 'CANVAS_DATABASE_PROVIDER'] as const;
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', { url: 'https://canvas.test/en/notebook' });
  const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previousGlobals = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const redirects: string[] = [];
  const location = { origin: dom.window.location.origin, pathname: '/en/notebook', replace: (href: string) => { redirects.push(href); } };
  const browserWindow = new Proxy(dom.window, { get: (target, key) => key === 'location' ? location : Reflect.get(target, key, target) });
  for (const key of globalKeys) {
    Object.defineProperty(globalThis, key, { configurable: true,
      value: key === 'window' ? browserWindow : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] });
  }

  type AuthState = { data: { user: { id: string }; session: { id: string } } | null; isPending: boolean; error: { status: number } | null };
  let authState: AuthState = { data: null, isPending: true, error: null };
  const authListeners = new Set<() => void>();
  const authAtomListeners = new Set<(value: AuthState) => void>();
  const pathListeners = new Set<() => void>();
  let signals = 0;
  let afterSignal: (() => void) | null = null;
  const authClient = {
    useSession: () => useSyncExternalStore(listener => { authListeners.add(listener); return () => { authListeners.delete(listener); }; },
      () => authState, () => authState),
    $store: {
      atoms: { session: { get: () => authState, listen: (listener: (value: AuthState) => void) => {
        authAtomListeners.add(listener);
        return () => { authAtomListeners.delete(listener); };
      } } },
      notify: (signal: string) => {
        assert.equal(signal, '$sessionSignal');
        signals += 1;
        // Exactly the production auth-client listener; no auth/network or alternate cache implementation.
        invalidateOpenedDocumentAuth();
        afterSignal?.();
      },
    },
  };
  const setAuth = (userId: string | null, sessionId = 'browser-session', isPending = false, error: { status: number } | null = null) => {
    authState = { data: userId ? { user: { id: userId }, session: { id: sessionId } } : null, isPending, error };
    observeOpenedDocumentAuth(authState);
    for (const listener of authAtomListeners) listener(authState);
    for (const listener of authListeners) listener();
  };
  const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/auth-client' || /\/app\/lib\/auth-client(?:\.ts)?$/u.test(request)) return { authClient };
    if (request === 'next/navigation') return {
      usePathname: () => useSyncExternalStore(listener => { pathListeners.add(listener); return () => { pathListeners.delete(listener); }; },
        () => location.pathname, () => location.pathname),
    };
    return originalLoad(request, parent, isMain);
  };

  const previousFetch = globalThis.fetch;
  let fetchResponse: (init?: RequestInit) => Promise<Response> = async () => { throw new Error('Missing response fixture.'); };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let unexpectedRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname !== '/api/notifications/summary') {
      unexpectedRequests += 1;
      throw new Error(`Unexpected HTTP path: ${url.pathname}`);
    }
    requests.push({ url: url.toString(), init });
    return fetchResponse(init);
  };
  let invalidations = 0;
  const unsubscribeInvalidation = subscribeOpenedDocumentAuthInvalidation(() => { invalidations += 1; });
  let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined;
  let queryClient: ReturnType<typeof import('../app/lib/queries/client').getNotebookQueryClient> | undefined;
  try {
    const {
      getSessionExpirySnapshot, reportSessionExpiry, SessionExpiredError, StaleSessionResponseError,
    } = await import('../app/lib/auth/session-expiry');
    const { readNotificationSummary } = await import('../app/components/notifications/notification-summary');
    const { updateNotification } = await import('../app/components/notifications/notification-actions');
    const { getNotebookQueryClient, notebookQueryKey } = await import('../app/lib/queries/client');
    const { buildCachedChatSessionEntry, rememberChatSessionCacheEntry, persistChatSessionCache, readLatestCachedChatSession } = await import('../app/lib/chat/session-cache');
    const { AuthenticatedSessionBoundary, useAuthenticatedRequestScope } = await import('../app/components/auth/AuthenticatedSessionBoundary');
    queryClient = getNotebookQueryClient();
    const summary: NotificationSummary = { unreadCount: 1,
      counts: { unread: 1, chat: 1, todos: 0, todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
      items: [], sections: { notifications: [], todos: [], todoAttention: [], emailAttention: [] } };
    const success = () => Response.json({ success: true, data: summary });
    const expired = (error: unknown) => error instanceof SessionExpiredError;
    const superseded = (error: unknown) => error instanceof StaleSessionResponseError;
    const newLogin = (sessionId: string, userId = 'alice') => { setAuth(userId, sessionId); assert.equal(getSessionExpirySnapshot().sessionExpired, false); };
    const responseWithBody = (body: Promise<unknown>, status = 200) => ({ status, ok: status >= 200 && status < 300, json: () => body } as Response);

    fetchResponse = async () => success();
    assert.deepEqual(await readNotificationSummary(), summary, 'Existing unresolved null/null successful reads remain compatible.');
    fetchResponse = async () => Response.json({ error: 'Unauthorized' }, { status: 401 });
    await assert.rejects(readNotificationSummary(), /Unauthorized/u);
    assert.equal(getSessionExpirySnapshot().sessionExpired, false);
    assert.equal(signals, 0, 'Anonymous/unresolved 401 cannot expire or redirect any login.');

    newLogin('alice-one');
    const firstScope = openedDocumentAuthScope()!;
    const signal = new AbortController().signal;
    fetchResponse = async () => success();
    assert.deepEqual(await readNotificationSummary({ authScope: firstScope, signal, activeChatSessionId: 'private chat' }), summary);
    assert.equal(requests.at(-1)?.init?.signal, signal);
    assert.equal(requests.at(-1)?.init?.credentials, 'include');
    assert.equal(requests.at(-1)?.init?.cache, 'no-store');
    assert.equal(new URL(requests.at(-1)!.url).searchParams.get('activeChatSessionId'), 'private chat');
    const stableSnapshot = getSessionExpirySnapshot();
    assert.equal(getSessionExpirySnapshot(), stableSnapshot, 'useSyncExternalStore gets a stable unchanged snapshot.');
    const privateKey = notebookQueryKey('workspace', 'private');
    queryClient.setQueryData(privateKey, 'Private query contents');
    for (const status of [403, 500, 503]) {
      fetchResponse = async () => Response.json({ error: `HTTP ${status}` }, { status });
      await assert.rejects(readNotificationSummary({ authScope: firstScope }), new RegExp(`HTTP ${status}`, 'u'));
      assert.equal(getSessionExpirySnapshot().sessionExpired, false);
      assert.equal(queryClient.getQueryData(privateKey), 'Private query contents');
    }
    fetchResponse = async () => { throw new TypeError('Offline'); };
    await assert.rejects(readNotificationSummary({ authScope: firstScope }), { name: 'TypeError', message: 'Offline' });
    assert.equal(signals, 0);
    assert.equal(redirects.length, 0, '403/network/5xx do not log out or navigate.');

    const file: CurrentFile = { path: 'private.txt', content: '', collaboration: {
      path: 'private.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: 'private-doc', provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null },
    } };
    const documentSession: CollaborationSessionResponse = { success: true, documentId: 'private-doc', documentName: 'private-doc', provider: 'yjs',
      representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
      token: 'synthetic-unit-token', expiresAt: '2099-01-01T00:00:00.000Z', websocketUrl: '/ws/collaboration',
      user: { id: 'alice', name: 'Alice', color: '#123456', colorLight: '#abcdef' } };
    assert.equal(validateOpenedLiveDocumentSession('workspace', file.path, documentSession), true);
    rememberOpenedLiveDocument({ scope: firstScope, workspaceId: 'workspace', path: file.path, file, session: documentSession,
      stateProof: 'synthetic-receipt', snapshot: new Uint8Array([1, 2]) });
    assert.ok(findOpenedLiveDocument('workspace', file.path, documentSession.documentId));
    const chat: AISession = { id: 1, sessionId: 'private-chat', agentId: 'canvas-agent', model: 'fixture', title: 'Private chat title',
      createdAt: '2026-10-12T00:00:00.000Z', workspace: { workspaceId: 'workspace', workspaceType: 'personal',
        workspaceName: 'Personal', organizationId: 'org', rootRelativePath: null, legacy: false } };
    rememberChatSessionCacheEntry(buildCachedChatSessionEntry({ authScope: firstScope, session: chat,
      messages: [{ id: '1', role: 'user', content: 'Private transcript' }], hasMoreBefore: false,
      oldestTimestamp: null, oldestMessageId: 1, oldestSequence: 1 }));
    persistChatSessionCache();
    assert.ok(dom.window.sessionStorage.getItem('canvas.chat.sessionMessages.v2'));
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let responses = 0;
    fetchResponse = () => (++responses === 1 ? firstResponse.promise : secondResponse.promise);
    const firstRead = assert.rejects(readNotificationSummary({ authScope: firstScope }), expired);
    const secondRead = assert.rejects(readNotificationSummary({ authScope: firstScope }), superseded);
    const invalidationsBeforeExpiry = invalidations;
    let bodyReads = 0;
    firstResponse.resolve({ status: 401, ok: false, json: async () => { bodyReads += 1; return { error: 'Denied' }; } } as Response);
    await firstRead;
    secondResponse.resolve(Response.json({ error: 'Denied again' }, { status: 401 }));
    await secondRead;
    assert.equal(bodyReads, 0, 'A current 401 invalidates before waiting for response JSON.');
    assert.equal(signals, 1);
    assert.equal(invalidations, invalidationsBeforeExpiry + 1, 'Existing auth signal clears the private chain once.');
    assert.equal(openedDocumentAuthScope()!.epoch, firstScope.epoch + 1);
    assert.equal(queryClient.getQueryCache().getAll().length, 0);
    assert.equal(findOpenedLiveDocument('workspace', file.path, documentSession.documentId), null);
    assert.equal(readLatestCachedChatSession(chat.sessionId), null);
    assert.equal(dom.window.sessionStorage.getItem('canvas.chat.sessionMessages.v2'), null);
    assert.deepEqual(redirects, ['/en/login']);
    const requestCountAfterExpiry = requests.length;
    await assert.rejects(readNotificationSummary(), expired);
    assert.equal(requests.length, requestCountAfterExpiry, 'Expired helpers cannot keep a polling loop fetching.');
    assert.equal(reportSessionExpiry(firstScope), false);
    invalidateOpenedDocumentAuth();
    assert.equal(getSessionExpirySnapshot().sessionExpired, true, 'Same identity remains expired across another epoch.');
    setAuth(null, '', true);
    assert.equal(getSessionExpirySnapshot().sessionExpired, true, 'Null/pending cannot reveal private UI.');
    setAuth('alice', 'alice-two', true);
    assert.equal(getSessionExpirySnapshot().sessionExpired, true, 'A pending new identity is not validated yet.');
    newLogin('alice-two');

    const oldScope = openedDocumentAuthScope()!;
    const late401 = deferred<Response>();
    fetchResponse = () => late401.promise;
    const obsolete401 = assert.rejects(readNotificationSummary({ authScope: oldScope }), superseded);
    newLogin('bob-one', 'bob');
    const bobKey = notebookQueryKey('workspace', 'bob-private');
    queryClient.setQueryData(bobKey, 'Bob query');
    late401.resolve(Response.json({ error: 'Old Alice unauthorized' }, { status: 401 }));
    await obsolete401;
    assert.equal(queryClient.getQueryData(bobKey), 'Bob query');
    assert.equal(signals, 1);
    assert.equal(redirects.length, 1, 'A late old-session 401 cannot redirect a newer login.');
    const jsonBody = deferred<unknown>();
    const jsonEntered = deferred<void>();
    const bobScope = openedDocumentAuthScope()!;
    fetchResponse = async () => ({ status: 200, ok: true, json: () => { jsonEntered.resolve(); return jsonBody.promise; } } as Response);
    const obsolete200 = assert.rejects(readNotificationSummary({ authScope: bobScope }), superseded);
    await jsonEntered.promise;
    newLogin('bob-two', 'bob');
    jsonBody.resolve({ success: true, data: summary });
    await obsolete200;
    const aborted = new AbortController();
    const abortedResponse = deferred<Response>();
    fetchResponse = () => abortedResponse.promise;
    const abortCheck = assert.rejects(readNotificationSummary({ authScope: openedDocumentAuthScope(), signal: aborted.signal }), { name: 'AbortError' });
    aborted.abort();
    abortedResponse.resolve(Response.json({ error: 'Aborted 401' }, { status: 401 }));
    await abortCheck;
    assert.equal(signals, 1, 'Even a fetch implementation ignoring abort cannot expire the session.');
    const beforePreflightReject = requests.length;
    await assert.rejects(readNotificationSummary({ signal: aborted.signal }), { name: 'AbortError' });
    await assert.rejects(readNotificationSummary({ authScope: bobScope }), superseded);
    assert.equal(requests.length, beforePreflightReject);

    let mutationEvents = 0;
    const mutationEvent = () => { mutationEvents += 1; };
    dom.window.addEventListener('notification_summary_updated', mutationEvent);
    const mutationSignal = new AbortController().signal;
    fetchResponse = async () => Response.json({ success: true });
    await updateNotification({ action: 'mark_all_read' }, { authScope: openedDocumentAuthScope(), signal: mutationSignal });
    assert.equal(requests.at(-1)!.init?.method, 'PATCH');
    assert.equal(requests.at(-1)!.init?.signal, mutationSignal);
    assert.equal(mutationEvents, 1);
    const patchBody = deferred<unknown>();
    const patchEntered = deferred<void>();
    fetchResponse = async () => responseWithBody((patchEntered.resolve(), patchBody.promise));
    const obsoletePatch = assert.rejects(updateNotification({ action: 'mark_all_read' }, { authScope: openedDocumentAuthScope() }), superseded);
    await patchEntered.promise;
    await Promise.resolve();
    newLogin('bob-three', 'bob');
    patchBody.resolve({ success: true });
    await obsoletePatch;
    assert.equal(mutationEvents, 1, 'A late successful PATCH does not dispatch an update into a new login.');
    location.pathname = '/de/settings';
    fetchResponse = async () => Response.json({ error: 'Mutation unauthorized' }, { status: 401 });
    await assert.rejects(updateNotification({ action: 'mark_all_read' }, { authScope: openedDocumentAuthScope() }), expired);
    assert.equal(mutationEvents, 1);
    assert.equal(signals, 2);
    assert.equal(redirects.at(-1), '/de/login');
    dom.window.removeEventListener('notification_summary_updated', mutationEvent);

    const { createRoot } = await import('react-dom/client');
    root = createRoot(document.getElementById('root')!);
    const Probe = () => {
      const state = useAuthenticatedRequestScope();
      return <span data-active={String(state.active)} data-expired={String(state.sessionExpired)}>{state.scope?.sessionId ?? 'unresolved'}</span>;
    };
    const renderBoundary = async (pathname: string, contents: string) => {
      await act(async () => {
        location.pathname = pathname;
        for (const listener of pathListeners) listener();
        root!.render(<><Probe /><AuthenticatedSessionBoundary><div data-testid="private-tree">{contents}</div></AuthenticatedSessionBoundary></>);
      });
    };
    await renderBoundary('/de/settings', 'PRIVATE');
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null);
    for (const pathname of ['/en/login', '/de/sign-in', '/en/sign-up', '/de/setup', '/en/invite/team', '/en/oauth/consent']) {
      await renderBoundary(pathname, 'PUBLIC');
      assert.equal(document.querySelector('[data-testid="private-tree"]')?.textContent, 'PUBLIC');
    }
    await renderBoundary('/en/notebook', 'PRIVATE');
    await act(async () => { setAuth(null, '', true); });
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null);
    await act(async () => { setAuth('bob', 'bob-four', true); });
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null);
    await act(async () => { newLogin('bob-four', 'bob'); });
    assert.equal(document.querySelector('[data-testid="private-tree"]')?.textContent, 'PRIVATE');
    assert.equal(document.querySelector('[data-active="true"]')?.textContent, 'bob-four');
    await act(async () => { setAuth(null, '', true); });
    assert.ok(document.querySelector('[data-active="false"]'));
    await act(async () => { newLogin('carol-one', 'carol'); });
    assert.equal(document.querySelector('[data-active="true"]')?.textContent, 'carol-one', 'Initial null→auth hydration updates the actual hook.');
    await act(async () => { reportSessionExpiry(openedDocumentAuthScope()); });
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null, 'Private tree is removed while intercepted navigation remains pending.');
    await act(async () => { newLogin('dave-one', 'dave'); });
    const redirectsBeforeNotifyRace = redirects.length;
    afterSignal = () => setAuth('dave', 'dave-two');
    await act(async () => { reportSessionExpiry(openedDocumentAuthScope()); });
    afterSignal = null;
    assert.equal(redirects.length, redirectsBeforeNotifyRace, 'A synchronous validated session replacement during signal cannot be redirected.');
    assert.equal(getSessionExpirySnapshot().sessionExpired, false);

    const redirectsBeforePending = redirects.length;
    await act(async () => { setAuth(null, '', true); });
    assert.equal(getSessionExpirySnapshot().sessionExpired, false, 'Pending session refocus never expires a previously validated session.');
    for (const status of [403, 500, 503]) {
      await act(async () => { setAuth(null, '', false, { status }); });
      assert.equal(getSessionExpirySnapshot().sessionExpired, false, 'A failed auth observation is not authoritative absence.');
    }
    assert.equal(redirects.length, redirectsBeforePending);
    await act(async () => { newLogin('dave-three', 'dave'); });
    const signalsBeforeSettledAbsence = signals;
    const invalidationsBeforeSettledAbsence = invalidations;
    await act(async () => { setAuth(null); });
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null,
      'Settled BetterAuth absence hides the entire private tree without waiting for an application 401.');
    assert.equal(getSessionExpirySnapshot().sessionExpired, true);
    assert.equal(redirects.length, redirectsBeforePending + 1);
    assert.equal(redirects.at(-1), '/en/login');
    assert.equal(signals, signalsBeforeSettledAbsence, 'Settled absence does not start another auth refetch.');
    assert.equal(invalidations, invalidationsBeforeSettledAbsence + 1, 'Existing null auth observation already clears private caches.');
    await act(async () => { setAuth('dave', 'dave-three'); });
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null, 'Returning the same rejected identity cannot reset the latch.');
    await act(async () => { newLogin('dave-four', 'dave'); });
    assert.equal(document.querySelector('[data-testid="private-tree"]')?.textContent, 'PRIVATE');
    const staleNull: AuthState = { data: null, error: null, isPending: false };
    const redirectsBeforeOldObservation = redirects.length;
    await act(async () => { for (const listener of authAtomListeners) listener(staleNull); });
    assert.equal(getSessionExpirySnapshot().sessionExpired, false, 'A queued atom observation cannot expire a newer actual atom value.');
    assert.equal(redirects.length, redirectsBeforeOldObservation);
    await renderBoundary('/de/invite/team', 'PUBLIC INVITATION');
    await act(async () => { setAuth(null); });
    assert.equal(document.querySelector('[data-testid="private-tree"]')?.textContent, 'PUBLIC INVITATION');
    assert.equal(redirects.length, redirectsBeforeOldObservation, 'Settled absence never redirects away from a public invitation page.');
    await renderBoundary('/de/settings', 'PRIVATE');
    assert.equal(document.querySelector('[data-testid="private-tree"]'), null);
    assert.equal(redirects.at(-1), '/de/login', 'Entering a private route with a latched expiry uses localized replacement.');

    console.log('session-expiry-test: ok (real registry/query/chat invalidation, current/late/aborted GET+PATCH, single redirect, identity latch, settled BetterAuth absence and React private/public boundary)');
  } finally {
    await act(async () => { root?.unmount(); });
    unsubscribeInvalidation();
    queryClient?.clear();
    globalThis.fetch = previousFetch;
    moduleInternals._load = originalLoad;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else Reflect.set(process.env, key, value);
    }
    dom.window.close();
    await fs.rm(dataRoot, { recursive: true, force: true });
    assert.equal(unexpectedRequests, 0, 'No external/auth/DB-related HTTP requests escape the fixture.');
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
