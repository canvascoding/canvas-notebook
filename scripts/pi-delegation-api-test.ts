import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-api-'));
process.env.DATA = dataDir;

let authenticatedUserId = 'delegation-api-user-1';
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>>;

function matchesModule(request: string, suffix: string): boolean {
  const normalized = request.replace(/\\/gu, '/').replace(/\.(?:c|m)?(?:js|ts)$/u, '');
  return normalized === `@/${suffix}` || normalized.endsWith(`/${suffix}`);
}

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithMocks(request, parent, isMain) {
  if (request === 'server-only') return {};
  if (testDatabase && matchesModule(request, 'app/lib/db')) return testDatabase;
  if (matchesModule(request, 'app/lib/agents/access')) return { requireAgentAccess: async () => undefined };
  if (matchesModule(request, 'app/lib/pi/session-workspace-context')) return {
    resolveAgentSessionWorkspaceForUser: async () => ({ workspaceId: 'workspace-api', organizationId: 'org-api', projectId: null, workspaceType: 'personal' }),
  };
  if (matchesModule(request, 'app/lib/agents/management-actions')) return { listManagedAgents: async () => [] };
  if (matchesModule(request, 'app/lib/pi/delegation-actions')) return { prepareUserDelegation: async () => { throw new Error('unused'); } };
  if (matchesModule(request, 'app/lib/pi/delegation-dispatcher')) return {
    enqueueDelegatedTask: async () => { throw new Error('unused'); },
    cancelDelegatedTask: async (id: string, userId: string) => {
      const store = await import('../app/lib/pi/delegation-store');
      return store.requestPiDelegationCancellation(id, userId);
    },
  };
  if (matchesModule(request, 'app/lib/utils/rate-limit')) return { rateLimit: () => ({ ok: true }) };
  if (request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  if (matchesModule(request, 'app/lib/auth')) {
    return {
      auth: {
        api: {
          getSession: async () => authenticatedUserId
            ? { user: { id: authenticatedUserId } }
            : null,
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    testDatabase = await createPiTestDatabase();
    const { db } = testDatabase;
    const { piSessions, user } = await import('../app/lib/db/schema');
    const { claimQueuedPiDelegation, completeRunningPiDelegation, createPiDelegation, getPiDelegation } = await import('../app/lib/pi/delegation-store');
    const listRoute = await import('../app/api/delegations/route');
    const cancelRoute = await import('../app/api/delegations/[id]/route');
    const steeringRoute = await import('../app/api/delegations/[id]/steering/route');

    const now = new Date();
    await db.insert(user).values([
      {
        id: 'delegation-api-user-1',
        name: 'Delegation API User One',
        email: 'delegation-api-one@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'delegation-api-user-2',
        name: 'Delegation API User Two',
        email: 'delegation-api-two@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(piSessions).values([
      { sessionId: 'source-api-session', userId: 'delegation-api-user-1', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-api', organizationId: 'org-api', createdAt: now, updatedAt: now },
      { sessionId: 'source-api-other', userId: 'delegation-api-user-1', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-api', organizationId: 'org-api', createdAt: now, updatedAt: now },
      { sessionId: 'source-api-session', userId: 'delegation-api-user-2', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-api', organizationId: 'org-api', createdAt: now, updatedAt: now },
      { sessionId: 'worker-api-session', userId: 'delegation-api-user-1', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker', parentSessionId: 'source-api-session', delegationId: 'delegation-api-task-1', delegationDepth: 1,
        workspaceId: 'workspace-api', organizationId: 'org-api', createdAt: now, updatedAt: now },
      { sessionId: 'worker-api-session-2', userId: 'delegation-api-user-2', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker', parentSessionId: 'source-api-session', delegationId: 'delegation-api-task-2', delegationDepth: 1,
        workspaceId: 'workspace-api', organizationId: 'org-api', createdAt: now, updatedAt: now },
    ]);
    await createPiDelegation({
      id: 'delegation-api-task-1',
      userId: 'delegation-api-user-1',
      sourceSessionId: 'source-api-session',
      sourceAgentId: 'bradley',
      workerSessionId: 'worker-api-session',
      workerType: 'ephemeral',
      goal: 'Test the delegation API',
      toolsets: ['file'],
    });
    await createPiDelegation({
      id: 'delegation-api-task-2',
      userId: 'delegation-api-user-2',
      sourceSessionId: 'source-api-session',
      sourceAgentId: 'bradley',
      workerSessionId: 'worker-api-session-2',
      workerType: 'ephemeral',
      goal: 'Must remain private',
      toolsets: ['file'],
    });

    const listResponse = await listRoute.GET(new NextRequest(
      'http://localhost:3000/api/delegations?sourceSessionId=source-api-session',
    ));
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as {
      success: boolean;
      delegations: Array<{ id: string; toolsets: string[]; status: string }>;
    };
    assert.equal(listPayload.success, true);
    assert.deepEqual(listPayload.delegations.map((record) => record.id), ['delegation-api-task-1']);
    assert.deepEqual(listPayload.delegations[0]?.toolsets, ['file']);
    const wrongParentCancel = await cancelRoute.DELETE(
      new NextRequest('http://localhost:3000/api/delegations/delegation-api-task-1?sourceSessionId=source-api-other', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'delegation-api-task-1' }) },
    );
    assert.equal(wrongParentCancel.status, 404);
    assert.equal((await getPiDelegation('delegation-api-task-1'))?.status, 'queued');

    authenticatedUserId = 'delegation-api-user-2';
    const forbiddenCancel = await cancelRoute.DELETE(
      new NextRequest('http://localhost:3000/api/delegations/delegation-api-task-1?sourceSessionId=source-api-session', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'delegation-api-task-1' }) },
    );
    assert.equal(forbiddenCancel.status, 404);
    assert.equal((await getPiDelegation('delegation-api-task-1'))?.status, 'queued');

    authenticatedUserId = 'delegation-api-user-1';
    const cancelResponse = await cancelRoute.DELETE(
      new NextRequest('http://localhost:3000/api/delegations/delegation-api-task-1?sourceSessionId=source-api-session', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'delegation-api-task-1' }) },
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal((await getPiDelegation('delegation-api-task-1'))?.status, 'cancelled');

    await db.insert(piSessions).values({ sessionId: 'worker-api-steering', userId: 'delegation-api-user-1', agentId: 'bradley',
      provider: 'test', model: 'test', sessionKind: 'delegation_worker', parentSessionId: 'source-api-session',
      delegationId: 'delegation-api-steering', delegationDepth: 1, workspaceId: 'workspace-api', organizationId: 'org-api',
      createdAt: now, updatedAt: now });
    await createPiDelegation({ id: 'delegation-api-steering', userId: 'delegation-api-user-1',
      sourceSessionId: 'source-api-session', sourceAgentId: 'bradley', workerSessionId: 'worker-api-steering',
      workerType: 'ephemeral', goal: 'Test steering API', toolsets: ['file'] });
    assert.ok(await claimQueuedPiDelegation('delegation-api-steering', 'steering-api-owner'));
    const steeringContext = { params: Promise.resolve({ id: 'delegation-api-steering' }) };
    const steeringPost = (sourceSessionId: string, requestId: string) => steeringRoute.POST(new NextRequest(
      'http://localhost:3000/api/delegations/delegation-api-steering/steering', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceSessionId, requestId, message: 'Check the exact file.' }),
      },
    ), steeringContext);
    assert.equal((await steeringRoute.POST(new NextRequest(
      'http://localhost:3000/api/delegations/delegation-api-steering/steering', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
      },
    ), steeringContext)).status, 400);
    assert.equal((await steeringPost('source-api-other', 'wrong-parent')).status, 404);
    const accepted = await steeringPost('source-api-session', 'correct-parent');
    assert.equal(accepted.status, 200);
    const acceptedPayload = await accepted.json() as { receipt: { id: string; status: string }; message?: string };
    assert.equal(acceptedPayload.receipt.status, 'accepted');
    assert.doesNotMatch(JSON.stringify(acceptedPayload), /Check the exact file/u);
    const receiptUrl = (parent: string) =>
      `http://localhost:3000/api/delegations/delegation-api-steering/steering?sourceSessionId=${parent}&receiptId=${acceptedPayload.receipt.id}`;
    assert.equal((await steeringRoute.GET(new NextRequest(receiptUrl('source-api-other')), steeringContext)).status, 404);
    authenticatedUserId = 'delegation-api-user-2';
    assert.equal((await steeringRoute.GET(new NextRequest(receiptUrl('source-api-session')), steeringContext)).status, 404);
    authenticatedUserId = 'delegation-api-user-1';
    const receiptResponse = await steeringRoute.GET(new NextRequest(receiptUrl('source-api-session')), steeringContext);
    assert.equal(receiptResponse.status, 200);
    assert.equal((await receiptResponse.json() as { receipt: { id: string } }).receipt.id, acceptedPayload.receipt.id);
    await completeRunningPiDelegation({ id: 'delegation-api-steering', resultStatus: 'ok', runOwnerId: 'steering-api-owner' });
    assert.equal((await steeringPost('source-api-session', 'too-late')).status, 409);

    authenticatedUserId = '';
    const unauthorized = await listRoute.GET(new NextRequest('http://localhost:3000/api/delegations'));
    assert.equal(unauthorized.status, 401);

    console.log('pi-delegation-api-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await testDatabase?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
