import assert from 'node:assert/strict';
import Module from 'node:module';
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

// Run the real verification service and model probe; isolate only credentials,
// catalog storage and the provider transport. No live provider or DB is used.
const installationId = `aip_${'a'.repeat(24)}`;
let selectedModel: Model<Api> = {
  id: 'gpt-5.4', name: 'Probe fixture', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://unused.invalid', reasoning: true, input: ['text'],
  contextWindow: 32_000, maxTokens: 4_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const requests: SimpleStreamOptions[] = [];
const authScopes: Array<{ organizationId: string; userId: string }> = [];
const writes: Array<Record<string, unknown>> = [];
const moduleInternals = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request.endsWith('/catalog-store')) return {
    CatalogRevisionConflictError: class extends Error {},
    ProviderVerificationStoreConflictError: class extends Error {},
    readAppRuntimeCatalog: async (organizationId: string) => {
      assert.equal(organizationId, 'org-probe');
      return { revision: 7, providers: [{
        installationId, providerId: selectedModel.provider, revision: 2, enabled: true,
        status: 'unverified', verifiedAt: null, verifiedByUserId: null,
        models: [{ id: selectedModel.id, enabled: true, isProviderDefault: true }],
      }] };
    },
    updateProviderVerificationStore: async (input: Record<string, unknown>) => {
      writes.push(input);
      return { ...input, catalogRevision: 7, providerRevision: 3 };
    },
  };
  if (request.endsWith('/installation-credentials')) return {
    resolveProviderInstallationRuntimeAuth: async (input: { organizationId: string; userId: string }) => {
      authScopes.push(input);
      return { configured: true, apiKey: 'fixture-only', headers: { 'x-probe': 'scoped' }, env: {} };
    },
  };
  if (request.endsWith('/provider-runtime')) return {
    AiRuntimeExecutionError: class extends Error {},
    resolveProviderInstallationModel: async () => selectedModel,
  };
  if (request.endsWith('/managed/control-plane-models')) return { CANVAS_CONTROL_PLANE_PROVIDER_ID: 'canvas-control-plane' };
  if (request === '@earendil-works/pi-ai/compat') return {
    completeSimple: async (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
      requests.push(options);
      return { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'stop', usage: {} };
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { verifyProviderInstallation } = await import('../app/lib/agent-runtime-policy/provider-verification-service');
  for (const [id, temperature] of [['gpt-5.4', undefined], ['gpt-4.1', 0]] as const) {
    selectedModel = { ...selectedModel, id };
    const result = await verifyProviderInstallation({ organizationId: 'org-probe', actorUserId: 'user-probe', providerInstallationId: installationId });
    assert.equal(result.success, true);
    assert.equal(requests.at(-1)?.temperature, temperature);
    assert.equal(requests.at(-1)?.apiKey, 'fixture-only');
    assert.equal(requests.at(-1)?.headers?.['x-probe'], 'scoped');
    assert.ok(requests.at(-1)?.signal);
  }
  assert.equal(writes.length, 2);
  assert.ok(authScopes.every((scope) => scope.organizationId === 'org-probe' && scope.userId === 'user-probe'));
  const abort = new AbortController();
  abort.abort(new Error('fixture abort'));
  await assert.rejects(verifyProviderInstallation({ organizationId: 'org-probe', actorUserId: 'user-probe', providerInstallationId: installationId, signal: abort.signal }), { code: 'PROVIDER_VERIFICATION_ABORTED' });
  assert.equal(requests.length, 2);
  assert.equal(writes.length, 2);
  console.log('provider verification option and scope contracts passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  moduleInternals._load = originalLoad;
});
