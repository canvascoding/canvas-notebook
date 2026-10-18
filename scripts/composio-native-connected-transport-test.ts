import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ResolvedComposioContext } from '../app/lib/composio/composio-context';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-connected-transport-')));
  await fs.chmod(root, 0o700);
  const provider = await createComposioProviderFixture();
  const { startConsentProxy } = await import('./run-plugin-extension-e2e.mjs');
  const proxy = await startConsentProxy(provider, { setStatus() {} }, randomBytes(24).toString('hex'), 'https://127.0.0.1:41001/logos/canva.svg');
  const allowed = new Set([proxy.origin, provider.baseUrl]);
  const routeProofs: Array<{ service: string; method: string; path: string; status: number; durationMs: number }> = [];
  const blocked: string[] = [];
  const originalEnvironment = process.env.COMPOSIO_BASE_URL;
  process.env.COMPOSIO_BASE_URL = proxy.origin;
  const actualFetch = (await import('undici')).fetch;
  // The real SDK factory may start its own version/telemetry work. Keep this guard
  // installed until this standalone test process exits, including after cleanup.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!allowed.has(url.origin)) { blocked.push('external_origin'); throw new Error('External transport blocked by owned fixture.'); }
    const started = performance.now();
    const response = await actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]);
    const pathname = ['/api/v3.1/connected_accounts', '/api/v3.1/auth_configs', '/api/v3.1/toolkits'].includes(url.pathname) ? url.pathname : 'other_owned_route';
    routeProofs.push({ service: url.origin === proxy.origin ? 'native_proxy' : 'provider', method: init?.method ?? 'GET',
      path: pathname, status: response.status, durationMs: Math.round(performance.now() - started) });
    return response as unknown as Response;
  };
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load, originalError = console.error, originalWarn = console.warn, originalLog = console.log;
  const fixtureKey = 'owned-native-connected-transport-key';
  internals._load = function(request, parent, isMain) {
    if (parent?.filename.endsWith('/composio-client.ts') && request === '../integrations/env-config') {
      return { readScopedEnvState: async () => ({ entries: [{ key: 'COMPOSIO_API_KEY', value: fixtureKey }] }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  let passed = false;
  try {
    const factory = await import('../app/lib/composio/composio-client');
    const context: ResolvedComposioContext = { kind: 'resolved_composio_context', userId: 'owned-user', workspaceId: 'owned-workspace',
      profileId: 'owned-profile', profileName: 'Owned profile', profileSource: 'default', composioUserId: 'owned-native-entity',
      cacheRevision: '1', storageScope: { secretScope: 'user', userId: 'owned-user' } };
    provider.accounts.set(context.composioUserId, [{ id: 'owned-account-1', toolkit: 'canva', status: 'ACTIVE' },
      { id: 'owned-account-2', toolkit: 'canva', status: 'ACTIVE' }]);
    const client = await factory.getComposioForContext(context); assert(client);
    const started = performance.now();
    const result = await client.connectedAccounts.list({ userIds: [context.composioUserId], limit: 100 }, { signal: AbortSignal.timeout(3_000) });
    assert.equal(result.items.length, 2); assert(result.items.every(account => account.toolkit.slug === 'canva' && account.status === 'ACTIVE'));
    assert.equal(result.nextCursor ?? null, null);
    const listDurationMs = Math.round(performance.now() - started);
    const empty = await client.connectedAccounts.list({ userIds: ['owned-other-entity'], limit: 100 }, { signal: AbortSignal.timeout(3_000) });
    assert.equal(empty.items.length, 0, 'The real SDK must serialize the exact account entity, not reuse the first profile.');
    const statusStarted = performance.now(); const status = await factory.verifyApiKey(context);
    assert.equal(status.valid, true); assert.equal(status.healthy, true);
    const statusDurationMs = Math.round(performance.now() - statusStarted);
    const reads = provider.calls.filter(call => call.path === '/api/v3.1/connected_accounts');
    assert.equal(provider.calls.length, 3, 'Only the three readonly account requests reach the own provider.');
    assert.equal(proxy.counters.businessCalls, 0);
    assert.deepEqual(reads.map(call => call.userId), [context.composioUserId, 'owned-other-entity', context.composioUserId]);
    assert(reads.every(call => call.apiKey === fixtureKey));
    assert.equal(routeProofs.filter(row => row.service === 'native_proxy' && row.path === '/api/v3.1/connected_accounts').length, 3);
    assert.equal(routeProofs.filter(row => row.service === 'provider' && row.path === '/api/v3.1/connected_accounts').length, 3);
    assert(routeProofs.filter(row => row.path === '/api/v3.1/connected_accounts').every(row => row.status === 200));
    const summary = { version: 1, classification: 'controlled_local_transport_diagnostic', actualSdkFactory: true, actualNativeConsentProxy: true,
      actualSdkAccountCodec: true, syntheticAccountsOnly: true, databaseUsed: false, realOAuthUsed: false, businessCalls: 0,
      listDurationMs, statusDurationMs, blockedExternalAttempts: blocked.length, routeProofs };
    await fs.writeFile(path.join(root, 'transport-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
    factory.resetComposioInstance(); passed = true;
  } finally {
    internals._load = originalLoad; console.error = originalError; console.warn = originalWarn; console.log = originalLog;
    if (originalEnvironment === undefined) delete process.env.COMPOSIO_BASE_URL; else process.env.COMPOSIO_BASE_URL = originalEnvironment;
    await proxy.close(); await provider.close();
    await fs.writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ ownedProxyClosed: true, ownedProviderClosed: true, externalTransportGuardRetained: true }), { mode: 0o600, flag: 'wx' });
  }
  assert(passed);
  console.log(JSON.stringify({ status: 'passed', diagnosticRoot: root, actualSdkFactory: true, actualNativeConsentProxy: true,
    connectedAccountResponses: routeProofs.filter(row => row.path === '/api/v3.1/connected_accounts'),
    blockedExternalAttempts: blocked.length, ownedListenersClosed: true }));
}
void main().catch(error => { console.error({ status: 'failed', errorType: error instanceof Error ? error.name : 'Unknown' }); process.exitCode = 1; });
