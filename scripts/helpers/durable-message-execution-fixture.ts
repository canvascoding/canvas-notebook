import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createCapabilityPackageStoreApplicationFixture } from './capability-package-store-application-fixture';

type ApplicationFixture = Awaited<ReturnType<typeof createCapabilityPackageStoreApplicationFixture>>;
export type DurableExecutionFixtureUser = 'owner' | 'alice' | 'bob';
export type DurableExecutionFixtureModel = {
  providerInstallationId: string;
  providerId: 'ollama';
  modelId: string;
  thinkingLevel: 'off';
  expectedCatalogRevision: number;
};
export type DurableExecutionSessionInput = {
  userId?: DurableExecutionFixtureUser;
  sessionId?: string;
  agentId?: string;
};

/**
 * Owns the real application fixture, catalog writer, session writer and Runtime
 * factory. Only the SQL transport and local model-catalog HTTP bytes are test
 * boundaries. No authority, Runtime registry, source or model resolver is mocked.
 * Native mode retains the existing strict managed-PostgreSQL opt-in gate.
 */
export async function createDurableMessageExecutionFixture(options: { native?: boolean; nativePoolMax?: 2 | 10 } = {}) {
  const originalFetch = globalThis.fetch;
  const application = await createCapabilityPackageStoreApplicationFixture(options);
  const fixtureFetch = globalThis.fetch;
  const nonce = randomUUID().replaceAll('-', '');
  const sessions = new Map<string, { userId: DurableExecutionFixtureUser; agentId: string; sessionId: string }>();
  let catalogReads = 0, forbiddenModelRequests = 0, closed = false;
  let runtimeApi: typeof import('../../app/lib/pi/live-runtime') | undefined;
  const modelId = `durable-execution-${nonce}:latest`;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/tags') {
      forbiddenModelRequests++;
      request.resume(); response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'This fixture permits model metadata only.' }));
      return;
    }
    catalogReads++;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ models: [{ name: modelId, model: modelId, modified_at: '2026-10-14T00:00:00Z',
      digest: nonce.repeat(2), size: 1 }] }));
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    // Dispose only actual registered Runtime instances created for this fixture.
    for (const session of sessions.values()) {
      try { await runtimeApi?.invalidatePiRuntime(session.sessionId, session.userId); }
      catch (error) { errors.push(error); }
    }
    if (server.listening) {
      try { await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      }); } catch (error) { errors.push(error); }
    }
    globalThis.fetch = fixtureFetch;
    try { await application.close(); } catch (error) { errors.push(error); }
    if (forbiddenModelRequests) errors.push(new Error('A model business request reached the metadata-only execution fixture.'));
    if (application.providerRequests()) errors.push(new Error('An unapproved external request reached the execution fixture.'));
    if (errors.length) throw new AggregateError(errors, 'Durable execution fixture cleanup failed.');
  };

  try {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.DATA, application.root);
    assert.equal(process.env.CANVAS_DATA_ROOT, application.root);
    assert.match(path.basename(application.root), /^canvas-store-application-/u);
    const stat = await fs.lstat(application.root);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    // macOS aliases /var to /private/var; retain the no-symlink leaf check
    // without treating the OS-owned temporary-directory alias as fixture drift.
    assert.equal(await fs.realpath(application.root), path.join(await fs.realpath(path.dirname(application.root)), path.basename(application.root)));
    // No retained setup client competes with real factory SQL on a small pool.
    await application.releaseSetupConnection();
    const sql = async <T>(operation: (database: import('../../app/lib/db').SqlConnection) => T | Promise<T>): Promise<T> => {
      const database = await application.database.openDb();
      try { return await operation(database); } finally { await database.close(); }
    };
    const databaseName = await sql(async database => String((await database.get('SELECT current_database() AS name') as { name: string }).name));
    const assertOwnedScope = async () => {
      assert(!closed, 'The owned fixture is closed.');
      assert.equal(process.env.DATA, application.root);
      assert.equal(process.env.CANVAS_DATA_ROOT, application.root);
      await sql(async database => {
        const actual = await database.get('SELECT current_database() AS name') as { name: string };
        assert.equal(actual.name, databaseName);
        if (application.native) assert.match(actual.name, /^canvas_connection_test_[a-f0-9]{32}$/u);
        const organization = await database.get('SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id=$1',
          [application.organizationId]) as { owner_user_id: string } | undefined;
        const actor = await database.get('SELECT role FROM "user" WHERE id=$1', ['owner']) as { role: string } | undefined;
        assert.equal(organization?.owner_user_id, 'owner'); assert.equal(actor?.role, 'admin');
      });
    };
    await assertOwnedScope();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo;
    assert.equal(address.address, '127.0.0.1'); assert(address.port !== 3000 && address.port !== 3001);
    const origin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== origin) return fixtureFetch(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'GET' || url.pathname !== '/api/tags' || url.search || url.hash) {
        forbiddenModelRequests++;
        throw new Error('Only the owned Ollama catalog GET is permitted; no generation or model execution.');
      }
      return originalFetch(input, init);
    };
    const { discoverOllamaModels } = await import('../../app/lib/agent-runtime-policy/ollama-discovery-service');
    const { loadAiCatalogDiscovery } = await import('../../app/lib/agent-runtime-policy/catalog-discovery');
    const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-service');
    const { readAppRuntimeCatalog } = await import('../../app/lib/agent-runtime-policy/catalog-store');
    const { isProviderInstallationCredentialAvailable } = await import('../../app/lib/agent-runtime-policy/installation-credentials');
    const initial = await readAppRuntimeCatalog(application.organizationId);
    assert.equal(initial.providers.length, 0, 'Only this fixture’s empty catalog may be initialized.');
    assert.equal(initial.defaultSelection, null);
    const discovered = await discoverOllamaModels({ serverUrl: origin });
    assert.deepEqual(discovered.map(model => model.id), [modelId]); assert.equal(catalogReads, 1);
    const config = { ollamaMode: 'local' as const, ollamaHost: origin, ollamaModelSource: 'custom' as const,
      ollamaCustomModel: modelId, ollamaAdditionalModels: [modelId] };
    const discovery = await loadAiCatalogDiscovery({ ollama: [config] });
    const update = parseAiCatalogUpdate({ expectedRevision: initial.revision, providers: [{ providerId: 'ollama', enabled: true,
      credentialScope: 'organization', config, modelIds: [modelId], defaultModelId: modelId }], defaultSelection: null });
    const unverified = await replaceAiAppRuntimeCatalog({ organizationId: application.organizationId, actorUserId: 'owner',
      update, discovery, migrationState: 'configured' });
    const installation = unverified.providers.find(provider => provider.providerId === 'ollama');
    assert(installation?.enabled && installation.status === 'unverified');
    assert(await isProviderInstallationCredentialAvailable({ provider: installation, organizationId: application.organizationId, userId: 'owner' }));
    await assertOwnedScope();
    // Existing bootstrap contract, using only the real stored installation after
    // its no-auth credential check. This does not claim model verification.
    const catalog = await replaceAiAppRuntimeCatalog({ organizationId: application.organizationId, actorUserId: 'owner',
      update: parseAiCatalogUpdate({ ...update, expectedRevision: unverified.revision }), discovery,
      migrationState: 'configured', readyInstallationIds: new Set([installation.installationId]) });
    const ready = catalog.providers.find(provider => provider.installationId === installation.installationId);
    assert(ready?.enabled && ready.status === 'ready'); assert.equal(ready.config.ollamaHost, origin);
    assert.equal(catalog.defaultSelection, null);
    const model: DurableExecutionFixtureModel = { providerInstallationId: ready.installationId, providerId: 'ollama', modelId,
      thinkingLevel: 'off', expectedCatalogRevision: catalog.revision };
    runtimeApi = await import('../../app/lib/pi/live-runtime');
    const actualRuntimeApi = runtimeApi;
    const createSessionRuntime = async (input: DurableExecutionSessionInput = {}) => {
      await assertOwnedScope();
      const userId = input.userId ?? 'owner';
      assert(['owner', 'alice', 'bob'].includes(userId));
      const sessionId = input.sessionId ?? `execution-${nonce}-${randomUUID()}`;
      assert.match(sessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
      const key = JSON.stringify([userId, sessionId]);
      const previous = sessions.get(key);
      if (previous) {
        if (input.agentId !== undefined) assert.equal(input.agentId, previous.agentId);
      }
      const { createManagedAgent, inspectManagedAgent } = await import('../../app/lib/agents/management-actions');
      const agentId = previous?.agentId ?? input.agentId ?? (await createManagedAgent({ ...application.owner, source: 'api' }, {
        name: `Execution ${nonce.slice(0, 10)} ${userId} ${randomUUID().slice(0, 8)}`, scopeType: 'organization', enabledTools: ['read'],
        defaultProviderInstallationId: model.providerInstallationId, defaultProvider: model.providerId,
        defaultModel: model.modelId, defaultThinking: model.thinkingLevel, expectedCatalogRevision: model.expectedCatalogRevision,
        extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] },
        grants: ['alice', 'bob'].map(targetId => ({ targetType: 'user' as const, targetId, canUse: true, canEdit: false, canManage: false })),
      })).agent.agentId;
      const inspected = await inspectManagedAgent({ ...application.actor(userId), source: 'api' }, agentId,
        { includeFiles: false, includeAccess: false });
      assert.equal(inspected.agent.agentId, agentId); assert.equal(inspected.agent.organizationId, application.organizationId);
      assert.equal(inspected.access.canUse, true);
      const { resolveAgentSessionWorkspaceForUser, workspaceToPiSessionFields, resolveAgentExecutionContextForStoredSession } = await import('../../app/lib/pi/session-workspace-context');
      if (!previous) {
        const workspace = await resolveAgentSessionWorkspaceForUser({ userId, workspaceId: application.actor(userId).workspaceId,
          permissions: ['canRead', 'canRunAgent'] });
        assert.equal(workspace.organizationId, application.organizationId);
        const { resolveExecutableAgentRuntime } = await import('../../app/lib/agent-runtime-policy/provider-runtime');
        const resolved = await resolveExecutableAgentRuntime({ organizationId: application.organizationId, userId,
          workspaceId: workspace.workspaceId, workspaceType: workspace.workspaceType, agentId,
          requestedSelection: { providerInstallationId: model.providerInstallationId, providerId: model.providerId, modelId, thinkingLevel: 'off' },
          executionMode: 'interactive', principal: { type: 'user', userId, credentialSubjectUserId: userId } });
        const { sessionRuntimeSnapshotFromResolvedSelection } = await import('../../app/lib/agent-runtime-policy/runtime-snapshot');
        const { createPiSystemPromptSnapshot } = await import('../../app/lib/pi/system-prompt-snapshot');
        const { createPiSessionWithRuntimeSnapshot } = await import('../../app/lib/pi/session-store');
        await createPiSessionWithRuntimeSnapshot({ userId, sessionId, agentId, title: 'Durable execution metadata fixture',
          workspace: workspaceToPiSessionFields(workspace), runtimeSnapshot: sessionRuntimeSnapshotFromResolvedSelection(resolved.selection),
          systemPromptSnapshot: await createPiSystemPromptSnapshot(agentId, { userId, organizationId: application.organizationId,
            workspaceId: workspace.workspaceId }) });
        sessions.set(key, { userId, sessionId, agentId });
      }
      const { runtime } = await actualRuntimeApi.getOrCreatePiRuntimeWithState(sessionId, userId, { metadataOnlyExternal: true });
      assert.equal(runtime.userId, userId); assert.equal(runtime.agentId, agentId); assert.equal(runtime.sessionId, sessionId);
      assert.equal(await actualRuntimeApi.getExistingPiRuntime(sessionId, userId), runtime);
      assert.equal(runtime.getStatus().phase, 'idle');
      const context = await resolveAgentExecutionContextForStoredSession({ userId, sessionId, agentId });
      return { runtime, userId, sessionId, agentId, context, model };
    };
    return { application, runtimeApi: actualRuntimeApi, model, origin, databaseName, createSessionRuntime,
      counts: () => ({ catalogReads, forbiddenModelRequests, externalRequests: application.providerRequests() }), close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Execution fixture initialization failed.'); }
    throw error;
  }
}
