import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-chat-session-fork-api-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_DEPLOYMENT_MODE = 'single_user';
process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      getModels: () => [],
      getProviders: () => [],
      registerBuiltInApiProviders: () => undefined,
    };
  }
  return originalLoad(request, parent, isMain);
};

function providerInstallationId(organizationId: string): string {
  return `aip_${createHash('sha256')
    .update(`${organizationId}\0openai-compatible\0organization`)
    .digest('hex')
    .slice(0, 24)}`;
}

function jsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function routeContext(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

async function main(): Promise<void> {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    parseAiCatalogUpdate,
    replaceAiAppRuntimeCatalog,
  } = await import('../app/lib/agent-runtime-policy/catalog-service');
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const {
    createWorkspaceRecord,
    ensureDefaultWorkspaceRecords,
  } = await import('../app/lib/workspaces/service');

  const owner = await createInitialOwner({
    name: 'Chat Fork API Owner',
    email: 'chat-fork-api-owner@example.test',
    password: 'ChatForkApiOwnerPassword123!',
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
    name: 'Fork API Organization',
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

  const installationId = providerInstallationId(organization.organizationId);
  const modelId = 'fork-api-model';
  await replaceAiAppRuntimeCatalog({
    organizationId: organization.organizationId,
    actorUserId: owner.id,
    update: parseAiCatalogUpdate({
      expectedRevision: 0,
      providers: [{
        providerInstallationId: installationId,
        providerId: 'openai-compatible',
        enabled: true,
        credentialScope: 'organization',
        config: {
          openaiCompatibleBaseUrl: 'http://localhost:9900/v1',
          openaiCompatibleModelSource: 'custom',
          openaiCompatibleCustomModel: modelId,
        },
        modelIds: [modelId],
        defaultModelId: modelId,
      }],
      defaultSelection: {
        providerInstallationId: installationId,
        providerId: 'openai-compatible',
        modelId,
        thinkingLevel: 'off',
      },
    }),
    discovery: {
      'openai-compatible': {
        id: 'openai-compatible',
        name: 'OpenAI Compatible',
        source: 'self-hosted',
        models: [{
          id: modelId,
          name: 'Fork API Model',
          reasoning: false,
          supportsVision: false,
        }],
      },
    },
  });
  sqlite.prepare(`
    UPDATE ai_provider_installations
    SET status = 'ready', verified_at = ?
    WHERE id = ?
  `).run(Date.now(), installationId);

  const memberId = 'chat-fork-api-member';
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason,
      ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, 'user', NULL, NULL, NULL, ?, ?)
  `).run(memberId, 'Chat Fork API Member', 'chat-fork-api-member@example.test', now, now);
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
  `).run(organization.organizationId, memberId, now, now);

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
  const forkRoute = await import('../app/api/sessions/[sessionId]/fork/route');
  routeSession = routeSessionFor({ id: owner.id, email: owner.email, role: 'admin' });
  const createResponse = await sessionsRoute.POST(jsonRequest(
    'http://localhost:3000/api/sessions',
    {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      title: 'Fork API Chat',
    },
  ));
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
  const sourceSessionId = createPayload.session.sessionId as string;
  const source = sqlite.prepare(`
    SELECT id
    FROM pi_sessions
    WHERE session_id = ? AND user_id = ?
  `).get(sourceSessionId, owner.id) as { id: number };

  const userMessage = JSON.stringify({
    role: 'user',
    content: 'Where should we start?',
    timestamp: now + 1_000,
  });
  const assistantMessage = JSON.stringify({
    role: 'assistant',
    content: [{ type: 'text', text: 'Start with the launch brief.' }],
    provider: 'openai-compatible',
    model: modelId,
    stopReason: 'stop',
    timestamp: now + 2_000,
  });
  sqlite.prepare(`
    INSERT INTO pi_messages (pi_session_db_id, role, content, timestamp, sequence)
    VALUES (?, 'user', ?, ?, 1), (?, 'assistant', ?, ?, 2)
  `).run(source.id, userMessage, now + 1_000, source.id, assistantMessage, now + 2_000);

  routeSession = null;
  const unauthorizedResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, {}),
    routeContext(sourceSessionId),
  );
  assert.equal(unauthorizedResponse.status, 401);

  routeSession = routeSessionFor({ id: owner.id, email: owner.email, role: 'admin' });
  const crossWorkspaceResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, {
      agentId: 'canvas-agent',
      workspaceId: organizationWorkspaceId,
      throughSequence: 2,
      clientRequestId: 'fork-api-cross-workspace',
    }),
    routeContext(sourceSessionId),
  );
  assert.equal(crossWorkspaceResponse.status, 403);

  const invalidPointResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, {
      agentId: 'canvas-agent',
      workspaceId: personalWorkspaceId,
      throughSequence: 1,
      clientRequestId: 'fork-api-invalid-point',
    }),
    routeContext(sourceSessionId),
  );
  const invalidPointPayload = await invalidPointResponse.json();
  assert.equal(invalidPointResponse.status, 409, JSON.stringify(invalidPointPayload));
  assert.equal(invalidPointPayload.code, 'INVALID_FORK_POINT');

  const forkRequest = {
    agentId: 'canvas-agent',
    workspaceId: personalWorkspaceId,
    throughSequence: 2,
    clientRequestId: 'fork-api-success',
  };
  const forkResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, forkRequest),
    routeContext(sourceSessionId),
  );
  const forkPayload = await forkResponse.json();
  assert.equal(forkResponse.status, 200, JSON.stringify(forkPayload));
  assert.equal(forkPayload.created, true);
  assert.equal(forkPayload.copiedMessageCount, 2);
  assert.equal(forkPayload.session.title, 'Fork API Chat (2)');
  assert.equal(forkPayload.session.forkedFromSessionId, sourceSessionId);
  assert.equal(forkPayload.session.forkedFromSequence, 2);
  assert.equal(forkPayload.session.engine, 'pi');
  assert.equal(forkPayload.session.workspace.workspaceId, personalWorkspaceId);

  const forkSessionId = forkPayload.session.sessionId as string;
  const forkRow = sqlite.prepare(`
    SELECT id, client_request_id AS clientRequestId,
           forked_from_session_id AS forkedFromSessionId,
           forked_from_sequence AS forkedFromSequence
    FROM pi_sessions
    WHERE session_id = ? AND user_id = ?
  `).get(forkSessionId, owner.id) as {
    id: number;
    clientRequestId: string;
    forkedFromSessionId: string;
    forkedFromSequence: number;
  };
  assert.equal(forkRow.clientRequestId, forkRequest.clientRequestId);
  assert.equal(forkRow.forkedFromSessionId, sourceSessionId);
  assert.equal(forkRow.forkedFromSequence, 2);
  assert.deepEqual(sqlite.prepare(`
    SELECT role, content, timestamp, sequence
    FROM pi_messages
    WHERE pi_session_db_id = ?
    ORDER BY sequence ASC
  `).all(forkRow.id), [
    { role: 'user', content: userMessage, timestamp: now + 1_000, sequence: 1 },
    { role: 'assistant', content: assistantMessage, timestamp: now + 2_000, sequence: 2 },
  ]);
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM session_channel_links
    WHERE session_id = ? AND user_id = ? AND channel_id = 'web'
  `).get(forkSessionId, owner.id) as { count: number }).count, 1);
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_events
    WHERE session_id = ? AND action = 'pi_session.fork' AND status = 'success'
  `).get(forkSessionId) as { count: number }).count, 1);

  const retryResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, forkRequest),
    routeContext(sourceSessionId),
  );
  const retryPayload = await retryResponse.json();
  assert.equal(retryResponse.status, 200, JSON.stringify(retryPayload));
  assert.equal(retryPayload.created, false);
  assert.equal(retryPayload.session.sessionId, forkSessionId);
  assert.equal((sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_events
    WHERE session_id = ? AND action = 'pi_session.fork'
  `).get(forkSessionId) as { count: number }).count, 1, 'idempotent retries must not duplicate audit events');

  const secondResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, {
      ...forkRequest,
      clientRequestId: 'fork-api-second',
    }),
    routeContext(sourceSessionId),
  );
  const secondPayload = await secondResponse.json();
  assert.equal(secondResponse.status, 200, JSON.stringify(secondPayload));
  assert.equal(secondPayload.session.title, 'Fork API Chat (3)');

  const nestedResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${forkSessionId}/fork`, {
      ...forkRequest,
      clientRequestId: 'fork-api-nested',
    }),
    routeContext(forkSessionId),
  );
  const nestedPayload = await nestedResponse.json();
  assert.equal(nestedResponse.status, 200, JSON.stringify(nestedPayload));
  assert.equal(nestedPayload.session.title, 'Fork API Chat (4)');

  routeSession = routeSessionFor({
    id: memberId,
    email: 'chat-fork-api-member@example.test',
    role: 'user',
  });
  const crossOwnerResponse = await forkRoute.POST(
    jsonRequest(`http://localhost:3000/api/sessions/${sourceSessionId}/fork`, {
      ...forkRequest,
      clientRequestId: 'fork-api-cross-owner',
    }),
    routeContext(sourceSessionId),
  );
  assert.equal(crossOwnerResponse.status, 404);

  sqlite.close();
}

main()
  .then(() => {
    console.log('[Chat Session Fork API Integration Test] passed');
  })
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error('[Chat Session Fork API Integration Test] failed:', error);
    process.exitCode = 1;
  });
