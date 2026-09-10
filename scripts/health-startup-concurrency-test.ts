import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NextResponse } from 'next/server';
import * as asyncChecks from '../app/lib/health/async-check';
import { loadIsolatedModule } from './helpers/isolated-source-module';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function main() {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    const auth = deferred<void>();
    const acquisition = deferred<Connection>();
    const query = deferred<void>();
    let authCalls = 0;
    let opens = 0;
    let queries = 0;
    let releases = 0;
    let authFailure = false;
    let teamFeatures = false;
    let acquire = () => acquisition.promise;
    type Connection = { get: () => Promise<void>; close: () => Promise<void> };
    const connection: Connection = {
      get: async () => { queries++; await query.promise; },
      close: async () => { await delay(0); releases++; },
    };
    const route = loadIsolatedModule<{ GET: () => Promise<Response> }>('app/api/health/route.ts', {
      'next/server': { NextResponse },
      '@/app/lib/auth': { ensureAuthReady: async () => {
        authCalls++;
        if (authFailure) throw new Error('private auth connection details');
        await auth.promise;
      } },
      '@/app/lib/db': { openDb: async () => { opens++; return acquire(); } },
      '@/app/lib/db/provider': { resolveDatabaseProviderGate: () => ({ ok: true }), toPublicDatabaseProviderStatus: () => ({ provider: 'postgres' }) },
      '@/app/lib/organization/config': { areTeamFeaturesEnabled: () => teamFeatures, getDeploymentMode: () => 'community' },
      '@/app/lib/collaboration/health': {
        getCollaborationRuntimeHealth: () => ({ websocketReady: true, excalidrawWebsocketReady: true, capabilityReady: true }),
        setCollaborationRuntimeHealth: () => {},
      },
      '@/app/lib/license/entitlements': { requireRuntimeCapability: async () => {}, requireTeamRuntimeLicense: async () => {} },
      '@/app/lib/mcp/server/readiness': { getDirectMcpReadiness: async () => ({ status: 'disabled', code: 'MCP_DISABLED' }) },
      '@/app/lib/health/async-check': asyncChecks,
    }, { process: { env: { CANVAS_HEALTH_CHECK_TIMEOUT_MS: '20' } } });

    const pollWave = async () => {
      const start = performance.now();
      const responses = await Promise.all(Array.from({ length: 50 }, () => route.GET()));
      assert.ok(performance.now() - start < 2_000, 'HTTP polls must not wait for the stalled DB operation');
      assert.ok(responses.every((response) => response.status === 503));
    };
    await pollWave();
    assert.equal(authCalls, 1, 'all health work, including Auth, must share one in-flight check');
    assert.equal(opens, 0);
    auth.resolve();
    await pollWave();
    assert.equal(opens, 1, 'HTTP timeouts must not enqueue a new acquisition');
    acquisition.resolve(connection);
    await pollWave();
    assert.equal(queries, 1);
    assert.equal(releases, 0, 'no release while a query is in flight');
    query.reject(new Error('late private query failure'));
    await delay(10);
    assert.equal(releases, 1, 'late acquisition/query must still be cleaned up exactly once');
    assert.deepEqual(unhandled, []);

    acquire = async () => ({
      get: async () => { queries++; },
      close: async () => { releases++; },
    });
    const [first, second] = await Promise.all([route.GET(), route.GET()]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first, second, 'do not share a consumed Response body between requests');
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(opens, 2);
    assert.equal(releases, 2);
    await route.GET();
    assert.equal(opens, 3, 'only share in-flight work; do not cache complete DB health results');

    authFailure = true;
    const failedAuth = await route.GET();
    assert.equal(failedAuth.status, 503, 'disabled MCP must not mask failed authentication');
    const failedBody = await failedAuth.json();
    assert.equal(failedBody.checks.auth, 'error');
    assert.doesNotMatch(JSON.stringify(failedBody), /private auth/);
    authFailure = false;
    teamFeatures = true;
    const healthyTeam = await route.GET();
    assert.equal(healthyTeam.status, 200);
    assert.equal((await healthyTeam.json()).checks.collaboration, 'ok');

    const lateAcquisition = deferred<Connection>();
    acquire = () => lateAcquisition.promise;
    const opensBefore = opens;
    await pollWave();
    await pollWave();
    assert.equal(opens, opensBefore + 1);
    lateAcquisition.reject(new Error('late connection failure'));
    await delay(10);
    assert.deepEqual(unhandled, []);
    console.log('Health startup checks: bounded waves, late failures/releases, independent responses and Auth/MCP readiness passed.');
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
