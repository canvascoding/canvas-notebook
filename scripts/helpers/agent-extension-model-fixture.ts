import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type AgentExtensionFixtureModel = {
  providerInstallationId: string;
  providerId: 'ollama';
  providerName: string;
  modelId: string;
  modelName: string;
  thinkingLevel: 'off';
  expectedCatalogRevision: number;
};
export type AgentExtensionModelFixture = {
  model: AgentExtensionFixtureModel;
  origin: string;
  counts: () => { catalogReads: number; forbiddenRequests: number };
  close: () => Promise<void>;
};

/** Fail before mutation unless this is the runner's actual nonce-owned SQL scope. */
async function requireOwnedModelFixture(input: { nonce: string; organizationId: string; actorUserId: string }): Promise<void> {
  assert.match(input.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_PLUGIN_EXTENSION_E2E, '1');
  assert.equal(process.env.PLUGIN_EXTENSION_E2E_NONCE, input.nonce);
  assert.equal(process.env.CANVAS_ORGANIZATION_ID, input.organizationId);
  assert.equal(input.organizationId, `agent-settings-browser-${input.nonce}`);
  const url = new URL(process.env.DATABASE_URL ?? '');
  const expectedDatabase = `canvas_plugin_extension_test_${input.nonce}`;
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433');
  assert.equal(url.pathname, `/${expectedDatabase}`); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const { openDb } = await import('../../app/lib/db');
  const database = await openDb();
  try {
    const actual = await database.get('SELECT current_database() AS database_name') as { database_name: string };
    assert.equal(actual.database_name, expectedDatabase);
    const owner = await database.get('SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id=$1', [input.organizationId]) as { owner_user_id: string } | undefined;
    assert.equal(owner?.owner_user_id, input.actorUserId);
    const actor = await database.get('SELECT role FROM "user" WHERE id=$1', [input.actorUserId]) as { role: string } | undefined;
    assert.equal(actor?.role, 'admin');
  } finally { await database.close(); }
}

/**
 * A real catalog installation over one owned metadata-only Ollama transport.
 * Readiness follows the existing bootstrap credential-availability contract;
 * neither this helper nor its `ready` catalog status proves model execution.
 * No model verification/chat/generation request is allowed in Agent Stage 3.
 */
export async function createAgentExtensionModelFixture(input: {
  nonce: string; organizationId: string; actorUserId: string;
}): Promise<AgentExtensionModelFixture> {
  await requireOwnedModelFixture(input);
  const { discoverOllamaModels } = await import('../../app/lib/agent-runtime-policy/ollama-discovery-service');
  const { loadAiCatalogDiscovery } = await import('../../app/lib/agent-runtime-policy/catalog-discovery');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-service');
  const { readAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-store');
  const { isProviderInstallationCredentialAvailable } = await import('../../app/lib/agent-runtime-policy/installation-credentials');
  const previous = await readAppRuntimeCatalog(input.organizationId);
  assert.equal(previous.providers.length, 0, 'The model fixture may only initialize the isolated runner’s empty catalog.');
  assert.equal(previous.defaultSelection, null);
  const modelId = `agent-extension-${input.nonce.slice(0, 12)}:latest`;
  let catalogReads = 0, forbiddenRequests = 0, closed = false;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/tags') {
      forbiddenRequests++;
      request.resume(); response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Only model catalog metadata is permitted in this fixture.' }));
      return;
    }
    catalogReads++;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ models: [{ name: modelId, model: modelId,
      modified_at: '2026-10-14T00:00:00Z', size: 1, digest: input.nonce.repeat(2) }] }));
  });
  const close = async () => {
    if (!closed) {
      closed = true;
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    assert.equal(forbiddenRequests, 0, 'The model fixture received a forbidden request; Stage 3 may not execute models.');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1'); assert(address.port !== 3000 && address.port !== 3001);
    const origin = `http://127.0.0.1:${address.port}`;
    const models = await discoverOllamaModels({ serverUrl: origin });
    assert.deepEqual(models.map(model => model.id), [modelId]); assert.equal(catalogReads, 1);
    const config = { ollamaMode: 'local' as const, ollamaHost: origin, ollamaModelSource: 'custom' as const,
      ollamaCustomModel: models[0]!.id, ollamaAdditionalModels: models.map(model => model.id) };
    const discovery = await loadAiCatalogDiscovery({ ollama: [config] });
    assert(discovery.ollama?.models.some(model => model.id === modelId));
    const update = parseAiCatalogUpdate({ expectedRevision: previous.revision, providers: [{ providerId: 'ollama', enabled: true,
      credentialScope: 'organization', config, modelIds: [modelId], defaultModelId: modelId }], defaultSelection: null });
    // Persist through the normal writer first, rather than manufacturing an
    // installation or a verification object for the credential lookup.
    const installed = await replaceAiAppRuntimeCatalog({ organizationId: input.organizationId, actorUserId: input.actorUserId,
      update, discovery, migrationState: 'configured' });
    const installation = installed.providers.find(provider => provider.providerId === 'ollama');
    assert(installation && installation.enabled && installation.status === 'unverified');
    assert(await isProviderInstallationCredentialAvailable({ provider: installation,
      organizationId: input.organizationId, userId: input.actorUserId }), 'The actual local no-auth credential contract must be configured.');
    // Same ready-installation input as legacy bootstrap, derived from the actual
    // stored installation's credential check. This is not model verification.
    await requireOwnedModelFixture(input);
    await replaceAiAppRuntimeCatalog({ organizationId: input.organizationId, actorUserId: input.actorUserId,
      update: parseAiCatalogUpdate({ ...update, expectedRevision: installed.revision }), discovery,
      migrationState: 'configured', readyInstallationIds: new Set([installation.installationId]) });
    const catalog = await readAppRuntimeCatalog(input.organizationId);
    const ready = catalog.providers.find(provider => provider.installationId === installation.installationId);
    assert(ready?.enabled && ready.status === 'ready' && ready.credentialScope === 'organization');
    assert.equal(ready.config.ollamaHost, origin);
    const model = ready.models.find(model => model.enabled && model.id === modelId);
    assert(model && model.thinkingLevels.includes('off')); assert.equal(forbiddenRequests, 0);
    assert.equal(catalog.defaultSelection, null, 'The fixture provides selectable overrides without changing the application default.');
    return { origin, model: { providerInstallationId: ready.installationId, providerId: 'ollama', providerName: ready.name,
      modelId: model.id, modelName: model.name, thinkingLevel: 'off', expectedCatalogRevision: catalog.revision },
      counts: () => ({ catalogReads, forbiddenRequests }), close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}
