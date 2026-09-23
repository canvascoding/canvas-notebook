import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const database = await createPiTestDatabase();
  const { db } = database;
  const now = new Date();
  let prepared = 0;
  let denyPreparation = false;
  let agentAllowed = true;
  let failLink = false;
  const links: string[] = [];
  const audits: string[] = [];
  const snapshot = {
    selection: { providerInstallationId: 'installation', providerId: 'openai', modelId: 'fixture-model', thinkingLevel: 'high' },
    catalogRevision: 0, policyRevision: 0, selectionSource: 'session',
  };
  const mocks: Record<string, unknown> = {
    auth: { auth: { api: { getSession: async () => ({ user: { id: 'owner', name: 'Owner', email: 'owner@test.invalid' } }) } } },
    'utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    'agents/catalog': { isAgentId: () => true },
    'agents/registry': { normalizeManagedAgentId: (value: string) => value || 'main', getAgentProfile: async () => ({ id: 'main' }) },
    'agents/runtime': { getActiveAiAgentEngine: () => 'pi' },
    'agents/storage': { readAgentRuntimeConfig: async () => ({}), providerIdToAgentId: () => 'main' },
    'agents/access': { requireAgentAccess: async () => { if (!agentAllowed) throw new Error('Access lost'); } },
    'channels/agents': { ensureDefaultAgent: async () => {} },
    'channels/channel-links': { ensureSessionChannelLink: async (input: { sessionId: string }) => { if (failLink) throw new Error('Link failed'); links.push(input.sessionId); } },
    'pi/runtime-service': {},
    'pi/system-prompt-snapshot': { createPiSystemPromptSnapshot: async () => ({ systemPrompt: 'Private snapshot', systemPromptHash: 'hash', systemPromptCreatedAt: now }) },
    'agent-runtime-policy/session-runtime-service': {
      hasSessionRuntimeUpdate: () => false,
      prepareSessionRuntimeSnapshot: async () => {
        prepared++;
        if (denyPreparation) throw new Error('Catalog revision changed');
        return { snapshot, resolution: { providers: [] } };
      },
    },
    'pi/session-workspace-context': {
      resolveAgentSessionWorkspaceForUser: async (input: { workspaceId: string }) => ({ workspaceId: input.workspaceId || 'workspace', workspaceType: 'personal', organizationId: 'org', projectId: null }),
      workspaceToPiSessionFields: (workspace: object) => workspace,
      storedPiSessionWorkspaceToSummary: (row: { workspaceId: string }) => ({ workspaceId: row.workspaceId, workspaceType: 'personal', workspaceName: 'Test' }),
    },
    'audit/audit-service': { recordAuditEvent: async (input: { sessionId: string }) => { audits.push(input.sessionId); } },
  };
  const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (request, parent, isMain) => {
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => {} };
    }
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    const libPath = request.replace(/^.*(?:@\/app\/lib\/|\/app\/lib\/)/u, '').replace(/\.ts$/u, '');
    if (Object.hasOwn(mocks, libPath)) return mocks[libPath];
    return originalLoad(request, parent, isMain);
  };
  try {
    const { piSessions, user } = await import('../app/lib/db/schema');
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@test.invalid', emailVerified: true, createdAt: now, updatedAt: now });
    const { POST } = await import('../app/api/sessions/route');
    const create = (overrides: Record<string, unknown> = {}) => POST(new NextRequest('https://canvas.test/api/sessions', {
      method: 'POST', body: JSON.stringify({ workspaceId: 'workspace', agentId: 'main', clientRequestId: 'creation-key', ...overrides }),
      headers: { 'content-type': 'application/json' },
    }));
    const firstResponse = await create();
    assert.equal(firstResponse.status, 200, JSON.stringify(await firstResponse.clone().json()));
    const first = await firstResponse.json();
    assert.equal(first.created, true);
    assert.equal(first.session.systemPromptSnapshot, undefined);
    assert.equal(typeof first.session.title, 'string');
    assert.deepEqual(first.runtime, snapshot);
    assert.equal(prepared, 1);
    denyPreparation = true;
    const replayResponse = await create();
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.created, false);
    assert.equal(replay.session.sessionId, first.session.sessionId);
    assert.deepEqual(replay.runtime, snapshot);
    assert.equal(replay.resolution, undefined);
    assert.equal(prepared, 1, 'Replay must bypass current catalog/policy checks');
    assert.deepEqual(audits, [first.session.sessionId]);
    assert.deepEqual(links, [first.session.sessionId, first.session.sessionId]);
    assert.equal((await create({ workspaceId: 'other-workspace' })).status, 409);
    assert.equal((await create({ agentId: 'other-agent' })).status, 409);
    assert.equal((await create({ clientRequestId: '' })).status, 400);
    agentAllowed = false;
    assert.equal((await create()).status, 403);
    agentAllowed = true;
    denyPreparation = false;

    // Store-level serialization is exercised by two first requests, not mocked.
    const concurrent = await Promise.all([create({ clientRequestId: 'concurrent-key' }), create({ clientRequestId: 'concurrent-key' })]);
    const bodies = await Promise.all(concurrent.map(response => response.json()));
    assert.ok(bodies.every(body => body.success), JSON.stringify(bodies));
    assert.equal(bodies[0].session.sessionId, bodies[1].session.sessionId);
    assert.deepEqual(bodies.map(body => body.created).sort(), [false, true]);

    // A committed row is replayable even when the first response failed after commit.
    failLink = true;
    const failed = await create({ clientRequestId: 'link-retry' });
    assert.equal(failed.status, 500);
    failLink = false;
    denyPreparation = true;
    const healedResponse = await create({ clientRequestId: 'link-retry' });
    assert.equal(healedResponse.status, 200);
    const healed = await healedResponse.json();
    assert.equal(healed.created, false);
    assert.equal(links.at(-1), healed.session.sessionId);
    assert.equal((await db.select().from(piSessions)).length, 3);
    await database.getPostgresRuntimeQueryable().exec('DROP INDEX idx_pi_sessions_user_client_request');
    await db.insert(piSessions).values({
      sessionId: 'duplicate-old-session', clientRequestId: 'creation-key', userId: 'owner', agentId: 'main',
      provider: 'openai', model: 'fixture-model', workspaceId: 'workspace', createdAt: now, updatedAt: now,
    });
    assert.equal((await create()).status, 409, 'Legacy ambiguous request IDs must not replay an arbitrary session');
    console.log('Session creation idempotency: retries, concurrent requests, revision changes, permissions and link recovery passed.');
  } finally {
    loader._load = originalLoad;
    await database.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
