import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-api-'));
process.env.DATA = dataDir;

let authenticatedUserId = 'delegation-api-user-1';

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
    const { db } = await import('../app/lib/db');
    const { user } = await import('../app/lib/db/schema');
    const { createPiDelegation, getPiDelegation } = await import('../app/lib/pi/delegation-store');
    const listRoute = await import('../app/api/delegations/route');
    const cancelRoute = await import('../app/api/delegations/[id]/route');

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
    await createPiDelegation({
      id: 'delegation-api-task-1',
      userId: 'delegation-api-user-1',
      sourceSessionId: 'source-api-session',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-api-session',
      workerType: 'ephemeral',
      goal: 'Test the delegation API',
      toolsets: ['file'],
    });
    await createPiDelegation({
      id: 'delegation-api-task-2',
      userId: 'delegation-api-user-2',
      sourceSessionId: 'source-api-session',
      sourceAgentId: 'canvas-agent',
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

    authenticatedUserId = 'delegation-api-user-2';
    const forbiddenCancel = await cancelRoute.DELETE(
      new NextRequest('http://localhost:3000/api/delegations/delegation-api-task-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'delegation-api-task-1' }) },
    );
    assert.equal(forbiddenCancel.status, 404);
    assert.equal((await getPiDelegation('delegation-api-task-1'))?.status, 'queued');

    authenticatedUserId = 'delegation-api-user-1';
    const cancelResponse = await cancelRoute.DELETE(
      new NextRequest('http://localhost:3000/api/delegations/delegation-api-task-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'delegation-api-task-1' }) },
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal((await getPiDelegation('delegation-api-task-1'))?.status, 'cancelled');

    authenticatedUserId = '';
    const unauthorized = await listRoute.GET(new NextRequest('http://localhost:3000/api/delegations'));
    assert.equal(unauthorized.status, 401);

    console.log('pi-delegation-api-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
