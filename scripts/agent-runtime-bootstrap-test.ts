import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canvas-agent-runtime-bootstrap-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

const managedStreamCalls: string[] = [];

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
      streamSimple: (model: { id: string }) => {
        managedStreamCalls.push(model.id);
        return {};
      },
      createAssistantMessageEventStream: () => ({ push: () => undefined }),
    };
  }
  return originalLoad(request, parent, isMain);
};

function legacyConfig(activeProvider = 'openai-compatible') {
  return {
    version: 2,
    activeProvider,
    providers: {
      'openai-compatible': {
        id: 'openai-compatible',
        model: 'legacy-model',
        thinking: 'off',
        enabledTools: [],
        openaiCompatibleBaseUrl: 'http://localhost:9900/v1',
        openaiCompatibleModelSource: 'custom',
        openaiCompatibleCustomModel: 'legacy-model',
      },
      'canvas-control-plane': {
        id: 'canvas-control-plane',
        model: 'managed-second',
        thinking: 'high',
        enabledTools: [],
      },
    },
    enabledSkills: [],
    updatedAt: '2026-07-11T00:00:00.000Z',
    updatedBy: 'legacy-test',
  };
}

function resetRuntimeCatalog(sqlite: Database.Database) {
  sqlite.exec(`
    DELETE FROM ai_user_model_preferences;
    DELETE FROM ai_workspace_model_policies;
    DELETE FROM ai_runtime_defaults;
    DELETE FROM ai_provider_models;
    DELETE FROM ai_provider_installations;
  `);
}

function managedPayload(input: {
  revision?: string;
  defaultModelId?: string;
  models?: Array<{ id: string; name: string; provider: string; reasoning: boolean }>;
} = {}) {
  return {
    catalogRevision: input.revision ?? 'managed-revision-1',
    defaultModelId: input.defaultModelId ?? 'managed-second',
    defaultThinkingLevel: 'high',
    models: input.models ?? [
      { id: 'managed-first', name: 'Managed First', provider: 'openrouter', reasoning: true },
      { id: 'managed-second', name: 'Managed Second', provider: 'openrouter', reasoning: true },
    ],
  };
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    ensureAgentRuntimeCatalogInitialized,
    ManagedCatalogSyncError,
    syncManagedAgentRuntimeCatalog,
  } = await import('../app/lib/agent-runtime-policy/bootstrap-service');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const {
    readAppRuntimeCatalog,
    replaceAppRuntimeCatalogStore,
  } = await import('../app/lib/agent-runtime-policy/catalog-store');
  const {
    AiRuntimeExecutionError,
    resolveExecutableAgentRuntime,
    resolveProviderInstallationModel,
  } = await import('../app/lib/agent-runtime-policy/provider-runtime');
  const { resolveEffectiveAgentRuntime } = await import('../app/lib/agent-runtime-policy/runtime-resolver');
  const { readUserModelPreference } = await import('../app/lib/agent-runtime-policy/runtime-store');
  const { readPiRuntimeConfig } = await import('../app/lib/agents/storage');
  const { resolveSettingsStoragePath } = await import('../app/lib/settings-storage');

  const owner = await createInitialOwner({
    name: 'Runtime Bootstrap Owner',
    email: 'runtime-bootstrap@example.test',
    password: 'RuntimeBootstrapPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  sqlite.pragma('foreign_keys = ON');
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  const personalWorkspace = sqlite.prepare(`
    SELECT id
    FROM canvas_workspaces
    WHERE organization_id = ? AND type = 'personal' AND owner_user_id = ?
    LIMIT 1
  `).get(organization.organizationId, owner.id) as { id: string };
  const runtimeConfigPath = resolveSettingsStoragePath('pi-runtime-config.json');
  await fs.mkdir(path.dirname(runtimeConfigPath), { recursive: true });
  await fs.writeFile(runtimeConfigPath, JSON.stringify(legacyConfig()), 'utf8');

  const concurrentMigrations = await Promise.all([
    ensureAgentRuntimeCatalogInitialized({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
    }),
    ensureAgentRuntimeCatalogInitialized({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
    }),
  ]);
  const migrated = concurrentMigrations.find((result) => result.action === 'legacy_migrated')
    ?? concurrentMigrations[0];
  assert.equal(concurrentMigrations.some((result) => result.action === 'existing'), true);
  assert.equal(migrated.action, 'legacy_migrated');
  assert.equal(migrated.issueCode, null);
  assert.equal(migrated.catalog.migrationState, 'migrated');
  assert.equal(migrated.catalog.defaultSelection?.providerId, 'openai-compatible');
  assert.equal(migrated.catalog.providers.length, 1);
  assert.equal(migrated.catalog.providers[0].credentialScope, 'system');
  assert.equal(migrated.catalog.providers[0].status, 'ready');
  assert.ok(migrated.catalog.legacySourceHash);
  const ownerPreference = await readUserModelPreference({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    agentId: 'canvas-agent',
  });
  assert.equal(ownerPreference?.selection.modelId, 'legacy-model');
  assert.equal(ownerPreference?.revision, 1);

  const repeatedMigration = await ensureAgentRuntimeCatalogInitialized({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
  });
  assert.equal(repeatedMigration.action, 'existing');
  assert.equal(repeatedMigration.catalog.revision, 1);
  assert.equal((await readUserModelPreference({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    agentId: 'canvas-agent',
  }))?.revision, 1);

  resetRuntimeCatalog(sqlite);
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
    VALUES ('legacy-member', 'Legacy Member', 'legacy-member@example.test', 1, NULL, 'user', ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    UPDATE canvas_organization_settings
    SET team_features_enabled = 1
    WHERE organization_id = ?
  `).run(organization.organizationId);
  await fs.writeFile(runtimeConfigPath, JSON.stringify({ ...legacyConfig(), updatedBy: 'legacy-team-test' }), 'utf8');
  const teamReview = await ensureAgentRuntimeCatalogInitialized({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
  });
  assert.equal(teamReview.action, 'review_required');
  assert.equal(teamReview.issueCode, 'LEGACY_TEAM_REVIEW_REQUIRED');
  assert.equal(teamReview.catalog.migrationState, 'review_required');
  assert.equal(teamReview.catalog.defaultSelection, null);
  assert.equal(teamReview.catalog.providers.length, 1);
  assert.equal(await readUserModelPreference({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    agentId: 'canvas-agent',
  }), null);

  resetRuntimeCatalog(sqlite);
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'true';
  process.env.CANVAS_CONTROL_PLANE_URL = 'https://control-plane.example.test';
  process.env.CANVAS_INSTANCE_TOKEN = 'managed-instance-token';
  const originalFetch = globalThis.fetch;
  let payload = managedPayload();
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const managed = await ensureAgentRuntimeCatalogInitialized({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
  });
  assert.equal(managed.action, 'managed_initialized');
  assert.equal(managed.catalog.revision, 1);
  assert.equal(managed.catalog.defaultSelection?.modelId, 'managed-second');
  assert.notEqual(managed.catalog.defaultSelection?.modelId, managed.catalog.providers[0].models[0].id);
  assert.equal(managed.catalog.providers[0].providerId, 'canvas-control-plane');
  assert.equal(managed.catalog.providers[0].sourceRevision, 'managed-revision-1');
  assert.ok(managed.catalog.providers[0].lastSyncedAt);

  const managedProvider = managed.catalog.providers[0];
  const managedSecond = managedProvider.models.find((model) => model.id === 'managed-second')!;
  const managedRuntime = await resolveExecutableAgentRuntime({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    workspaceType: 'personal',
    agentId: 'canvas-agent',
  });
  payload = managedPayload({ revision: 'managed-revision-2' });
  const compatibleManagedModel = await resolveProviderInstallationModel({
    provider: managedProvider,
    model: managedSecond,
  });
  assert.equal(compatibleManagedModel.id, 'managed-second');
  await managedRuntime.streamFn(managedRuntime.model, { messages: [] });
  assert.deepEqual(managedStreamCalls, ['managed-second']);
  assert.equal(managedRuntime.requiresRecreation(), false);

  payload = managedPayload({
    revision: 'managed-revision-3',
    defaultModelId: 'managed-first',
    models: [{ id: 'managed-first', name: 'Managed First', provider: 'openrouter', reasoning: true }],
  });
  await assert.rejects(
    () => resolveProviderInstallationModel({ provider: managedProvider, model: managedSecond }),
    (error) => error instanceof AiRuntimeExecutionError
      && error.code === 'RUNTIME_MANAGED_CATALOG_CHANGED',
  );
  await managedRuntime.streamFn(managedRuntime.model, { messages: [] });
  assert.deepEqual(managedStreamCalls, ['managed-second']);
  assert.equal(managedRuntime.requiresRecreation(), true);
  payload = managedPayload();

  await fs.rm(runtimeConfigPath, { force: true });
  const compatibilityConfig = await readPiRuntimeConfig();
  assert.equal(compatibilityConfig.activeProvider, 'canvas-control-plane');
  assert.equal(compatibilityConfig.providers['canvas-control-plane']?.model, 'managed-second');

  const idempotent = await syncManagedAgentRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    expectedRevision: 1,
    setAsDefault: true,
  });
  assert.equal(idempotent.revision, 1);

  const adminSelectedCatalog = await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update: parseAiCatalogUpdate({
      expectedRevision: 1,
      providers: [{
        providerId: 'canvas-control-plane',
        enabled: true,
        credentialScope: 'managed',
        config: {},
        modelIds: ['managed-first', 'managed-second'],
        defaultModelId: 'managed-first',
      }],
      defaultSelection: {
        providerId: 'canvas-control-plane',
        modelId: 'managed-first',
        thinkingLevel: 'high',
      },
    }),
    discovery: {
      'canvas-control-plane': {
        id: 'canvas-control-plane',
        name: 'Canvas Control Plane',
        source: 'managed',
        models: [
          {
            id: 'managed-first',
            name: 'Managed First',
            reasoning: true,
            supportsVision: false,
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
          {
            id: 'managed-second',
            name: 'Managed Second',
            reasoning: true,
            supportsVision: false,
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      },
    },
  });
  assert.equal(adminSelectedCatalog.defaultSelection?.modelId, 'managed-first');
  const configuredChatRuntime = await resolveEffectiveAgentRuntime({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    workspaceType: 'personal',
    agentId: 'canvas-agent',
  });
  assert.equal(configuredChatRuntime.effectiveSelection?.selection.modelId, 'managed-first');
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).revision, 2);

  resetRuntimeCatalog(sqlite);
  const chatRuntime = await resolveEffectiveAgentRuntime({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    workspaceType: 'personal',
    agentId: 'canvas-agent',
  });
  assert.equal(chatRuntime.valid, true);
  assert.equal(chatRuntime.effectiveSelection?.selection.providerId, 'canvas-control-plane');
  assert.equal(chatRuntime.effectiveSelection?.selection.modelId, 'managed-second');
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).revision, 1);

  const managedCatalogWithoutDefault = await readAppRuntimeCatalog(organization.organizationId);
  await replaceAppRuntimeCatalogStore({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    expectedRevision: managedCatalogWithoutDefault.revision,
    migrationState: 'uninitialized',
    defaultSelection: null,
    providers: managedCatalogWithoutDefault.providers.map((provider) => ({
      ...provider,
      verifiedAt: provider.verifiedAt ? Date.parse(provider.verifiedAt) : null,
      lastSyncedAt: provider.lastSyncedAt ? Date.parse(provider.lastSyncedAt) : null,
    })),
  });
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).defaultSelection, null);

  const repairContext = {
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspace.id,
    workspaceType: 'personal' as const,
    agentId: 'canvas-agent',
  };
  const repairedChatRuntimes = await Promise.all([
    resolveEffectiveAgentRuntime(repairContext),
    resolveEffectiveAgentRuntime(repairContext),
  ]);
  for (const repairedChatRuntime of repairedChatRuntimes) {
    assert.equal(repairedChatRuntime.valid, true);
    assert.equal(repairedChatRuntime.effectiveSelection?.selection.providerId, 'canvas-control-plane');
    assert.equal(repairedChatRuntime.effectiveSelection?.selection.modelId, 'managed-second');
  }
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).revision, 3);
  assert.equal((await resolveEffectiveAgentRuntime(repairContext)).valid, true);
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).revision, 3);

  globalThis.fetch = async () => {
    throw new Error('control plane unavailable');
  };
  await assert.rejects(
    () => syncManagedAgentRuntimeCatalog({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      expectedRevision: 3,
      setAsDefault: false,
    }),
    (error) => error instanceof ManagedCatalogSyncError && error.code === 'MANAGED_CATALOG_REQUEST_FAILED',
  );
  const lastKnownGood = await readAppRuntimeCatalog(organization.organizationId);
  assert.equal(lastKnownGood.revision, 3);
  assert.equal(lastKnownGood.defaultSelection?.modelId, 'managed-second');

  payload = managedPayload({
    revision: 'managed-revision-2',
    defaultModelId: 'managed-first',
    models: [{ id: 'managed-first', name: 'Managed First', provider: 'openrouter', reasoning: true }],
  });
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => syncManagedAgentRuntimeCatalog({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      expectedRevision: 3,
      setAsDefault: false,
    }),
    (error) => error instanceof ManagedCatalogSyncError && error.code === 'MANAGED_CURRENT_DEFAULT_REMOVED',
  );
  assert.equal((await readAppRuntimeCatalog(organization.organizationId)).revision, 3);
  const confirmedManagedDefault = await syncManagedAgentRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    expectedRevision: 3,
    setAsDefault: true,
  });
  assert.equal(confirmedManagedDefault.revision, 4);
  assert.equal(confirmedManagedDefault.defaultSelection?.modelId, 'managed-first');

  resetRuntimeCatalog(sqlite);
  payload = managedPayload({ defaultModelId: undefined });
  delete (payload as { defaultModelId?: string }).defaultModelId;
  const invalidManaged = await ensureAgentRuntimeCatalogInitialized({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
  });
  assert.equal(invalidManaged.action, 'uninitialized');
  assert.equal(invalidManaged.issueCode, 'MANAGED_DEFAULT_MISSING');
  assert.equal(invalidManaged.catalog.revision, 0);
  const invalidCompatibilityConfig = await readPiRuntimeConfig();
  assert.notEqual(invalidCompatibilityConfig.activeProvider, 'canvas-control-plane');
  assert.equal(invalidCompatibilityConfig.providers['canvas-control-plane']?.model || '', '');

  delete process.env.CANVAS_INSTANCE_TOKEN;
  resetRuntimeCatalog(sqlite);
  await fs.writeFile(runtimeConfigPath, JSON.stringify(legacyConfig('canvas-control-plane')), 'utf8');
  const incompleteManagedConnection = await ensureAgentRuntimeCatalogInitialized({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
  });
  assert.equal(incompleteManagedConnection.action, 'review_required');
  assert.equal(incompleteManagedConnection.issueCode, 'LEGACY_MANAGED_PROVIDER_NOT_CONNECTED');
  assert.equal(incompleteManagedConnection.catalog.providers.length, 0);

  globalThis.fetch = originalFetch;
  sqlite.close();
  console.log('agent runtime bootstrap tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    moduleInternals._load = originalLoad;
    delete process.env.CANVAS_MANAGED_SERVICES_ENABLED;
    delete process.env.CANVAS_CONTROL_PLANE_URL;
    delete process.env.CANVAS_INSTANCE_TOKEN;
    await fs.rm(dataDir, { recursive: true, force: true });
  });
