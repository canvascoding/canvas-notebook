import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createMcpOAuthLauncher } from './mcp-oauth.mjs';
import { createSharedComposioOAuthLauncher } from './composio-oauth.mjs';

const ref = 'canvas-connection:11111111-2222-4333-8444-555555555555';
const watchedEvents = ['did-start-navigation', 'did-navigate-in-page', 'did-navigate', 'destroyed', 'render-process-gone'];

function deferredSharedLauncherResponse() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function sharedLauncherFixture(provider = 'composio', options = {}) {
  const state = provider === 'mcp' ? `desktop_${'x'.repeat(32)}` : Buffer.alloc(32, 7).toString('base64url');
  const authorizationUrl = 'https://own-provider.example/authorize?client_id=controlled-fixture';
  const expiresAt = new Date(Date.now() + (options.lifetime ?? 60_000)).toISOString();
  const request = { state, authorizationUrl, expiresAt, target: { kind: 'shared', connectionRef: ref, workspaceId: 'workspace-a' } };
  const waiting = { connectionRef: ref, state, status: 'waiting', expiresAt, authorizationUrl };
  const frame = { url: 'https://canvas.example/en/plugins?workspaceId=workspace-a&view=advanced' };
  const cookie = { name: '__Host-better-auth.session_token', domain: 'canvas.example', path: '/', hostOnly: true, value: 'controlled-session-a' };
  const cookies = new EventEmitter();
  let jar = [{ ...cookie }], cookieReads = 0;
  cookies.get = async () => { cookieReads += 1; return jar.map(value => ({ ...value })); };
  const requests = [], opened = [], statusRequested = deferredSharedLauncherResponse();
  let reply = options.response, configuredUrl = 'https://canvas.example';
  const webContents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false,
    session: { cookies, fetch: async (url, init) => {
      requests.push({ url, init }); statusRequested.resolve();
      return typeof reply === 'function' ? reply() : reply ?? Response.json({ success: true, data: waiting });
    } } });
  const browserWindow = { webContents, isDestroyed: () => false };
  let currentWindow = browserWindow;
  const event = { sender: webContents, senderFrame: frame };
  const create = provider === 'mcp' ? createMcpOAuthLauncher : createSharedComposioOAuthLauncher;
  const handler = create({ getMainWindow: () => currentWindow, getConfiguredServerUrl: () => configuredUrl,
    openExternal: async url => { opened.push(url); await options.openExternal?.(); } });
  return { handler, request, waiting, event, frame, cookies, webContents, browserWindow, requests, opened, statusRequested,
    cookieReads: () => cookieReads,
    setResponse: value => { reply = value; },
    setConfiguredUrl: value => { configuredUrl = value; },
    setWindow: value => { currentWindow = value; },
    replaceCookie: (value, cause = 'explicit', removed = false, emit = true) => {
      const next = { ...cookie, value }; jar = removed ? [] : [next];
      if (emit) cookies.emit('changed', {}, next, cause, removed);
    },
    navigate: (url, main = true, fullDocument = false) => {
      if (main) frame.url = url;
      if (fullDocument) webContents.emit('did-start-navigation', { url, isMainFrame: main, isSameDocument: false, frame: main ? frame : {} });
      else webContents.emit('did-navigate-in-page', {}, url, main, 10, 20);
    } };
}

function assertSharedLauncherListenersDetached(fixture) {
  assert.equal(fixture.cookies.listenerCount('changed'), 0);
  for (const name of watchedEvents) assert.equal(fixture.webContents.listenerCount(name), 0, `${name} listener must detach`);
}

test('both shared providers bind only their fixed exact-ref status namespace and real session transport', async () => {
  for (const provider of ['mcp', 'composio']) {
    const f = sharedLauncherFixture(provider);
    assert.deepEqual(await f.handler(f.event, f.request), { ok: true });
    assert.deepEqual(f.opened, [f.request.authorizationUrl]); assert.equal(f.requests.length, 1);
    const url = new URL(f.requests[0].url);
    assert.equal(url.origin, 'https://canvas.example');
    assert.equal(url.pathname, provider === 'mcp' ? `/api/mcp/shared-connections/${encodeURIComponent(ref)}/oauth/desktop`
      : `/api/composio/shared-connections/${encodeURIComponent(ref)}/connect/desktop`);
    assert.deepEqual([...url.searchParams.keys()], ['state', 'workspaceId']);
    assert.equal(url.searchParams.get('state'), f.request.state); assert.equal(url.searchParams.get('workspaceId'), 'workspace-a');
    assert.equal(f.requests[0].init.method, 'GET'); assert.equal(f.requests[0].init.credentials, 'include');
    assert.equal(f.requests[0].init.redirect, 'error'); assert.equal(f.cookieReads(), 3);
    assertSharedLauncherListenersDetached(f);
  }
});

test('Composio IPC requires canonical43 state, exact ISO deadline and shared-only bounded target before network', async () => {
  const base = sharedLauncherFixture();
  for (const request of [null, [], {}, { ...base.request, state: `desktop_${'x'.repeat(32)}` },
    { ...base.request, state: 'x'.repeat(43) }, { ...base.request, expiresAt: undefined },
    { ...base.request, expiresAt: 'invalid' }, { ...base.request, expiresAt: new Date(0).toISOString() },
    { ...base.request, expiresAt: base.request.expiresAt.replace('.000Z', 'Z') + ' ' },
    { ...base.request, target: undefined }, { ...base.request, target: { ...base.request.target, kind: 'personal' } },
    { ...base.request, target: { ...base.request.target, connectionRef: 'same-name' } },
    { ...base.request, target: { ...base.request.target, workspaceId: undefined } },
    { ...base.request, target: { ...base.request.target, workspaceId: ' bad ' } },
    { ...base.request, target: { ...base.request.target, accountId: 'forbidden' } },
    { ...base.request, statusUrl: 'https://foreign.example/status' }, { ...base.request, provider: 'mcp' },
    { ...base.request, authSessionId: 'forbidden' }, { ...base.request, authorizationUrl: 'https://user:pass@provider.example/oauth' },
    { ...base.request, authorizationUrl: 'http://remote.example/oauth' }]) {
    const f = sharedLauncherFixture();
    assert.equal((await f.handler(f.event, request)).ok, false);
    assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0); assertSharedLauncherListenersDetached(f);
  }
  const mcp = sharedLauncherFixture('mcp');
  assert.equal((await mcp.handler(mcp.event, { ...mcp.request, state: base.request.state })).ok, false);
  assert.equal(mcp.requests.length, 0, 'A Composio state cannot enter personal MCP or shared MCP lookup.');
});

test('unconfirmed start, no-auth, terminal, mismatched and malformed summaries cannot open a browser', async () => {
  for (const provider of ['mcp', 'composio']) {
    const baseline = sharedLauncherFixture(provider);
    for (const data of [{ connectionRef: ref, noAuth: true },
      ...['starting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed'].map(status => ({ ...baseline.waiting, status })),
      { ...baseline.waiting, connectionRef: `${ref}x` }, { ...baseline.waiting, state: 'different' },
      { ...baseline.waiting, authorizationUrl: `${baseline.waiting.authorizationUrl}&different=1` },
      { ...baseline.waiting, expiresAt: new Date(Date.parse(baseline.waiting.expiresAt) + 1).toISOString() },
      { ...baseline.waiting, credentialRevision: 'forbidden' }, { ...baseline.waiting, expiresAt: 'invalid' }]) {
      const f = sharedLauncherFixture(provider, { response: Response.json({ success: true, data }) });
      assert.equal((await f.handler(f.event, { ...f.request, expiresAt: baseline.request.expiresAt })).ok, false);
      assert.equal(f.opened.length, 0); assertSharedLauncherListenersDetached(f);
    }
  }
});

test('cookie/session and main-frame ABA during awaited lookup stay sticky for both shared providers', async () => {
  for (const provider of ['mcp', 'composio']) for (const change of [
    f => f.replaceCookie('controlled-session-b'),
    f => { f.replaceCookie('controlled-session-b'); f.replaceCookie('controlled-session-a'); },
    f => { f.webContents.session = { ...f.webContents.session }; },
    f => { const before = f.frame.url; f.navigate('https://canvas.example/en/plugins?workspaceId=workspace-b'); f.navigate(before); },
    f => f.navigate(f.frame.url, true, true),
    f => { f.webContents.mainFrame = { url: f.frame.url }; },
    f => f.setConfiguredUrl('https://other.example'),
    f => f.setWindow({ ...f.browserWindow }),
    f => f.webContents.emit('destroyed'),
  ]) {
    const hold = deferredSharedLauncherResponse(), f = sharedLauncherFixture(provider, { response: () => hold.promise });
    const pending = f.handler(f.event, f.request); await f.statusRequested.promise;
    change(f); hold.resolve(Response.json({ success: true, data: f.waiting }));
    assert.equal((await pending).ok, false); assert.equal(f.opened.length, 0); assertSharedLauncherListenersDetached(f);
  }
});

test('subframe navigation, foreign cookies and identical auth-cookie expiry refresh preserve shared authority', async () => {
  for (const provider of ['mcp', 'composio']) {
    const hold = deferredSharedLauncherResponse(), f = sharedLauncherFixture(provider, { response: () => hold.promise });
    const pending = f.handler(f.event, f.request); await f.statusRequested.promise;
    f.navigate('https://foreign.example/subframe', false); f.navigate('https://foreign.example/subframe', false, true);
    f.cookies.emit('changed', {}, { name: '__Host-better-auth.session_token', domain: 'foreign.example', path: '/', value: 'different' }, 'explicit', false);
    f.replaceCookie('controlled-session-a', 'overwrite', true); f.replaceCookie('controlled-session-a', 'inserted');
    hold.resolve(Response.json({ success: true, data: f.waiting }));
    assert.equal((await pending).ok, true); assert.equal(f.opened.length, 1); assertSharedLauncherListenersDetached(f);
  }
});

test('expiry after the last cookie-read await prevents opening without replacing the real clock', async () => {
  const f = sharedLauncherFixture('composio', { lifetime: 300 }), originalGet = f.cookies.get;
  let reads = 0, beforeOpenReadReached = false;
  f.cookies.get = async () => {
    if (++reads === 2) {
      assert(Date.now() < Date.parse(f.request.expiresAt)); beforeOpenReadReached = true;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(f.request.expiresAt) - Date.now() + 10)));
    }
    return originalGet();
  };
  assert.equal((await f.handler(f.event, f.request)).ok, false); assert.equal(beforeOpenReadReached, true);
  assert.equal(f.opened.length, 0); assertSharedLauncherListenersDetached(f);
});

test('cookie/frame identity replacement during the real opener promise cannot produce a successful ACK', async () => {
  for (const provider of ['mcp', 'composio']) for (const change of [
    f => { f.replaceCookie('controlled-session-b'); f.replaceCookie('controlled-session-a'); },
    f => { const before = f.frame.url; f.navigate('https://canvas.example/en/plugins?workspaceId=b'); f.navigate(before); },
    f => f.replaceCookie('controlled-session-b', 'explicit', false, false),
  ]) {
    const entered = deferredSharedLauncherResponse(), ack = deferredSharedLauncherResponse();
    const f = sharedLauncherFixture(provider, { openExternal: () => { entered.resolve(); return ack.promise; } });
    const pending = f.handler(f.event, f.request); await entered.promise;
    assert.equal(f.opened.length, 1, 'The controlled opener has already been invoked; a failed ACK cannot undo that effect.');
    change(f); ack.resolve(); assert.equal((await pending).ok, false); assert.equal(f.opened.length, 1);
    assertSharedLauncherListenersDetached(f);
  }
});

test('expiry during opener ACK is truthful even after the controlled open effect', async () => {
  const f = sharedLauncherFixture('composio', { lifetime: 300, openExternal: async () => {
    assert(Date.now() < Date.parse(f.request.expiresAt));
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(f.request.expiresAt) - Date.now() + 10)));
  } });
  assert.equal((await f.handler(f.event, f.request)).ok, false); assert.equal(f.opened.length, 1);
  assertSharedLauncherListenersDetached(f);
});

test('only concurrent identical full-tuple requests share one lookup/open; settled success never caches identity', async () => {
  for (const provider of ['mcp', 'composio']) {
    const hold = deferredSharedLauncherResponse(), f = sharedLauncherFixture(provider, { response: () => hold.promise });
    const first = f.handler(f.event, f.request), second = f.handler(f.event, { ...f.request, target: { ...f.request.target } });
    await f.statusRequested.promise; assert.equal(f.requests.length, 1);
    hold.resolve(Response.json({ success: true, data: f.waiting }));
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
    assert.equal(f.opened.length, 1); assertSharedLauncherListenersDetached(f);
    f.replaceCookie('controlled-session-b'); f.setResponse(Response.json({ success: false }, { status: 403 }));
    assert.equal((await f.handler(f.event, f.request)).ok, false);
    assert.equal(f.requests.length, 2); assert.equal(f.opened.length, 1); assertSharedLauncherListenersDetached(f);
  }
});

test('transport, cookie, malformed JSON and opener failures detach all watchers and hide raw errors', async () => {
  for (const configure of [
    f => { f.cookies.get = async () => { throw new Error('PRIVATE_COOKIE_VALUE'); }; },
    f => { f.webContents.session.fetch = async () => { throw new Error('PRIVATE_FETCH_VALUE'); }; },
    f => f.setResponse(new Response('PRIVATE_NON_JSON_VALUE')),
    f => f.setResponse(Response.json({ success: false, error: 'PRIVATE_BODY_VALUE' })),
  ]) {
    const f = sharedLauncherFixture(); configure(f);
    const result = await f.handler(f.event, f.request); assert.equal(result.ok, false); assert.doesNotMatch(result.error, /PRIVATE_/u);
    assert.equal(f.opened.length, 0); assertSharedLauncherListenersDetached(f);
  }
  const f = sharedLauncherFixture('composio', { openExternal: async () => { throw new Error('PRIVATE_OPEN_VALUE'); } });
  const result = await f.handler(f.event, f.request); assert.equal(result.ok, false); assert.doesNotMatch(result.error, /PRIVATE_/u);
  assertSharedLauncherListenersDetached(f);
});

test('preload advertises the Composio version and routes its shared-only payload to its own narrow IPC', async () => {
  const f = sharedLauncherFixture(), channels = [];
  let bridge;
  vm.runInNewContext(await readFile(new URL('../preload/index.cjs', import.meta.url), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'canvasDesktop'); bridge = value; } },
    ipcRenderer: { invoke: (channel, value) => { channels.push(channel); return f.handler(f.event, value); } },
  }) });
  assert.equal(bridge.sharedMcpOAuthVersion, 1); assert.equal(bridge.sharedComposioOAuthVersion, 1);
  assert.equal((await bridge.openSharedComposioOAuth(f.request)).ok, true);
  assert.deepEqual(channels, ['desktop:open-shared-composio-oauth']); assert.equal(f.opened.length, 1);
  assertSharedLauncherListenersDetached(f);
});
