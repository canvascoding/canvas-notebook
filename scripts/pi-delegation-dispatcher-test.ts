import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { DelegateTaskRequest, DelegateTaskResult } from '../app/lib/pi/delegate-task-tool';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-dispatcher-'));
process.env.DATA = dataDir;

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
  if (request === 'server-only') return {};
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
  let dispatcher: import('../app/lib/pi/delegation-dispatcher').PiDelegationDispatcher | null = null;
  try {
    const { db } = await import('../app/lib/db');
    const { piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const { createDelegationCompletionMessage, isDelegationCompletionMessage } = await import(
      '../app/lib/pi/delegation-completion-message'
    );
    const { PiDelegationDispatcher } = await import('../app/lib/pi/delegation-dispatcher');
    const {
      claimQueuedPiDelegation,
      createPiDelegation,
      getPiDelegation,
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
    await claimQueuedPiDelegation(interrupted.id);

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
    assert.equal(recoveredRecord?.attemptCount, 2);
    assert.equal(recoveredRecord?.resultText, 'Recovered persisted result.');
    assert.equal(recoveredRecord?.deliveryStatus, 'delivered');

    console.log('pi-delegation-dispatcher-test: ok');
  } finally {
    dispatcher?.stop();
    moduleLoader._load = originalLoad;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
