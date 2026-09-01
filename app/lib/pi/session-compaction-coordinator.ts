import 'server-only';

import { randomUUID } from 'node:crypto';

import type { PiHistoryComposition, PiSessionSummaryState } from './history-budget';
import type { PreparePiHistoryContextResult } from './session-summary';
import {
  commitPiSessionCompactionSummary,
  countPiSessionCompactionIneffectiveAttempts,
  countPiSessionCompactionRetryFailures,
  finishPiSessionCompactionAttempt,
  recordPiSessionCompactionProgress,
  startPiSessionCompactionAttempt,
  type CommitPiCompactionSummaryInput,
  type CommitPiCompactionSummaryResult,
  type FinishPiCompactionAttemptInput,
  type PiCompactionAttemptMetrics,
  type PiCompactionReasonCode,
  type PiCompactionScope,
  type RecordPiCompactionProgressInput,
  type PiCompactionTrigger,
  type StartPiCompactionAttemptInput,
  type StartPiCompactionAttemptResult,
} from './session-compaction-store';

export type PiCompactionCoordinatorPolicy = Readonly<{
  /** Legacy single timeout; used for both deadlines when split values are absent. */
  timeoutMs: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  breakerStrikeLimit?: number;
  breakerRecoveryMs?: number;
  retryDelaysMs: readonly number[];
}>;

type ResolvedPiCompactionCoordinatorPolicy = Readonly<{
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  breakerStrikeLimit: number;
  breakerRecoveryMs: number;
  retryDelaysMs: readonly number[];
}>;

export const DEFAULT_PI_COMPACTION_COORDINATOR_POLICY: PiCompactionCoordinatorPolicy = Object.freeze({
  timeoutMs: 120_000,
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 600_000,
  breakerStrikeLimit: 2,
  breakerRecoveryMs: 300_000,
  retryDelaysMs: Object.freeze([30_000, 120_000, 600_000]),
});

export type PiCompactionCoordinatorResult = Readonly<{
  state: 'succeeded' | 'no_op' | 'deferred' | 'failed' | 'aborted' | 'stale' | 'already_running' | 'cooldown_active' | 'breaker_active';
  attemptId: string;
  reasonCode: PiCompactionReasonCode | null;
  retryAt: Date | null;
  summary: PiSessionSummaryState | null;
  composition: PiHistoryComposition | null;
}>;

export type PiCompactionCoordinatorStore = Readonly<{
  start: (input: StartPiCompactionAttemptInput) => Promise<StartPiCompactionAttemptResult>;
  finish: (input: FinishPiCompactionAttemptInput) => Promise<Readonly<{
    changed: boolean;
    attempt: { attemptId: string; retryAt: Date | null };
  }>>;
  commit: (input: CommitPiCompactionSummaryInput) => Promise<CommitPiCompactionSummaryResult>;
  countRetryFailures: (scope: PiCompactionScope) => Promise<number>;
  countIneffectiveAttempts?: (scope: PiCompactionScope) => Promise<number>;
  progress?: (input: RecordPiCompactionProgressInput) => Promise<boolean>;
}>;

export type PiCompactionProgressReport = Readonly<{
  stage?: string;
  completed?: number;
  total?: number;
}>;

export type RunPiSessionCompactionInput = PiCompactionScope & Readonly<{
  trigger: PiCompactionTrigger;
  /** Allows one internal exact-budget retry through an automatic cooldown. */
  bypassCooldown?: boolean;
  generation: string;
  expectedSummaryRevision: number;
  expectedThroughSequence: number | null;
  provider: string;
  model: string;
  contractFingerprint?: string | null;
  metrics?: PiCompactionAttemptMetrics;
  signal?: AbortSignal;
  now?: Date;
  attemptId?: string;
  policy?: PiCompactionCoordinatorPolicy;
  store?: PiCompactionCoordinatorStore;
  isGenerationCurrent?: (generation: string) => boolean;
  prepareCandidate: (
    signal: AbortSignal,
    reportProgress: (progress?: PiCompactionProgressReport) => void,
  ) => Promise<PreparePiHistoryContextResult>;
}>;

type ActiveAttempt = {
  attemptId: string;
  generation: string;
  controller: AbortController;
  termination: 'aborted' | 'stale' | 'idle_timed_out' | 'total_timed_out' | null;
  startedAt: Date;
  progressEventCount: number;
};

const activeAttempts = new Map<string, ActiveAttempt>();

const DEFAULT_STORE: PiCompactionCoordinatorStore = {
  start: startPiSessionCompactionAttempt,
  finish: finishPiSessionCompactionAttempt,
  commit: commitPiSessionCompactionSummary,
  countRetryFailures: countPiSessionCompactionRetryFailures,
  countIneffectiveAttempts: countPiSessionCompactionIneffectiveAttempts,
  progress: recordPiSessionCompactionProgress,
};

function scopeKey(scope: PiCompactionScope): string {
  return JSON.stringify([scope.userId, scope.sessionId, scope.agentId]);
}

function validatePolicy(policy: PiCompactionCoordinatorPolicy): ResolvedPiCompactionCoordinatorPolicy {
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new Error('Compaction timeout must be a positive integer.');
  }
  if (
    policy.retryDelaysMs.length === 0
    || policy.retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new Error('Compaction retry delays must contain non-negative integers.');
  }
  const idleTimeoutMs = policy.idleTimeoutMs ?? policy.timeoutMs;
  const totalTimeoutMs = policy.totalTimeoutMs ?? policy.timeoutMs;
  const breakerStrikeLimit = policy.breakerStrikeLimit ?? 2;
  const breakerRecoveryMs = policy.breakerRecoveryMs ?? 300_000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error('Compaction idle timeout must be a positive integer.');
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < idleTimeoutMs) {
    throw new Error('Compaction total timeout must be an integer at least as large as the idle timeout.');
  }
  if (!Number.isSafeInteger(breakerStrikeLimit) || breakerStrikeLimit < 2) {
    throw new Error('Compaction breaker strike limit must be an integer of at least two.');
  }
  if (!Number.isSafeInteger(breakerRecoveryMs) || breakerRecoveryMs <= 0) {
    throw new Error('Compaction breaker recovery must be a positive integer.');
  }
  return Object.freeze({
    idleTimeoutMs,
    totalTimeoutMs,
    breakerStrikeLimit,
    breakerRecoveryMs,
    retryDelaysMs: policy.retryDelaysMs,
  });
}

function result(input: {
  state: PiCompactionCoordinatorResult['state'];
  attemptId: string;
  reasonCode?: PiCompactionReasonCode | null;
  retryAt?: Date | null;
  summary?: PiSessionSummaryState | null;
  composition?: PiHistoryComposition | null;
}): PiCompactionCoordinatorResult {
  return Object.freeze({
    state: input.state,
    attemptId: input.attemptId,
    reasonCode: input.reasonCode ?? null,
    retryAt: input.retryAt ?? null,
    summary: input.summary ?? null,
    composition: input.composition ?? null,
  });
}

function pressureBasisPoints(tokens: number, triggerTokens: number): number | null {
  if (triggerTokens <= 0) return null;
  return Math.max(0, Math.round((tokens / triggerTokens) * 10_000));
}

function getCandidateMetrics(
  candidate: PreparePiHistoryContextResult,
  baseMetrics: PiCompactionAttemptMetrics | undefined,
  active: ActiveAttempt,
  finishedAt: Date,
): PiCompactionAttemptMetrics {
  return {
    ...baseMetrics,
    afterEstimatedTokens: candidate.composition.estimatedHistoryTokens,
    afterEstimatedBytes: candidate.composition.estimatedHistoryBytes,
    triggerTokens: candidate.composition.triggerHistoryTokens,
    targetTokens: candidate.composition.targetHistoryTokens,
    afterPressureBasisPoints: pressureBasisPoints(
      candidate.composition.estimatedHistoryTokens,
      candidate.composition.triggerHistoryTokens,
    ),
    summarizedUnitCount: candidate.unsummarizedMessageCount,
    omittedUnitCount: candidate.composition.omittedMessages.length,
    durationMs: Math.max(0, finishedAt.getTime() - active.startedAt.getTime()),
    progressEventCount: active.progressEventCount,
  };
}

function getTerminalMetrics(
  baseMetrics: PiCompactionAttemptMetrics | undefined,
  active: ActiveAttempt,
  finishedAt: Date,
): PiCompactionAttemptMetrics {
  return {
    ...baseMetrics,
    durationMs: Math.max(0, finishedAt.getTime() - active.startedAt.getTime()),
    progressEventCount: active.progressEventCount,
  };
}

function candidateFailureReason(candidate: PreparePiHistoryContextResult): PiCompactionReasonCode {
  if (candidate.composition.payloadBudgetExceeded) return 'payload_bytes_exceeded';
  if (candidate.composition.contextBudgetExceeded) return 'fixed_context_too_large';
  if (candidate.summaryFailed) return 'summary_provider_error';
  return candidate.composition.softThresholdExceeded
    ? 'nothing_eligible'
    : 'soft_threshold_not_reached';
}

function isAttemptCurrent(
  key: string,
  active: ActiveAttempt,
  input: RunPiSessionCompactionInput,
): boolean {
  return activeAttempts.get(key) === active
    && active.termination === null
    && !active.controller.signal.aborted
    && (input.isGenerationCurrent?.(active.generation) ?? true);
}

function terminate(active: ActiveAttempt, termination: NonNullable<ActiveAttempt['termination']>): void {
  if (active.termination !== null) return;
  active.termination = termination;
  active.controller.abort(new Error(`Compaction ${termination}.`));
}

function getTermination(active: ActiveAttempt): ActiveAttempt['termination'] {
  return active.termination;
}

function retryAtForFailure(now: Date, ordinal: number, policy: ResolvedPiCompactionCoordinatorPolicy): Date {
  const index = Math.min(Math.max(0, ordinal), policy.retryDelaysMs.length - 1);
  return new Date(now.getTime() + policy.retryDelaysMs[index]);
}

async function finishWithRetry(
  store: PiCompactionCoordinatorStore,
  scope: PiCompactionScope,
  attemptId: string,
  state: 'deferred' | 'failed' | 'timed_out',
  reasonCode: PiCompactionReasonCode,
  now: Date,
  policy: ResolvedPiCompactionCoordinatorPolicy,
  metrics?: PiCompactionAttemptMetrics,
  composition?: PiHistoryComposition | null,
): Promise<PiCompactionCoordinatorResult> {
  const failureOrdinal = await store.countRetryFailures(scope);
  const retryAt = retryAtForFailure(now, failureOrdinal, policy);
  const finished = await store.finish({
    ...scope,
    attemptId,
    state,
    reasonCode,
    retryAt,
    metrics,
    now,
  });
  return result({
    state: state === 'timed_out' ? 'failed' : state,
    attemptId,
    reasonCode,
    retryAt: finished.attempt.retryAt ?? retryAt,
    composition,
  });
}

async function finishNoOp(
  store: PiCompactionCoordinatorStore,
  scope: PiCompactionScope,
  input: RunPiSessionCompactionInput,
  attemptId: string,
  reasonCode: PiCompactionReasonCode,
  now: Date,
  policy: ResolvedPiCompactionCoordinatorPolicy,
  metrics: PiCompactionAttemptMetrics,
  composition: PiHistoryComposition,
): Promise<PiCompactionCoordinatorResult> {
  let retryAt: Date | null = null;
  if (
    reasonCode === 'nothing_eligible'
    && input.trigger !== 'manual'
    && store.countIneffectiveAttempts
  ) {
    const priorStrikes = await store.countIneffectiveAttempts(scope);
    if (priorStrikes + 1 >= policy.breakerStrikeLimit) {
      retryAt = new Date(now.getTime() + policy.breakerRecoveryMs);
    }
  }
  const finished = await store.finish({
    ...scope,
    attemptId,
    state: 'no_op',
    reasonCode,
    retryAt,
    metrics,
    now,
  });
  return result({
    state: 'no_op',
    attemptId,
    reasonCode,
    retryAt: finished.attempt.retryAt ?? retryAt,
    composition,
  });
}

export async function runPiSessionCompaction(
  input: RunPiSessionCompactionInput,
): Promise<PiCompactionCoordinatorResult> {
  const scope: PiCompactionScope = {
    sessionId: input.sessionId,
    userId: input.userId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  };
  const key = scopeKey(scope);
  const existing = activeAttempts.get(key);
  if (existing) {
    return result({ state: 'already_running', attemptId: existing.attemptId });
  }

  const policy = validatePolicy(input.policy ?? DEFAULT_PI_COMPACTION_COORDINATOR_POLICY);
  const store = input.store ?? DEFAULT_STORE;
  const now = input.now ?? new Date();
  const attemptId = input.attemptId?.trim() || `compact-${randomUUID()}`;
  const active: ActiveAttempt = {
    attemptId,
    generation: input.generation,
    controller: new AbortController(),
    termination: null,
    startedAt: now,
    progressEventCount: 0,
  };
  activeAttempts.set(key, active);

  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  let totalTimeout: ReturnType<typeof setTimeout> | null = null;
  let progressWrites = Promise.resolve();
  let removeExternalAbort: (() => void) | null = null;
  try {
    if (input.signal?.aborted) terminate(active, 'aborted');
    else if (input.signal) {
      const onAbort = () => terminate(active, 'aborted');
      input.signal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbort = () => input.signal?.removeEventListener('abort', onAbort);
    }

    const deadlineAt = new Date(now.getTime() + policy.totalTimeoutMs);
    const idleDeadlineAt = new Date(now.getTime() + policy.idleTimeoutMs);
    const initialMetrics: PiCompactionAttemptMetrics = {
      ...input.metrics,
      beforePressureBasisPoints: input.metrics?.beforePressureBasisPoints
        ?? pressureBasisPoints(
          input.metrics?.beforeEstimatedTokens ?? 0,
          input.metrics?.triggerTokens ?? 0,
        ),
      summaryProvider: input.metrics?.summaryProvider ?? input.provider,
      summaryModel: input.metrics?.summaryModel ?? input.model,
    };
    const started = await store.start({
      ...scope,
      attemptId,
      trigger: input.trigger,
      bypassCooldown: input.bypassCooldown,
      expectedSummaryRevision: input.expectedSummaryRevision,
      expectedThroughSequence: input.expectedThroughSequence,
      deadlineAt,
      idleDeadlineAt,
      provider: input.provider,
      model: input.model,
      contractFingerprint: input.bypassCooldown
        ? `exact-budget-retry:${input.contractFingerprint ?? input.generation}`
        : input.contractFingerprint,
      metrics: initialMetrics,
      expiredAttemptRetryAt: policy.retryDelaysMs[0] > 0
        ? new Date(now.getTime() + policy.retryDelaysMs[0])
        : null,
      now,
    });
    if (started.status === 'already_running') {
      return result({ state: 'already_running', attemptId: started.attempt.attemptId });
    }
    if (started.status === 'cooldown_active') {
      return result({
        state: 'cooldown_active',
        attemptId: started.attempt.attemptId,
        reasonCode: 'cooldown_active',
        retryAt: started.attempt.retryAt,
      });
    }
    if (started.status === 'breaker_active') {
      return result({
        state: 'breaker_active',
        attemptId: started.attempt.attemptId,
        reasonCode: 'breaker_active',
        retryAt: started.attempt.retryAt,
      });
    }
    if (started.status === 'stale') {
      return result({ state: 'stale', attemptId, reasonCode: 'stale_snapshot' });
    }
    if (active.termination === 'aborted') {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'aborted',
        reasonCode: 'aborted',
        metrics: getTerminalMetrics(initialMetrics, active, now),
        now,
      });
      return result({ state: 'aborted', attemptId, reasonCode: 'aborted', retryAt: finished.attempt.retryAt });
    }
    if (active.termination === 'stale' || !(input.isGenerationCurrent?.(active.generation) ?? true)) {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'stale',
        reasonCode: 'stale_snapshot',
        metrics: getTerminalMetrics(initialMetrics, active, now),
        now,
      });
      return result({ state: 'stale', attemptId, reasonCode: 'stale_snapshot', retryAt: finished.attempt.retryAt });
    }

    const armIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => terminate(active, 'idle_timed_out'), policy.idleTimeoutMs);
    };
    const reportProgress = (_progress?: PiCompactionProgressReport) => {
      if (!isAttemptCurrent(key, active, input)) return;
      active.progressEventCount += 1;
      armIdleTimeout();
      if (store.progress) {
        const progressNow = new Date();
        progressWrites = progressWrites
          .then(() => store.progress!({
            ...scope,
            attemptId,
            idleDeadlineAt: new Date(progressNow.getTime() + policy.idleTimeoutMs),
            now: progressNow,
          }))
          .then(() => undefined)
          .catch(() => undefined);
      }
    };
    armIdleTimeout();
    totalTimeout = setTimeout(() => terminate(active, 'total_timed_out'), policy.totalTimeoutMs);
    const candidatePromise = Promise.resolve().then(() => input.prepareCandidate(
      active.controller.signal,
      reportProgress,
    ));
    const terminationPromise = new Promise<never>((_resolve, reject) => {
      if (active.controller.signal.aborted) {
        reject(active.controller.signal.reason);
        return;
      }
      active.controller.signal.addEventListener('abort', () => reject(active.controller.signal.reason), { once: true });
    });

    let candidate: PreparePiHistoryContextResult;
    try {
      candidate = await Promise.race([candidatePromise, terminationPromise]);
    } catch {
      void candidatePromise.catch(() => undefined);
      const finishedAt = new Date();
      await progressWrites;
      const termination = getTermination(active);
      if (termination === 'idle_timed_out' || termination === 'total_timed_out') {
        return finishWithRetry(
          store,
          scope,
          attemptId,
          'timed_out',
          termination === 'idle_timed_out' ? 'summary_idle_timeout' : 'summary_total_timeout',
          finishedAt,
          policy,
          getTerminalMetrics(initialMetrics, active, finishedAt),
        );
      }
      if (termination === 'aborted') {
        const finished = await store.finish({
          ...scope,
          attemptId,
          state: 'aborted',
          reasonCode: 'aborted',
          metrics: getTerminalMetrics(initialMetrics, active, finishedAt),
          now: finishedAt,
        });
        return result({ state: 'aborted', attemptId, reasonCode: 'aborted', retryAt: finished.attempt.retryAt });
      }
      if (termination === 'stale') {
        const finished = await store.finish({
          ...scope,
          attemptId,
          state: 'stale',
          reasonCode: 'stale_snapshot',
          metrics: getTerminalMetrics(initialMetrics, active, finishedAt),
          now: finishedAt,
        });
        return result({ state: 'stale', attemptId, reasonCode: 'stale_snapshot', retryAt: finished.attempt.retryAt });
      }
      return finishWithRetry(
        store,
        scope,
        attemptId,
        'failed',
        'summary_provider_error',
        finishedAt,
        policy,
        getTerminalMetrics(initialMetrics, active, finishedAt),
      );
    }

    await progressWrites;
    const candidateFinishedAt = new Date();
    const candidateMetrics = getCandidateMetrics(candidate, initialMetrics, active, candidateFinishedAt);
    const termination = getTermination(active);
    if (termination === 'idle_timed_out' || termination === 'total_timed_out') {
      return finishWithRetry(
        store,
        scope,
        attemptId,
        'timed_out',
        termination === 'idle_timed_out' ? 'summary_idle_timeout' : 'summary_total_timeout',
        candidateFinishedAt,
        policy,
        candidateMetrics,
      );
    }
    if (termination === 'aborted') {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'aborted',
        reasonCode: 'aborted',
        metrics: candidateMetrics,
        now: candidateFinishedAt,
      });
      return result({ state: 'aborted', attemptId, reasonCode: 'aborted', retryAt: finished.attempt.retryAt });
    }
    if (!isAttemptCurrent(key, active, input)) {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'stale',
        reasonCode: 'stale_snapshot',
        metrics: candidateMetrics,
        now: new Date(),
      });
      return result({ state: 'stale', attemptId, reasonCode: 'stale_snapshot', retryAt: finished.attempt.retryAt });
    }

    if (candidate.composition.contextBudgetExceeded) {
      const reasonCode = candidateFailureReason(candidate);
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'failed',
        reasonCode,
        metrics: candidateMetrics,
        now: new Date(),
      });
      return result({ state: 'failed', attemptId, reasonCode, retryAt: finished.attempt.retryAt });
    }

    if (candidate.summaryFailed) {
      return finishWithRetry(
        store,
        scope,
        attemptId,
        candidate.safeToSend ? 'deferred' : 'failed',
        'summary_provider_error',
        new Date(),
        policy,
        candidateMetrics,
        candidate.composition,
      );
    }

    if (!candidate.summaryUpdated) {
      const reasonCode = candidateFailureReason(candidate);
      return finishNoOp(
        store,
        scope,
        input,
        attemptId,
        reasonCode,
        new Date(),
        policy,
        candidateMetrics,
        candidate.composition,
      );
    }

    const summaryText = candidate.summary.summaryText?.trim() || null;
    const throughSequence = candidate.summary.summaryThroughSequence;
    if (!summaryText || throughSequence === null) {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'failed',
        reasonCode: 'persistence_conflict',
        metrics: candidateMetrics,
        now: new Date(),
      });
      return result({
        state: 'failed',
        attemptId,
        reasonCode: 'persistence_conflict',
        retryAt: finished.attempt.retryAt,
      });
    }

    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = null;
    if (totalTimeout) clearTimeout(totalTimeout);
    totalTimeout = null;
    let committed: CommitPiCompactionSummaryResult;
    try {
      const commitNow = new Date();
      const commitMetrics = getCandidateMetrics(candidate, initialMetrics, active, commitNow);
      committed = await store.commit({
        ...scope,
        attemptId,
        expectedSummaryRevision: input.expectedSummaryRevision,
        expectedThroughSequence: input.expectedThroughSequence,
        summaryText,
        throughSequence,
        metrics: commitMetrics,
        now: commitNow,
      });
    } catch {
      const finished = await store.finish({
        ...scope,
        attemptId,
        state: 'failed',
        reasonCode: 'persistence_conflict',
        metrics: candidateMetrics,
        now: new Date(),
      });
      return result({
        state: 'failed',
        attemptId,
        reasonCode: 'persistence_conflict',
        retryAt: finished.attempt.retryAt,
      });
    }
    if (committed.status === 'stale') {
      return result({ state: 'stale', attemptId, reasonCode: 'stale_snapshot' });
    }
    if (committed.status === 'already_finished') {
      const state = committed.attempt.state === 'aborted' ? 'aborted' : 'stale';
      return result({
        state,
        attemptId,
        reasonCode: committed.attempt.reasonCode ?? (state === 'aborted' ? 'aborted' : 'stale_snapshot'),
        retryAt: committed.attempt.retryAt,
      });
    }
    // The transactional store result is authoritative once the summary commit wins.
    // A concurrent abort/invalidation may still stop the active turn, but callers must
    // adopt the committed revision so later saves cannot continue from stale state.
    return result({
      state: 'succeeded',
      attemptId,
      summary: committed.summary,
      composition: candidate.composition,
    });
  } finally {
    if (idleTimeout) clearTimeout(idleTimeout);
    if (totalTimeout) clearTimeout(totalTimeout);
    removeExternalAbort?.();
    if (activeAttempts.get(key) === active) activeAttempts.delete(key);
  }
}

export function abortPiSessionCompaction(scope: PiCompactionScope): boolean {
  const active = activeAttempts.get(scopeKey(scope));
  if (!active) return false;
  terminate(active, 'aborted');
  return true;
}

export function invalidatePiSessionCompaction(scope: PiCompactionScope): boolean {
  const active = activeAttempts.get(scopeKey(scope));
  if (!active) return false;
  terminate(active, 'stale');
  return true;
}

export function getActivePiSessionCompaction(scope: PiCompactionScope): Readonly<{
  attemptId: string;
  generation: string;
}> | null {
  const active = activeAttempts.get(scopeKey(scope));
  return active ? Object.freeze({ attemptId: active.attemptId, generation: active.generation }) : null;
}
