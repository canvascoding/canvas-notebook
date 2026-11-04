import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

async function main() {
  const previous = process.env.BETTER_AUTH_BASE_URL;
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  try {
    const { default: middleware } = await import('../proxy');
    const request = (method: string, pathname: string, key: string | null = 'candidate-only-not-a-valid-key', host = 'app.example.test') =>
      new NextRequest(`https://${host}${pathname}`, { method, headers: { host, ...(key === null ? {} : { 'X-Canvas-API-Key': key }) } });
    for (const key of ['', 'invalid', 'candidate-one,candidate-two']) {
      const response = await middleware(request('GET', '/api/workspaces', key));
      assert.equal(response.headers.get('x-middleware-next'), '1', 'A candidate must reach the actual route, not acquire authority in proxy.');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const key of [null, 'x'.repeat(4097)]) {
      const response = await middleware(request('GET', '/api/workspaces', key));
      assert.equal(response.status, 401); assert.equal(response.headers.get('x-middleware-next'), null);
    }
    for (const [method, pathname] of [['POST', '/api/workspaces'], ['PATCH', '/api/workspaces'], ['DELETE', '/api/workspaces'],
      ['GET', '/api/workspaces/'], ['GET', '/api/workspaces/foreign'], ['GET', '/api/workspaces-other'],
      ['GET', '/api/integrations/env'], ['GET', '/api/api-access/integrations'], ['GET', '/api/admin/users']]) {
      const response = await middleware(request(method, pathname));
      assert.equal(response.status, 401); assert.equal(response.headers.get('x-middleware-next'), null);
    }
    const preview = await middleware(request('GET', '/api/workspaces', 'candidate-only', 'preview.app.example.test'));
    assert.equal(preview.status, 404); assert.equal(preview.headers.get('x-middleware-next'), null);
    console.log('API-key workspace proxy: exact GET candidate delegation, real-handler responsibility, bounded headers, adjacent method/API denial and preview isolation passed; no key-authority claim.');
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = previous;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'API-key workspace proxy failed.'); process.exitCode = 1; });
