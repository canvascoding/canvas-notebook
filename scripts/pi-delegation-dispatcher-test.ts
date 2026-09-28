import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

import type { DelegateTaskRequest, DelegateTaskResult } from '../app/lib/pi/delegate-task-tool';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-dispatcher-'));
process.env.DATA = dataDir;

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>>;
moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDatabase;
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentExecutionContextForSession: async ({ sessionId }: { sessionId: string }) => ({
      organizationId: 'managed-org',
      workspaceId: ['managed-parent-other-workspace', 'managed-worker-other-workspace'].includes(sessionId)
        ? 'other-workspace' : 'managed-workspace',
      workspaceType: 'personal',
      workspaceRoot: '/test-workspace',
    }),
    resolveAgentSessionWorkspaceForUser: async ({ workspaceId }: { workspaceId: string }) => ({
      organizationId: 'managed-org', workspaceId, workspaceType: 'personal',
    }),
  };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return {
      registerBuiltInApiProviders: () => undefined,
      getProviders: () => [],
      getModels: () => [],
    };
  }
  if (request === '@earendil-works/pi-ai/oauth') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function completionResult(request: DelegateTaskRequest, reply: string): DelegateTaskResult {
  return {
    delegation_id: request.delegationId,
    status: 'ok',
    worker_type: request.targetAgentId ? 'managed' : 'ephemeral',
    source_agent_id: request.sourceAgentId,
    target_agent_id: request.targetAgentId,
    session_id: request.workerSessionId || request.sessionId || 'missing-worker-session',
    role: request.workerRole,
    toolsets: request.toolsets,
    wait_for_result: false,
    timeout_seconds: 0,
    reply,
  };
}

async function main() {
  testDatabase = await createPiTestDatabase();
  let dispatcher: import('../app/lib/pi/delegation-dispatcher').PiDelegationDispatcher | null = null;
  try {
    const { db } = testDatabase;
    const { piDelegations, piDelegationSteering, piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const { createDelegationCompletionMessage, isDelegationCompletionMessage } = await import(
      '../app/lib/pi/delegation-completion-message'
    );
    const { PiDelegationDispatcher } = await import('../app/lib/pi/delegation-dispatcher');
    const {
      claimQueuedPiDelegation,
      createPiDelegation,
      getPiDelegation,
      requestPiDelegationCancellation,
    } = await import('../app/lib/pi/delegation-store');

    const now = new Date();
    await db.insert(user).values({
      id: 'dispatcher-user',
      name: 'Dispatcher User',
      email: 'dispatcher@example.test',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    const started: DelegateTaskRequest[] = [];
    const delivered: string[] = [];
    const originalParentControllers: AbortController[] = [];
    dispatcher = new PiDelegationDispatcher({
      maxConcurrency: 2,
      pollIntervalMs: 60_000,
      recoverInterrupted: false,
      startDelegatedRunFn: async (request) => {
        started.push(request);
        request.abortSignal?.addEventListener('abort', () => {
          void request.onCompletion?.({
            ...completionResult(request, ''),
            status: 'error',
            error: request.abortSignal?.reason instanceof Error
              ? request.abortSignal.reason.message
              : 'Delegated task was aborted.',
            reply: undefined,
          });
        }, { once: true });
        return {
          delegation_id: request.delegationId,
          status: 'accepted',
          worker_type: request.targetAgentId ? 'managed' : 'ephemeral',
          source_agent_id: request.sourceAgentId,
          target_agent_id: request.targetAgentId,
          session_id: request.workerSessionId || request.sessionId || 'missing-worker-session',
          role: request.workerRole,
          toolsets: request.toolsets,
          wait_for_result: false,
          timeout_seconds: 0,
        };
      },
      deliverCompletionFn: async (record) => {
        delivered.push(record.id);
        const message = createDelegationCompletionMessage(record, 1234);
        assert.equal(isDelegationCompletionMessage(message), true);
        assert.equal(message.delegationCompletion.delegationId, record.id);
        assert.match(typeof message.content === 'string' ? message.content : '', /delegation_completion/);
      },
    });

    const enqueue = async (goal: string) => {
      const parentController = new AbortController();
      originalParentControllers.push(parentController);
      return dispatcher!.enqueue({
        userId: 'dispatcher-user',
        sourceAgentId: 'canvas-agent',
        sourceSessionId: 'source-session',
        abortSignal: parentController.signal,
        goal,
        workerRole: 'researcher',
        toolsets: ['file'],
        waitForResult: false,
        timeoutSeconds: 0,
      });
    };

    const accepted = await Promise.all([
      enqueue('Task one'),
      enqueue('Task two'),
      enqueue('Task three'),
    ]);
    assert.equal(accepted.every((result) => result.status === 'accepted'), true);
    assert.equal(accepted.every((result) => Boolean(result.delegation_id)), true);

    await waitFor(() => started.length === 2, 'The first two tasks did not start concurrently.');
    assert.equal(dispatcher.getActiveCount(), 2);
    assert.equal(originalParentControllers.some((controller) => started[0]?.abortSignal === controller.signal), false);
    assert.equal(originalParentControllers.some((controller) => started[1]?.abortSignal === controller.signal), false);
    const firstOwned = await getPiDelegation(started[0]!.delegationId!);
    const secondOwned = await getPiDelegation(started[1]!.delegationId!);
    await db.insert(piDelegationSteering).values([
      { record: firstOwned!, status: 'accepted' },
      { record: secondOwned!, status: 'claimed' },
    ].map(({ record, status }, index) => ({
      id: `terminal-steer-${index}`, delegationId: record.id, userId: 'dispatcher-user',
      sourceSessionId: 'source-session', runOwnerId: record.runOwnerId!,
      idempotencyKey: `terminal-key-${index}`, message: 'Check another file.',
      status, createdAt: now, updatedAt: now,
    })));

    await started[0]?.onCompletion?.(completionResult(started[0], 'First task complete.'));
    await waitFor(() => started.length === 3, 'The queued task did not start after a slot became available.');
    await waitFor(() => delivered.length === 1, 'The first result was not delivered.');
    assert.equal(dispatcher.getActiveCount(), 2);

    const secondId = started[1]?.delegationId;
    assert.ok(secondId);
    const cancellation = await dispatcher.cancel(secondId, 'dispatcher-user');
    assert.equal(cancellation?.status, 'running');
    assert.ok(cancellation?.cancelRequestedAt instanceof Date);
    await waitFor(
      () => started[1]?.abortSignal?.aborted === true,
      'Cancelling a running delegation did not abort its detached worker signal.',
    );

    await started[2]?.onCompletion?.(completionResult(started[2], 'Third task complete.'));
    await waitFor(() => dispatcher!.getActiveCount() === 0, 'Delegation workers did not settle.');
    await waitFor(() => delivered.length === 2, 'Successful delegation results were not delivered.');

    const firstRecord = await getPiDelegation(started[0]!.delegationId!);
    const secondRecord = await getPiDelegation(secondId);
    const thirdRecord = await getPiDelegation(started[2]!.delegationId!);
    assert.equal(firstRecord?.status, 'completed');
    assert.equal(firstRecord?.deliveryStatus, 'delivered');
    assert.equal(secondRecord?.status, 'cancelled');
    assert.equal(secondRecord?.deliveryStatus, 'skipped');
    assert.equal(thirdRecord?.status, 'completed');
    assert.deepEqual(new Set(delivered), new Set([firstRecord?.id, thirdRecord?.id]));
    const terminalSteering = await db.select().from(piDelegationSteering);
    assert.deepEqual(terminalSteering.map((receipt) => receipt.status), ['missed', 'missed']);

    // Model a stop request written by a different server process. The owner
    // dispatcher must observe it through its durable heartbeat, then abort.
    const remoteStop = await enqueue('Task stopped from another process');
    await waitFor(() => started.length === 4, 'Remote-stop task did not start.');
    const remoteStopId = remoteStop.delegation_id!;
    await requestPiDelegationCancellation(remoteStopId, 'dispatcher-user');
    await (dispatcher as unknown as { heartbeatOwned: () => Promise<void> }).heartbeatOwned();
    await waitFor(
      () => started[3]?.abortSignal?.aborted === true,
      'A remote stop request did not abort the owner worker.',
    );
    await waitFor(() => dispatcher!.getActiveCount() === 0, 'Remote-stop worker did not settle.');
    assert.equal((await getPiDelegation(remoteStopId))?.status, 'cancelled');
    assert.equal(delivered.includes(remoteStopId), false);

    dispatcher.stop();
    const recoveredWorkerSessionId = 'recovered-worker-session';
    const [recoveredSession] = await db.insert(piSessions).values({
      sessionId: recoveredWorkerSessionId,
      userId: 'dispatcher-user',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      title: 'Recovered worker',
      channelId: 'app',
      createdAt: now,
      updatedAt: now,
    }).returning();
    assert.ok(recoveredSession);
    await db.insert(piMessages).values([
      {
        piSessionDbId: recoveredSession.id,
        role: 'user',
        content: JSON.stringify({
          role: 'user',
          content: 'Delegated task from agent "canvas-agent".\nDelegation task ID: delegation-recovered',
          timestamp: 1,
        }),
        timestamp: 1,
        sequence: 1,
      },
      {
        piSessionDbId: recoveredSession.id,
        role: 'assistant',
        content: JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered persisted result.' }],
          stopReason: 'stop',
          timestamp: 2,
        }),
        timestamp: 2,
        sequence: 2,
      },
    ]);
    const interrupted = await createPiDelegation({
      id: 'delegation-recovered',
      userId: 'dispatcher-user',
      sourceSessionId: 'source-session',
      sourceAgentId: 'canvas-agent',
      workerSessionId: recoveredWorkerSessionId,
      workerType: 'ephemeral',
      goal: 'Recover the persisted worker result',
      toolsets: ['file'],
    });
    await claimQueuedPiDelegation(interrupted.id, 'crashed-dispatcher');
    await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) }).where((await import('drizzle-orm')).eq(piDelegations.id, interrupted.id));

    let recoveredWorkerStarts = 0;
    const recoveredDeliveries: string[] = [];
    dispatcher = new PiDelegationDispatcher({
      maxConcurrency: 1,
      pollIntervalMs: 60_000,
      recoverInterrupted: true,
      startDelegatedRunFn: async () => {
        recoveredWorkerStarts += 1;
        throw new Error('A persisted completed worker must not be started again.');
      },
      deliverCompletionFn: async (record) => {
        recoveredDeliveries.push(record.resultText || '');
      },
    });
    await dispatcher.initialize();
    await waitFor(() => recoveredDeliveries.length === 1, 'Recovered result was not delivered.');
    const recoveredRecord = await getPiDelegation(interrupted.id);
    assert.equal(recoveredWorkerStarts, 0);
    assert.equal(recoveredRecord?.status, 'completed');
    assert.equal(recoveredRecord?.attemptCount, 1);
    assert.equal(recoveredRecord?.resultText, 'Recovered persisted result.');
    assert.equal(recoveredRecord?.deliveryStatus, 'delivered');

    dispatcher.stop();
    await db.insert(user).values({
      id: 'dispatcher-foreign-user', name: 'Foreign User', email: 'dispatcher-foreign@example.test',
      emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(piSessions).values([
      { sessionId: 'managed-parent-original', userId: 'dispatcher-user', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
      { sessionId: 'managed-parent-other', userId: 'dispatcher-user', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
      { sessionId: 'managed-parent-other-workspace', userId: 'dispatcher-user', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        organizationId: 'managed-org', workspaceId: 'other-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
      { sessionId: 'managed-parent-foreign-user', userId: 'dispatcher-foreign-user', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
      { sessionId: 'managed-worker-reused', userId: 'dispatcher-user', agentId: 'research-agent',
        provider: 'test-provider', model: 'test-model', sessionKind: 'delegation_worker', delegationDepth: 1,
        parentSessionId: 'managed-parent-original', delegationId: 'managed-prior-task',
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
      { sessionId: 'managed-worker-wrong-kind', userId: 'dispatcher-user', agentId: 'research-agent',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        parentSessionId: 'managed-parent-original', organizationId: 'managed-org',
        workspaceId: 'managed-workspace', workspaceType: 'personal', createdAt: now, updatedAt: now },
      { sessionId: 'managed-worker-wrong-depth', userId: 'dispatcher-user', agentId: 'research-agent',
        provider: 'test-provider', model: 'test-model', sessionKind: 'delegation_worker', delegationDepth: 0,
        parentSessionId: 'managed-parent-original', organizationId: 'managed-org',
        workspaceId: 'managed-workspace', workspaceType: 'personal', createdAt: now, updatedAt: now },
      { sessionId: 'managed-worker-other-workspace', userId: 'dispatcher-user', agentId: 'research-agent',
        provider: 'test-provider', model: 'test-model', sessionKind: 'delegation_worker', delegationDepth: 1,
        parentSessionId: 'managed-parent-original', organizationId: 'managed-org',
        workspaceId: 'other-workspace', workspaceType: 'personal', createdAt: now, updatedAt: now },
    ]);
    const managedWorker = await db.query.piSessions.findFirst({
      where: (sessions, { eq }) => eq(sessions.sessionId, 'managed-worker-reused'),
      columns: { id: true },
    });
    assert.ok(managedWorker);
    await db.insert(piMessages).values({
      piSessionDbId: managedWorker.id,
      role: 'user',
      content: JSON.stringify({ role: 'user', content: 'Prior managed context', timestamp: 3 }),
      timestamp: 3,
      sequence: 1,
    });
    await createPiDelegation({
      id: 'managed-prior-task', userId: 'dispatcher-user', sourceSessionId: 'managed-parent-original',
      sourceAgentId: 'bradley', workerSessionId: 'managed-worker-reused', workerType: 'managed',
      targetAgentId: 'research-agent', goal: 'Previous managed task', toolsets: ['web'],
    });
    await claimQueuedPiDelegation('managed-prior-task');
    const { completeRunningPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { getDelegatedWorkerToolsets } = await import('../app/lib/pi/delegation-policy');
    await completeRunningPiDelegation({ id: 'managed-prior-task', resultStatus: 'ok', resultText: 'Done.' });
    assert.deepEqual(await getDelegatedWorkerToolsets({ userId: 'dispatcher-user', sessionId: 'managed-worker-reused' }), []);
    let resumedRequest: DelegateTaskRequest | undefined;
    dispatcher = new PiDelegationDispatcher({
      maxConcurrency: 1, pollIntervalMs: 60_000, recoverInterrupted: false,
      startDelegatedRunFn: async (request) => {
        resumedRequest = request;
        return { ...completionResult(request, ''), status: 'accepted', reply: undefined };
      },
      deliverCompletionFn: async () => undefined,
    });
    const managedRequest = {
      userId: 'dispatcher-user', sourceAgentId: 'bradley', sourceSessionId: 'managed-parent-original',
      targetAgentId: 'research-agent', sessionId: 'managed-worker-reused',
      goal: 'Follow up on prior work', toolsets: ['file'], waitForResult: false, timeoutSeconds: 0,
    } satisfies DelegateTaskRequest;
    const initialCount = (await db.select().from(piDelegations)).length;
    for (const { request, reason } of [
      { request: { ...managedRequest, sourceSessionId: 'managed-parent-other' }, reason: /does not belong to this Bradley chat/u },
      { request: { ...managedRequest, sourceSessionId: 'managed-parent-other-workspace' }, reason: /does not belong to this Bradley chat/u },
      { request: { ...managedRequest, userId: 'dispatcher-foreign-user', sourceSessionId: 'managed-parent-foreign-user' }, reason: /not found or is ambiguous/u },
      { request: { ...managedRequest, targetAgentId: 'other-agent' }, reason: /belongs to a different agent/u },
      { request: { ...managedRequest, sessionId: 'managed-worker-wrong-kind' }, reason: /does not belong to this Bradley chat/u },
      { request: { ...managedRequest, sessionId: 'managed-worker-wrong-depth' }, reason: /does not belong to this Bradley chat/u },
      { request: { ...managedRequest, sessionId: 'managed-worker-other-workspace' }, reason: /different workspace/u },
    ]) {
      await assert.rejects(dispatcher.enqueue(request), reason);
      assert.equal((await db.select().from(piDelegations)).length, initialCount,
        'an unauthorized managed-session reuse must be rejected before queue persistence');
    }
    const validFollowup = await dispatcher.enqueue(managedRequest);
    assert.equal(validFollowup.status, 'accepted');
    assert.equal(validFollowup.session_id, 'managed-worker-reused');
    assert.notEqual(validFollowup.delegation_id, 'managed-prior-task');
    assert.equal((await db.select().from(piDelegations)).length, initialCount + 1);
    await waitFor(() => Boolean(resumedRequest), 'The valid managed follow-up did not start.');
    assert.equal(resumedRequest?.workerSessionId, 'managed-worker-reused');
    assert.deepEqual(resumedRequest?.toolsets, ['file']);
    assert.deepEqual(await getDelegatedWorkerToolsets({ userId: 'dispatcher-user', sessionId: 'managed-worker-reused' }), ['file']);
    await resumedRequest?.onCompletion?.(completionResult(resumedRequest, 'Follow-up complete.'));
    await waitFor(() => dispatcher!.getActiveCount() === 0, 'The managed follow-up did not settle.');
    assert.equal((await getPiDelegation(validFollowup.delegation_id!))?.status, 'completed');
    assert.deepEqual(await getDelegatedWorkerToolsets({ userId: 'dispatcher-user', sessionId: 'managed-worker-reused' }), []);
    const { loadPiSession } = await import('../app/lib/pi/session-store');
    const savedWorkerHistory = await loadPiSession('managed-worker-reused', 'dispatcher-user', 'research-agent');
    assert.ok(savedWorkerHistory?.some((message) => message.role === 'user' && message.content === 'Prior managed context'));

    console.log('pi-delegation-dispatcher-test: ok');
  } finally {
    dispatcher?.stop();
    moduleLoader._load = originalLoad;
    await testDatabase.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
