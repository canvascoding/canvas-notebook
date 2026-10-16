import assert from 'node:assert/strict';
import * as client from '../app/components/settings/ai-runtime/catalog-client';
import type { AdminRuntimeCatalogData, AiRuntimeCatalogDraft } from '../app/components/settings/ai-runtime/catalog-client';

const originalFetch = globalThis.fetch;
const catalog = (): AdminRuntimeCatalogData => ({
  catalog: {
    organizationId: 'fixture-org', revision: 21, migrationState: 'configured', legacySourceHash: null, updatedAt: null, updatedByUserId: null,
    defaultSelection: { providerInstallationId: 'managed', providerId: 'canvas-control-plane', modelId: 'managed-model', thinkingLevel: 'off' },
    providers: ['canvas-control-plane', 'openai-codex'].map((providerId, index) => ({
      installationId: index ? 'personal' : 'managed', providerId, name: providerId,
      source: index ? 'built-in' : 'managed', credentialScope: index ? 'user' : 'managed',
      enabled: true, status: 'ready', config: index ? { authMethod: 'oauth' } : {}, revision: 21,
      sourceRevision: null, lastSyncedAt: null, verifiedAt: null, verifiedByUserId: null,
      models: [{ id: index ? 'codex-model' : 'managed-model', name: 'Model', enabled: true,
        isProviderDefault: true, reasoning: false, supportsVision: false, thinkingLevels: ['off'], metadata: {}, revision: 21 }],
    })),
  }, discovery: {},
});

async function main() {
  const remove = client.removeAdminRuntimeCatalogProvider;
  assert.equal(typeof remove, 'function', 'provider removal needs a fresh, bounded catalog mutation');
  const baseline = client.catalogDataToDraft(catalog()).providers[1];
  let state = catalog();
  let reads = 0;
  let writes: AiRuntimeCatalogDraft[] = [];
  let race = false;
  let denied = false;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/admin/agent-runtime/catalog', 'removal never disconnects OAuth or deletes Secrets');
    if (!init?.method) { reads++; return Response.json({ success: true, data: state }); }
    assert.equal(init.method, 'PUT');
    const body = JSON.parse(String(init.body));
    writes.push(body);
    if (denied) return Response.json({ success: false, code: 'ADMIN_REQUIRED', error: 'Forbidden' }, { status: 403 });
    if (race) {
      state.catalog.revision++;
      return Response.json({ success: false, code: 'CATALOG_REVISION_CONFLICT', error: 'Catalog changed' }, { status: 409 });
    }
    assert.equal(body.expectedRevision, state.catalog.revision);
    state.catalog.providers = state.catalog.providers.filter(provider => body.providers.some((entry: { providerInstallationId: string }) => entry.providerInstallationId === provider.installationId));
    state.catalog.revision++;
    state.catalog.defaultSelection = body.defaultSelection;
    return Response.json({ success: true, data: state });
  };
  try {
    // A failed model check advances the catalog and changes readiness, not configuration.
    state.catalog.revision = 22;
    state.catalog.providers[1].status = 'degraded';
    state.catalog.providers[1].revision = 22;
    state.catalog.providers[0].models[0].name = 'Concurrent managed model update';
    await remove(baseline);
    assert.equal(writes[0].expectedRevision, 22);
    assert.equal(state.catalog.providers.length, 1);
    assert.equal(state.catalog.providers[0].models[0].name, 'Concurrent managed model update');
    assert.equal(state.catalog.defaultSelection?.providerInstallationId, 'managed');

    writes = []; reads = 0;
    await remove(baseline);
    assert.equal(reads, 1); assert.equal(writes.length, 0, 'already removed is idempotent');

    state = catalog(); writes = [];
    state.catalog.providers[1].enabled = false;
    await assert.rejects(() => remove(baseline), { code: 'PROVIDER_CHANGED' });
    assert.equal(writes.length, 0, 'concurrent edits to the target require review');

    state = catalog(); writes = []; reads = 0; race = true;
    await assert.rejects(() => remove(baseline), { code: 'CATALOG_REVISION_CONFLICT' });
    assert.equal(writes.length, 2, 'retries are bounded'); assert.equal(reads, 2);
    race = false; denied = true; writes = [];
    await assert.rejects(() => remove(baseline), { status: 403 });
    assert.equal(writes.length, 1, 'authorization errors are never retried');

    state = catalog(); denied = false; writes = [];
    state.catalog.defaultSelection = { providerInstallationId: 'personal', providerId: 'openai-codex', modelId: 'codex-model', thinkingLevel: 'off' };
    await remove(baseline);
    assert.equal(state.catalog.defaultSelection, null, 'a removed provider cannot remain the app default');
    console.log('provider-catalog-removal-test: ok');
  } finally { globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
