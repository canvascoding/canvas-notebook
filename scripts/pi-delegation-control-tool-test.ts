import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

function details<T>(result: unknown): T {
  return (result as { details: T }).details;
}

function errorText(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-delegation-control-'));
  process.env.DATA = dataDir;
  const testDatabase = await createPiTestDatabase();
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) {
      return testDatabase;
    }
    if (request === 'server-only') return {};
    if (request === '@/app/lib/agents/access') return { requireAgentAccess: async () => undefined };
    if (request === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentSessionWorkspaceForUser: async () => ({
        workspaceId: 'workspace-1', organizationId: 'org-1', projectId: null, workspaceType: 'personal',
      }),
    };
    if (request === '@earendil-works/pi-agent-core') return {};
    if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
      return { registerBuiltInApiProviders: () => undefined, getProviders: () => [], getModels: () => [] };
    }
    if (request === '@earendil-works/pi-ai/oauth') return {};
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { db } = testDatabase;
    const { user, piSessions, piDelegations, piDelegationSteering } = await import('../app/lib/db/schema');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { createDelegateTaskTool } = await import('../app/lib/pi/delegate-task-tool');
    const now = new Date();
    await db.insert(user).values([
      { id: 'owner', name: 'Owner', email: 'control-owner@example.test', emailVerified: true, createdAt: now, updatedAt: now },
      { id: 'stranger', name: 'Stranger', email: 'control-stranger@example.test', emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(piSessions).values([
      { sessionId: 'parent-1', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now },
      { sessionId: 'parent-2', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now },
      { sessionId: 'stranger-parent', userId: 'stranger', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now },
      ...['task-1', 'task-2', 'task-3'].map((id) => ({
        sessionId: `child-${id}`, userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker' as const, delegationDepth: 1, parentSessionId: 'parent-1', delegationId: id,
        workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now,
      })),
    ]);
    for (const id of ['task-1', 'task-2', 'task-3']) {
      await createPiDelegation({ id, userId: 'owner', sourceSessionId: 'parent-1', sourceAgentId: 'bradley',
        workerSessionId: `child-${id}`, workerType: 'ephemeral', goal: `Goal for ${id}`, toolsets: ['file'] });
      await claimQueuedPiDelegation(id, `process-${id}`);
    }
    await db.update(piDelegations).set({ status: 'completed', completedAt: now }).where(eq(piDelegations.id, 'task-3'));

    const owned = createDelegateTaskTool({ userId: 'owner', sourceAgentId: 'bradley', sourceSessionId: 'parent-1' });
    const wrongParent = createDelegateTaskTool({ userId: 'owner', sourceAgentId: 'bradley', sourceSessionId: 'parent-2' });
    const wrongUser = createDelegateTaskTool({ userId: 'stranger', sourceAgentId: 'bradley', sourceSessionId: 'stranger-parent' });
    const child = createDelegateTaskTool({ userId: 'owner', sourceAgentId: 'research-agent', sourceSessionId: 'parent-1' });

    const listed = details<{ tasks: Array<{ delegation_id: string; status: string }> }>(await owned.execute('list-1', { action: 'list' }));
    assert.deepEqual(new Set(listed.tasks.map((task) => task.delegation_id)), new Set(['task-1', 'task-2', 'task-3']));
    assert.deepEqual(details<{ tasks: unknown[] }>(await wrongParent.execute('list-parent-2', { action: 'list' })).tasks, []);
    assert.deepEqual(details<{ tasks: unknown[] }>(await wrongUser.execute('list-stranger', { action: 'list' })).tasks, []);
    assert.match(errorText(await child.execute('list-child', { action: 'list' })), /Only Bradley/u);

    for (const denied of [wrongParent, wrongUser, child]) {
      assert.match(errorText(await denied.execute('steer-denied', { action: 'steer', delegation_id: 'task-1', message: 'Change direction' })), /Error:/u);
      assert.match(errorText(await denied.execute('stop-denied', { action: 'stop', delegation_id: 'task-1' })), /Error:/u);
    }
    assert.equal((await db.select().from(piDelegationSteering)).length, 0);
    assert.equal((await db.query.piDelegations.findFirst({ where: eq(piDelegations.id, 'task-1') }))?.cancelRequestedAt, null);

    const steered = details<{ delegation_id: string; receipt_id: string; status: string }>(
      await owned.execute('steer-task-1', { action: 'steer', delegation_id: 'task-1', message: 'Check the second file too.' }),
    );
    assert.equal(steered.delegation_id, 'task-1');
    assert.equal(steered.status, 'accepted');
    assert.equal((await db.select().from(piDelegationSteering)).length, 1);
    assert.match(errorText(await owned.execute('steer-completed', {
      action: 'steer', delegation_id: 'task-3', message: 'Too late',
    })), /no longer running/u);
    const receipt = details<{ receipt_id: string; status: string }>(await owned.execute('receipt-1', {
      action: 'list', delegation_id: 'task-1', receipt_id: steered.receipt_id,
    }));
    assert.equal(receipt.receipt_id, steered.receipt_id);
    assert.equal(receipt.status, 'accepted');
    assert.match(errorText(await wrongParent.execute('receipt-wrong-parent', {
      action: 'list', delegation_id: 'task-1', receipt_id: steered.receipt_id,
    })), /Error:/u);
    assert.match(errorText(await wrongUser.execute('receipt-wrong-user', {
      action: 'list', delegation_id: 'task-1', receipt_id: steered.receipt_id,
    })), /Error:/u);
    assert.match(errorText(await owned.execute('receipt-wrong-task', {
      action: 'list', delegation_id: 'task-2', receipt_id: steered.receipt_id,
    })), /Error:/u);

    const stopped = details<{ delegation_id: string; status: string }>(
      await owned.execute('stop-task-1', { action: 'stop', delegation_id: 'task-1' }),
    );
    assert.equal(stopped.delegation_id, 'task-1');
    assert.equal(stopped.status, 'stop_requested');
    assert.ok((await db.query.piDelegations.findFirst({ where: eq(piDelegations.id, 'task-1') }))?.cancelRequestedAt);
    assert.equal((await db.query.piDelegations.findFirst({ where: eq(piDelegations.id, 'task-2') }))?.cancelRequestedAt, null);
    assert.equal((await db.query.piDelegations.findFirst({ where: eq(piDelegations.id, 'task-3') }))?.cancelRequestedAt, null);
    assert.match(errorText(await owned.execute('steer-stopped', {
      action: 'steer', delegation_id: 'task-1', message: 'Cannot resume a stopped task',
    })), /no longer running/u);

    console.log('pi-delegation-control-tool-test: ok');
  } finally {
    loader._load = originalLoad;
    const dispatcher = (globalThis as typeof globalThis & { __canvasPiDelegationDispatcher?: { stop: () => void } }).__canvasPiDelegationDispatcher;
    dispatcher?.stop();
    await testDatabase.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
