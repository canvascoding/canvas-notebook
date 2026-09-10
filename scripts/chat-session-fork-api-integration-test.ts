import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { piMetadataFixture, piToolMetadataFixture } from './helpers/pi-message-fixture';

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-fork-api-'));
  process.env.DATA = dataDir;
  const testDatabase = await createPiTestDatabase();
  const { db } = testDatabase;
  const userId = 'fork-api-user';
  const agentId = 'fork-api-agent';
  const sourceSessionId = 'fork-api-source';
  const workspace = { workspaceId: 'fork-api-workspace', workspaceType: 'personal', organizationId: 'fork-api-org', projectId: null, customerId: null };
  let authenticatedUser: string | null = userId;
  let workspaceAllowed = true;
  let agentAllowed = true;
  let active = false;
  let prepared = 0;
  let audited = 0;
  const now = new Date();
  const runtimeSnapshot = {
    selection: { providerInstallationId: 'fixture-installation', providerId: 'openai', modelId: 'fixture-model', thinkingLevel: 'high' },
    catalogRevision: 1, policyRevision: 1, selectionSource: 'session',
  };
  // Real POST handler, ownership/workspace checks, fork service, transactions,
  // and migrated PostgreSQL schema. External auth/policy/runtime edges are fixtures.
  const mocks: Record<string, unknown> = {
    auth: { auth: { api: { getSession: async () => authenticatedUser ? { user: { id: authenticatedUser, name: 'Fixture', email: 'fixture@example.test' } } : null } } },
    'utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    'agents/registry': { normalizeManagedAgentId: (value: string | null) => value || agentId },
    'agents/access': { requireAgentAccess: async (id: string, agent: string, permission: string, scope: unknown) => {
      assert.deepEqual([id, agent, permission], [userId, agentId, 'canUse']);
      assert.deepEqual(scope, { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, projectId: null });
      if (!agentAllowed) throw new Error('fixture denial');
    } },
    'agent-runtime-policy/runtime-service': { runtimeErrorResponse: () => ({ status: 500, code: 'FIXTURE_ERROR', message: 'Unexpected failure' }) },
    'agent-runtime-policy/session-runtime-service': { prepareSessionRuntimeSnapshot: async (input: { context: Record<string, unknown> }) => {
      assert.equal(input.context.userId, userId);
      assert.equal(input.context.sessionId, sourceSessionId);
      prepared += 1;
      return { snapshot: runtimeSnapshot };
    } },
    'pi/runtime-service': {
      withRuntimeSessionOperation: async (sessionId: string, id: string, operation: () => Promise<unknown>) => {
        assert.deepEqual([sessionId, id], [sourceSessionId, userId]);
        return operation();
      },
      getActiveRuntimeStatusSummaries: async () => active ? { [sourceSessionId]: { phase: 'running' } } : {},
    },
    'pi/system-prompt-snapshot': { ensurePiSessionSystemPromptSnapshot: async () => ({ systemPrompt: 'Fixture prompt', systemPromptHash: 'fixture-hash', systemPromptCreatedAt: now }) },
    'pi/session-workspace-context': {
      resolveAgentSessionWorkspaceForUser: async (input: { userId: string; workspaceId: string; permissions: string[] }) => {
        assert.equal(input.userId, userId);
        assert.deepEqual(input.permissions, ['canRead', 'canRunAgent']);
        if (!workspaceAllowed) throw new Error('fixture denial');
        return { ...workspace, workspaceId: input.workspaceId };
      },
      storedPiSessionWorkspaceToSummary: () => workspace,
    },
    'audit/audit-service': { recordAuditEvent: async (event: Record<string, unknown>) => {
      assert.equal(event.action, 'pi_session.fork');
      assert.equal(event.userId, userId);
      audited += 1;
    } },
  };
  const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function load(request, parent, isMain) {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
    const libPath = request.replace(/^.*(?:@\/app\/lib\/|\/app\/lib\/)/u, '').replace(/\.ts$/u, '');
    if (Object.hasOwn(mocks, libPath)) return mocks[libPath];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { piMessages, piSessions, user } = await import('../app/lib/db/schema');
    await db.insert(user).values({ id: userId, name: 'Fixture', email: 'fork-api@example.test', emailVerified: true, createdAt: now, updatedAt: now });
    const [source] = await db.insert(piSessions).values({
      sessionId: sourceSessionId, userId, agentId, provider: 'openai', model: 'fixture-model',
      title: 'API replay', titleGenerationState: 'manual', ...workspace, createdAt: now, updatedAt: now,
    }).returning();
    const messages = [
      { role: 'user', content: 'Inspect this.', timestamp: 999 }, piMetadataFixture, piToolMetadataFixture,
      { ...piMetadataFixture, content: [{ type: 'text', text: 'Done.', textSignature: '/opaque/final/signature==' }], stopReason: 'stop', endTurn: true, timestamp: 1_002 },
    ];
    await db.insert(piMessages).values(messages.map((message, index) => ({
      piSessionDbId: source.id, role: message.role, content: JSON.stringify(message), timestamp: message.timestamp, sequence: index + 1,
    })));
    const { POST } = await import('../app/api/sessions/[sessionId]/fork/route');
    const requestFork = (overrides: Record<string, unknown> = {}) => POST(new NextRequest('http://localhost/api/sessions/fixture/fork', {
      method: 'POST', body: JSON.stringify({ agentId, workspaceId: workspace.workspaceId, clientRequestId: 'fixture-request', throughSequence: 4, ...overrides }),
      headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ sessionId: sourceSessionId }) });

    authenticatedUser = null;
    assert.equal((await requestFork()).status, 401);
    authenticatedUser = 'different-user';
    assert.equal((await requestFork()).status, 404, 'another user cannot discover or fork this session');
    authenticatedUser = userId;
    assert.equal((await requestFork({ throughSequence: 0 })).status, 400);
    workspaceAllowed = false;
    assert.equal((await requestFork()).status, 403);
    workspaceAllowed = true;
    assert.equal((await requestFork({ workspaceId: 'other-workspace' })).status, 403);
    agentAllowed = false;
    assert.equal((await requestFork()).status, 403);
    agentAllowed = true;
    active = true;
    assert.equal((await requestFork()).status, 409);
    active = false;
    assert.equal(prepared, 0, 'denied or active runs must not prepare a runtime');
    assert.equal((await db.select().from(piSessions)).length, 1);

    const response = await requestFork();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const result = await response.json();
    assert.equal(result.created, true);
    assert.equal(result.copiedMessageCount, 4);
    assert.equal(result.session.engine, 'pi');
    const copied = await db.select().from(piMessages).where(eq(piMessages.piSessionDbId, result.session.id)).orderBy(asc(piMessages.sequence));
    assert.deepEqual(copied.map((message) => message.content), messages.map((message) => JSON.stringify(message)));
    const repeated = await (await requestFork()).json();
    assert.equal(repeated.created, false);
    assert.equal(repeated.session.sessionId, result.session.sessionId);
    assert.equal(audited, 1, 'idempotent retry must not duplicate the audit event');
    const invalidBoundary = await requestFork({ throughSequence: 2, clientRequestId: 'invalid-tool-boundary' });
    assert.equal(invalidBoundary.status, 409);
    assert.equal((await invalidBoundary.json()).code, 'INVALID_FORK_POINT');
    assert.equal((await db.select().from(piSessions)).length, 2, 'a rejected fork must not leave partial session data');
    console.log('Chat fork API → PostgreSQL metadata and access integration passed');
  } finally {
    moduleLoader._load = originalLoad;
    await testDatabase.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
