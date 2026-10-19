import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import Module from 'node:module';
import type { ResolvedComposioContext } from '../app/lib/composio/composio-context';

type Mode = 'normal' | 'empty' | 'second-error' | 'cycle' | 'invalid-cursor' | 'missing-cursor' | 'truncated' | 'invalid-total' | 'unbounded' | 'overflow' | 'timeout';
type Call = { cursor: string | null; limit: string | null };
const calls: Call[] = [], accountContexts: string[] = [], factoryScopes: unknown[] = [];
let mode: Mode = 'normal';
const toolkit = (slug: string, noAuth = false, count = 7) => ({ slug, name: slug === 'canva' || slug === 'slack' ? 'Same display name' : slug,
  is_local_toolkit: false, type: 'native', deprecated: { toolkitId: slug }, no_auth: noAuth,
  auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], meta: {
    categories: [{ id: 'productivity', name: 'Productivity' }], created_at: '2026-01-01', updated_at: '2026-10-18',
    description: `Use ${slug}`, logo: `https://logos.example.test/${slug}.svg`, tools_count: count, triggers_count: 3, app_url: `https://${slug}.example.test`, version: '1.0' } });
const server = http.createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  assert.equal(request.method, 'GET'); assert.equal(url.pathname, '/api/v3.1/toolkits');
  assert.equal(url.searchParams.has('user_ids'), false, 'public catalogue never enumerates an account entity');
  const cursor = url.searchParams.get('cursor'); calls.push({ cursor, limit: url.searchParams.get('limit') });
  if (mode === 'timeout' && cursor) return;
  if (mode === 'second-error' && cursor) {
    response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'PRIVATE-PROVIDER-BODY' })); return;
  }
  const page = cursor === 'page-3' ? 3 : cursor ? 2 : 1;
  const items = mode === 'empty' || page === 3 ? [] : page === 1 ? [toolkit('canva'), toolkit('slack')]
    : [toolkit('github'), toolkit('duckduckgo', true), toolkit('canva', false, 99)];
  const next = mode === 'empty' ? null : mode === 'invalid-cursor' ? { private: 'INVALID' } : mode === 'missing-cursor' || mode === 'truncated' || mode === 'invalid-total' ? null
    : mode === 'cycle' ? 'cycle' : mode === 'unbounded' ? `unbounded-${calls.length}` : page === 1 ? 'page-2' : page === 2 ? 'page-3' : null;
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({
    items: mode === 'overflow' ? Array.from({ length: 1001 }, (_, index) => toolkit(`app-${index}`)) : items,
    current_page: page, total_items: mode === 'empty' ? 0 : mode === 'invalid-total' ? 2.5 : 4, total_pages: mode === 'empty' || mode === 'truncated' || mode === 'invalid-total' ? 1 : mode === 'unbounded' ? 100 : 3, next_cursor: next,
  }));
});
const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
const originalError = console.error;
const errors: unknown[][] = [];
function context(profileId = 'profile-a', userId = 'owner'): ResolvedComposioContext {
  return { kind: 'resolved_composio_context', userId, workspaceId: 'workspace', profileId, profileName: profileId,
    profileSource: 'default', composioUserId: `entity-${profileId}`, cacheRevision: '1', storageScope: { secretScope: 'user', userId } };
}
async function main() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const actualFetch = (await import('undici')).fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, baseURL, 'block external transport before network');
    return actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]) as unknown as Promise<Response>;
  };
  const { Composio } = await import('@composio/core');
  const client = new Composio({ apiKey: 'owned-pagination-fixture-key', baseURL, allowTracking: false, disableVersionCheck: true });
  internals._load = function(request, parent, isMain) {
    if (parent?.filename.endsWith('/composio-toolkit-registry.ts')) {
      if (request === './composio-client') return { getComposio: async (scope: unknown) => { factoryScopes.push(scope); return client; } };
      if (request === './composio-auth') return { getConnectedAccounts: async (_options: unknown, scope: ResolvedComposioContext) => {
        accountContexts.push(scope.profileId); return scope.profileId === 'profile-a' ? [{ toolkit: { slug: 'github' }, id: 'own-account-a', status: 'ACTIVE' }] : [];
      } };
      if (request === './composio-context') return { composioContextCacheKey: (scope: ResolvedComposioContext) => JSON.stringify([scope.profileId, scope.composioUserId, scope.cacheRevision]) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  console.error = (...values) => { errors.push(values); };
  try {
    const registry = await import('../app/lib/composio/composio-toolkit-registry');
    const owner = context();
    const raw = await registry.getAvailableToolkitsRaw(owner) as { slug: string; noAuth: boolean; meta: Record<string, unknown>; authSchemes: string[]; composioManagedAuthSchemes: string[] }[];
    assert.ok(raw.some(app => app.slug === 'github'), 'a real SDK provider toolkit on page 2 must not disappear from the detail catalogue');
    assert.deepEqual(calls.map(call => call.cursor), [null, 'page-2', 'page-3']);
    assert.ok(calls.every(call => call.limit === '1000'));
    assert.deepEqual(raw.map(app => app.slug), ['canva', 'slack', 'github', 'duckduckgo'], 'deduplicate exact slug, never shared display names');
    assert.equal(raw.find(app => app.slug === 'canva')?.meta.toolsCount, 99, 'latest repeated canonical slug metadata replaces its previous copy');
    const github = raw.find(app => app.slug === 'github')!;
    assert.deepEqual(github.meta, { categories: [{ slug: 'productivity', name: 'Productivity' }], appUrl: 'https://github.example.test',
      createdAt: '2026-01-01', description: 'Use github', logo: 'https://logos.example.test/github.svg', toolsCount: 7, triggersCount: 3, updatedAt: '2026-10-18' });
    assert.deepEqual(github.authSchemes, ['OAUTH2']); assert.deepEqual(github.composioManagedAuthSchemes, ['OAUTH2']);
    assert.equal(raw.find(app => app.slug === 'duckduckgo')?.noAuth, true);
    const beforeCache = calls.length;
    assert.equal(await registry.getAvailableToolkitsRaw(owner), raw); assert.equal(calls.length, beforeCache, 'only a complete raw catalogue is reused');
    const projected = await registry.getAvailableToolkits(owner);
    assert.equal(projected.find(app => app.slug === 'github')?.connectedAccountId, 'own-account-a');
    assert.equal(projected.find(app => app.slug === 'github')?.toolsCount, 7);
    assert.equal(projected.find(app => app.slug === 'duckduckgo')?.connected, true);
    assert.equal((await registry.getAvailableToolkits(context('profile-b'))).find(app => app.slug === 'github')?.connected, false, 'public metadata cache cannot copy another profile account state');
    assert.equal(calls.length, beforeCache); assert.deepEqual(accountContexts, ['profile-a', 'profile-b']);
    assert.equal(JSON.stringify(raw).includes('own-account-a'), false);
    await registry.getAvailableToolkitsRaw(context('profile-b', 'other-owner'));
    assert.equal(calls.length, beforeCache + 3, 'storage scope separation is preserved');
    assert.ok(factoryScopes.every(scope => scope && typeof scope === 'object' && 'secretScope' in scope));
    for (const failure of ['second-error', 'cycle', 'invalid-cursor', 'missing-cursor', 'truncated', 'invalid-total', 'unbounded', 'overflow', 'timeout'] as const) {
      registry.clearToolkitCache(); calls.length = 0; mode = failure;
      if (failure === 'timeout') globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => originalTimeout(handler, delay === 15_000 ? 40 : delay, ...args)) as typeof setTimeout;
      let rejection: unknown;
      try { await registry.getAvailableToolkits(owner); } catch (error) { rejection = error; }
      globalThis.setTimeout = originalTimeout;
      assert.ok(rejection instanceof Error, `${failure} must propagate an incomplete catalogue failure rather than success/404`);
      assert.equal(JSON.stringify(rejection).includes('PRIVATE'), false); assert.equal(String(rejection).includes('PRIVATE'), false);
      assert.equal((rejection as Error & { code: string }).code, failure === 'second-error' ? 'COMPOSIO_UNAVAILABLE' : failure === 'timeout' ? 'COMPOSIO_TIMEOUT' : 'COMPOSIO_BAD_RESPONSE');
      assert.ok(calls.length <= 20); if (failure === 'unbounded') assert.equal(calls.length, 20);
      if (failure === 'second-error' || failure === 'timeout' || failure === 'cycle') assert.equal(calls.length, 2, 'bounded requests do not retry or loop a failed page');
      const failedCalls = calls.length; mode = 'normal';
      const retried = await registry.getAvailableToolkits(owner);
      assert.ok(retried.some(app => app.slug === 'github'));
      assert.equal(calls.length, failedCalls + 3, `${failure} cannot leave a partial raw or empty processed cache`);
    }
    registry.clearToolkitCache(); calls.length = 0; mode = 'empty';
    assert.deepEqual(await registry.getAvailableToolkitsRaw(owner), []);
    assert.deepEqual(await registry.getAvailableToolkitsRaw(owner), []); assert.equal(calls.length, 1, 'a genuinely completed empty catalogue is cacheable');
    assert.equal(JSON.stringify(errors).includes('PRIVATE'), false, 'logs do not expose provider bodies or credentials');
    console.log('Toolkit registry pagination: real SDK later pages, normalization, dedupe, scope/cache isolation, cycle/bounds/error/timeout and recovery passed.');
  } finally {
    console.error = originalError; internals._load = originalLoad; globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout;
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
