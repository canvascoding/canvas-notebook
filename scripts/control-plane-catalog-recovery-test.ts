import assert from 'node:assert/strict';
import { mock } from 'node:test';

const originalFetch = globalThis.fetch;
const envKeys = ['CANVAS_MANAGED_SERVICES_ENABLED', 'CANVAS_CONTROL_PLANE_URL', 'CANVAS_INSTANCE_TOKEN'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
process.env.CANVAS_CONTROL_PLANE_URL = 'https://catalog-recovery.example.test';
process.env.CANVAS_INSTANCE_TOKEN = 'recovery-fixture-token';

function readyResponse() {
  return Response.json({ catalogRevision: 'revision-1', defaultModelId: 'fixture-model',
    models: [{ id: 'fixture-model', provider: 'openai' }] });
}

async function main() {
  const { getCanvasControlPlaneCatalog: catalog, invalidateCanvasControlPlaneCatalogCache: clear,
    MANAGED_CATALOG_REQUEST_TIMEOUT_MS, MANAGED_CATALOG_RETRY_DELAY_MS } =
    await import('../app/lib/managed/control-plane-models');
  let requests = 0;

  clear();
  globalThis.fetch = async () => ++requests === 1 ? new Response('Deploying', { status: 503 }) : readyResponse();
  const [recovered, joined] = await Promise.all([catalog(), catalog()]);
  assert.equal(recovered.status, 'ready');
  assert.equal(joined.status, 'ready');
  assert.equal(requests, 2, 'concurrent callers share a single retry');

  for (const [status, code] of [[401, 'MANAGED_CATALOG_AUTH_FAILED'], [403, 'MANAGED_CATALOG_FORBIDDEN'],
    [404, 'MANAGED_CATALOG_HTTP_ERROR']] as const) {
    clear(); requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response('', { status }); };
    const result = await catalog();
    assert.equal(result.errorCode, code);
    assert.equal(result.httpStatus, status);
    assert.equal(result.retryable, false);
    assert.equal(requests, 1, 'permanent HTTP errors must not be retried');
  }

  for (const status of [408, 429, 500, 502, 503, 504]) {
    clear(); requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response('', { status }); };
    const failed = await catalog();
    assert.equal(requests, 2, 'a sustained outage is bounded to two attempts');
    assert.equal(failed.errorCode, 'MANAGED_CATALOG_TEMPORARILY_UNAVAILABLE');
    assert.equal(failed.httpStatus, status);
    globalThis.fetch = async () => { requests += 1; return readyResponse(); };
    assert.equal((await catalog({ maxAgeMs: 30_000 })).status, 'ready');
    assert.equal(requests, 3, 'failed discovery must not be cached or require a sync');
  }

  clear(); requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new TypeError('fetch failed'); };
  assert.equal((await catalog()).errorCode, 'MANAGED_CATALOG_REQUEST_FAILED');
  assert.equal(requests, 2);

  for (const response of [new Response('{broken json'), Response.json({ models: [] })]) {
    clear(); requests = 0;
    globalThis.fetch = async () => { requests += 1; return response; };
    assert.equal((await catalog()).status, 'invalid');
    assert.equal(requests, 1, 'invalid catalog content must not be retried');
  }

  clear(); requests = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.fetch = async (_url, options) => {
      requests += 1;
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    };
    const pending = catalog();
    mock.timers.tick(MANAGED_CATALOG_REQUEST_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(MANAGED_CATALOG_RETRY_DELAY_MS);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(MANAGED_CATALOG_REQUEST_TIMEOUT_MS);
    const timedOut = await pending;
    assert.equal(timedOut.errorCode, 'MANAGED_CATALOG_TIMEOUT');
    assert.equal(requests, 2);
  } finally { mock.timers.reset(); }

  clear(); requests = 0;
  const deferred = Promise.withResolvers<Response>();
  globalThis.fetch = async () => { requests += 1; return deferred.promise; };
  const controller = new AbortController();
  const cancelled = catalog({ signal: controller.signal });
  const otherSession = catalog();
  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(cancelled, /fixture cancellation/);
  deferred.resolve(readyResponse());
  assert.equal((await otherSession).status, 'ready', 'one cancelled caller must not cancel another session');
  assert.equal(requests, 1);
  await assert.rejects(catalog({ signal: controller.signal }), /fixture cancellation/);
  assert.equal(requests, 1, 'an aborted caller must not start discovery');

  delete process.env.CANVAS_INSTANCE_TOKEN;
  assert.equal((await catalog()).errorCode, 'MANAGED_CONNECTION_INCOMPLETE');
  assert.equal(requests, 1);
  console.log('Control Plane catalog retry, classification, timeout and cancellation tests passed');
}

void main().finally(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
