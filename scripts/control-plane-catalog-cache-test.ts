import assert from 'node:assert/strict';

process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane-cache.example.test';
process.env.CANVAS_INSTANCE_TOKEN = 'catalog-cache-test-token';

const originalFetch = globalThis.fetch;

async function main() {
  const {
    getCanvasControlPlaneCatalog,
    invalidateCanvasControlPlaneCatalogCache,
    managedProviderPath,
  } = await import('../app/lib/managed/control-plane-models');

  invalidateCanvasControlPlaneCatalogCache();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return new Response(JSON.stringify({
      catalogRevision: `revision-${fetchCount}`,
      defaultModelId: 'managed-openai',
      defaultThinkingLevel: 'medium',
      models: [
        {
          id: 'managed-openai',
          name: 'Managed OpenAI Model',
          provider: 'openai',
          reasoning: true,
        },
        {
          id: 'managed-anthropic',
          name: 'Managed Anthropic Model',
          provider: 'anthropic',
          reasoning: true,
        },
        {
          id: 'managed-ollama',
          name: 'Managed Ollama Model',
          provider: 'ollama',
          reasoning: false,
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const [first, joined] = await Promise.all([
    getCanvasControlPlaneCatalog(),
    getCanvasControlPlaneCatalog(),
  ]);
  assert.equal(fetchCount, 1);
  assert.equal(first.catalogRevision, 'revision-1');
  assert.equal(joined.catalogRevision, 'revision-1');
  assert.equal(first.status, 'ready');
  assert.equal(first.defaultModelId, 'managed-openai');
  assert.equal(first.models.find((model) => model.id === 'managed-openai')?.api, 'openai-completions');
  assert.equal(first.models.find((model) => model.id === 'managed-anthropic')?.api, 'anthropic-messages');
  assert.equal(first.models.find((model) => model.id === 'managed-ollama')?.managedProvider, 'ollama');
  assert.equal(managedProviderPath('openai'), 'openai');
  assert.equal(managedProviderPath('anthropic'), 'anthropic');
  assert.equal(managedProviderPath('ollama'), 'ollama');

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
