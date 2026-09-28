import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>>;
let agentAllowed = true;
let workspaceAllowed = true;
moduleLoader._load = function loadWithMocks(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@/app/lib/agents/access') return {
    requireAgentAccess: async () => { if (!agentAllowed) throw new Error('Agent access denied.'); },
  };
  if (request === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentSessionWorkspaceForUser: async () => {
      if (!workspaceAllowed) throw new Error('Workspace access denied.');
      return { workspaceId: 'workspace-1', organizationId: 'org-1', projectId: null, workspaceType: 'personal' };
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    testDatabase = await createPiTestDatabase();
    const { db } = testDatabase;
    const { user, piSessions, piDelegations, piDelegationSteering } = await import('../app/lib/db/schema');
    const {
      createPiDelegation, claimQueuedPiDelegation, completeRunningPiDelegation,
    } = await import('../app/lib/pi/delegation-store');
    const {
      acceptPiDelegationSteering, claimNextPiDelegationSteering,
      confirmPiDelegationSteeringDelivered, markUndeliveredPiDelegationSteeringMissed,
      readAuthorizedPiDelegationSteeringReceipt,
    } = await import('../app/lib/pi/delegation-steering');
    const now = new Date();
    await db.insert(user).values([
      { id: 'owner', name: 'Owner', email: 'steering-owner@example.test', emailVerified: true, createdAt: now, updatedAt: now },
      { id: 'stranger', name: 'Stranger', email: 'steering-stranger@example.test', emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(piSessions).values([
      { sessionId: 'parent-1', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1',
        createdAt: now, updatedAt: now },
      { sessionId: 'parent-2', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, workspaceId: 'workspace-1', organizationId: 'org-1',
        createdAt: now, updatedAt: now },
      { sessionId: 'child-1', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker', delegationDepth: 1, parentSessionId: 'parent-1', delegationId: 'task-1',
        workspaceId: 'workspace-1', organizationId: 'org-1', createdAt: now, updatedAt: now },
    ]);
    await createPiDelegation({ id: 'task-1', userId: 'owner', sourceSessionId: 'parent-1', sourceAgentId: 'bradley',
      workerSessionId: 'child-1', workerType: 'ephemeral', goal: 'Inspect files', toolsets: ['file'] });

    const acceptInput = { delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1', idempotencyKey: 'steer-1', message: 'Check the second file too.' };
    await assert.rejects(acceptPiDelegationSteering(acceptInput), /no longer running/u);
    await claimQueuedPiDelegation('task-1', 'owner-process');
    await assert.rejects(acceptPiDelegationSteering({ ...acceptInput, userId: 'stranger' }));
    await assert.rejects(acceptPiDelegationSteering({ ...acceptInput, sourceSessionId: 'parent-2' }));
    agentAllowed = false;
    await assert.rejects(acceptPiDelegationSteering(acceptInput));
    agentAllowed = true;
    workspaceAllowed = false;
    await assert.rejects(acceptPiDelegationSteering(acceptInput));
    workspaceAllowed = true;

    const accepted = await acceptPiDelegationSteering(acceptInput);
    assert.equal(accepted.status, 'accepted');
    assert.equal((await acceptPiDelegationSteering(acceptInput)).id, accepted.id, 'same command ID must be idempotent');
    await assert.rejects(acceptPiDelegationSteering({ ...acceptInput, message: 'Different text' }), /already used/u);
    assert.equal(await claimNextPiDelegationSteering({ delegationId: 'task-1', userId: 'owner', runOwnerId: 'wrong-process' }), null);
    const claim = await claimNextPiDelegationSteering({ delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' });
    assert.equal(claim?.id, accepted.id);
    assert.equal(claim?.message, 'Check the second file too.');
    assert.equal(claim?.status, 'claimed');
    assert.equal(await claimNextPiDelegationSteering({ delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' }), null);
    assert.equal(await confirmPiDelegationSteeringDelivered({ id: accepted.id, delegationId: 'task-1', userId: 'owner', runOwnerId: 'wrong-process' }), null);
    const delivered = await confirmPiDelegationSteeringDelivered({ id: accepted.id, delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' });
    assert.equal(delivered?.status, 'delivered');
    assert.equal((await confirmPiDelegationSteeringDelivered({ id: accepted.id, delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' }))?.status, 'delivered');

    const pending = await acceptPiDelegationSteering({ ...acceptInput, idempotencyKey: 'steer-2', message: 'Also inspect permissions.' });
    await assert.rejects(readAuthorizedPiDelegationSteeringReceipt({ id: pending.id, delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-2' }));
    assert.equal((await readAuthorizedPiDelegationSteeringReceipt({ id: pending.id, delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' }))?.status, 'accepted');
    await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) }).where(eq(piDelegations.id, 'task-1'));
    assert.equal(await claimNextPiDelegationSteering({ delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' }), null,
      'expired owner must not take a pending correction');
    assert.equal(await confirmPiDelegationSteeringDelivered({ id: pending.id, delegationId: 'task-1', userId: 'owner', runOwnerId: 'owner-process' }), null);
    await completeRunningPiDelegation({ id: 'task-1', resultStatus: 'ok', resultText: 'Done.' });
    assert.equal(await markUndeliveredPiDelegationSteeringMissed({ delegationId: 'task-1', userId: 'owner' }), 1);
    assert.equal((await readAuthorizedPiDelegationSteeringReceipt({ id: pending.id, delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' }))?.status, 'missed');
    assert.equal((await readAuthorizedPiDelegationSteeringReceipt({ id: delivered!.id, delegationId: 'task-1', userId: 'owner', sourceSessionId: 'parent-1' }))?.status, 'delivered');
    await assert.rejects(acceptPiDelegationSteering({ ...acceptInput, idempotencyKey: 'steer-3' }), /no longer running/u);

    const rows = await db.select().from(piDelegationSteering);
    assert.equal(rows.length, 2);
    const postgres = testDatabase.getPostgresRuntimeQueryable();
    await postgres.query('DROP TABLE pi_delegations_steering');
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const table = await postgres.query<{ name: string | null }>("SELECT to_regclass('pi_delegations_steering') AS name");
    assert.equal(table.rows[0].name, 'pi_delegations_steering');
    console.log('pi-delegation-steering-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await testDatabase?.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
