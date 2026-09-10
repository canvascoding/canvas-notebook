import assert from 'node:assert/strict';

import { createAutomationRunDispatcher } from '../app/lib/automations/dispatch-limiter';

type PendingRun = {
  reject: (error: Error) => void;
  resolve: () => void;
};

async function main(): Promise<void> {
  const pendingRuns = new Map<string, PendingRun>();
  const startedRuns: string[] = [];
  const dispatch = createAutomationRunDispatcher(
    (runId) => {
      startedRuns.push(runId);
      return new Promise<void>((resolve, reject) => {
        pendingRuns.set(runId, { reject, resolve });
      });
    },
    2,
  );

  assert.equal(dispatch('run-1'), true);
  assert.equal(dispatch('run-2'), true);
  assert.equal(dispatch('run-1'), false, 'duplicate runs must not be dispatched');
  assert.equal(dispatch('run-3'), false, 'runs above the concurrency limit must remain queued');
  assert.deepEqual(startedRuns, ['run-1', 'run-2']);

  pendingRuns.get('run-1')?.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatch('run-3'), true, 'a completed run must release its slot');

  pendingRuns.get('run-2')?.reject(new Error('expected test failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatch('run-4'), true, 'a failed run must release its slot');

  pendingRuns.get('run-3')?.resolve();
  pendingRuns.get('run-4')?.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  console.log('Automation dispatch concurrency checks passed.');
}

void main();
