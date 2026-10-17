import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/dist/experimental/testing/server/middleware-testing-utils';

/** Actual static proxy matcher and bounded POST denials. No database, valid
 * session, HTTP server or successful document-read authority is simulated. */
async function main(): Promise<void> {
  const { config } = await import('../proxy');
  const matches = (pathname: string) => unstable_doesMiddlewareMatch({ config, url: `http://localhost:3000${pathname}` });
  assert.equal(matches('/api/documents/read'), false);
  assert.equal(matches('/api/documents/read?selection=1'), false);
  for (const pathname of ['/api/documents/read/extra', '/api/documents/read-extra', '/api/documents/reader',
    '/api/documents', '/api/files', '/api/agents', '/api/mobile/v1/bootstrap']) {
    assert.equal(matches(pathname), true, `${pathname}: neighboring routes retain their existing proxy guard`);
  }

  const { POST } = await import('../app/api/documents/read/route');
  const { applyRateLimit } = await import('../app/lib/api/route-helpers');
  const request = (body: string) => new NextRequest('http://localhost:3000/api/documents/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const headers = (response: Response) => {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  };
  for (const [body, status, code] of [['{broken', 400, 'INVALID_REQUEST'],
    [' '.repeat(32 * 1024 + 1), 413, 'DOCUMENT_TOO_LARGE']] as const) {
    const response = await POST(request(body));
    assert.equal(response.status, status); headers(response);
    assert.deepEqual(await response.json(), { apiVersion: 1, success: false, code });
  }

  // Exercise the original limiter, including its Retry-After, before body/auth
  // access. The two real POST denials above already consumed two entries.
  for (let count = 2; count < 120; count++) {
    assert.equal(applyRateLimit(request(''), { limit: 120, windowMs: 60_000, keyPrefix: 'documents-read-v1' }), null);
  }
  const limited = await POST(request('')); headers(limited);
  assert.equal(limited.status, 429); assert.match(limited.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/u);
  assert.deepEqual(await limited.json(), { success: false, error: 'Too many requests' });
  console.log('Document read HTTP boundary: exact matcher, protected neighbors, bounded actual POST errors and original rate-limit denial passed. No session/PG/transport acceptance claim.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
