import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

async function main() {
  const originalOrigin = process.env.BETTER_AUTH_BASE_URL;
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  try {
    const { default: middleware } = await import('../proxy');
    const request = (method: string, pathname: string, token = `Bearer ${'a'.repeat(32)}`, host = 'app.example.test') =>
      new NextRequest(`https://${host}${pathname}`, { method, headers: { host, authorization: token } });
    const scenes = [['POST', '/api/excalidraw/scenes'], ['GET', '/api/excalidraw/scenes/doc'],
      ['POST', '/api/excalidraw/scenes/doc/operations']];
    for (const [method, pathname] of scenes) {
      for (const token of [`Bearer ${'a'.repeat(32)}`, `bearer ${'a'.repeat(32)}.${'b'.repeat(43)}=`]) {
        const result = await middleware(request(method, pathname, token));
        assert.equal(result.headers.get('x-middleware-next'), '1', 'Only a bounded bearer candidate is forwarded to real route authentication.');
        assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      }
      for (const token of ['', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer one two', `Bearer ${'a'.repeat(4097)}`]) {
        const result = await middleware(request(method, pathname, token));
        assert.equal(result.status, 401);
        assert.equal(result.headers.get('x-middleware-next'), null);
      }
    }
    for (const [method, pathname] of [['GET', '/api/excalidraw/scenes'], ['PUT', '/api/excalidraw/scenes/doc'],
      ['GET', '/api/excalidraw/scenes/doc/operations'], ['POST', '/api/excalidraw/scenes-other'],
      ['GET', '/api/excalidraw/scenes/doc/extra'], ['POST', '/api/excalidraw/scenes/doc/operations/extra'],
      ['GET', `/api/excalidraw/scenes/${'a'.repeat(201)}`], ['GET', '/api/files'], ['GET', '/api/agents']]) {
      const result = await middleware(request(method, pathname));
      assert.equal(result.status, 401, 'Unrelated web API routes and unmatched scene methods keep cookie-only forwarding.');
      assert.equal(result.headers.get('x-middleware-next'), null);
    }
    const page = await middleware(request('GET', '/en/plugins'));
    assert.equal(page.headers.get('x-middleware-next'), '1', 'Page authentication belongs to the actual page guard.');
    assert.equal(page.headers.get('x-middleware-request-x-canvas-page-return-to'), '/en/plugins');
    assert.equal((await middleware(request('GET', '/api/excalidraw/scenes/doc', undefined, 'preview.app.example.test'))).status, 404);
    console.log('Excalidraw bearer proxy: exact Create/Get/Edit methods, bounded candidates, adjacent API denial, page-guard delegation and preview isolation verified; no session-authority claim.');
  } finally {
    if (originalOrigin === undefined) delete process.env.BETTER_AUTH_BASE_URL;
    else process.env.BETTER_AUTH_BASE_URL = originalOrigin;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
