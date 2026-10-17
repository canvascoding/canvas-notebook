import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

import proxy from '../proxy';
import { handleHtmlPreviewBoundary } from '../server/html-preview-boundary';

async function main(): Promise<void> {
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  const flow = randomBytes(32).toString('base64url');
  const callback = `/api/composio/callback?flow=${flow}`;
  const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

  for (const query of ['', '&status=success&connected_account_id=ca_owned', '&status=failed', '&error=access_denied']) {
    for (const metadata of [{}, navigation]) {
      for (const cookie of ['', 'better-auth.session_token=fixture']) {
        const response = await proxy(new NextRequest(`https://app.example.test${callback}${query}`, {
          headers: { host: 'app.example.test', ...metadata, ...(cookie ? { cookie } : {}) },
        }));
        assert.equal(response.headers.get('x-middleware-next'), '1', 'provider return reaches its single-use state validator without a browser session');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      }
    }
  }

  const denied = [
    { path: callback, method: 'POST' },
    { path: callback, method: 'HEAD' },
    { path: callback, headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } },
    { path: callback, headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } },
    { path: '/api/composio/callback' },
    { path: '/api/composio/callback?flow=invalid' },
    { path: `${callback}&flow=${flow}` },
    { path: `/api/composio/callback/extra?flow=${flow}` },
    { path: `/api/composio/shared/callback?flow=${flow}` },
    { path: '/api/composio/connections' },
    { path: '/api/composio/connect/canva', method: 'POST' },
    { path: '/api/mobile/v1/integrations/composio/connections', method: 'POST' },
  ];
  for (const scenario of denied) {
    const response = await proxy(new NextRequest(`https://app.example.test${scenario.path}`, {
      method: scenario.method || 'GET', headers: { host: 'app.example.test', ...navigation, ...scenario.headers },
    }));
    assert.equal(response.status, 401, `${scenario.path} remains session protected`);
  }

  // Exercise both admission layers together, as the custom Node server does.
  const server = http.createServer((request, response) => {
    if (handleHtmlPreviewBoundary(request, response)) return;
    void (async () => {
      const result = await proxy(new NextRequest(`https://app.example.test${request.url}`, {
        method: request.method, headers: request.headers as Record<string, string>,
      }));
      const admitted = result.headers.get('x-middleware-next') === '1';
      response.writeHead(admitted ? 204 : result.status, Object.fromEntries(result.headers));
      response.end();
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const send = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: address.port,
      path: `${callback}&status=success&connected_account_id=ca_owned`, headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode || 0));
    });
    request.once('error', reject);
  });
  try {
    for (const cookie of ['', 'better-auth.session_token=fixture']) {
      const headers = { host: 'app.example.test', ...navigation, 'sec-fetch-site': 'cross-site', ...(cookie ? { cookie } : {}) };
      assert.equal(await send(headers), 204);
      for (const origin of ['null', 'https://preview.app.example.test']) {
        assert.equal(await send({ ...headers, origin }), 403);
      }
      assert.equal(await send({ ...headers, host: 'preview.app.example.test' }), 404);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log('composio-oauth-callback-boundary-test: PASS (cookie-independent personal return, privacy headers, protected APIs and preview isolation)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
