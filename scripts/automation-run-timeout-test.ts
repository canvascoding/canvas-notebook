import assert from 'node:assert/strict';

import {
  AutomationLoopShutdownError,
  AutomationRunTimeoutError,
  runWithAutomationTimeout,
} from '../app/lib/automations/run-timeout';

async function main() {
  const immediateResult = await runWithAutomationTimeout({
    timeoutMs: 50,
    abortGraceMs: 20,
    operation: async () => 'completed',
  });
  assert.equal(immediateResult, 'completed');

  let abortObserved = false;
  await assert.rejects(
    runWithAutomationTimeout({
      timeoutMs: 5,
      abortGraceMs: 50,
      operation: (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          abortObserved = true;
          setTimeout(() => reject(new Error('operation aborted')), 1);
        }, { once: true });
      }),
    }),
    (error: unknown) => error instanceof AutomationRunTimeoutError,
  );
  assert.equal(abortObserved, true, 'the timeout must abort the running operation');

  const shutdownStartedAt = Date.now();
  let releaseNonCooperativeOperation!: () => void;
  let shutdownError: AutomationLoopShutdownError | null = null;
  try {
    await runWithAutomationTimeout({
      timeoutMs: 5,
      abortGraceMs: 10,
      operation: async () => new Promise<void>((resolve) => {
        releaseNonCooperativeOperation = resolve;
      }),
    });
  } catch (error) {
    assert.ok(error instanceof AutomationLoopShutdownError);
    assert.equal(error.loopQuiescent, false);
    shutdownError = error;
  }
  assert.ok(shutdownError);
  assert.ok(
    Date.now() - shutdownStartedAt >= 10,
    'a non-cooperative operation must be given its configured abort grace period',
  );
  let detachedOperationSettled = false;
  void shutdownError.operationSettlement.then(() => {
    detachedOperationSettled = true;
  });
  await Promise.resolve();
  assert.equal(detachedOperationSettled, false);
  releaseNonCooperativeOperation();
  await shutdownError.operationSettlement;
  assert.equal(detachedOperationSettled, true);

  console.log('automation-run-timeout-test: ok');
}

void main();
