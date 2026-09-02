import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-runtime-resolution-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

const scopedStreamCalls: Array<{
  modelId: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
}> = [];

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let organizationCredentialReadBarrier: {
  remainingReads: number;
  started: Deferred;
  release: Deferred;
} | null = null;

let userCredentialReadBarrier: {
  remainingReads: number;
  started: Deferred;
  release: Deferred;
} | null = null;

function delayOrganizationCredentialReadAfter(readsToSkip: number): {
  started: Promise<void>;
  release: () => void;
} {
  const started = deferred();
  const release = deferred();
  organizationCredentialReadBarrier = {
    remainingReads: readsToSkip,
    started,
    release,
  };
  return {
    started: started.promise,
    release: () => {
      organizationCredentialReadBarrier = null;
      release.resolve();
    },
  };
}

function delayUserCredentialReadAfter(readsToSkip: number): {
  started: Promise<void>;
  release: () => void;
} {
  const started = deferred();
  const release = deferred();
  userCredentialReadBarrier = {
    remainingReads: readsToSkip,
    started,
    release,
  };
  return {
    started: started.promise,
    release: () => {
      userCredentialReadBarrier = null;
      release.resolve();
    },
  };
}

let catalogDefaultsReadBarrier: {
  started: Deferred;
  release: Deferred;
} | null = null;

function delayCatalogReadAfterDefaults(): {
  started: Promise<void>;
  release: () => void;
} {
  const started = deferred();
  const release = deferred();
  catalogDefaultsReadBarrier = { started, release };
  return {
    started: started.promise,
    release: () => {
      catalogDefaultsReadBarrier = null;
      release.resolve();
    },
  };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db') {
    const database = originalLoad(request, parent, isMain) as {
      openDb: () => Promise<{
        get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
        run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
        all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
        close: () => void | Promise<void>;
      }>;
    };
    return {
      ...database,
      openDb: async () => {
        const connection = await database.openDb();
        return {
          ...connection,
          get: async (sql: string, params?: unknown[]) => {
            const result = await connection.get(sql, params);
            const barrier = catalogDefaultsReadBarrier;
            if (
              barrier
              && sql.includes('legacy_source_hash')
              && /FROM\s+ai_runtime_defaults/u.test(sql)
            ) {
              barrier.started.resolve();
              await barrier.release.promise;
            }
            return result;
          },
        };
      },
    };
  }
  if (request === '@/app/lib/integrations/env-config') {
    const envConfig = originalLoad(request, parent, isMain) as {
      readScopedEnvState: (
        scope: string,
        storageScope?: { secretScope?: string } | null,
      ) => Promise<unknown>;
    };
    return {
      ...envConfig,
      readScopedEnvState: async (
        scope: string,
        storageScope?: { secretScope?: string } | null,
      ) => {
        const barrier = storageScope?.secretScope === 'organization'
          ? organizationCredentialReadBarrier
          : storageScope?.secretScope === 'user'
            ? userCredentialReadBarrier
            : null;
        if (barrier) {
          if (barrier.remainingReads > 0) {
            barrier.remainingReads -= 1;
          } else {
            barrier.started.resolve();
            await barrier.release.promise;
          }
        }
        return envConfig.readScopedEnvState(scope, storageScope);
      },
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') {
    return { getOAuthProvider: () => null };
  }
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      getSupportedThinkingLevels: (model: {
        reasoning?: boolean;
        thinkingLevelMap?: Partial<Record<'xhigh' | 'max', unknown>>;
      }) => {
        if (!model.reasoning) return ['off'];
        const levels = ['off', 'minimal', 'low', 'medium', 'high'];
        if (model.thinkingLevelMap?.xhigh !== undefined) levels.push('xhigh');
        if (model.thinkingLevelMap?.max !== undefined) levels.push('max');
        return levels;
      },
      registerBuiltInApiProviders: () => undefined,
      streamSimple: (
        model: { id: string },
        _context: unknown,
        options?: { apiKey?: string; env?: Record<string, string | undefined> },
      ) => {
        scopedStreamCalls.push({ modelId: model.id, apiKey: options?.apiKey, env: options?.env });
        return {};
      },
      createAssistantMessageEventStream: () => ({ push: () => undefined }),
    };
  }
  return originalLoad(request, parent, isMain);
};

function installationId(organizationId: string, providerId: string, credentialScope: string): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${providerId}\0${credentialScope}`)
    .digest('hex')
    .slice(0, 24);
  return `aip_${digest}`;
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { readAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-store');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const {
    AiRuntimePolicyError,
    assertEffectiveRuntimeSelection,
    resolveEffectiveAgentRuntime,
  } = await import('../app/lib/agent-runtime-policy/runtime-resolver');
  const {
    resolveAndPinSessionRuntime,
    resolveExecutableAgentRuntime,
  } = await import('../app/lib/agent-runtime-policy/provider-runtime');
  const {
    isProviderInstallationCredentialAvailable,
    resolveProviderInstallationRuntimeAuth,
    resolveProviderInstallationRuntimeCredential,
  } = await import('../app/lib/agent-runtime-policy/installation-credentials');
  const {
    parseUserPreferenceUpdate,
    replaceWorkspaceRuntimePolicy,
    resetUserRuntimePreference,
    setUserProviderGrant,
    setUserRuntimePreference,
  } = await import('../app/lib/agent-runtime-policy/runtime-service');
  const {
    deleteWorkspaceModelPolicyStore,
    readPiSessionRuntimeSnapshot,
    RuntimeContextRevisionConflictError,
    RuntimeStoredDataError,
    SessionRuntimeSnapshotConflictError,
    writeUserModelPreferenceStore,
    writeUserWorkspaceProviderGrant,
    writeWorkspaceModelPolicyStore,
    writePiSessionRuntimeSnapshot,
  } = await import('../app/lib/agent-runtime-policy/runtime-store');
  const { createAgentProfile } = await import('../app/lib/agents/registry');
  const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const {
    createWorkspaceRecord,
    ensureDefaultWorkspaceRecords,
  } = await import('../app/lib/workspaces/service');
  const { resolveAgentSessionWorkspaceForUser } = await import('../app/lib/pi/session-workspace-context');
  const { buildPiSystemPromptSnapshotFromText } = await import('../app/lib/pi/system-prompt-snapshot');
  const { savePiSession } = await import('../app/lib/pi/session-store');

  const owner = await createInitialOwner({
    name: 'Runtime Resolution Owner',
    email: 'runtime-resolution@example.test',
    password: 'RuntimeResolutionPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  sqlite.pragma('foreign_keys = ON');
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  const remoteOllamaInstallation = {
    installationId: `aip_${'d'.repeat(24)}`,
    providerId: 'ollama',
    name: 'Remote Ollama',
    source: 'self-hosted' as const,
    credentialScope: 'organization' as const,
    enabled: true,
    status: 'ready' as const,
    config: { ollamaMode: 'cloud' as const, ollamaHost: 'http://ollama.example.test' },
    sourceRevision: null,
    lastSyncedAt: null,
    revision: 1,
    verifiedAt: new Date().toISOString(),
    verifiedByUserId: owner.id,
    models: [],
  };
  assert.equal(await isProviderInstallationCredentialAvailable({
    provider: remoteOllamaInstallation,
    organizationId: organization.organizationId,
    userId: owner.id,
  }), true);
  assert.equal(await resolveProviderInstallationRuntimeCredential({
    provider: remoteOllamaInstallation,
    organizationId: organization.organizationId,
    userId: owner.id,
  }), 'canvas-local-runtime');
  sqlite.prepare(`
    UPDATE canvas_organization_settings
    SET team_features_enabled = 1
    WHERE organization_id = ?
  `).run(organization.organizationId);
  ensureDefaultWorkspaceRecords(sqlite, {
    organizationId: organization.organizationId,
    userId: owner.id,
  });
  createWorkspaceRecord(sqlite, {
    actor: resolveWorkspaceActor({
      id: owner.id,
      email: owner.email,
      role: 'admin',
    }),
    organizationId: organization.organizationId,
    type: 'organization',
    name: 'Agent Runtime Organization',
    teamFeaturesEnabled: true,
  });
  const workspaces = sqlite.prepare(`
    SELECT id, type
    FROM canvas_workspaces
    WHERE organization_id = ?
  `).all(organization.organizationId) as Array<{ id: string; type: string }>;
  const personalWorkspaceId = workspaces.find((workspace) => workspace.type === 'personal')?.id;
  const organizationWorkspaceId = workspaces.find((workspace) => workspace.type === 'organization')?.id;
  assert.ok(personalWorkspaceId);
  assert.ok(organizationWorkspaceId);

  const organizationCompatibleKey = 'sk-org-compatible-runtime-test';
  await replaceScopedEnvEntries(
    'agents',
    [
      { key: 'OPENAI_COMPATIBLE_API_KEY', value: organizationCompatibleKey },
      { key: 'AWS_ACCESS_KEY_ID', value: 'org-bedrock-access-key' },
      { key: 'AWS_SECRET_ACCESS_KEY', value: 'org-bedrock-secret-key' },
      { key: 'AWS_REGION', value: 'eu-central-1' },
      { key: 'AZURE_OPENAI_API_KEY', value: 'org-azure-api-key' },
      { key: 'AZURE_OPENAI_RESOURCE_NAME', value: 'org-azure-resource' },
    ],
    { secretScope: 'organization', organizationId: organization.organizationId },
  );
  const organizationBedrockInstallation = {
    installationId: `aip_${'e'.repeat(24)}`,
    providerId: 'amazon-bedrock',
    name: 'Organization Bedrock',
    source: 'built-in' as const,
    credentialScope: 'organization' as const,
    enabled: true,
    status: 'ready' as const,
    config: {},
    sourceRevision: null,
    lastSyncedAt: null,
    revision: 1,
    verifiedAt: new Date().toISOString(),
    verifiedByUserId: owner.id,
    models: [],
  };
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_BEDROCK_SKIP_AUTH',
  ]) {
    delete process.env[name];
  }
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'system-bedrock-bearer-must-not-leak';
  await assert.rejects(
    () => resolveProviderInstallationRuntimeAuth({
      provider: organizationBedrockInstallation,
      organizationId: organization.organizationId,
      userId: owner.id,
    }),
    /conflict with ambient system configuration/u,
  );
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  const scopedBedrockAuth = await resolveProviderInstallationRuntimeAuth({
    provider: organizationBedrockInstallation,
    organizationId: organization.organizationId,
    userId: owner.id,
  });
  assert.equal(scopedBedrockAuth.configured, true);
  assert.equal(scopedBedrockAuth.env.AWS_ACCESS_KEY_ID, 'org-bedrock-access-key');
  assert.equal(scopedBedrockAuth.env.AWS_SECRET_ACCESS_KEY, 'org-bedrock-secret-key');
  assert.equal(scopedBedrockAuth.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  delete process.env.AZURE_OPENAI_BASE_URL;
  delete process.env.AZURE_OPENAI_RESOURCE_NAME;
  const scopedAzureAuth = await resolveProviderInstallationRuntimeAuth({
    provider: {
      ...organizationBedrockInstallation,
      installationId: `aip_${'f'.repeat(24)}`,
      providerId: 'azure-openai-responses',
      name: 'Organization Azure OpenAI',
    },
    organizationId: organization.organizationId,
    userId: owner.id,
  });
  assert.equal(scopedAzureAuth.configured, true);
  assert.equal(scopedAzureAuth.apiKey, 'org-azure-api-key');
  assert.equal(scopedAzureAuth.env.AZURE_OPENAI_BASE_URL, undefined);
  assert.equal(scopedAzureAuth.env.AZURE_OPENAI_RESOURCE_NAME, 'org-azure-resource');

  const organizationProviderId = installationId(organization.organizationId, 'openai-compatible', 'organization');
  const userProviderId = installationId(organization.organizationId, 'openai-compatible', 'user');
  const codexProviderId = installationId(organization.organizationId, 'openai-codex', 'user');
  const missingCredentialProviderId = installationId(organization.organizationId, 'openai', 'user');
  const sharedModel = 'shared-model';
  const codexModel = 'codex-model';
  const catalogUpdate = parseAiCatalogUpdate({
    expectedRevision: 0,
    providers: [
      {
        providerInstallationId: organizationProviderId,
        providerId: 'openai-compatible',
        enabled: true,
        credentialScope: 'organization',
        config: {
          openaiCompatibleBaseUrl: 'http://localhost:9000/v1',
          openaiCompatibleModelSource: 'custom',
          openaiCompatibleCustomModel: sharedModel,
        },
        modelIds: [sharedModel],
        defaultModelId: sharedModel,
      },
      {
        providerInstallationId: userProviderId,
        providerId: 'openai-compatible',
        enabled: true,
        credentialScope: 'user',
        config: {
          openaiCompatibleBaseUrl: 'http://localhost:9001/v1',
          openaiCompatibleModelSource: 'custom',
          openaiCompatibleCustomModel: sharedModel,
        },
        modelIds: [sharedModel],
        defaultModelId: sharedModel,
      },
      {
        providerInstallationId: codexProviderId,
        providerId: 'openai-codex',
        enabled: true,
        credentialScope: 'user',
        // Legacy OAuth-only installations legitimately omit authMethod. The
        // team consent path must derive OAuth from the provider contract.
        config: {},
        modelIds: [codexModel],
        defaultModelId: codexModel,
      },
      {
        providerInstallationId: missingCredentialProviderId,
        providerId: 'openai',
        enabled: true,
        credentialScope: 'user',
        config: { authMethod: 'api-key' },
        modelIds: ['key-model'],
        defaultModelId: 'key-model',
      },
    ],
    defaultSelection: {
      providerInstallationId: organizationProviderId,
      providerId: 'openai-compatible',
      modelId: sharedModel,
      thinkingLevel: 'off',
    },
  });
  await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update: catalogUpdate,
    discovery: {
      'openai-compatible': {
        id: 'openai-compatible',
        name: 'OpenAI Compatible',
        source: 'self-hosted',
        models: [{
          id: sharedModel,
          name: 'Shared Model',
          reasoning: true,
          supportsVision: false,
        }],
      },
      openai: {
        id: 'openai',
        name: 'OpenAI',
        source: 'built-in',
        models: [{
          id: 'key-model',
          name: 'Key Model',
          reasoning: true,
          supportsVision: true,
        }],
      },
      'openai-codex': {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        source: 'built-in',
        models: [{
          id: codexModel,
          name: 'Codex Model',
          reasoning: true,
          supportsVision: true,
        }],
      },
    },
  });
  sqlite.prepare(`
    UPDATE ai_provider_installations
    SET status = 'ready', verified_at = ?
    WHERE id = ?
  `).run(Date.now(), organizationProviderId);

  const extendedThinkingLevels = JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const setSharedModelCapabilityState = (revision: number, supportsExtendedThinking: boolean) => {
    sqlite.transaction(() => {
      sqlite.prepare(`
        UPDATE ai_runtime_defaults
        SET catalog_revision = ?
        WHERE organization_id = ?
      `).run(revision, organization.organizationId);
      sqlite.prepare(`
        UPDATE ai_provider_installations
        SET revision = ?
        WHERE organization_id = ?
      `).run(revision, organization.organizationId);
      sqlite.prepare(`
        UPDATE ai_provider_models
        SET revision = ?
        WHERE organization_id = ?
      `).run(revision, organization.organizationId);
      sqlite.prepare(`
        UPDATE ai_provider_models
        SET reasoning = ?, thinking_levels_json = ?
        WHERE organization_id = ? AND model_id = ?
      `).run(
        supportsExtendedThinking ? 1 : 0,
        supportsExtendedThinking ? extendedThinkingLevels : JSON.stringify(['off']),
        organization.organizationId,
        sharedModel,
      );
    })();
  };

  const catalogRead = delayCatalogReadAfterDefaults();
  const catalogDuringUpdatePromise = readAppRuntimeCatalog(organization.organizationId);
  let catalogStateChanged = false;
  try {
    await within(catalogRead.started, 'Catalog defaults read barrier');
    setSharedModelCapabilityState(2, false);
    catalogStateChanged = true;
    catalogRead.release();
    const stableCatalog = await within(catalogDuringUpdatePromise, 'Stable catalog read');
    const stableModel = stableCatalog.providers
      .find((provider) => provider.installationId === organizationProviderId)
      ?.models.find((model) => model.id === sharedModel);
    assert.equal(stableCatalog.revision, 1);
    assert.equal(stableModel?.revision, 1);
    assert.equal(stableModel?.thinkingLevels.includes('high'), true);

    const updatedCatalog = await readAppRuntimeCatalog(organization.organizationId);
    const updatedModel = updatedCatalog.providers
      .find((provider) => provider.installationId === organizationProviderId)
      ?.models.find((model) => model.id === sharedModel);
    assert.equal(updatedCatalog.revision, 2);
    assert.equal(updatedModel?.revision, 2);
    assert.deepEqual(updatedModel?.thinkingLevels, ['off']);
  } finally {
    catalogRead.release();
    if (catalogStateChanged) setSharedModelCapabilityState(1, true);
  }

  const personalContext = {
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: personalWorkspaceId,
    workspaceType: 'personal' as const,
    agentId: 'canvas-agent',
  };
  let resolution = await resolveEffectiveAgentRuntime(personalContext);
  assert.equal(resolution.valid, true);
  assert.equal(resolution.source, 'app_default');
  assert.equal(resolution.effectiveSelection?.selection.providerInstallationId, organizationProviderId);
  const legacyCloudAliasResolution = await resolveEffectiveAgentRuntime({
    ...personalContext,
    requestedSelection: {
      providerInstallationId: organizationProviderId,
      providerId: 'openai-compatible',
      modelId: `${sharedModel}:cloud`,
      thinkingLevel: 'off',
    },
  });
  assert.equal(legacyCloudAliasResolution.valid, true);
  assert.equal(legacyCloudAliasResolution.effectiveSelection?.selection.modelId, sharedModel);
  assert.equal(resolution.providers.filter((provider) => provider.providerId === 'openai-compatible').length, 2);
  const executableRuntime = await resolveExecutableAgentRuntime(personalContext);
  assert.equal(executableRuntime.providerInstallation.installationId, organizationProviderId);
  assert.equal(executableRuntime.model.id, sharedModel);
  assert.equal(executableRuntime.model.baseUrl, 'http://localhost:9000/v1');
  assert.equal(await executableRuntime.getApiKey('openai-compatible'), organizationCompatibleKey);
  assert.equal(await executableRuntime.getApiKey('openai'), undefined);
  await executableRuntime.streamFn(executableRuntime.model, { messages: [] }, { sessionId: 'scoped-runtime-test' });
  assert.deepEqual(scopedStreamCalls.at(-1), {
    modelId: sharedModel,
    apiKey: organizationCompatibleKey,
    env: { OPENAI_COMPATIBLE_API_KEY: organizationCompatibleKey },
  });

  const streamCallsBeforePolicyRace = scopedStreamCalls.length;
  const credentialRead = delayOrganizationCredentialReadAfter(2);
  const racedStream = executableRuntime.streamFn(
    executableRuntime.model,
    { messages: [] },
    { sessionId: 'scoped-runtime-policy-race-test' },
  );
  let racedPolicyRevision: number | null = null;
  try {
    await within(credentialRead.started, 'Credential read barrier');
    const racedPolicy = await replaceWorkspaceRuntimePolicy({
      organizationId: organization.organizationId,
      workspaceId: personalWorkspaceId,
      workspaceType: 'personal',
      actorUserId: owner.id,
      update: {
        expectedRevision: 0,
        expectedCatalogRevision: 1,
        allowedModels: [],
        defaultSelection: null,
        allowUserCredentials: true,
      },
    });
    racedPolicyRevision = racedPolicy.revision;
    credentialRead.release();
    await within(Promise.resolve(racedStream), 'Revoked provider stream');
  } finally {
    credentialRead.release();
    if (racedPolicyRevision !== null) {
      await deleteWorkspaceModelPolicyStore({
        organizationId: organization.organizationId,
        workspaceId: personalWorkspaceId,
        expectedRevision: racedPolicyRevision,
      });
    }
  }
  assert.equal(scopedStreamCalls.length, streamCallsBeforePolicyRace);
  assert.equal(executableRuntime.requiresRecreation(), true);

  const intelligenceRuntime = await resolveExecutableAgentRuntime({
    ...personalContext,
    requestedSelection: {
      providerInstallationId: organizationProviderId,
      providerId: 'openai-compatible',
      modelId: sharedModel,
      thinkingLevel: 'high',
    },
  });
  const streamCallsBeforeCatalogRace = scopedStreamCalls.length;
  const catalogCredentialRead = delayOrganizationCredentialReadAfter(2);
  const catalogRacedStream = intelligenceRuntime.streamFn(
    intelligenceRuntime.model,
    { messages: [] },
    { sessionId: 'scoped-runtime-catalog-race-test' },
  );
  catalogStateChanged = false;
  try {
    await within(catalogCredentialRead.started, 'Catalog race credential read barrier');
    setSharedModelCapabilityState(2, false);
    catalogStateChanged = true;
    catalogCredentialRead.release();
    await within(Promise.resolve(catalogRacedStream), 'Revoked intelligence stream');
  } finally {
    catalogCredentialRead.release();
    if (catalogStateChanged) setSharedModelCapabilityState(1, true);
  }
  assert.equal(scopedStreamCalls.length, streamCallsBeforeCatalogRace);
  assert.equal(intelligenceRuntime.requiresRecreation(), true);

  const userSelection = {
    providerInstallationId: userProviderId,
    providerId: 'openai-compatible',
    modelId: sharedModel,
    thinkingLevel: 'off' as const,
  };
  sqlite.prepare(`
    UPDATE ai_runtime_defaults
    SET catalog_revision = 2
    WHERE organization_id = ?
  `).run(organization.organizationId);
  await assert.rejects(
    () => writeUserModelPreferenceStore({
      ...personalContext,
      agentId: 'stale-catalog-preference',
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
      selection: userSelection,
    }),
    (error) => error instanceof RuntimeContextRevisionConflictError
      && error.currentCatalogRevision === 2
      && error.currentPolicyRevision === 0,
  );
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM ai_user_model_preferences
    WHERE user_id = ? AND workspace_id = ? AND agent_id = 'stale-catalog-preference'
  `).get(owner.id, personalWorkspaceId) as { count: number }).count, 0);
  await assert.rejects(
    () => writeWorkspaceModelPolicyStore({
      organizationId: organization.organizationId,
      workspaceId: personalWorkspaceId,
      actorUserId: owner.id,
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      allowedModels: null,
      defaultSelection: null,
      allowUserCredentials: true,
    }),
    (error) => error instanceof RuntimeContextRevisionConflictError
      && error.currentCatalogRevision === 2
      && error.currentPolicyRevision === 0,
  );
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM ai_workspace_model_policies
    WHERE organization_id = ? AND workspace_id = ?
  `).get(organization.organizationId, personalWorkspaceId) as { count: number }).count, 0);
  sqlite.prepare(`
    UPDATE ai_runtime_defaults
    SET catalog_revision = 1
    WHERE organization_id = ?
  `).run(organization.organizationId);

  resolution = await setUserRuntimePreference({
    context: personalContext,
    update: parseUserPreferenceUpdate({
      workspaceId: personalWorkspaceId,
      agentId: 'canvas-agent',
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
      selection: userSelection,
    }),
  });
  assert.equal(resolution.valid, true);
  assert.equal(resolution.source, 'user_preference');
  assert.equal(resolution.preference?.revision, 1);

  const samePreference = await setUserRuntimePreference({
    context: personalContext,
    update: {
      expectedRevision: 1,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
      selection: userSelection,
    },
  });
  assert.equal(samePreference.preference?.revision, 1);

  const idempotentRacePolicy = await writeWorkspaceModelPolicyStore({
    organizationId: organization.organizationId,
    workspaceId: personalWorkspaceId,
    actorUserId: owner.id,
    expectedRevision: 0,
    expectedCatalogRevision: 1,
    allowedModels: null,
    defaultSelection: null,
    allowUserCredentials: true,
  });
  await assert.rejects(
    () => writeUserModelPreferenceStore({
      ...personalContext,
      agentId: 'canvas-agent',
      expectedRevision: 1,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
      selection: userSelection,
    }),
    (error) => error instanceof RuntimeContextRevisionConflictError
      && error.currentCatalogRevision === 1
      && error.currentPolicyRevision === idempotentRacePolicy.revision,
  );
  assert.equal((sqlite.prepare(`
    SELECT revision
    FROM ai_user_model_preferences
    WHERE user_id = ? AND workspace_id = ? AND agent_id = 'canvas-agent'
  `).get(owner.id, personalWorkspaceId) as { revision: number }).revision, 1);
  await deleteWorkspaceModelPolicyStore({
    organizationId: organization.organizationId,
    workspaceId: personalWorkspaceId,
    expectedRevision: idempotentRacePolicy.revision,
  });

  await assert.rejects(
    () => createAgentProfile({
      name: 'Rejected Legacy Agent',
      defaultProvider: 'openai-compatible',
      defaultModel: sharedModel,
      defaultThinking: 'off',
    }),
    /providerInstallationId, provider, model, and thinking level together/u,
  );
  const ambiguousAgent = await createAgentProfile({ name: 'Ambiguous Agent' });
  // Legacy rows without installation IDs remain readable and fail closed. New
  // registry/API writes above may no longer create this ambiguous shape.
  sqlite.prepare(`
    UPDATE agents
    SET default_provider = ?, default_model = ?, default_thinking = ?
    WHERE agent_id = ?
  `).run('openai-compatible', sharedModel, 'off', ambiguousAgent.agentId);
  const ambiguousResolution = await resolveEffectiveAgentRuntime({
    ...personalContext,
    agentId: ambiguousAgent.agentId,
  });
  assert.equal(ambiguousResolution.valid, false);
  assert.equal(ambiguousResolution.issues.some((entry) => entry.code === 'AGENT_DEFAULT_AMBIGUOUS'), true);

  const missingCredentialResolution = await resolveEffectiveAgentRuntime({
    ...personalContext,
    requestedSelection: {
      providerInstallationId: missingCredentialProviderId,
      providerId: 'openai',
      modelId: 'key-model',
      thinkingLevel: 'high',
    },
  });
  assert.equal(missingCredentialResolution.valid, false);
  assert.equal(missingCredentialResolution.issues.some((entry) => entry.code === 'CREDENTIAL_NOT_AVAILABLE'), true);
  assert.equal(
    missingCredentialResolution.providers.find((provider) => provider.installationId === missingCredentialProviderId)?.selectable,
    false,
  );
  assert.equal(
    missingCredentialResolution.providers.find((provider) => provider.installationId === missingCredentialProviderId)?.authMethod,
    'api-key',
  );

  const organizationContext = {
    ...personalContext,
    workspaceId: organizationWorkspaceId,
    workspaceType: 'organization' as const,
  };
  const codexSelection = {
    providerInstallationId: codexProviderId,
    providerId: 'openai-codex',
    modelId: codexModel,
    thinkingLevel: 'off' as const,
  };
  const defaultTeamResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    requestedSelection: codexSelection,
  });
  const defaultTeamCodexProvider = defaultTeamResolution.providers.find((provider) => (
    provider.installationId === codexProviderId
  ));
  assert.equal(defaultTeamCodexProvider?.authMethod, 'oauth');
  assert.equal(defaultTeamCodexProvider?.userCredentialEligibility?.state, 'consent_required');
  assert.equal(defaultTeamCodexProvider?.selectable, false);
  const defaultPolicyGrant = await setUserProviderGrant({
    context: { ...organizationContext, agentId: 'default-policy-consent-agent' },
    update: {
      providerInstallationId: codexProviderId,
      allowedExecutionModes: ['interactive'],
      expectedRevision: 0,
    },
  });
  assert.equal(defaultPolicyGrant.status, 'active');

  let organizationPolicy = await replaceWorkspaceRuntimePolicy({
    organizationId: organization.organizationId,
    workspaceId: organizationWorkspaceId,
    workspaceType: 'organization',
    actorUserId: owner.id,
    update: {
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      allowedModels: [{ providerInstallationId: organizationProviderId, modelId: sharedModel }],
      defaultSelection: {
        providerInstallationId: organizationProviderId,
        providerId: 'openai-compatible',
        modelId: sharedModel,
        thinkingLevel: 'off',
      },
      allowUserCredentials: false,
    },
  });
  assert.equal(organizationPolicy.revision, 1);
  await assert.rejects(
    () => writeUserModelPreferenceStore({
      ...organizationContext,
      agentId: 'stale-policy-preference',
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
      selection: userSelection,
    }),
    (error) => error instanceof RuntimeContextRevisionConflictError
      && error.currentCatalogRevision === 1
      && error.currentPolicyRevision === 1,
  );
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM ai_user_model_preferences
    WHERE user_id = ? AND workspace_id = ? AND agent_id = 'stale-policy-preference'
  `).get(owner.id, organizationWorkspaceId) as { count: number }).count, 0);
  resolution = await resolveEffectiveAgentRuntime(organizationContext);
  assert.equal(resolution.valid, true);
  assert.equal(resolution.source, 'workspace_default');
  assert.equal(resolution.providers.some((provider) => provider.installationId === userProviderId), false);

  await assert.rejects(
    () => setUserRuntimePreference({
      context: organizationContext,
      update: {
        expectedRevision: 0,
        expectedCatalogRevision: 1,
        expectedPolicyRevision: 1,
        selection: userSelection,
      },
    }),
    (error) => error instanceof AiRuntimePolicyError && error.code === 'PROVIDER_INSTALLATION_NOT_ALLOWED',
  );

  organizationPolicy = await replaceWorkspaceRuntimePolicy({
    organizationId: organization.organizationId,
    workspaceId: organizationWorkspaceId,
    workspaceType: 'organization',
    actorUserId: owner.id,
    update: {
      expectedRevision: 1,
      expectedCatalogRevision: 1,
      allowedModels: [
        { providerInstallationId: organizationProviderId, modelId: sharedModel },
        { providerInstallationId: userProviderId, modelId: sharedModel },
        { providerInstallationId: codexProviderId, modelId: codexModel },
      ],
      defaultSelection: organizationPolicy.defaultSelection,
      allowUserCredentials: true,
    },
  });
  assert.equal(organizationPolicy.revision, 2);
  const ungrantedCodexResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    requestedSelection: codexSelection,
  });
  const ungrantedCodexProvider = ungrantedCodexResolution.providers.find((provider) => (
    provider.installationId === codexProviderId
  ));
  assert.equal(ungrantedCodexProvider?.authMethod, 'oauth');
  assert.equal(ungrantedCodexProvider?.selectable, false);
  assert.equal(ungrantedCodexResolution.valid, false);

  const codexGrant = await setUserProviderGrant({
    context: organizationContext,
    update: {
      providerInstallationId: codexProviderId,
      allowedExecutionModes: ['interactive'],
      expectedRevision: 0,
    },
  });
  assert.equal(codexGrant.status, 'active');
  const grantedCodexResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    requestedSelection: codexSelection,
  });
  assert.equal(grantedCodexResolution.valid, false);
  assert.equal(
    grantedCodexResolution.issues.some((entry) => entry.code === 'CREDENTIAL_NOT_AVAILABLE'),
    true,
  );
  assert.equal(
    grantedCodexResolution.providers.find((provider) => provider.installationId === codexProviderId)?.selectable,
    false,
  );
  const ungrantedTeamResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    requestedSelection: userSelection,
  });
  assert.equal(ungrantedTeamResolution.valid, false);
  assert.equal(
    ungrantedTeamResolution.issues.some((entry) => entry.code === 'CREDENTIAL_NOT_AVAILABLE'),
    true,
  );
  const userCredentialGrant = await writeUserWorkspaceProviderGrant({
    organizationId: organization.organizationId,
    userId: owner.id,
    workspaceId: organizationWorkspaceId,
    agentId: 'canvas-agent',
    providerInstallationId: userProviderId,
    allowedExecutionModes: ['interactive'],
    expectedRevision: 0,
  });
  assert.equal(userCredentialGrant.status, 'active');
  assert.deepEqual(userCredentialGrant.allowedExecutionModes, ['interactive']);
  await replaceScopedEnvEntries(
    'agents',
    [{ key: 'OPENAI_COMPATIBLE_API_KEY', value: 'sk-user-compatible-runtime-test' }],
    { secretScope: 'user', organizationId: organization.organizationId, userId: owner.id },
  );
  resolution = await setUserRuntimePreference({
    context: organizationContext,
    update: {
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 2,
      selection: userSelection,
    },
  });
  assert.equal(resolution.source, 'user_preference');

  const personalAutomationResolution = await resolveEffectiveAgentRuntime({
    ...personalContext,
    requestedSelection: userSelection,
    executionMode: 'personal_automation',
    principal: {
      type: 'user',
      userId: owner.id,
      credentialSubjectUserId: owner.id,
    },
  });
  assert.equal(personalAutomationResolution.valid, true);
  assert.equal(
    personalAutomationResolution.effectiveSelection?.selection.providerInstallationId,
    userProviderId,
  );

  const grantedTeamRuntime = await resolveExecutableAgentRuntime({
    ...organizationContext,
    requestedSelection: userSelection,
  });
  const streamCallsBeforeGrantRace = scopedStreamCalls.length;
  const userCredentialRead = delayUserCredentialReadAfter(1);
  const revokedGrantStream = grantedTeamRuntime.streamFn(
    grantedTeamRuntime.model,
    { messages: [] },
    { sessionId: 'scoped-runtime-grant-race-test' },
  );
  try {
    await within(userCredentialRead.started, 'User credential read barrier');
    sqlite.prepare(`
      UPDATE ai_user_workspace_provider_grants
      SET status = 'revoked', revision = revision + 1, revoked_at = ?, updated_at = ?
      WHERE organization_id = ? AND user_id = ? AND workspace_id = ?
        AND agent_id = ? AND provider_installation_id = ?
    `).run(
      Date.now(),
      Date.now(),
      organization.organizationId,
      owner.id,
      organizationWorkspaceId,
      'canvas-agent',
      userProviderId,
    );
    userCredentialRead.release();
    await within(Promise.resolve(revokedGrantStream), 'Revoked user grant stream');
  } finally {
    userCredentialRead.release();
  }
  assert.equal(scopedStreamCalls.length, streamCallsBeforeGrantRace);
  assert.equal(grantedTeamRuntime.requiresRecreation(), true);

  // A personal interactive grant must not follow the same user's session into
  // an external channel. Those runs use only non-user credentials unless a
  // future, separately reviewed grant mode explicitly permits them.
  const externalChannelResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    executionMode: 'external_channel',
    principal: {
      type: 'user',
      userId: owner.id,
      credentialSubjectUserId: owner.id,
    },
  });
  assert.equal(externalChannelResolution.valid, true);
  assert.equal(externalChannelResolution.source, 'workspace_default');
  assert.equal(
    externalChannelResolution.providers.some((provider) => provider.installationId === userProviderId),
    false,
  );

  // Organization automations retain a responsible user for audit and
  // workspace authorization, but that user must never become the credential
  // subject. Even with the workspace policy and a user preference enabled,
  // user-scoped installations are unavailable to a service principal.
  const organizationAutomationContext = {
    ...organizationContext,
    executionMode: 'organization_automation' as const,
    principal: {
      type: 'organization_service' as const,
      serviceActorId: `org-service:${organization.organizationId}`,
      responsibleUserId: owner.id,
      credentialSubjectUserId: null,
    },
  };
  const organizationAutomationResolution = await resolveEffectiveAgentRuntime(organizationAutomationContext);
  assert.equal(organizationAutomationResolution.valid, true);
  assert.equal(organizationAutomationResolution.source, 'workspace_default');
  assert.equal(
    organizationAutomationResolution.providers.some((provider) => provider.installationId === userProviderId),
    false,
  );
  const organizationAutomationUserSelection = await resolveEffectiveAgentRuntime({
    ...organizationAutomationContext,
    requestedSelection: userSelection,
  });
  assert.equal(organizationAutomationUserSelection.valid, false);
  assert.equal(
    organizationAutomationUserSelection.issues.some((entry) => entry.code === 'PROVIDER_INSTALLATION_NOT_ALLOWED'),
    true,
  );

  const memberId = 'runtime-member';
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(memberId, 'Runtime Member', 'runtime-member@example.test', 1, null, 'user', now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status,
      can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
      created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, ?, ?)
  `).run(organization.organizationId, memberId, now, now);
  const memberResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    userId: memberId,
  });
  assert.equal(memberResolution.valid, true);
  assert.equal(memberResolution.preference, null);
  assert.equal(memberResolution.source, 'workspace_default');
  assert.equal(memberResolution.effectiveSelection?.selection.providerInstallationId, organizationProviderId);
  const memberCodexResolution = await resolveEffectiveAgentRuntime({
    ...organizationContext,
    userId: memberId,
    requestedSelection: codexSelection,
  });
  assert.equal(memberCodexResolution.valid, false);
  assert.equal(
    memberCodexResolution.providers.find((provider) => provider.installationId === codexProviderId)?.credentialAvailable,
    false,
  );

  const { auth } = await import('../app/lib/auth');
  type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  let routeSession: RouteSession | null = null;
  Reflect.set(auth.api, 'getSession', async () => routeSession);
  const preferencesRoute = await import('../app/api/agent-runtime/preferences/route');
  const catalogRoute = await import('../app/api/admin/agent-runtime/catalog/route');
  const workspacePolicyRoute = await import('../app/api/admin/agent-runtime/workspace-policy/route');
  const agentsRoute = await import('../app/api/agents/route');
  const onboardingUserRoute = await import('../app/api/onboarding/user/route');
  const envRoute = await import('../app/api/integrations/env/route');

  const unauthorizedPreferenceResponse = await preferencesRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/preferences?workspaceId=${organizationWorkspaceId}&agentId=canvas-agent`,
  ));
  assert.equal(unauthorizedPreferenceResponse.status, 401);

  routeSession = {
    user: {
      id: memberId,
      email: 'runtime-member@example.test',
      name: 'Runtime Member',
      role: 'user',
      emailVerified: true,
      image: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    session: {
      id: 'runtime-member-session',
      token: 'runtime-member-token',
      userId: memberId,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    },
  } as RouteSession;
  const memberPreferenceResponse = await preferencesRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/preferences?workspaceId=${organizationWorkspaceId}&agentId=canvas-agent`,
  ));
  assert.equal(memberPreferenceResponse.status, 200);
  const forbiddenPersonalResponse = await preferencesRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/preferences?workspaceId=${personalWorkspaceId}&agentId=canvas-agent`,
  ));
  assert.equal(forbiddenPersonalResponse.status, 404);
  const memberCatalogResponse = await catalogRoute.GET(new NextRequest('http://localhost:3000/api/admin/agent-runtime/catalog'));
  assert.equal(memberCatalogResponse.status, 403);
  const memberPolicyResponse = await workspacePolicyRoute.GET(new NextRequest(
    `http://localhost:3000/api/admin/agent-runtime/workspace-policy?workspaceId=${organizationWorkspaceId}`,
  ));
  assert.equal(memberPolicyResponse.status, 403);
  const memberInheritedAgentResponse = await agentsRoute.POST(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Member Inherited Agent',
        defaultProviderInstallationId: null,
        defaultProvider: null,
        defaultModel: null,
        defaultThinking: null,
      }),
    },
  ));
  assert.equal(memberInheritedAgentResponse.status, 200);
  const memberInheritedAgentPayload = await memberInheritedAgentResponse.json();
  const memberInheritedAgentId = memberInheritedAgentPayload.data.agent.agentId as string;
  const memberAgentDefaultMutation = await agentsRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: memberInheritedAgentId,
        defaultProviderInstallationId: userProviderId,
        defaultProvider: 'openai-compatible',
        defaultModel: sharedModel,
        defaultThinking: 'off',
        expectedRevision: 1,
        expectedCatalogRevision: 1,
      }),
    },
  ));
  assert.equal(memberAgentDefaultMutation.status, 403);
  const memberRoleAfterWorkspaceAccess = sqlite.prepare(`
    SELECT u.role AS globalRole, p.role AS organizationRole
    FROM user u
    JOIN organization_user_permissions p ON p.user_id = u.id
    WHERE p.organization_id = ? AND u.id = ?
  `).get(organization.organizationId, memberId) as { globalRole: string; organizationRole: string };
  assert.deepEqual(memberRoleAfterWorkspaceAccess, { globalRole: 'user', organizationRole: 'member' });
  const memberOrganizationSecretsResponse = await envRoute.GET(new NextRequest(
    'http://localhost:3000/api/integrations/env?scope=agents&secretScope=organization',
  ));
  const memberOrganizationSecretsPayload = await memberOrganizationSecretsResponse.json();
  assert.equal(memberOrganizationSecretsResponse.status, 403, JSON.stringify(memberOrganizationSecretsPayload));

  const memberPreferenceUpdateResponse = await preferencesRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agent-runtime/preferences',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: organizationWorkspaceId,
        agentId: 'canvas-agent',
        expectedRevision: 0,
        expectedCatalogRevision: 1,
        expectedPolicyRevision: 2,
        selection: userSelection,
      }),
    },
  ));
  const memberPreferenceUpdatePayload = await memberPreferenceUpdateResponse.json();
  // A team member cannot save a preference for an unconfigured personal
  // credential. This prevents the owner’s user-scoped credential from being
  // treated as shared workspace state.
  assert.equal(memberPreferenceUpdateResponse.status, 409, JSON.stringify(memberPreferenceUpdatePayload));
  assert.equal(memberPreferenceUpdatePayload.code, 'CREDENTIAL_NOT_AVAILABLE');

  routeSession = {
    ...routeSession,
    user: {
      ...routeSession.user,
      id: owner.id,
      email: owner.email,
      name: owner.name,
      role: 'admin',
    },
    session: {
      ...routeSession.session,
      id: 'runtime-owner-session',
      token: 'runtime-owner-token',
      userId: owner.id,
    },
  } as RouteSession;
  const ownerPreferenceResponse = await preferencesRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/preferences?workspaceId=${personalWorkspaceId}&agentId=canvas-agent`,
  ));
  assert.equal(ownerPreferenceResponse.status, 200);
  const ownerCatalogResponse = await catalogRoute.GET(new NextRequest(
    'http://localhost:3000/api/admin/agent-runtime/catalog',
  ));
  assert.equal(ownerCatalogResponse.status, 200);
  const ownerCatalogPayload = await ownerCatalogResponse.json();
  assert.equal(
    ownerCatalogPayload.data.discovery['openai-compatible'].installationIds.organization,
    organizationProviderId,
  );
  assert.equal(
    ownerCatalogPayload.data.discovery['openai-compatible'].installationIds.user,
    userProviderId,
  );
  const ownerPolicyResponse = await workspacePolicyRoute.GET(new NextRequest(
    `http://localhost:3000/api/admin/agent-runtime/workspace-policy?workspaceId=${organizationWorkspaceId}`,
  ));
  assert.equal(ownerPolicyResponse.status, 200);

  const ownerDefaultAgentResponse = await agentsRoute.POST(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Owner Default Agent',
        defaultProviderInstallationId: null,
        defaultProvider: null,
        defaultModel: null,
        defaultThinking: null,
      }),
    },
  ));
  assert.equal(ownerDefaultAgentResponse.status, 200);
  const ownerDefaultAgentId = (await ownerDefaultAgentResponse.json()).data.agent.agentId as string;

  const outsideCatalogAgentDefault = await agentsRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: ownerDefaultAgentId,
        defaultProviderInstallationId: `aip_${'f'.repeat(24)}`,
        defaultProvider: 'openai-compatible',
        defaultModel: sharedModel,
        defaultThinking: 'off',
        expectedRevision: 1,
        expectedCatalogRevision: 1,
      }),
    },
  ));
  assert.equal(outsideCatalogAgentDefault.status, 409);
  assert.equal((await outsideCatalogAgentDefault.json()).code, 'PROVIDER_INSTALLATION_NOT_ALLOWED');

  const staleAgentDefault = await agentsRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: ownerDefaultAgentId,
        defaultProviderInstallationId: userProviderId,
        defaultProvider: 'openai-compatible',
        defaultModel: sharedModel,
        defaultThinking: 'off',
        expectedRevision: 1,
        expectedCatalogRevision: 0,
      }),
    },
  ));
  assert.equal(staleAgentDefault.status, 409);
  const staleAgentDefaultPayload = await staleAgentDefault.json();
  assert.equal(staleAgentDefaultPayload.code, 'AGENT_DEFAULT_CATALOG_REVISION_CONFLICT');
  assert.equal(staleAgentDefaultPayload.currentCatalogRevision, 1);
  const defaultAfterRejectedWrites = sqlite.prepare(`
    SELECT default_provider_installation_id AS providerInstallationId,
           default_provider AS provider, default_model AS model, default_thinking AS thinking
    FROM agents
    WHERE agent_id = ?
  `).get(ownerDefaultAgentId) as {
    providerInstallationId: string | null;
    provider: string | null;
    model: string | null;
    thinking: string | null;
  };
  assert.deepEqual(defaultAfterRejectedWrites, {
    providerInstallationId: null,
    provider: null,
    model: null,
    thinking: null,
  });

  const exactAgentDefault = await agentsRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: ownerDefaultAgentId,
        defaultProviderInstallationId: userProviderId,
        defaultProvider: 'openai-compatible',
        defaultModel: sharedModel,
        defaultThinking: 'off',
        expectedRevision: 1,
        expectedCatalogRevision: 1,
      }),
    },
  ));
  assert.equal(exactAgentDefault.status, 200);
  const exactAgentDefaultPayload = await exactAgentDefault.json();
  assert.deepEqual(
    {
      providerInstallationId: exactAgentDefaultPayload.data.agent.defaultProviderInstallationId,
      provider: exactAgentDefaultPayload.data.agent.defaultProvider,
      model: exactAgentDefaultPayload.data.agent.defaultModel,
      thinking: exactAgentDefaultPayload.data.agent.defaultThinking,
    },
    {
      providerInstallationId: userProviderId,
      provider: 'openai-compatible',
      model: sharedModel,
      thinking: 'off',
    },
  );
  const invalidCombinedAgentPatch = await agentsRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/agents',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: ownerDefaultAgentId,
        name: '',
        defaultProviderInstallationId: organizationProviderId,
        defaultProvider: 'openai-compatible',
        defaultModel: sharedModel,
        defaultThinking: 'off',
        expectedRevision: 2,
        expectedCatalogRevision: 1,
      }),
    },
  ));
  assert.equal(invalidCombinedAgentPatch.status, 400);
  const defaultAfterInvalidCombinedPatch = sqlite.prepare(`
    SELECT default_provider_installation_id AS providerInstallationId,
           default_provider AS provider, default_model AS model, default_thinking AS thinking
    FROM agents
    WHERE agent_id = ?
  `).get(ownerDefaultAgentId);
  assert.deepEqual(defaultAfterInvalidCombinedPatch, {
    providerInstallationId: userProviderId,
    provider: 'openai-compatible',
    model: sharedModel,
    thinking: 'off',
  });
  const ownerOrganizationSecretWrite = await envRoute.PUT(new NextRequest(
    'http://localhost:3000/api/integrations/env?scope=agents&secretScope=organization',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'agents',
        secretScope: 'organization',
        mode: 'kv',
        entries: [
          { key: 'OPENAI_COMPATIBLE_API_KEY', value: 'organization-secret-value' },
          { key: 'UNRELATED_SECRET', value: 'must-not-be-returned' },
        ],
      }),
    },
  ));
  assert.equal(ownerOrganizationSecretWrite.status, 200);
  const scopedKeyRead = await envRoute.GET(new NextRequest(
    'http://localhost:3000/api/integrations/env?scope=agents&secretScope=organization&key=OPENAI_COMPATIBLE_API_KEY',
  ));
  assert.equal(scopedKeyRead.status, 200);
  const scopedKeyPayload = await scopedKeyRead.json();
  assert.equal(scopedKeyPayload.data.rawContent, '');
  assert.deepEqual(scopedKeyPayload.data.entries.map((entry: { key: string }) => entry.key), ['OPENAI_COMPATIBLE_API_KEY']);
  assert.equal(JSON.stringify(scopedKeyPayload).includes('must-not-be-returned'), false);

  const { initializeUserOnboarding } = await import('../app/lib/user-preferences');
  await initializeUserOnboarding(owner.id);
  const onboardingWorkspaceResponse = await onboardingUserRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/onboarding/user',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'workspace' }),
    },
  ));
  assert.equal(onboardingWorkspaceResponse.status, 200);
  const onboardingProfileResponse = await onboardingUserRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/onboarding/user',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'profile' }),
    },
  ));
  assert.equal(onboardingProfileResponse.status, 200);
  assert.equal((await onboardingProfileResponse.json()).data.runtime, 'skipped');
  const removedRuntimeStepResponse = await onboardingUserRoute.PATCH(new NextRequest(
    'http://localhost:3000/api/onboarding/user',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'runtime' }),
    },
  ));
  assert.equal(removedRuntimeStepResponse.status, 400);

  organizationPolicy = await replaceWorkspaceRuntimePolicy({
    organizationId: organization.organizationId,
    workspaceId: organizationWorkspaceId,
    workspaceType: 'organization',
    actorUserId: owner.id,
    update: {
      expectedRevision: 2,
      expectedCatalogRevision: 1,
      allowedModels: [{ providerInstallationId: organizationProviderId, modelId: sharedModel }],
      defaultSelection: organizationPolicy.defaultSelection,
      allowUserCredentials: false,
    },
  });
  const stalePreferenceResolution = await resolveEffectiveAgentRuntime(organizationContext);
  assert.equal(stalePreferenceResolution.preference?.revision, 1);
  assert.equal(stalePreferenceResolution.inheritedSelection?.selection.providerInstallationId, organizationProviderId);
  assert.equal(stalePreferenceResolution.effectiveSelection, null);
  assert.equal(stalePreferenceResolution.valid, false);
  assert.equal(stalePreferenceResolution.issues.some((entry) => entry.code === 'PROVIDER_INSTALLATION_NOT_ALLOWED'), true);

  const resetTeamPreference = await resetUserRuntimePreference({
    context: organizationContext,
    expectedRevision: 1,
  });
  assert.equal(resetTeamPreference.valid, true);
  assert.equal(resetTeamPreference.preference, null);
  assert.equal(resetTeamPreference.source, 'workspace_default');

  const sessionResolution = await resolveEffectiveAgentRuntime(personalContext);
  const sessionSelection = assertEffectiveRuntimeSelection(sessionResolution);
  const runtimeSnapshot = {
    selection: sessionSelection.selection,
    catalogRevision: sessionSelection.catalogRevision,
    policyRevision: sessionSelection.policyRevision,
    selectionSource: sessionSelection.selectionSource,
  };
  const personalWorkspace = await resolveAgentSessionWorkspaceForUser({
    userId: owner.id,
    workspaceId: personalWorkspaceId,
  });
  const promptSnapshot = buildPiSystemPromptSnapshotFromText('Runtime resolution test prompt');
  await savePiSession(
    'sess-runtime-auto-pin',
    owner.id,
    'legacy-provider',
    'legacy-model',
    [{ role: 'user', content: 'Legacy session', timestamp: now - 1 }],
    undefined,
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspace.workspaceId,
      systemPromptSnapshot: promptSnapshot,
    },
  );
  const autoPinnedRuntime = await resolveAndPinSessionRuntime({
    ...personalContext,
    sessionId: 'sess-runtime-auto-pin',
  });
  assert.equal(autoPinnedRuntime.model.id, sessionSelection.selection.modelId);
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-auto-pin',
    userId: owner.id,
    agentId: 'canvas-agent',
  }), runtimeSnapshot);

  await savePiSession(
    'sess-runtime-snapshot',
    owner.id,
    runtimeSnapshot.selection.providerId,
    runtimeSnapshot.selection.modelId,
    [{ role: 'user', content: 'First message', timestamp: now }],
    undefined,
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspace.workspaceId,
      runtimeSnapshot,
      systemPromptSnapshot: promptSnapshot,
    },
  );
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-snapshot',
    userId: owner.id,
    agentId: 'canvas-agent',
  }), runtimeSnapshot);

  await savePiSession(
    'sess-runtime-snapshot',
    owner.id,
    'mutated-provider',
    'mutated-model',
    [{ role: 'user', content: 'First message', timestamp: now }],
    undefined,
    { agentId: 'canvas-agent', workspaceId: personalWorkspace.workspaceId, persistedLength: 1 },
  );
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-snapshot',
    userId: owner.id,
    agentId: 'canvas-agent',
  }), runtimeSnapshot);
  const persistedRuntime = sqlite.prepare(`
    SELECT provider, model
    FROM pi_sessions
    WHERE session_id = ?
  `).get('sess-runtime-snapshot') as { provider: string; model: string };
  assert.equal(persistedRuntime.provider, runtimeSnapshot.selection.providerId);
  assert.equal(persistedRuntime.model, runtimeSnapshot.selection.modelId);

  const replacementSnapshot = {
    ...runtimeSnapshot,
    selection: {
      providerInstallationId: organizationProviderId,
      providerId: 'openai-compatible',
      modelId: sharedModel,
      thinkingLevel: 'off' as const,
    },
    selectionSource: 'session' as const,
  };
  await assert.rejects(
    () => writePiSessionRuntimeSnapshot({
      sessionId: 'sess-runtime-snapshot',
      userId: owner.id,
      agentId: 'canvas-agent',
      snapshot: replacementSnapshot,
    }),
    (error) => error instanceof SessionRuntimeSnapshotConflictError,
  );
  await writePiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-snapshot',
    userId: owner.id,
    agentId: 'canvas-agent',
    snapshot: replacementSnapshot,
    allowReplace: true,
  });
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-snapshot',
    userId: owner.id,
    agentId: 'canvas-agent',
  }), replacementSnapshot);

  const personalPolicy = await replaceWorkspaceRuntimePolicy({
    organizationId: organization.organizationId,
    workspaceId: personalWorkspaceId,
    workspaceType: 'personal',
    actorUserId: owner.id,
    update: {
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      allowedModels: [],
      defaultSelection: null,
      allowUserCredentials: true,
    },
  });
  assert.equal(personalPolicy.revision, 1);
  const revokedSessionResolution = await resolveEffectiveAgentRuntime({
    ...personalContext,
    sessionId: 'sess-runtime-snapshot',
  });
  assert.equal(revokedSessionResolution.valid, false);
  assert.equal(revokedSessionResolution.source, 'session');
  assert.equal(revokedSessionResolution.issues.some((entry) => entry.code === 'PROVIDER_INSTALLATION_NOT_ALLOWED'), true);
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId: 'sess-runtime-snapshot',
    userId: owner.id,
    agentId: 'canvas-agent',
  }), replacementSnapshot);
  await deleteWorkspaceModelPolicyStore({
    organizationId: organization.organizationId,
    workspaceId: personalWorkspaceId,
    expectedRevision: 1,
  });

  sqlite.prepare(`
    UPDATE ai_user_model_preferences
    SET thinking_level = 'corrupt'
    WHERE user_id = ? AND workspace_id = ? AND agent_id = 'canvas-agent'
  `).run(owner.id, personalWorkspaceId);
  await assert.rejects(
    () => resolveEffectiveAgentRuntime(personalContext),
    (error) => error instanceof RuntimeStoredDataError && error.code === 'RUNTIME_PREFERENCE_CORRUPT',
  );
  await resetUserRuntimePreference({ context: personalContext, expectedRevision: 1 });

  await replaceWorkspaceRuntimePolicy({
    organizationId: organization.organizationId,
    workspaceId: personalWorkspaceId,
    workspaceType: 'personal',
    actorUserId: owner.id,
    update: {
      expectedRevision: 0,
      expectedCatalogRevision: 1,
      allowedModels: [{ providerInstallationId: organizationProviderId, modelId: sharedModel }],
      defaultSelection: null,
      allowUserCredentials: true,
    },
  });
  sqlite.prepare(`
    UPDATE ai_workspace_model_policies
    SET allowed_models_json = 'not-json'
    WHERE workspace_id = ?
  `).run(personalWorkspaceId);
  await assert.rejects(
    () => resolveEffectiveAgentRuntime(personalContext),
    (error) => error instanceof RuntimeStoredDataError && error.code === 'RUNTIME_POLICY_CORRUPT',
  );

  sqlite.close();
  console.log('agent runtime resolution tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  });
