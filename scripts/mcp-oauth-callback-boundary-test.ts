import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';

import { handleHtmlPreviewBoundary } from '../server/html-preview-boundary';

async function main(): Promise<void> {
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  const { default: proxy } = await import('../proxy');
  const nonce = 'a'.repeat(32);
  const desktopPath = `/api/mcp/oauth/callback?state=desktop_${nonce}&code=fixture-code`;
  const browserPath = `/api/mcp/oauth/callback?state=${nonce}&code=fixture-code`;
  const sharedPath = `/api/mcp/shared-connections/oauth/callback?state=${nonce}&code=fixture-code`;
  const sharedComposioPath = `/api/composio/shared/callback?flow=${'b'.repeat(43)}`;
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const cookie = { cookie: '__Host-better-auth.session_token=fixture' };
  const desktop = await proxy(new NextRequest(`https://app.example.test${desktopPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(desktop.headers.get('x-middleware-next'), '1', 'cookie-independent desktop callback reaches its state validator');
  assert.equal(desktop.headers.get('Referrer-Policy'), 'no-referrer');
  const browser = await proxy(new NextRequest(`https://app.example.test${browserPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(browser.status, 401, 'ordinary browser callback still requires a Canvas session cookie');
  const browserSignedIn = await proxy(new NextRequest(`https://app.example.test${browserPath}`, { headers: { host: 'app.example.test', ...navigation, ...cookie } }));
  assert.equal(browserSignedIn.headers.get('x-middleware-next'), '1');
  const sharedUnsigned = await proxy(new NextRequest(`https://app.example.test${sharedPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(sharedUnsigned.status, 401, 'shared browser callback still requires a Canvas session cookie');
  const sharedSignedIn = await proxy(new NextRequest(`https://app.example.test${sharedPath}`, { headers: { host: 'app.example.test', ...navigation, ...cookie } }));
  assert.equal(sharedSignedIn.headers.get('x-middleware-next'), '1', 'signed-in shared callback reaches its current actor/state validator');
  const composioUnsigned = await proxy(new NextRequest(`https://app.example.test${sharedComposioPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(composioUnsigned.status, 401, 'shared Composio browser return still requires a Canvas session cookie');
  const composioSignedIn = await proxy(new NextRequest(`https://app.example.test${sharedComposioPath}`, { headers: { host: 'app.example.test', ...navigation, ...cookie } }));
  assert.equal(composioSignedIn.headers.get('x-middleware-next'), '1', 'signed-in shared Composio return reaches its stored flow validator');
  for (const scenario of [
    { path: '/api/mcp/oauth/desktop?state=desktop_' + nonce, method: 'GET', metadata: navigation },
    { path: desktopPath, method: 'POST', metadata: navigation },
    { path: desktopPath, method: 'GET', metadata: { ...navigation, 'sec-fetch-dest': 'iframe' } },
    { path: desktopPath, method: 'GET', metadata: { ...navigation, 'sec-fetch-mode': 'cors' } },
    { path: '/api/mcp/oauth/callback?state=desktop_invalid', method: 'GET', metadata: navigation },
    { path: '/api/mcp/oauth/callback/extra?state=desktop_' + nonce, method: 'GET', metadata: navigation },
  ]) {
    const denied = await proxy(new NextRequest(`https://app.example.test${scenario.path}`, { method: scenario.method, headers: { host: 'app.example.test', ...scenario.metadata } }));
    assert.equal(denied.status, 401, `${scenario.method} ${scenario.path} is not a public desktop callback`);
  }

  const server = http.createServer((req, res) => {
    if (handleHtmlPreviewBoundary(req, res)) return;
    res.writeHead(200);
    res.end('state-validator');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const send = (route: string, metadata: Record<string, string>, method = 'GET') => new Promise<number>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${address.port}${route}`, { method, headers: { host: 'app.example.test', ...cookie, ...navigation, ...metadata } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject);
    req.end();
  });
  try {
    assert.equal(await send(desktopPath, {}), 200, 'an unrelated browser cookie does not block desktop state validation');
    assert.equal(await send(browserPath, {}), 200, 'signed-in browser document callback still reaches its authenticated handler');
    const deniedMetadata: Array<Record<string, string>> = [{ 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-mode': 'cors' }, { origin: 'https://preview.app.example.test' }, { origin: 'null' }];
    for (const metadata of deniedMetadata) {
      assert.equal(await send(desktopPath, metadata), 403, 'untrusted previews and subresources stay blocked');
    }
    assert.equal(await send(desktopPath, {}, 'POST'), 403);
    assert.equal(await send('/api/mcp/oauth/desktop?state=desktop_' + nonce, {}), 403);
    assert.equal(await send('/api/mcp/oauth/callback?state=desktop_invalid', {}), 403);
    assert.equal(await send(desktopPath, { host: 'preview.app.example.test' }), 404);
    const sharedDenied: Array<{ path: string; method: string; metadata: Record<string, string> }> = [
      { path: sharedPath, method: 'POST', metadata: {} },
      { path: sharedPath, method: 'HEAD', metadata: {} },
      { path: '/api/mcp/shared-connections/oauth/callback?state=invalid&code=fixture-code', method: 'GET', metadata: {} },
      { path: '/api/mcp/shared-connections/oauth/callback?code=fixture-code', method: 'GET', metadata: {} },
      { path: `/api/mcp/shared-connections/oauth/callback?state=desktop_${nonce}&code=fixture-code`, method: 'GET', metadata: {} },
      { path: `/api/mcp/shared-connections/oauth/callback/extra?state=${nonce}&code=fixture-code`, method: 'GET', metadata: {} },
      { path: sharedPath, method: 'GET', metadata: { 'sec-fetch-dest': 'iframe' } },
      { path: sharedPath, method: 'GET', metadata: { 'sec-fetch-mode': 'cors' } },
      { path: sharedPath, method: 'GET', metadata: { origin: 'https://preview.app.example.test' } },
      { path: sharedPath, method: 'GET', metadata: { origin: 'null' } },
      { path: '/api/mcp/shared-connections', method: 'GET', metadata: {} },
      { path: '/api/files', method: 'GET', metadata: {} },
    ];
    for (const scenario of sharedDenied) {
      for (const site of ['cross-site', 'same-site']) {
        assert.equal(await send(scenario.path, { ...scenario.metadata, 'sec-fetch-site': site }, scenario.method), 403,
          'shared callback exceptions must not allow other methods, invalid states, suffixes, preview sources or ordinary APIs');
      }
    }
    assert.equal(await send(sharedPath, { host: 'preview.app.example.test' }), 404, 'preview hosts never expose the shared callback');
    console.log('mcp-oauth-callback-boundary-test: shared negative matrix PASS (authenticated proxy, exact method/state/path/navigation and preview isolation)');
    for (const site of ['cross-site', 'same-site']) {
      assert.equal(await send(sharedPath, { 'sec-fetch-site': site }), 200,
        'signed-in shared browser document callback must reach its current actor/state validator');
    }
    const composioDenied: Array<{ path: string; method: string; metadata: Record<string, string> }> = [
      { path: sharedComposioPath, method: 'POST', metadata: {} },
      { path: sharedComposioPath, method: 'HEAD', metadata: {} },
      { path: '/api/composio/shared/callback?flow=invalid', method: 'GET', metadata: {} },
      { path: '/api/composio/shared/callback', method: 'GET', metadata: {} },
      { path: `/api/composio/shared/callback?flow=desktop_${'b'.repeat(43)}`, method: 'GET', metadata: {} },
      { path: `/api/composio/shared/callback/extra?flow=${'b'.repeat(43)}`, method: 'GET', metadata: {} },
      { path: sharedComposioPath, method: 'GET', metadata: { 'sec-fetch-dest': 'iframe' } },
      { path: sharedComposioPath, method: 'GET', metadata: { 'sec-fetch-mode': 'cors' } },
      { path: sharedComposioPath, method: 'GET', metadata: { origin: 'https://preview.app.example.test' } },
      { path: sharedComposioPath, method: 'GET', metadata: { origin: 'null' } },
      { path: '/api/composio/shared-connections', method: 'GET', metadata: {} },
    ];
    for (const scenario of composioDenied) {
      for (const site of ['cross-site', 'same-site']) {
        assert.equal(await send(scenario.path, { ...scenario.metadata, 'sec-fetch-site': site }, scenario.method), 403,
          'shared Composio return exceptions stay confined to exact opaque-flow document GETs');
      }
    }
    assert.equal(await send(sharedComposioPath, { host: 'preview.app.example.test' }), 404, 'preview hosts never expose shared Composio callbacks');
    console.log('mcp-oauth-callback-boundary-test: shared Composio negative matrix PASS (cookie-gated proxy, exact flow/path/method and preview isolation)');
    for (const site of ['cross-site', 'same-site']) {
      assert.equal(await send(sharedComposioPath, { 'sec-fetch-site': site }), 200,
        'shared Composio browser document return must reach the stored flow validator');
      assert.equal(await send(sharedComposioPath, { 'sec-fetch-site': site, 'sec-fetch-mode': '', 'sec-fetch-dest': '' }), 200,
        'missing fetch-navigation metadata retains the exact shared Composio flow exception');
    }
    console.log('mcp-oauth-callback-boundary-test: PASS (personal desktop/browser preserved, exact authenticated shared GET, no iframe/subresource/preview or ordinary API bypass)');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
