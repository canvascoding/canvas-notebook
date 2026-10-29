import assert from 'node:assert/strict';
import Module from 'node:module';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { CatalogStoreProviderInput } from '../app/lib/agent-runtime-policy/catalog-store';

/** Real PostgreSQL catalog/settings and real verification orchestration; only
 * the external model/credential transport is substituted. */
async function main(): Promise<void> {
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: true });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  const compat = await import('@earendil-works/pi-ai/compat');
  const runtime = await import('../app/lib/agent-runtime-policy/provider-runtime');
  let probeFailure = false, afterProbe: (() => Promise<void>) | undefined, probes = 0;
  loader._load = (name, parent, isMain) => {
    if (name.endsWith('/installation-credentials')) return {
      resolveProviderInstallationRuntimeAuth: async (input: { organizationId: string; userId: string }) => {
        assert.equal(input.organizationId, fixture.organizationId); assert.equal(input.userId, fixture.owner.userId);
        return { configured: true, apiKey: 'fixture-only', env: {} };
      },
    };
    if (name.endsWith('/provider-runtime')) return { ...runtime,
      resolveProviderInstallationModel: async (input: { model: { id: string } }) => ({
        id: input.model.id, name: input.model.id, provider: 'openai', api: 'openai-responses',
        baseUrl: 'https://unused.invalid', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    };
    if (name === '@earendil-works/pi-ai/compat') return { ...compat,
      completeSimple: async () => {
        probes++; await afterProbe?.();
        return { role: 'assistant', content: [{ type: 'text', text: 'OK' }],
          stopReason: probeFailure ? 'error' : 'stop', errorMessage: probeFailure ? 'owned model fault' : undefined, usage: {} };
      },
    };
    return originalLoad(name, parent, isMain);
  };
  try {
    const store = await import('../app/lib/agent-runtime-policy/catalog-store');
    const { verifyProviderInstallation } = await import('../app/lib/agent-runtime-policy/provider-verification-service');
    const memory = await import('../app/lib/memory/runtime-configuration');
    const { markInstanceProviderVerified, getServerSettings } = await import('../app/lib/server-settings');
    const installationId = `aip_${'a'.repeat(24)}`;
    const models = ['gpt-4.1', 'gpt-5.4'].map((id, i) => ({ id, name: id, enabled: true,
      isProviderDefault: i === 0, reasoning: false, supportsVision: false, thinkingLevels: ['off' as const], metadata: {}, revision: 1 }));
    const provider: CatalogStoreProviderInput = { installationId, providerId: 'openai', name: 'Owned probe fixture',
      source: 'built-in', credentialScope: 'organization', enabled: true, status: 'ready', config: {},
      sourceRevision: null, lastSyncedAt: null, revision: 1, verifiedAt: 1, verifiedByUserId: fixture.owner.userId, models };
    const selection = { providerInstallationId: installationId, providerId: 'openai', modelId: models[0].id, thinkingLevel: 'off' as const };
    await store.replaceAppRuntimeCatalogStore({ organizationId: fixture.organizationId, actorUserId: fixture.owner.userId,
      expectedRevision: 0, migrationState: 'configured', defaultSelection: selection, providers: [provider] });
    const initial = await verifyProviderInstallation({ organizationId: fixture.organizationId,
      actorUserId: fixture.owner.userId, providerInstallationId: installationId });
    assert(initial.success);
    await markInstanceProviderVerified(fixture.owner.userId, { catalogRevision: initial.catalogRevision, providerInstallationId: installationId });
    const before = await store.readAppRuntimeCatalog(fixture.organizationId);
    const snapshot = async () => {
      const result: Record<string, unknown[]> = {};
      for (const name of ['ai_runtime_defaults', 'ai_provider_installations', 'ai_provider_models'])
        result[name] = await fixture.sql.all(`SELECT *,xmin::text AS row_version FROM ${name} ORDER BY to_jsonb(${name})::text`);
      return result;
    };
    const catalogRows = await snapshot();
    const verify = (modelId: string) => memory.verifyAndConfigureMemoryReviewRuntime({ organizationId: fixture.organizationId,
      actorUserId: fixture.owner.userId, providerInstallationId: installationId, modelId, expectedCatalogRevision: before.revision });
    for (const model of models) {
      const configured = await verify(model.id);
      const after = await store.readAppRuntimeCatalog(fixture.organizationId);
      assert.equal(after.revision, before.revision, 'Memory model verification must preserve the existing app-default verification revision.');
      assert.deepEqual(after, before);
      assert.deepEqual(await snapshot(), catalogRows, 'Shared provider/default/model rows and xmin must not change.');
      assert.equal(configured.verification.catalogRevision, before.revision);
      assert.equal(configured.settings.modelId, model.id);
      assert.equal((await getServerSettings()).providerVerifiedCatalogRevision, before.revision);
      assert.equal((await memory.readMemoryReviewRuntimeCatalog(fixture.organizationId)).valid, true);
      assert.equal(configured.reactivatedJobs, 0, 'Choosing a model does not opt users into automatic memory.');
    }
    const saved = await fixture.sql.all('SELECT *,xmin::text AS row_version FROM memory_review_runtime_settings');
    probeFailure = true;
    await assert.rejects(verify(models[0].id)); probeFailure = false;
    assert.deepEqual(await snapshot(), catalogRows);
    assert.deepEqual(await fixture.sql.all('SELECT *,xmin::text AS row_version FROM memory_review_runtime_settings'), saved);

    // An actual catalog change during the model response still rejects saving
    // a verification for that superseded source, including probe-only callers.
    afterProbe = async () => {
      afterProbe = undefined;
      await store.replaceAppRuntimeCatalogStore({ organizationId: fixture.organizationId, actorUserId: fixture.owner.userId,
        expectedRevision: before.revision, migrationState: 'configured', defaultSelection: null,
        providers: [{ ...provider, enabled: false, status: 'disabled' }] });
    };
    await assert.rejects(verify(models[0].id), { code: 'MEMORY_REVIEWER_VERIFICATION_CHANGED' });
    assert.deepEqual(await fixture.sql.all('SELECT *,xmin::text AS row_version FROM memory_review_runtime_settings'), saved);
    assert.equal((await memory.readMemoryReviewRuntimeCatalog(fixture.organizationId)).valid, false);
    assert.equal(probes, 5);
    assert.equal(fixture.providerRequests(), 0);
    console.log('PASS native PostgreSQL: same/different memory model preserves shared catalog and app-default proof; failed probes preserve rows/xmin; actual concurrent catalog disable rejects stale verification.');
  } finally { loader._load = originalLoad; await fixture.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
