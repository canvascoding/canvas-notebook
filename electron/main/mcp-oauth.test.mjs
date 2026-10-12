import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { createMcpOAuthLauncher } from './mcp-oauth.mjs';

const state = `desktop_${'x'.repeat(32)}`;
const authorizationUrl = `https://provider.example/authorize?state=${state}&client_id=canvas`;

function fixture({ serverUrl = 'https://canvas.example', response, allowLoopbackHttp = false } = {}) {
  const opened = [];
  const requests = [];
  const frame = { url: `${serverUrl}/settings?tab=integrations` };
  const cookies = new EventEmitter();
  const initialCookie = { name: '__Host-better-auth.session_token', domain: new URL(serverUrl).hostname,
    hostOnly: true, path: '/', value: 'fixture-session-only' };
  let jar = [{ ...initialCookie }];
  cookies.get = async () => jar.map(cookie => ({ ...cookie }));
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    session: { cookies, fetch: async (url, options) => {
      requests.push({ url, options });
      return typeof response === 'function' ? response() : response ?? Response.json({
        success: true, data: { status: 'waiting', authorizationUrl },
      });
    } },
  });
  const browserWindow = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  let configuredUrl = serverUrl;
  let currentWindow = browserWindow;
  const handler = createMcpOAuthLauncher({
    getMainWindow: () => currentWindow,
    getConfiguredServerUrl: () => configuredUrl,
    openExternal: async url => { opened.push(url); },
    allowLoopbackHttp,
  });
  return { handler, event, opened, requests, frame, webContents, browserWindow, cookies,
    replaceCookie: (value, cause = 'explicit', removed = false) => {
      const cookie = { ...initialCookie, value };
      jar = removed ? [] : [cookie];
      cookies.emit('changed', {}, cookie, cause, removed);
    },
    setConfiguredUrl: value => { configuredUrl = value; },
    setWindow: value => { currentWindow = value; },
  };
}

test('opens the exact pending authorization URL verified with the Canvas session', async () => {
  const f = fixture();
  assert.deepEqual(await f.handler(f.event, { state, authorizationUrl }), { ok: true });
  assert.deepEqual(f.opened, [authorizationUrl]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, `https://canvas.example/api/mcp/oauth/desktop?state=${state}`);
  assert.equal(f.requests[0].options.credentials, 'include');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.method, 'GET');
});

test('rejects other windows, subframes, setup, foreign origins, and destroyed windows before requests', async () => {
  for (const modify of [
    f => { f.event.sender = {}; },
    f => { f.event.senderFrame = { url: f.frame.url }; },
    f => { f.frame.url = 'file:///desktop/setup.html'; },
    f => { f.frame.url = 'https://canvas.example.evil/settings'; },
    f => { f.browserWindow.isDestroyed = () => true; },
    f => { f.webContents.isDestroyed = () => true; },
    f => { f.setWindow(null); },
  ]) {
    const f = fixture();
    modify(f);
    assert.equal((await f.handler(f.event, { state, authorizationUrl })).ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.opened.length, 0);
  }
});

test('rejects unsafe targets and malformed states before network or browser actions', async () => {
  for (const target of [
    'javascript:alert(1)', 'file:///tmp/secret', 'mailto:somebody@example.com',
    'http://provider.example/authorize', 'http://localhost:5000/authorize',
    'https://user:password@provider.example/authorize', ' https://provider.example/authorize',
    'https://provider.example/authorize\n', `https://provider.example/${'x'.repeat(16_384)}`,
  ]) {
    const f = fixture();
    assert.equal((await f.handler(f.event, { state, authorizationUrl: target })).ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.opened.length, 0);
  }
  for (const request of [null, [], {}, { state: 'browser-state', authorizationUrl },
    { state: `${state}&other=value`, authorizationUrl }, { state: `desktop_${'x'.repeat(31)}`, authorizationUrl }]) {
    const f = fixture();
    assert.equal((await f.handler(f.event, request)).ok, false);
    assert.equal(f.requests.length, 0);
  }
});

test('permits HTTP only for loopback development and still binds the exact server response', async () => {
  const localUrl = `http://127.0.0.1:4000/authorize?state=${state}`;
  const f = fixture({ serverUrl: 'http://localhost:3000', allowLoopbackHttp: true,
    response: Response.json({ success: true, data: { status: 'waiting', authorizationUrl: localUrl } }) });
  assert.equal((await f.handler(f.event, { state, authorizationUrl: localUrl })).ok, true);
  assert.deepEqual(f.opened, [localUrl]);
  const remote = fixture({ serverUrl: 'http://private.example:3000', allowLoopbackHttp: true });
  assert.equal((await remote.handler(remote.event, { state, authorizationUrl })).ok, false);
  assert.equal(remote.requests.length, 0);
  const target = fixture({ allowLoopbackHttp: true });
  assert.equal((await target.handler(target.event, { state, authorizationUrl: 'http://192.168.1.2/authorize' })).ok, false);
  assert.equal(target.requests.length, 0);
});

test('refuses changed, completed, expired, denied, unauthenticated, and invalid server transactions', async () => {
  for (const response of [
    Response.json({ success: true, data: { status: 'waiting', authorizationUrl: `${authorizationUrl}&scope=other` } }),
    ...['callback_received', 'completed', 'expired', 'cancelled', 'failed'].map(status => Response.json({ success: true, data: { status, authorizationUrl } })),
    Response.json({ success: false, error: 'private upstream secret' }),
    Response.json({ success: true, data: { status: 'waiting', authorizationUrl } }, { status: 401 }),
    new Response('provider error', { status: 503 }), new Response('<html>login</html>'),
  ]) {
    const f = fixture({ response });
    const result = await f.handler(f.event, { state, authorizationUrl });
    assert.equal(result.ok, false);
    assert.equal(f.opened.length, 0);
    assert.doesNotMatch(result.error, /private upstream secret|provider error/u);
  }
  const failedFetch = fixture({ response: () => { throw new Error('private network information'); } });
  const result = await failedFetch.handler(failedFetch.event, { state, authorizationUrl });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /private network information/u);
  assert.equal(failedFetch.opened.length, 0);
});

test('rechecks the window, sender frame, and configured server after authenticated lookup', async () => {
  for (const alter of [
    f => { f.frame.url = 'https://foreign.example'; },
    f => { f.setConfiguredUrl('https://other.example'); },
    f => { f.setWindow({ webContents: f.webContents, isDestroyed: () => false }); },
    f => { f.webContents.mainFrame = { url: f.frame.url }; },
  ]) {
    let f;
    f = fixture({ response: () => {
      alter(f);
      return Response.json({ success: true, data: { status: 'waiting', authorizationUrl } });
    } });
    assert.equal((await f.handler(f.event, { state, authorizationUrl })).ok, false);
    assert.equal(f.opened.length, 0);
  }
});

test('preload exposes the narrow OAuth request through its IPC channel without broadening setup links', async () => {
  const f = fixture();
  let bridge;
  const channels = [];
  const context = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'canvasDesktop'); bridge = value; } },
      ipcRenderer: { invoke: async (channel, payload) => {
        channels.push(channel);
        assert.equal(channel, 'desktop:open-mcp-oauth');
        return f.handler(f.event, payload);
      } },
    }),
  };
  vm.runInNewContext(await readFile(new URL('../preload/index.cjs', import.meta.url), 'utf8'), context);
  assert.equal(bridge.sharedMcpOAuthVersion, 1, 'shared support is explicitly versioned; old bridges lack this flag');
  assert.equal((await bridge.openMcpOAuth({ state, authorizationUrl })).ok, true);
  assert.deepEqual(channels, ['desktop:open-mcp-oauth']);
  assert.deepEqual(f.opened, [authorizationUrl]);
  assert.equal(typeof bridge.openExternal, 'function');
});

const connectionRef = 'canvas-connection:11111111-2222-4333-8444-555555555555';
const target = { kind: 'shared', connectionRef, workspaceId: 'exact-team-workspace' };
const expiresAt = new Date(Date.now() + 600_000).toISOString();

test('shared targets use only the configured exact-reference status route and current session', async () => {
  for (const workspaceId of ['exact-team-workspace', null]) {
    const f = fixture({ response: Response.json({ success: true, data: { connectionRef, state, status: 'waiting', expiresAt, authorizationUrl } }) });
    assert.equal((await f.handler(f.event, { state, authorizationUrl, target: { ...target, workspaceId } })).ok, true);
    const url = new URL(f.requests[0].url);
    assert.equal(url.origin, 'https://canvas.example');
    assert.equal(url.pathname, `/api/mcp/shared-connections/${encodeURIComponent(connectionRef)}/oauth/desktop`);
    assert.equal(url.searchParams.get('workspaceId'), workspaceId);
    assert.equal(url.searchParams.get('state'), state);
    assert.deepEqual(f.opened, [authorizationUrl]);
    assert.equal(f.cookies.listenerCount('changed'), 0);
  }
});

test('shared malformed targets never fall back to personal status or caller-selected paths', async () => {
  for (const bad of [null, {}, [], { ...target, kind: 'personal' }, { ...target, serverName: 'fake' },
    { ...target, connectionRef: 'by-name' }, { ...target, workspaceId: undefined },
    { ...target, workspaceId: '' }, { ...target, workspaceId: ' bad ' }, { ...target, workspaceId: 'bad\0scope' },
    { ...target, statusUrl: 'https://foreign.example/api' }]) {
    const f = fixture();
    assert.equal((await f.handler(f.event, { state, authorizationUrl, target: bad })).ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(f.cookies.listenerCount('changed'), 0);
  }
});

test('shared status must match exact state, reference, URL, waiting status and unexpired deadline', async () => {
  const summary = { connectionRef, state, status: 'waiting', expiresAt, authorizationUrl };
  for (const data of [{ ...summary, connectionRef: `${connectionRef}x` }, { ...summary, state: `desktop_${'y'.repeat(32)}` },
    { ...summary, expiresAt: 'invalid' }, { ...summary, expiresAt: new Date(0).toISOString() },
    { ...summary, status: 'callback_received' }, { ...summary, authorizationUrl: `${authorizationUrl}&changed=1` },
    { status: 'waiting', authorizationUrl }]) {
    const f = fixture({ response: Response.json({ success: true, data }) });
    assert.equal((await f.handler(f.event, { state, authorizationUrl, target })).ok, false);
    assert.equal(f.opened.length, 0);
    assert.equal(f.cookies.listenerCount('changed'), 0);
  }
});

test('shared cookie/session/SPA workspace changes during awaited status, including A→B→A, prevent opening', async () => {
  for (const change of [
    f => f.replaceCookie('replacement-session'),
    f => { f.replaceCookie('replacement-session'); f.replaceCookie('fixture-session-only'); },
    f => f.replaceCookie('fixture-session-only', 'explicit', true),
    f => { f.webContents.session = { ...f.webContents.session }; },
    f => { f.frame.url = 'https://canvas.example/en/plugins?workspaceId=replacement-workspace'; },
  ]) {
    let release;
    const response = new Promise(resolve => { release = resolve; });
    const f = fixture({ response: () => response });
    const pending = f.handler(f.event, { state, authorizationUrl, target });
    // Observe actual dispatch after the initial Cookie.get promise settles.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
    change(f);
    release(Response.json({ success: true, data: { connectionRef, state, status: 'waiting', expiresAt, authorizationUrl } }));
    assert.equal((await pending).ok, false);
    assert.equal(f.opened.length, 0);
    assert.equal(f.cookies.listenerCount('changed'), 0);
  }
  let personal;
  personal = fixture({ response: () => {
    personal.frame.url = 'https://canvas.example/settings?tab=integrations&same-origin=legacy';
    return Response.json({ success: true, data: { status: 'waiting', authorizationUrl } });
  } });
  assert.equal((await personal.handler(personal.event, { state, authorizationUrl })).ok, true,
    'existing personal launcher retains its same-origin navigation semantics');
});

test('shared same-value cookie refresh is compatible; foreign cookies do not replace Canvas authority', async () => {
  let f;
  f = fixture({ response: () => {
    f.cookies.emit('changed', {}, { name: '__Host-better-auth.session_token', domain: 'foreign.example', path: '/', value: 'other' }, 'explicit', false);
    f.replaceCookie('fixture-session-only', 'overwrite', true);
    f.replaceCookie('fixture-session-only', 'inserted-no-value-change-overwrite');
    return Response.json({ success: true, data: { connectionRef, state, status: 'waiting', expiresAt, authorizationUrl } });
  } });
  assert.equal((await f.handler(f.event, { state, authorizationUrl, target })).ok, true);
  assert.equal(f.cookies.listenerCount('changed'), 0);
  const unsupported = fixture();
  delete unsupported.webContents.session.cookies;
  assert.equal((await unsupported.handler(unsupported.event, { state, authorizationUrl, target })).ok, false);
  assert.equal(unsupported.requests.length, 0);
  // The existing personal launcher still works without the added Shared cookie facility.
  assert.equal((await unsupported.handler(unsupported.event, { state, authorizationUrl })).ok, true);
});

test('shared cookie readback detects missed identity events and always releases listeners on failures', async () => {
  const missedEvent = fixture({ response: Response.json({ success: true, data: { connectionRef, state, status: 'waiting', expiresAt, authorizationUrl } }) });
  let reads = 0;
  missedEvent.cookies.get = async () => [{ name: '__Host-better-auth.session_token', domain: 'canvas.example', path: '/',
    value: ++reads === 1 ? 'fixture-session-only' : 'replacement-session' }];
  assert.equal((await missedEvent.handler(missedEvent.event, { state, authorizationUrl, target })).ok, false);
  assert.equal(missedEvent.opened.length, 0);
  assert.equal(missedEvent.cookies.listenerCount('changed'), 0);
  for (const configure of [
    f => { f.cookies.get = async () => { throw new Error('PRIVATE_COOKIE_ERROR'); }; },
    f => { f.cookies.get = async () => []; },
    f => { f.webContents.session.fetch = async () => { throw new Error('PRIVATE_FETCH_ERROR'); }; },
  ]) {
    const f = fixture(); configure(f);
    const result = await f.handler(f.event, { state, authorizationUrl, target });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /PRIVATE_/u);
    assert.equal(f.opened.length, 0);
    assert.equal(f.cookies.listenerCount('changed'), 0);
  }
});
