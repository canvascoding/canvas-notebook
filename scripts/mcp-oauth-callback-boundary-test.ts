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
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const cookie = { cookie: '__Host-better-auth.session_token=fixture' };
  const desktop = await proxy(new NextRequest(`https://app.example.test${desktopPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(desktop.headers.get('x-middleware-next'), '1', 'cookie-independent desktop callback reaches its state validator');
  assert.equal(desktop.headers.get('Referrer-Policy'), 'no-referrer');
  const browser = await proxy(new NextRequest(`https://app.example.test${browserPath}`, { headers: { host: 'app.example.test', ...navigation } }));
  assert.equal(browser.status, 401, 'ordinary browser callback still requires a Canvas session cookie');
  const browserSignedIn = await proxy(new NextRequest(`https://app.example.test${browserPath}`, { headers: { host: 'app.example.test', ...navigation, ...cookie } }));
  assert.equal(browserSignedIn.headers.get('x-middleware-next'), '1');
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
    console.log('mcp-oauth-callback-boundary-test: PASS (exact desktop GET exception, ordinary browser authentication, no iframe/subresource/preview bypass, other-account browser cookie)');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
