import assert from 'node:assert/strict';
import { packageWorkspacePath, PackageWorkspaceRequestError, workspaceRequest } from '../app/components/plugins/plugin-workspace-client';

// New client transport fixture: no server/database/provider request or authorization substitute.
async function main() {
  assert.equal(packageWorkspacePath('/api/plugins/catalog?workspaceId=old&q=old', 'active', { scope: 'team', teamId: 'design', q: 'safe search' }),
    '/api/plugins/catalog?q=safe+search&scope=team&teamId=design&workspaceId=active');
  assert.equal(packageWorkspacePath('/api/capabilities/packages/store', null, { scope: 'user', audience: 'own', page: 1, kind: undefined, workspaceId: 'forged' }),
    '/api/capabilities/packages/store?scope=user&audience=own&page=1');
  for (const path of ['https://external.invalid/api/packages', '//external.invalid/api/packages', '/api/../outside', '/api/\\outside', '/api/\0']) {
    assert.throws(() => packageWorkspacePath(path, 'active'), PackageWorkspaceRequestError);
  }
  const originalFetch = globalThis.fetch;
  try {
    let last: { path: string; init?: RequestInit } | undefined;
    globalThis.fetch = async (input, init) => { last = { path: String(input), init }; return Response.json({ success: true, data: { exact: true } }); };
    const controller = new AbortController();
    const data = await workspaceRequest<{ exact: boolean }>('/api/capabilities/packages/store/install', 'active', {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': 'old' }, body: JSON.stringify({ source: 'selection' }),
    });
    assert.equal(data.exact, true); assert(last);
    assert.equal(new Headers(last.init?.headers).get('x-canvas-workspace-id'), 'active');
    assert.equal(new Headers(last.init?.headers).get('Content-Type'), 'application/json');
    assert.equal(last.init?.cache, 'no-store'); assert.equal(last.init?.credentials, 'same-origin');
    assert.equal(last.init?.signal, controller.signal); assert.equal(last.init?.method, 'POST');
    globalThis.fetch = async () => Response.json({ success: false, code: 'PACKAGE_ACCESS_DENIED', error: 'SECRET provider body' }, { status: 403 });
    await assert.rejects(workspaceRequest('/api/capabilities/packages/store', 'active'), (error: unknown) => {
      assert(error instanceof PackageWorkspaceRequestError); assert.equal(error.status, 403); assert.equal(error.code, 'PACKAGE_ACCESS_DENIED');
      assert(!error.message.includes('SECRET')); return true;
    });
    globalThis.fetch = async () => Response.json({ success: false, code: 'PRIVATE\nVALUE', error: 'SECRET' }, { status: 503 });
    await assert.rejects(workspaceRequest('/api/capabilities/packages/store', 'active'), (error: unknown) => error instanceof PackageWorkspaceRequestError && error.code === 'PACKAGE_WORKSPACE_UNAVAILABLE');
    for (const body of ['not json', 'null', JSON.stringify({ success: true }), JSON.stringify({ arbitrary: 'SECRET' })]) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      await assert.rejects(workspaceRequest('/api/plugins/catalog', null), PackageWorkspaceRequestError);
    }
    const abort = new DOMException('Aborted', 'AbortError');
    globalThis.fetch = async () => { throw abort; };
    await assert.rejects(workspaceRequest('/api/plugins/catalog', null), error => error === abort);
    globalThis.fetch = async () => { throw new Error('SECRET transport details'); };
    await assert.rejects(workspaceRequest('/api/plugins/catalog', null), error => error instanceof PackageWorkspaceRequestError && !error.message.includes('SECRET'));
    console.log('Plugin workspace client PASS: canonical context transport, strict envelope, safe error/status codes, abort and POST options preserved.');
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
