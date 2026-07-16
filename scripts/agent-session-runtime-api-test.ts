import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-session-runtime-api-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  if (request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: (providerId: string) => providerId === 'sentinel-provider'
        ? [{
            id: 'sentinel-model',
            name: 'Sentinel Model',
            provider: 'sentinel-provider',
            api: 'openai-completions',
            baseUrl: 'http://localhost:9999/v1',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 1_024,
          }]
        : [],
      getProviders: () => ['sentinel-provider'],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

function installationId(organizationId: string): string {
  return `aip_${createHash('sha256')
    .update(`${organizationId}\0openai-compatible\0organization`)
    .digest('hex')
    .slice(0, 24)}`;
}

function jsonRequest(url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { parseAiCatalogUpdate, replaceAiAppRuntimeCatalog } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const {
    readPiSessionRuntimeSnapshot,
    SessionRuntimeContextRevisionConflictError,
    SessionRuntimeSnapshotConflictError,
    writePiSessionRuntimeSnapshot,
  } = await import('../app/lib/agent-runtime-policy/runtime-store');
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const {
    createWorkspaceRecord,
    ensureDefaultWorkspaceRecords,
  } = await import('../app/lib/workspaces/service');
  const { PI_RUNTIME_CONFIG_PATH } = await import('../app/lib/agents/storage');

  const owner = await createInitialOwner({
    name: 'Session Runtime Owner',
    email: 'session-runtime-owner@example.test',
    password: 'SessionRuntimeOwnerPassword123!',
  });
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  sqlite.pragma('foreign_keys = ON');
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };
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
    name: 'Session Runtime Organization',
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

  const providerInstallationId = installationId(organization.organizationId);
  const modelA = 'runtime-model-a';
  const modelB = 'runtime-model-b';
  await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update: parseAiCatalogUpdate({
      expectedRevision: 0,
      providers: [{
        providerInstallationId,
        providerId: 'openai-compatible',
        enabled: true,
        credentialScope: 'organization',
        config: {
          openaiCompatibleBaseUrl: 'http://localhost:9900/v1',
          openaiCompatibleModelSource: 'custom',
          openaiCompatibleCustomModel: modelA,
        },
        modelIds: [modelA, modelB],
        defaultModelId: modelA,
      }],
      defaultSelection: {
        providerInstallationId,
        providerId: 'openai-compatible',
        modelId: modelA,
        thinkingLevel: 'off',
      },
    }),
    discovery: {
      'openai-compatible': {
        id: 'openai-compatible',
        name: 'OpenAI Compatible',
        source: 'self-hosted',
        models: [
          { id: modelA, name: 'Runtime Model A', reasoning: false, supportsVision: false },
          { id: modelB, name: 'Runtime Model B', reasoning: false, supportsVision: false },
        ],
      },
    },
  });
  sqlite.prepare(`
    UPDATE ai_provider_installations
    SET status = 'ready', verified_at = ?
    WHERE id = ?
  `).run(Date.now(), providerInstallationId);

  const memberId = 'session-runtime-member';
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason,
      ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, 'user', NULL, NULL, NULL, ?, ?)
  `).run(memberId, 'Runtime Member', 'session-runtime-member@example.test', now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
  `).run(organization.organizationId, memberId, now, now);

  mkdirSync(path.dirname(PI_RUNTIME_CONFIG_PATH), { recursive: true });
  const globalConfigSentinel = `${JSON.stringify({
    version: 2,
    activeProvider: 'sentinel-provider',
    providers: {
      'sentinel-provider': {
        id: 'sentinel-provider',
        model: 'sentinel-model',
        thinking: 'off',
        enabledTools: [],
      },
    },
    enabledSkills: [],
    updatedAt: '2000-01-01T00:00:00.000Z',
    updatedBy: 'session-runtime-test',
  })}\n`;
  writeFileSync(PI_RUNTIME_CONFIG_PATH, globalConfigSentinel, 'utf8');

  const { auth } = await import('../app/lib/auth');
  type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  const routeSessionFor = (input: { id: string; email: string; role: 'user' | 'admin' }) => ({
    user: {
      id: input.id,
      email: input.email,
      name: input.id,
      role: input.role,
      emailVerified: true,
      image: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    session: {
      id: `${input.id}-session`,
      token: `${input.id}-token`,
      userId: input.id,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    },
  }) as RouteSession;
  let routeSession: RouteSession | null = null;
  Reflect.set(auth.api, 'getSession', async () => routeSession);
  const sessionsRoute = await import('../app/api/sessions/route');
  const effectiveRoute = await import('../app/api/agent-runtime/effective/route');

  const effectiveUrl = `http://localhost:3000/api/agent-runtime/effective?workspaceId=${personalWorkspaceId}&agentId=canvas-agent`;
  assert.equal((await effectiveRoute.GET(new NextRequest(effectiveUrl))).status, 401);

  routeSession = routeSessionFor({ id: owner.id, email: owner.email, role: 'admin' });
  const effectiveResponse = await effectiveRoute.GET(new NextRequest(effectiveUrl));
  const effectivePayload = await effectiveResponse.json();
  assert.equal(effectiveResponse.status, 200, JSON.stringify(effectivePayload));
  assert.equal(effectivePayload.resolution.catalogRevision, 1);
  assert.equal(effectivePayload.runtime.selection.modelId, modelA);

  const selectionA = {
    providerInstallationId,
    providerId: 'openai-compatible',
    modelId: modelA,
    thinkingLevel: 'off' as const,
  };
  const selectionB = { ...selectionA, modelId: modelB };
  const inheritedCreateResponse = await sessionsRoute.POST(jsonRequest(
    'http://localhost:3000/api/sessions',
    'POST',
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      title: 'Inherited runtime session',
    },
  ));
  const inheritedCreatePayload = await inheritedCreateResponse.json();
  assert.equal(inheritedCreateResponse.status, 200, JSON.stringify(inheritedCreatePayload));
  assert.deepEqual(inheritedCreatePayload.runtime.selection, selectionA);
  assert.equal(inheritedCreatePayload.runtime.selectionSource, 'app_default');
  const inheritedEffectiveResponse = await effectiveRoute.GET(new NextRequest(
    `${effectiveUrl}&sessionId=${encodeURIComponent(inheritedCreatePayload.session.sessionId)}`,
  ));
  const inheritedEffectivePayload = await inheritedEffectiveResponse.json();
  assert.equal(inheritedEffectiveResponse.status, 200, JSON.stringify(inheritedEffectivePayload));
  assert.equal(inheritedEffectivePayload.resolution.source, 'app_default');
  assert.equal(inheritedEffectivePayload.runtime.selectionSource, 'app_default');

  const createResponse = await sessionsRoute.POST(jsonRequest(
    'http://localhost:3000/api/sessions',
    'POST',
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      title: 'Pinned runtime session',
      runtimeSelection: selectionA,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
  const sessionId = createPayload.session.sessionId as string;
  assert.ok(sessionId);
  assert.deepEqual(createPayload.runtime.selection, selectionA);
  assert.equal(createPayload.runtime.selectionSource, 'session');
  assert.deepEqual(await readPiSessionRuntimeSnapshot({
    sessionId,
    userId: owner.id,
    agentId: 'canvas-agent',
  }), createPayload.runtime);

  const preferenceCount = () => (sqlite.prepare(`
    SELECT count(*) AS count
    FROM ai_user_model_preferences
    WHERE user_id = ? AND workspace_id = ? AND agent_id = 'canvas-agent'
  `).get(owner.id, personalWorkspaceId) as { count: number }).count;
  assert.equal(preferenceCount(), 0);

  const sessionsBeforeStaleCreate = (sqlite.prepare('SELECT count(*) AS count FROM pi_sessions').get() as { count: number }).count;
  const staleCreateResponse = await sessionsRoute.POST(jsonRequest(
    'http://localhost:3000/api/sessions',
    'POST',
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: selectionA,
      expectedCatalogRevision: 0,
      expectedPolicyRevision: 0,
    },
  ));
  assert.equal(staleCreateResponse.status, 409);
  assert.equal((sqlite.prepare('SELECT count(*) AS count FROM pi_sessions').get() as { count: number }).count, sessionsBeforeStaleCreate);

  const invalidSelectionResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: { ...selectionA, modelId: 'not-allowed' },
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  const invalidSelectionPayload = await invalidSelectionResponse.json();
  assert.equal(invalidSelectionResponse.status, 409, JSON.stringify(invalidSelectionPayload));
  assert.equal(invalidSelectionPayload.code, 'MODEL_NOT_ALLOWED');

  const crossWorkspaceResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: organizationWorkspaceId,
      runtimeSelection: selectionB,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  assert.equal(crossWorkspaceResponse.status, 403);
  const crossWorkspaceEffectiveResponse = await effectiveRoute.GET(new NextRequest(
    `http://localhost:3000/api/agent-runtime/effective?workspaceId=${organizationWorkspaceId}&agentId=canvas-agent&sessionId=${encodeURIComponent(sessionId)}`,
  ));
  assert.equal(crossWorkspaceEffectiveResponse.status, 403);

  routeSession = routeSessionFor({ id: memberId, email: 'session-runtime-member@example.test', role: 'user' });
  const crossOwnerResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: selectionB,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  assert.equal(crossOwnerResponse.status, 404);

  routeSession = routeSessionFor({ id: owner.id, email: owner.email, role: 'admin' });
  const wrongAgentResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'different-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: selectionB,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  assert.equal(wrongAgentResponse.status, 404);

  // A revoked legacy snapshot must not be materialized merely to perform the busy check.
  sqlite.prepare(`
    UPDATE pi_sessions
    SET provider = 'revoked-provider', model = 'revoked-model', thinking_level = 'off',
        runtime_provider_installation_id = 'aip_000000000000000000000000',
        runtime_catalog_revision = 1, runtime_policy_revision = 0,
        runtime_selection_source = 'session'
    WHERE session_id = ? AND user_id = ?
  `).run(sessionId, owner.id);
  const validReplacementResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: selectionB,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  ));
  const validReplacementPayload = await validReplacementResponse.json();
  assert.equal(validReplacementResponse.status, 200, JSON.stringify(validReplacementPayload));
  assert.deepEqual(validReplacementPayload.runtime.selection, selectionB);
  assert.equal(preferenceCount(), 0);

  const stalePatchResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      runtimeSelection: selectionA,
      expectedCatalogRevision: 0,
      expectedPolicyRevision: 0,
    },
  ));
  assert.equal(stalePatchResponse.status, 409);
  assert.equal((await readPiSessionRuntimeSnapshot({
    sessionId,
    userId: owner.id,
    agentId: 'canvas-agent',
  }))?.selection.modelId, modelB);

  const snapshotB = (await readPiSessionRuntimeSnapshot({
    sessionId,
    userId: owner.id,
    agentId: 'canvas-agent',
  }))!;
  const snapshotA = { ...snapshotB, selection: selectionA };
  await writePiSessionRuntimeSnapshot({
    sessionId,
    userId: owner.id,
    agentId: 'canvas-agent',
    snapshot: snapshotA,
    expectedSnapshot: snapshotB,
    allowReplace: true,
    contextRevision: {
      organizationId: organization.organizationId,
      workspaceId: personalWorkspaceId,
      expectedCatalogRevision: 1,
      expectedPolicyRevision: 0,
    },
  });
  await assert.rejects(
    () => writePiSessionRuntimeSnapshot({
      sessionId,
      userId: owner.id,
      agentId: 'canvas-agent',
      snapshot: snapshotB,
      expectedSnapshot: snapshotB,
      allowReplace: true,
    }),
    (error) => error instanceof SessionRuntimeSnapshotConflictError,
  );

  sqlite.prepare(`
    UPDATE ai_runtime_defaults
    SET catalog_revision = 2
    WHERE organization_id = ?
  `).run(organization.organizationId);
  await assert.rejects(
    () => writePiSessionRuntimeSnapshot({
      sessionId,
      userId: owner.id,
      agentId: 'canvas-agent',
      snapshot: snapshotB,
      expectedSnapshot: snapshotA,
      allowReplace: true,
      contextRevision: {
        organizationId: organization.organizationId,
        workspaceId: personalWorkspaceId,
        expectedCatalogRevision: 1,
        expectedPolicyRevision: 0,
      },
    }),
    (error) => error instanceof SessionRuntimeContextRevisionConflictError
      && error.currentCatalogRevision === 2,
  );
  sqlite.prepare(`
    UPDATE ai_runtime_defaults
    SET catalog_revision = 1
    WHERE organization_id = ?
  `).run(organization.organizationId);

  const sessionEffectiveResponse = await effectiveRoute.GET(new NextRequest(
    `${effectiveUrl}&sessionId=${encodeURIComponent(sessionId)}`,
  ));
  const sessionEffectivePayload = await sessionEffectiveResponse.json();
  assert.equal(sessionEffectiveResponse.status, 200, JSON.stringify(sessionEffectivePayload));
  assert.equal(sessionEffectivePayload.resolution.source, 'session');
  assert.equal(sessionEffectivePayload.runtime.selection.modelId, modelA);

  // Legacy clients remain functional, but the compatibility path resolves the
  // exact installation through the catalog and never writes global PI config.
  const legacyPatchResponse = await sessionsRoute.PATCH(jsonRequest(
    'http://localhost:3000/api/sessions',
    'PATCH',
    {
      sessionId,
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      provider: 'openai-compatible',
      model: modelB,
      thinkingLevel: 'off',
    },
  ));
  const legacyPatchPayload = await legacyPatchResponse.json();
  assert.equal(legacyPatchResponse.status, 200, JSON.stringify(legacyPatchPayload));
  assert.equal(legacyPatchPayload.runtime.selection.providerInstallationId, providerInstallationId);
  assert.equal(legacyPatchPayload.runtime.selection.modelId, modelB);

  assert.equal(readFileSync(PI_RUNTIME_CONFIG_PATH, 'utf8'), globalConfigSentinel);
  assert.equal(preferenceCount(), 0);
  sqlite.close();
}

main()
  .then(() => {
    console.log('Agent session runtime API test passed.');
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  });
