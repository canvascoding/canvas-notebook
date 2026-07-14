import assert from 'node:assert/strict';

process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane-cache.example.test';
process.env.CANVAS_INSTANCE_TOKEN = 'catalog-cache-test-token';

const originalFetch = globalThis.fetch;

async function main() {
  const {
    getCanvasControlPlaneCatalog,
    invalidateCanvasControlPlaneCatalogCache,
  } = await import('../app/lib/managed/control-plane-models');

  invalidateCanvasControlPlaneCatalogCache();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return new Response(JSON.stringify({
      catalogRevision: `revision-${fetchCount}`,
      defaultModelId: 'managed-model',
      defaultThinkingLevel: 'off',
      models: [{
        id: 'managed-model',
        name: 'Managed Model',
        provider: 'openrouter',
        reasoning: false,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const [first, joined] = await Promise.all([
    getCanvasControlPlaneCatalog(),
    getCanvasControlPlaneCatalog(),
  ]);
  assert.equal(fetchCount, 1);
  assert.equal(first.catalogRevision, 'revision-1');
  assert.equal(joined.catalogRevision, 'revision-1');

  const cached = await getCanvasControlPlaneCatalog({ maxAgeMs: 30_000 });
  assert.equal(fetchCount, 1);
  assert.equal(cached.catalogRevision, 'revision-1');

  const refreshed = await getCanvasControlPlaneCatalog();
  assert.equal(fetchCount, 2);
  assert.equal(refreshed.catalogRevision, 'revision-2');

  console.log('control-plane-catalog-cache-test: ok');
}

void main().finally(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
  delete process.env.CANVAS_CONTROL_PLANE_URL;
  delete process.env.CANVAS_INSTANCE_TOKEN;
});
