import assert from 'node:assert/strict';

import type { PiHistoryComposition, PiSessionSummaryState } from '../app/lib/pi/history-budget';
import {
  abortPiSessionCompaction,
  getActivePiSessionCompaction,
  invalidatePiSessionCompaction,
  runPiSessionCompaction,
  type PiCompactionCoordinatorStore,
} from '../app/lib/pi/session-compaction-coordinator';
import type { PreparePiHistoryContextResult } from '../app/lib/pi/session-summary';

const scope = {
  sessionId: 'session-coordinator',
  userId: 'user-coordinator',
  agentId: 'agent-coordinator',
  workspaceId: 'workspace-coordinator',
} as const;

function composition(overrides: Partial<PiHistoryComposition> = {}): PiHistoryComposition {
  return {
    llmMessages: [],
    keptMessages: [],
    omittedMessages: [],
    includedSummary: false,
    outputReserveTokens: 1_000,
    availableHistoryTokens: 8_000,
    triggerHistoryTokens: 6_000,
    targetHistoryTokens: 4_000,
    estimatedHistoryTokens: 2_000,
    availableHistoryBytes: 10_000,
    estimatedHistoryBytes: 4_000,
    contextBudgetExceeded: false,
    payloadBudgetExceeded: false,
    minimumRequiredTokens: 1_000,
    minimumRequiredBytes: 2_000,
    softThresholdExceeded: true,
    ...overrides,
  };
}

const committedSummary: PiSessionSummaryState = {
  summaryText: 'Private candidate summary',
  summaryUpdatedAt: new Date('2026-08-27T12:01:00.000Z'),
  summaryThroughTimestamp: 1_700_000_002,
  summaryThroughSequence: 2,
  summaryRevision: 0,
};

function candidate(overrides: Partial<PreparePiHistoryContextResult> = {}): PreparePiHistoryContextResult {
  return {
    summary: committedSummary,
    composition: composition({ includedSummary: true }),
    summaryAttempted: true,
    summaryUpdated: true,
    summaryFailed: false,
    unsummarizedMessageCount: 2,
    safeToSend: true,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function attempt(attemptId: string, retryAt: Date | null = null) {
  return {
    attemptId,
    piSessionDbId: 1,
    attemptOrdinal: 1,
    trigger: 'automatic' as const,
    state: 'running' as const,
    reasonCode: null,
    baseSummaryRevision: 0,
    committedSummaryRevision: null,
    baseThroughSequence: null,
    committedThroughSequence: null,
    messageSequenceCheckpoint: 2,
    contractFingerprint: 'fingerprint',
    provider: 'provider',
    model: 'model',
    startedAt: new Date('2026-08-27T12:00:00.000Z'),
    deadlineAt: new Date('2026-08-27T12:02:00.000Z'),
    completedAt: null,
    retryAt,
  };
}

function createStore() {
  const calls = {
    start: 0,
    finish: [] as Array<{ state: string; reasonCode: string; retryAt: Date | null | undefined }>,
    commit: 0,
    retryFailures: 0,
  };
  const store: PiCompactionCoordinatorStore = {
    start: async (input) => {
      calls.start += 1;
      return { status: 'started', attempt: attempt(input.attemptId) };
    },
    finish: async (input) => {
      calls.finish.push({ state: input.state, reasonCode: input.reasonCode, retryAt: input.retryAt });
      return {
        changed: true,
        attempt: { attemptId: input.attemptId, retryAt: input.retryAt ?? null },
      };
    },
    commit: async (input) => {
      calls.commit += 1;
      return {
        status: 'committed',
        summary: { ...committedSummary, summaryRevision: input.expectedSummaryRevision + 1 },
        attempt: {
          ...attempt(input.attemptId),
          state: 'succeeded',
          committedSummaryRevision: input.expectedSummaryRevision + 1,
          committedThroughSequence: input.throughSequence,
          completedAt: new Date(),
        },
      };
    },
    countRetryFailures: async () => calls.retryFailures,
  };
  return { store, calls };
}

function baseRunInput(store: PiCompactionCoordinatorStore) {
  return {
    ...scope,
    trigger: 'automatic' as const,
    generation: 'generation-1',
    expectedSummaryRevision: 0,
    expectedThroughSequence: null,
    provider: 'provider',
    model: 'model',
    contractFingerprint: 'fingerprint',
    policy: { timeoutMs: 1_000, retryDelaysMs: [25, 50] },
    store,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  {
    const { store, calls } = createStore();
    const pending = deferred<PreparePiHistoryContextResult>();
    let prepareCalls = 0;
    const first = runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-success',
      prepareCandidate: async () => {
        prepareCalls += 1;
        return pending.promise;
      },
    });
    await tick();
    assert.equal(getActivePiSessionCompaction(scope)?.attemptId, 'attempt-success');
    const duplicate = await runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-duplicate',
      prepareCandidate: async () => candidate(),
    });
    assert.equal(duplicate.state, 'already_running');
    assert.equal(duplicate.attemptId, 'attempt-success');
    pending.resolve(candidate());
    const succeeded = await first;
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.summary?.summaryRevision, 1);
    assert.equal(prepareCalls, 1);
    assert.equal(calls.start, 1);
    assert.equal(calls.commit, 1);
    assert.equal(getActivePiSessionCompaction(scope), null);
  }

  {
    const { store, calls } = createStore();
    const pending = deferred<PreparePiHistoryContextResult>();
    const run = runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-stale',
      prepareCandidate: async () => pending.promise,
    });
    await tick();
    assert.equal(invalidatePiSessionCompaction(scope), true);
    const stale = await run;
    assert.equal(stale.state, 'stale');
    assert.equal(stale.reasonCode, 'stale_snapshot');
    pending.resolve(candidate());
    await tick();
    assert.equal(calls.commit, 0, 'a late candidate must never commit after invalidation');
    assert.equal(calls.finish.at(-1)?.state, 'stale');
  }

  {
    const { store, calls } = createStore();
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    const commitWinsStore: PiCompactionCoordinatorStore = {
      ...store,
      commit: async (input) => {
        commitStarted.resolve();
        await releaseCommit.promise;
        return store.commit(input);
      },
    };
    const run = runPiSessionCompaction({
      ...baseRunInput(commitWinsStore),
      attemptId: 'attempt-commit-wins-abort-race',
      prepareCandidate: async () => candidate(),
    });
    await commitStarted.promise;
    assert.equal(abortPiSessionCompaction(scope), true);
    releaseCommit.resolve();
    const committed = await run;
    assert.equal(committed.state, 'succeeded');
    assert.equal(committed.summary?.summaryRevision, 1);
    assert.equal(calls.commit, 1);
    assert.equal(calls.finish.length, 0);
  }

  {
    const { store, calls } = createStore();
    let prepareCalls = 0;
    const staleBeforeProvider = await runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-stale-before-provider',
      isGenerationCurrent: () => false,
      prepareCandidate: async () => {
        prepareCalls += 1;
        return candidate();
      },
    });
    assert.equal(staleBeforeProvider.state, 'stale');
    assert.equal(prepareCalls, 0);
    assert.equal(calls.commit, 0);
    assert.equal(calls.finish.at(-1)?.state, 'stale');
  }

  {
    const { store, calls } = createStore();
    const pending = deferred<PreparePiHistoryContextResult>();
    const timedOut = await runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-timeout',
      policy: { timeoutMs: 10, retryDelaysMs: [25, 50] },
      prepareCandidate: async () => pending.promise,
    });
    assert.equal(timedOut.state, 'failed');
    assert.equal(timedOut.reasonCode, 'summary_timeout');
    assert.ok(timedOut.retryAt);
    pending.resolve(candidate());
    await tick();
    assert.equal(calls.commit, 0, 'a provider result after timeout must be consumed without commit');
    assert.equal(calls.finish.at(-1)?.state, 'timed_out');
  }

  {
    const { store, calls } = createStore();
    const pending = deferred<PreparePiHistoryContextResult>();
    const run = runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-abort',
      prepareCandidate: async () => pending.promise,
    });
    await tick();
    assert.equal(abortPiSessionCompaction(scope), true);
    const aborted = await run;
    assert.equal(aborted.state, 'aborted');
    assert.equal(calls.finish.at(-1)?.state, 'aborted');
    pending.resolve(candidate());
  }

  {
    const { store, calls } = createStore();
    calls.retryFailures = 1;
    const deferredResult = await runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-deferred',
      prepareCandidate: async () => candidate({
        summary: { ...committedSummary, summaryText: null, summaryThroughSequence: null },
        summaryUpdated: false,
        summaryFailed: true,
        safeToSend: true,
        composition: composition({ softThresholdExceeded: true }),
      }),
    });
    assert.equal(deferredResult.state, 'deferred');
    assert.equal(deferredResult.reasonCode, 'summary_provider_error');
    assert.ok(deferredResult.retryAt);
    assert.equal(calls.commit, 0);
    assert.equal(calls.finish.at(-1)?.retryAt instanceof Date, true);
  }

  {
    const { store, calls } = createStore();
    const noOp = await runPiSessionCompaction({
      ...baseRunInput(store),
      attemptId: 'attempt-no-op',
      prepareCandidate: async () => candidate({
        summary: { ...committedSummary, summaryText: null, summaryThroughSequence: null },
        summaryAttempted: false,
        summaryUpdated: false,
        unsummarizedMessageCount: 0,
        composition: composition({ softThresholdExceeded: false }),
      }),
    });
    assert.equal(noOp.state, 'no_op');
    assert.equal(noOp.reasonCode, 'soft_threshold_not_reached');
    assert.equal(calls.finish.at(-1)?.state, 'no_op');
  }

  {
    const { store, calls } = createStore();
    const failingCommitStore: PiCompactionCoordinatorStore = {
      ...store,
      commit: async () => {
        calls.commit += 1;
        throw new Error('injected persistence failure');
      },
    };
    const failedCommit = await runPiSessionCompaction({
      ...baseRunInput(failingCommitStore),
      attemptId: 'attempt-commit-failure',
      prepareCandidate: async () => candidate(),
    });
    assert.equal(failedCommit.state, 'failed');
    assert.equal(failedCommit.reasonCode, 'persistence_conflict');
    assert.equal(failedCommit.retryAt, null);
    assert.equal(calls.commit, 1);
    assert.equal(calls.finish.at(-1)?.state, 'failed');
  }

  {
    const { store } = createStore();
    const retryAt = new Date(Date.now() + 60_000);
    const cooldownStore: PiCompactionCoordinatorStore = {
      ...store,
      start: async (input) => ({
        status: 'cooldown_active',
        attempt: { ...attempt(input.attemptId, retryAt), state: 'failed', reasonCode: 'summary_provider_error' },
      }),
    };
    const cooldown = await runPiSessionCompaction({
      ...baseRunInput(cooldownStore),
      attemptId: 'attempt-cooldown',
      prepareCandidate: async () => {
        assert.fail('cooldown must stop before candidate generation');
      },
    });
    assert.equal(cooldown.state, 'cooldown_active');
    assert.equal(cooldown.retryAt?.getTime(), retryAt.getTime());
  }

  console.log('pi-session-compaction-coordinator-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
