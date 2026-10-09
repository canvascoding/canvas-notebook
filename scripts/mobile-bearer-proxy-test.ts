import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

/** Tests candidate forwarding only. Actual session/seat/workspace authority belongs to each route. */
async function main(): Promise<void> {
  const originalBaseUrl = process.env.BETTER_AUTH_BASE_URL;
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  try {
    const { default: middleware } = await import('../proxy');
    const authorization = `Bearer ${'a'.repeat(48)}`;
    const request = (pathname: string, options: { method?: string; authorization?: string; cookie?: string; host?: string } = {}) => {
      const host = options.host ?? 'app.example.test';
      const headers: Record<string, string> = { host, 'X-Canvas-Workspace-Id': 'owned-workspace' };
      if (options.authorization !== undefined) headers.authorization = options.authorization;
      if (options.cookie !== undefined) headers.cookie = options.cookie;
      return new NextRequest(`https://${host}${pathname}`, { method: options.method ?? 'GET', headers });
    };
    const bootstrap = await middleware(request('/api/mobile/v1/bootstrap', { authorization }));
    console.log(`MOBILE_BEARER_PROXY_OBSERVATION ${JSON.stringify({ bootstrapStatus: bootstrap.status,
      forwarded: bootstrap.headers.get('x-middleware-next') === '1' })}`);
    assert.equal(bootstrap.headers.get('x-middleware-next'), '1', 'A bounded Mobile bearer candidate must reach actual route authentication.');
    assert.equal(bootstrap.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(bootstrap.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(bootstrap.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/u);
    assert.match(bootstrap.headers.get('x-robots-tag') ?? '', /noindex/u);

    for (const [method, pathname] of [
      ['GET', '/api/mobile/v1/sessions'], ['POST', '/api/mobile/v1/sessions/chat/mcp-apps/calls'],
      ['PATCH', '/api/mobile/v1/agents'], ['GET', '/api/mobile/v1/integrations/mcp/connections'],
    ]) {
      const response = await middleware(request(pathname, { method, authorization }));
      assert.equal(response.headers.get('x-middleware-next'), '1');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const candidate of [undefined, '', 'Basic abc', 'Bearer', 'Bearer ', 'Bearer one two', `Bearer ${'a'.repeat(4097)}`]) {
      const response = await middleware(request('/api/mobile/v1/bootstrap', { authorization: candidate }));
      assert.equal(response.status, 401, 'Missing, malformed and oversized candidates stay denied.');
      assert.equal(response.headers.get('x-middleware-next'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const pathname of ['/api/agents', '/api/files', '/api/mobile/v1', '/api/mobile/v10/bootstrap', '/api/mobile/v1-other/bootstrap']) {
      const response = await middleware(request(pathname, { authorization }));
      assert.equal(response.status, 401, 'Bearer forwarding is confined to the exact Mobile v1 slash prefix.');
      assert.equal(response.headers.get('x-middleware-next'), null);
    }
    const page = await middleware(request('/en/plugins', { authorization }));
    assert.equal(page.status, 307, 'A bearer alone does not bypass Web page login.');
    assert.equal(new URL(page.headers.get('location')!).pathname, '/en/login');

    for (const pathname of ['/api/mobile/v1/bootstrap', '/api/agents']) {
      const response = await middleware(request(pathname, { cookie: '__Host-better-auth.session_token=owned-cookie-candidate' }));
      assert.equal(response.headers.get('x-middleware-next'), '1', 'Existing cookie forwarding stays compatible.');
    }
    const ticket = 'a'.repeat(43);
    for (const mode of ['host', 'frame', 'document']) {
      const response = await middleware(request(`/__preview/${ticket}/mobile-mcp/${mode}`));
      assert.equal(response.headers.get('x-middleware-next'), '1');
      assert.equal(response.headers.has('content-security-policy'), false, 'Credential-free tickets retain route-owned CSP.');
    }
    for (const [method, pathname, host] of [
      ['POST', `/__preview/${ticket}/mobile-mcp/host`, 'app.example.test'],
      ['GET', `/__preview/${ticket}/mobile-mcp/host/extra`, 'app.example.test'],
      ['GET', '/api/mobile/v1/bootstrap', 'preview.app.example.test'],
      ['GET', '/api/agents', 'preview.app.example.test'],
    ]) {
      const response = await middleware(request(pathname, { method, host, authorization }));
      assert.equal(response.status, 404, 'Bearer candidates cannot bypass preview-host/path isolation.');
    }
    console.log('Mobile bearer proxy: actual middleware/NextRequest candidate forwarding, common headers, malformed bounds, Web denial, cookie compatibility and preview isolation passed; no session-authority claim.');
  } finally {
    if (originalBaseUrl === undefined) delete process.env.BETTER_AUTH_BASE_URL;
    else process.env.BETTER_AUTH_BASE_URL = originalBaseUrl;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
