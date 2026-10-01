import assert from 'node:assert/strict';
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
  const webContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    session: { fetch: async (url, options) => {
      requests.push({ url, options });
      return typeof response === 'function' ? response() : response ?? Response.json({
        success: true, data: { status: 'waiting', authorizationUrl },
      });
    } },
  };
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
  return { handler, event, opened, requests, frame, webContents, browserWindow,
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
  assert.equal((await bridge.openMcpOAuth({ state, authorizationUrl })).ok, true);
  assert.deepEqual(channels, ['desktop:open-mcp-oauth']);
  assert.deepEqual(f.opened, [authorizationUrl]);
  assert.equal(typeof bridge.openExternal, 'function');
});
