import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-provider-verification-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

const ORGANIZATION_SECRET = 'sk-test-provider-verification-1234567890';
const WRONG_SYSTEM_SECRET = 'sk-test-wrong-system-scope-1234567890';
const originalSystemKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = WRONG_SYSTEM_SECRET;

const providerDefaultModel = {
  id: 'provider-default-model',
  name: 'Provider Default Model',
  provider: 'openrouter',
  api: 'openai-completions',
  baseUrl: 'https://openrouter.example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as const;

const memoryReviewModel = {
  ...providerDefaultModel,
  id: 'memory-review-model',
  name: 'Memory Review Model',
  contextWindow: 64_000,
  maxTokens: 4_096,
} as const;

let probeMode: 'success' | 'failure' = 'success';
const probeCalls: Array<{ modelId: string; baseUrl: string; apiKey: string | undefined }> = [];

function assistantResponse(model: typeof providerDefaultModel) {
  return {
    role: 'assistant',
    content: probeMode === 'success' ? [{ type: 'text', text: 'OK' }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: probeMode === 'success' ? 'stop' : 'error',
    errorMessage: probeMode === 'failure' ? `Provider rejected ${ORGANIZATION_SECRET}` : undefined,
    timestamp: Date.now(),
  };
}

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      completeSimple: async (
        model: typeof providerDefaultModel,
        _context: unknown,
        options: { apiKey?: string },
      ) => {
        probeCalls.push({ modelId: model.id, baseUrl: model.baseUrl, apiKey: options.apiKey });
        return assistantResponse(model);
      },
      getModels: (providerId: string) => providerId === 'openrouter' ? [providerDefaultModel, memoryReviewModel] : [],
      getProviders: () => ['openrouter'],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') {
    return { getOAuthProvider: () => null };
  }
  return originalLoad(request, parent, isMain);
};

function installationId(organizationId: string, providerId: string, credentialScope: string): string {
  return `aip_${createHash('sha256')
    .update(`${organizationId}\0${providerId}\0${credentialScope}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function insertUserWithOrganizationRole(input: {
  sqlite: Database.Database;
  organizationId: string;
  userId: string;
  globalRole: 'user' | 'admin';
  organizationRole: 'member' | 'admin';
}) {
  const now = Date.now();
  input.sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    input.userId,
    input.userId,
    `${input.userId}@example.test`,
    input.globalRole,
    now,
    now,
  );
  input.sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
  `).run(input.organizationId, input.userId, input.organizationRole, now, now);
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const {
    ProviderVerificationError,
    verifyProviderInstallation,
  } = await import('../app/lib/agent-runtime-policy/provider-verification-service');
  const { verifyAndConfigureMemoryReviewRuntime } = await import('../app/lib/memory/runtime-configuration');
  const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');

  const owner = await createInitialOwner({
    name: 'Provider Verification Owner',
    email: 'provider-verification@example.test',
    password: 'ProviderVerificationPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  sqlite.pragma('foreign_keys = ON');
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
  assert.ok(organization.organizationId);

  await replaceScopedEnvEntries(
    'agents',
    [{ key: 'OPENROUTER_API_KEY', value: ORGANIZATION_SECRET }],
    { secretScope: 'organization', organizationId: organization.organizationId },
  );

  const providerInstallationId = installationId(organization.organizationId, 'openrouter', 'organization');
  const decoyAppDefaultModelId = memoryReviewModel.id;
  const discovery = {
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      source: 'built-in' as const,
      models: [
        {
          id: providerDefaultModel.id,
          name: providerDefaultModel.name,
          reasoning: false,
          supportsVision: false,
          contextWindow: providerDefaultModel.contextWindow,
          maxTokens: providerDefaultModel.maxTokens,
        },
        {
          id: decoyAppDefaultModelId,
          name: memoryReviewModel.name,
          reasoning: false,
          supportsVision: false,
          contextWindow: 64_000,
          maxTokens: 4_096,
        },
      ],
    },
  };
  const catalog = await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update: parseAiCatalogUpdate({
      expectedRevision: 0,
      providers: [{
        providerInstallationId,
        providerId: 'openrouter',
        enabled: true,
        credentialScope: 'organization',
        config: { authMethod: 'api-key' },
        modelIds: [providerDefaultModel.id, decoyAppDefaultModelId],
        defaultModelId: providerDefaultModel.id,
      }],
      defaultSelection: {
        providerInstallationId,
        providerId: 'openrouter',
        modelId: decoyAppDefaultModelId,
        thinkingLevel: 'off',
      },
    }),
    discovery,
  });
  assert.equal(catalog.providers[0].status, 'unverified');

  const defaultsBefore = sqlite.prepare(`
    SELECT provider_installation_id AS providerInstallationId, provider_id AS providerId,
           model_id AS modelId, thinking_level AS thinkingLevel, catalog_revision AS catalogRevision
    FROM ai_runtime_defaults
    WHERE organization_id = ?
  `).get(organization.organizationId) as {
    providerInstallationId: string;
    providerId: string;
    modelId: string;
    thinkingLevel: string;
    catalogRevision: number;
  };
  const modelsBefore = sqlite.prepare(`
    SELECT model_id AS modelId, enabled, is_provider_default AS isProviderDefault
    FROM ai_provider_models
    WHERE organization_id = ? AND provider_installation_id = ?
    ORDER BY model_id
  `).all(organization.organizationId, providerInstallationId);

  const instanceOnlyUserId = 'provider-instance-only-admin';
  const organizationOnlyUserId = 'provider-organization-only-admin';
  insertUserWithOrganizationRole({
    sqlite,
    organizationId: organization.organizationId,
    userId: instanceOnlyUserId,
    globalRole: 'admin',
    organizationRole: 'member',
  });
  insertUserWithOrganizationRole({
    sqlite,
    organizationId: organization.organizationId,
    userId: organizationOnlyUserId,
    globalRole: 'user',
    organizationRole: 'admin',
  });

  const { auth } = await import('../app/lib/auth');
  type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  let routeSession: RouteSession | null = null;
  Reflect.set(auth.api, 'getSession', async () => routeSession);
  const verifyRoute = await import('../app/api/admin/agent-runtime/providers/[installationId]/verify/route');
  const routeContext = { params: Promise.resolve({ installationId: providerInstallationId }) };
  const routeUrl = `http://localhost:3000/api/admin/agent-runtime/providers/${providerInstallationId}/verify`;
  const routeSessionFor = (input: { userId: string; email: string; role: 'user' | 'admin' }) => ({
    user: {
      id: input.userId,
      email: input.email,
      name: input.userId,
      role: input.role,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    session: {
      id: `${input.userId}-session`,
      token: `${input.userId}-token`,
      userId: input.userId,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    },
  }) as RouteSession;

  const unauthorized = await verifyRoute.POST(
    new NextRequest(routeUrl, { method: 'POST' }),
    routeContext,
  );
  assert.equal(unauthorized.status, 401);

  routeSession = routeSessionFor({
    userId: organizationOnlyUserId,
    email: `${organizationOnlyUserId}@example.test`,
    role: 'user',
  });
  const missingInstanceAdmin = await verifyRoute.POST(
    new NextRequest(routeUrl, { method: 'POST' }),
    routeContext,
  );
  assert.equal(missingInstanceAdmin.status, 403);

  routeSession = routeSessionFor({
    userId: instanceOnlyUserId,
    email: `${instanceOnlyUserId}@example.test`,
    role: 'admin',
  });
  const missingOrganizationAdmin = await verifyRoute.POST(
    new NextRequest(routeUrl, { method: 'POST' }),
    routeContext,
  );
  assert.equal(missingOrganizationAdmin.status, 403);

  routeSession = routeSessionFor({ userId: owner.id, email: owner.email, role: 'admin' });
  const unexpectedBody = await verifyRoute.POST(
    new NextRequest(routeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: ORGANIZATION_SECRET }),
    }),
    routeContext,
  );
  assert.equal(unexpectedBody.status, 400);
  assert.equal(JSON.stringify(await unexpectedBody.json()).includes(ORGANIZATION_SECRET), false);
  assert.equal(probeCalls.length, 0);

  const emptyBodyRequest = new NextRequest(routeUrl, { method: 'POST', body: '' });
  assert.notEqual(emptyBodyRequest.body, null);
  const verifiedResponse = await verifyRoute.POST(emptyBodyRequest, routeContext);
  assert.equal(verifiedResponse.status, 200);
  const verifiedPayload = await verifiedResponse.json();
  assert.equal(verifiedPayload.success, true);
  assert.equal(verifiedPayload.data.modelId, providerDefaultModel.id);
  assert.equal(verifiedPayload.data.status, 'ready');
  assert.equal(JSON.stringify(verifiedPayload).includes(ORGANIZATION_SECRET), false);
  assert.deepEqual(probeCalls[0], {
    modelId: providerDefaultModel.id,
    baseUrl: providerDefaultModel.baseUrl,
    apiKey: ORGANIZATION_SECRET,
  });
  const explicitMemoryRuntime = await verifyAndConfigureMemoryReviewRuntime({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    providerInstallationId,
    modelId: memoryReviewModel.id,
    expectedCatalogRevision: verifiedPayload.data.catalogRevision,
  });
  assert.equal(explicitMemoryRuntime.verification.success, true);
  assert.equal(explicitMemoryRuntime.verification.modelId, memoryReviewModel.id);
  assert.equal(probeCalls.at(-1)?.modelId, memoryReviewModel.id);
  const memoryRuntime = sqlite.prepare(`
    SELECT provider_installation_id AS providerInstallationId, model_id AS modelId,
      verified_catalog_revision AS verifiedCatalogRevision, configured_by_user_id AS configuredByUserId
    FROM memory_review_runtime_settings
    WHERE organization_id = ?
  `).get(organization.organizationId) as {
    providerInstallationId: string;
    modelId: string;
    verifiedCatalogRevision: number;
    configuredByUserId: string;
  };
  assert.deepEqual(memoryRuntime, {
    providerInstallationId,
    modelId: memoryReviewModel.id,
    verifiedCatalogRevision: explicitMemoryRuntime.verification.catalogRevision,
    configuredByUserId: owner.id,
  });

  const verifiedProvider = sqlite.prepare(`
    SELECT status, verified_at AS verifiedAt, verified_by_user_id AS verifiedByUserId, revision
    FROM ai_provider_installations
    WHERE organization_id = ? AND id = ?
  `).get(organization.organizationId, providerInstallationId) as {
    status: string;
    verifiedAt: number;
    verifiedByUserId: string;
    revision: number;
  };
  assert.equal(verifiedProvider.status, 'ready');
  assert.equal(verifiedProvider.verifiedByUserId, owner.id);
  assert.equal(verifiedProvider.verifiedAt > 0, true);

  const abortedController = new AbortController();
  abortedController.abort(new Error('admin request disconnected'));
  const probesBeforeAbort = probeCalls.length;
  await assert.rejects(
    () => verifyProviderInstallation({
      organizationId: organization.organizationId,
      actorUserId: owner.id,
      providerInstallationId,
      signal: abortedController.signal,
    }),
    (error) => error instanceof ProviderVerificationError
      && error.code === 'PROVIDER_VERIFICATION_ABORTED',
  );
  assert.equal(probeCalls.length, probesBeforeAbort);
  const providerAfterAbort = sqlite.prepare(`
    SELECT status, verified_at AS verifiedAt, verified_by_user_id AS verifiedByUserId, revision
    FROM ai_provider_installations
    WHERE organization_id = ? AND id = ?
  `).get(organization.organizationId, providerInstallationId) as typeof verifiedProvider;
  assert.deepEqual(providerAfterAbort, verifiedProvider, 'Aborted verification must not mutate provider status.');

  const defaultsAfterSuccess = sqlite.prepare(`
    SELECT provider_installation_id AS providerInstallationId, provider_id AS providerId,
           model_id AS modelId, thinking_level AS thinkingLevel, catalog_revision AS catalogRevision
    FROM ai_runtime_defaults
    WHERE organization_id = ?
  `).get(organization.organizationId) as typeof defaultsBefore;
  assert.deepEqual(
    { ...defaultsAfterSuccess, catalogRevision: defaultsBefore.catalogRevision },
    defaultsBefore,
  );
  assert.equal(defaultsAfterSuccess.catalogRevision, defaultsBefore.catalogRevision + 2);
  const modelsAfterSuccess = sqlite.prepare(`
    SELECT model_id AS modelId, enabled, is_provider_default AS isProviderDefault
    FROM ai_provider_models
    WHERE organization_id = ? AND provider_installation_id = ?
    ORDER BY model_id
  `).all(organization.organizationId, providerInstallationId);
  assert.deepEqual(modelsAfterSuccess, modelsBefore);

  probeMode = 'failure';
  const failedResponse = await verifyRoute.POST(
    new NextRequest(routeUrl, { method: 'POST' }),
    routeContext,
  );
  assert.equal(failedResponse.status, 502);
  const failedPayload = await failedResponse.json();
  assert.equal(failedPayload.success, false);
  assert.equal(failedPayload.code, 'MODEL_TEST_FAILED');
  assert.equal(failedPayload.data.status, 'degraded');
  assert.equal(JSON.stringify(failedPayload).includes(ORGANIZATION_SECRET), false);
  const degradedProvider = sqlite.prepare(`
    SELECT status, verified_at AS verifiedAt, verified_by_user_id AS verifiedByUserId
    FROM ai_provider_installations
    WHERE organization_id = ? AND id = ?
  `).get(organization.organizationId, providerInstallationId) as {
    status: string;
    verifiedAt: number;
    verifiedByUserId: string;
  };
  assert.equal(degradedProvider.status, 'degraded');
  assert.equal(degradedProvider.verifiedAt, verifiedProvider.verifiedAt);
  assert.equal(degradedProvider.verifiedByUserId, owner.id);

  sqlite.prepare(`
    UPDATE ai_provider_installations
    SET status = 'unverified', verified_at = NULL, verified_by_user_id = NULL
    WHERE organization_id = ? AND id = ?
  `).run(organization.organizationId, providerInstallationId);
  const neverVerifiedFailure = await verifyProviderInstallation({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    providerInstallationId,
  });
  assert.equal(neverVerifiedFailure.success, false);
  assert.equal(neverVerifiedFailure.status, 'unverified');
  assert.equal(neverVerifiedFailure.verifiedAt, null);

  const probesBeforeWrongOrganization = probeCalls.length;
  await assert.rejects(
    () => verifyProviderInstallation({
      organizationId: 'different-organization',
      actorUserId: owner.id,
      providerInstallationId,
    }),
    (error) => error instanceof ProviderVerificationError
      && error.code === 'PROVIDER_INSTALLATION_NOT_FOUND',
  );
  assert.equal(probeCalls.length, probesBeforeWrongOrganization);

  const auditRows = sqlite.prepare(`
    SELECT summary, metadata_json AS metadataJson, input_hash AS inputHash,
           output_hash AS outputHash, secret_ref AS secretRef
    FROM audit_events
    WHERE action = 'ai_provider_installation.verify'
  `).all();
  assert.equal(auditRows.length >= 3, true);
  assert.equal(JSON.stringify(auditRows).includes(ORGANIZATION_SECRET), false);
  assert.equal(JSON.stringify(auditRows).includes(WRONG_SYSTEM_SECRET), false);

  probeMode = 'success';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await verifyRoute.POST(
      new NextRequest(routeUrl, { method: 'POST' }),
      routeContext,
    );
    assert.equal(response.status, 200);
  }
  const probesBeforeRateLimit = probeCalls.length;
  const rateLimited = await verifyRoute.POST(
    new NextRequest(routeUrl, { method: 'POST' }),
    routeContext,
  );
  assert.equal(rateLimited.status, 429);
  assert.equal(probeCalls.length, probesBeforeRateLimit);

  const onboardingVerifyRoute = await import('../app/api/onboarding/provider-verify/route');
  const onboardingVerified = await onboardingVerifyRoute.POST(new NextRequest(
    'http://localhost:3000/api/onboarding/provider-verify',
    { method: 'POST' },
  ));
  assert.equal(onboardingVerified.status, 200);
  const onboardingPayload = await onboardingVerified.json();
  assert.equal(onboardingPayload.success, true);
  assert.equal(onboardingPayload.data.providerInstallationId, providerInstallationId);
  assert.equal(onboardingPayload.data.modelId, providerDefaultModel.id);
  const { getServerSettings } = await import('../app/lib/server-settings');
  const serverSettings = await getServerSettings();
  assert.equal(serverSettings.providerVerifiedInstallationId, providerInstallationId);
  assert.equal(serverSettings.providerVerifiedCatalogRevision, onboardingPayload.data.catalogRevision);

  sqlite.close();
  console.log('agent-runtime-provider-verification-test: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    if (originalSystemKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalSystemKey;
    rmSync(dataDir, { recursive: true, force: true });
  });
