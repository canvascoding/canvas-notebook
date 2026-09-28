import 'server-only';

import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { DelegateTaskRequest, DelegateTaskResult } from '@/app/lib/pi/delegate-task-tool';
import { createDelegationCompletionMessage } from '@/app/lib/pi/delegation-completion-message';
import { appendPiDelegationProgress } from '@/app/lib/pi/delegation-progress';
import {
  cancelRunningPiDelegation,
  claimPiDelegationDelivery,
  claimQueuedPiDelegation,
  completeRunningPiDelegation,
  createPiDelegation,
  heartbeatOwnedPiDelegations,
  getPiDelegation,
  listDeliverablePiDelegations,
  listQueuedPiDelegations,
  listStaleRunningPiDelegations,
  piDelegationToolsets,
  recoverInterruptedPiDelegationDeliveries,
  failInterruptedPiDelegations,
  requestPiDelegationCancellation,
  updatePiDelegationDelivery,
  updateRunningPiDelegationWorkerSession,
  type PiDelegationRecord,
} from '@/app/lib/pi/delegation-store';

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONFIGURED_CONCURRENCY = 32;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DELIVERY_RETRY_INTERVAL_MS = 30_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
const LEASE_RECOVERY_INTERVAL_MS = 15_000;

type StartDelegatedRun = (request: DelegateTaskRequest) => Promise<DelegateTaskResult>;
type DeliverDelegationCompletion = (record: PiDelegationRecord) => Promise<void>;

export type DelegationDispatcherOptions = {
  maxConcurrency?: number;
  pollIntervalMs?: number;
  recoverInterrupted?: boolean;
  startDelegatedRunFn?: StartDelegatedRun;
  deliverCompletionFn?: DeliverDelegationCompletion;
};

function configuredMaxConcurrency(): number {
  const parsed = Number.parseInt(process.env.CANVAS_DELEGATION_MAX_CONCURRENCY || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(parsed, MAX_CONFIGURED_CONCURRENCY));
}

function buildDelegationId(): string {
  return `delegation-${Date.now()}-${randomUUID()}`;
}

function buildWorkerSessionId(): string {
  return `sess-${Date.now()}-${randomUUID()}`;
}

async function startDelegatedRun(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  const runner = await import('@/app/lib/pi/delegate-task-tool');
  return runner.startDelegatedRun(request);
}

async function deliverCompletionToParent(record: PiDelegationRecord): Promise<void> {
  const { sendFollowUpMessage } = await import('@/app/lib/pi/runtime-service');
  await sendFollowUpMessage(
    record.sourceSessionId,
    record.userId,
    createDelegationCompletionMessage(record),
    undefined,
    { expectedAgentId: record.sourceAgentId },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown delegation dispatcher error';
}

async function persistLifecycleProgress(input: Parameters<typeof appendPiDelegationProgress>[0]): Promise<void> {
  try {
    await appendPiDelegationProgress(input);
  } catch {
    // The delegation row is authoritative. A progress write must not strand a
    // claimed run or make an accepted task appear rejected to its caller.
    console.warn('[delegation-dispatcher] Could not persist a lifecycle progress event.');
  }
}

function messageText(message: AgentMessage): string {
  if (!('content' in message)) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (
    part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part
      ? String(part.text)
      : ''
  )).filter(Boolean).join('\n').trim();
}

async function recoverPersistedWorkerResult(record: PiDelegationRecord): Promise<DelegateTaskResult | null> {
  const { loadPiSession } = await import('@/app/lib/pi/session-store');
  const messages = await loadPiSession(
    record.workerSessionId,
    record.userId,
    record.targetAgentId ?? record.sourceAgentId,
  );
  if (!messages) return null;

  const marker = `Delegation task ID: ${record.id}`;
  const promptIndex = messages.findIndex((message) => (
    message.role === 'user' && messageText(message).includes(marker)
  ));
  if (promptIndex < 0) return null;

  const following = messages.slice(promptIndex + 1);
  const nextUserIndex = following.findIndex((message) => message.role === 'user');
  const taskMessages = nextUserIndex >= 0 ? following.slice(0, nextUserIndex) : following;
  const assistant = taskMessages.at(-1);
  if (!assistant || assistant.role !== 'assistant' || (assistant.stopReason !== 'stop' && assistant.stopReason !== 'error')) return null;
  const unresolvedTools = new Set<string>();
  for (const message of taskMessages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'toolCall') unresolvedTools.add(part.id);
      }
    }
    if (message.role === 'toolResult') unresolvedTools.delete(message.toolCallId);
  }
  if (unresolvedTools.size > 0) return null;

  const reply = messageText(assistant);
  const failed = assistant.stopReason === 'error';
  return {
    delegation_id: record.id,
    status: failed ? 'error' : 'ok',
    worker_type: record.workerType as 'ephemeral' | 'managed',
    source_agent_id: record.sourceAgentId,
    target_agent_id: record.targetAgentId ?? undefined,
    session_id: record.workerSessionId,
    role: record.workerRole ?? undefined,
    toolsets: piDelegationToolsets(record),
    wait_for_result: false,
    timeout_seconds: 0,
    reply: failed ? undefined : reply || undefined,
    error: failed ? assistant.errorMessage || reply || 'Recovered delegated worker failed.' : undefined,
  };
}

export class PiDelegationDispatcher {
  private readonly ownerId = randomUUID();
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly recoverInterrupted: boolean;
  private readonly startDelegatedRunFn: StartDelegatedRun;
  private readonly deliverCompletionFn: DeliverDelegationCompletion;
  private readonly active = new Map<string, AbortController>();
  private readonly delivering = new Set<string>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpScheduled = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deliveryRetryTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryPromise: Promise<void> | null = null;

  constructor(options: DelegationDispatcherOptions = {}) {
    this.maxConcurrency = Math.max(
      1,
      Math.min(Math.trunc(options.maxConcurrency ?? configuredMaxConcurrency()), MAX_CONFIGURED_CONCURRENCY),
    );
    this.pollIntervalMs = Math.max(100, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.recoverInterrupted = options.recoverInterrupted ?? true;
    this.startDelegatedRunFn = options.startDelegatedRunFn ?? startDelegatedRun;
    this.deliverCompletionFn = options.deliverCompletionFn ?? deliverCompletionToParent;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      if (this.recoverInterrupted) {
        await this.recoverExpiredLeases();
      }

      this.initialized = true;
      this.pollTimer = setInterval(() => this.schedulePump(), this.pollIntervalMs);
      this.pollTimer.unref?.();
      this.deliveryRetryTimer = setInterval(() => {
        void this.deliverPending().catch((error) => {
          console.error('[delegation-dispatcher] Completion delivery retry failed:', error);
        });
      }, DELIVERY_RETRY_INTERVAL_MS);
      this.deliveryRetryTimer.unref?.();
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeatOwned().catch(() => {
          for (const controller of this.active.values()) controller.abort(new Error('Delegation lease could not be renewed.'));
        });
      }, LEASE_HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
      if (this.recoverInterrupted) {
        this.recoveryTimer = setInterval(() => {
          void this.recoverExpiredLeases().catch(() => console.warn('[delegation-dispatcher] Lease recovery is temporarily unavailable.'));
        }, LEASE_RECOVERY_INTERVAL_MS);
        this.recoveryTimer.unref?.();
      }

      await this.deliverPending();
      this.schedulePump();
    })();

    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = null;
      throw error;
    }
  }

  async enqueue(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
    if (request.abortSignal?.aborted) {
      throw request.abortSignal.reason instanceof Error
        ? request.abortSignal.reason
        : new Error('Delegation was aborted before it could be queued.');
    }

    await this.initialize();
    const requestedSessionId = request.sessionId?.trim();
    if (requestedSessionId) {
      if (!request.targetAgentId) {
        throw new Error('session_id can only be used with target_agent_id.');
      }
      const { requireManagedDelegatedSessionReuse } = await import('@/app/lib/pi/delegate-task-tool');
      await requireManagedDelegatedSessionReuse(request, requestedSessionId);
    }
    const delegationId = request.delegationId?.trim() || buildDelegationId();
    const workerSessionId = requestedSessionId
      || request.workerSessionId?.trim()
      || buildWorkerSessionId();
    const workerType = request.targetAgentId ? 'managed' : 'ephemeral';
    const record = await createPiDelegation({
      id: delegationId,
      userId: request.userId,
      sourceSessionId: request.sourceSessionId,
      sourceAgentId: request.sourceAgentId,
      workerSessionId,
      requestedSessionId: request.sessionId,
      targetAgentId: request.targetAgentId,
      workerType,
      goal: request.goal,
      context: request.context,
      workerRole: request.workerRole,
      toolsets: request.toolsets,
    });
    await persistLifecycleProgress({ delegationId: record.id, userId: record.userId, kind: 'queued', eventKey: 'queued' });
    this.schedulePump();

    return {
      delegation_id: record.id,
      status: 'accepted',
      worker_type: workerType,
      source_agent_id: record.sourceAgentId,
      target_agent_id: record.targetAgentId ?? undefined,
      session_id: record.workerSessionId,
      role: record.workerRole ?? undefined,
      toolsets: piDelegationToolsets(record),
      wait_for_result: false,
      timeout_seconds: 0,
    };
  }

  async cancel(id: string, userId: string): Promise<PiDelegationRecord | null> {
    const record = await requestPiDelegationCancellation(id, userId);
    if (record?.status === 'cancelled') {
      await persistLifecycleProgress({ delegationId: id, userId, kind: 'cancelled', eventKey: 'cancelled' });
    }
    if (record?.status === 'running') {
      this.active.get(id)?.abort(new Error('Delegated task was cancelled by the user.'));
    }
    this.schedulePump();
    return record;
  }

  getActiveCount(): number {
    return this.active.size;
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deliveryRetryTimer) clearInterval(this.deliveryRetryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.pollTimer = null;
    this.deliveryRetryTimer = null;
    this.heartbeatTimer = null;
    this.recoveryTimer = null;
  }

  private async heartbeatOwned(): Promise<void> {
    const runningIds = [...this.active.keys()];
    const deliveringIds = [...this.delivering];
    if (runningIds.length === 0 && deliveringIds.length === 0) return;
    const refreshed = await heartbeatOwnedPiDelegations({ runOwnerId: this.ownerId, runningIds, deliveringIds });
    const ownedRunning = new Set(refreshed.runningIds);
    for (const id of runningIds) {
      if (!ownedRunning.has(id)) this.active.get(id)?.abort(new Error('Delegation run lease was lost.'));
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      for (const record of await listStaleRunningPiDelegations()) {
        const persistedResult = await recoverPersistedWorkerResult(record);
        if (!persistedResult) continue;
        const completed = await completeRunningPiDelegation({
          id: record.id,
          resultStatus: persistedResult.status === 'ok' ? 'ok' : 'error',
          resultText: persistedResult.reply,
          errorText: persistedResult.error,
          runOwnerId: record.runOwnerId ?? undefined,
          staleRecovery: true,
        });
        if (completed) await persistLifecycleProgress({
          delegationId: completed.id, userId: completed.userId,
          kind: completed.status === 'completed' ? 'completed' : 'failed', eventKey: 'terminal',
        });
      }
      const interrupted = await failInterruptedPiDelegations();
      for (const record of interrupted) {
        await persistLifecycleProgress({ delegationId: record.id, userId: record.userId, kind: 'failed', eventKey: 'interrupted-after-restart' });
      }
      const uncertainDeliveries = await recoverInterruptedPiDelegationDeliveries();
      if (interrupted.length > 0 || uncertainDeliveries > 0) {
        console.warn(`[delegation-dispatcher] Recovered ${interrupted.length} expired worker lease(s), ${uncertainDeliveries} uncertain completion delivery receipt(s).`);
      }
      if (interrupted.length > 0) await this.deliverPending();
    })();
    try { await this.recoveryPromise; } finally { this.recoveryPromise = null; }
  }

  private schedulePump(): void {
    if (!this.initialized || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump().catch((error) => {
        console.error('[delegation-dispatcher] Queue pump failed:', error);
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = (async () => {
      const availableSlots = this.maxConcurrency - this.active.size;
      if (availableSlots <= 0) return;

      const queued = await listQueuedPiDelegations(availableSlots);
      for (const candidate of queued) {
        if (this.active.size >= this.maxConcurrency) break;
        const claimed = await claimQueuedPiDelegation(candidate.id, this.ownerId);
        if (!claimed) continue;
        this.startClaimed(claimed);
      }
    })();

    try {
      await this.pumpPromise;
    } finally {
      this.pumpPromise = null;
    }
  }

  private startClaimed(record: PiDelegationRecord): void {
    const controller = new AbortController();
    this.active.set(record.id, controller);
    void (async () => {
      await persistLifecycleProgress({ delegationId: record.id, userId: record.userId, kind: 'running', eventKey: 'running' });
      await this.runClaimed(record, controller);
    })().catch((error) => {
      console.error(`[delegation-dispatcher] Task ${record.id} failed:`, error);
    }).finally(() => {
      this.active.delete(record.id);
      this.schedulePump();
    });
  }

  private async runClaimed(
    claimed: PiDelegationRecord,
    controller: AbortController,
  ): Promise<void> {
    let record = claimed;
    if (record.attemptCount > 1) {
      const persistedResult = await recoverPersistedWorkerResult(record);
      if (persistedResult) {
        await this.finalize(record.id, persistedResult, controller.signal);
        return;
      }
      await this.finalize(record.id, {
        delegation_id: record.id,
        status: 'error',
        worker_type: record.workerType as 'ephemeral' | 'managed',
        source_agent_id: record.sourceAgentId,
        target_agent_id: record.targetAgentId ?? undefined,
        session_id: record.workerSessionId,
        toolsets: piDelegationToolsets(record),
        wait_for_result: false,
        timeout_seconds: 0,
        error: 'Delegated task was interrupted before completion. Start a new task to continue.',
      }, controller.signal);
      return;
    }

    let resolveCompletion!: (result: DelegateTaskResult) => void;
    const completion = new Promise<DelegateTaskResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let completionReported = false;
    const reportCompletion = (result: DelegateTaskResult) => {
      if (completionReported) return;
      completionReported = true;
      resolveCompletion(result);
    };

    try {
      const started = await this.startDelegatedRunFn({
        delegationId: record.id,
        userId: record.userId,
        sourceAgentId: record.sourceAgentId,
        sourceSessionId: record.sourceSessionId,
        abortSignal: controller.signal,
        targetAgentId: record.targetAgentId ?? undefined,
        goal: record.goal,
        context: record.context ?? undefined,
        sessionId: record.requestedSessionId ?? undefined,
        workerSessionId: record.workerSessionId,
        workerRole: record.workerRole ?? undefined,
        toolsets: piDelegationToolsets(record),
        waitForResult: false,
        timeoutSeconds: 0,
        onCompletion: reportCompletion,
      });
      if (started.session_id && started.session_id !== record.workerSessionId) {
        const updated = await updateRunningPiDelegationWorkerSession(record.id, started.session_id, this.ownerId);
        if (updated) record = updated;
      }
      if (started.status !== 'accepted') reportCompletion(started);

      const result = await completion;
      await this.finalize(record.id, result, controller.signal);
    } catch (error) {
      await this.finalize(record.id, {
        delegation_id: record.id,
        status: 'error',
        worker_type: record.workerType as 'ephemeral' | 'managed',
        source_agent_id: record.sourceAgentId,
        target_agent_id: record.targetAgentId ?? undefined,
        session_id: record.workerSessionId,
        role: record.workerRole ?? undefined,
        toolsets: piDelegationToolsets(record),
        wait_for_result: false,
        timeout_seconds: 0,
        error: errorMessage(error),
      }, controller.signal);
    }
  }

  private async finalize(
    id: string,
    result: DelegateTaskResult,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await getPiDelegation(id);
    if (!current || current.status !== 'running' || current.runOwnerId !== this.ownerId) return;

    if (current.cancelRequestedAt || signal.aborted) {
      const cancelled = await cancelRunningPiDelegation(
        id,
        result.error || (signal.reason instanceof Error ? signal.reason.message : 'Delegated task was cancelled.'),
        this.ownerId,
      );
      if (cancelled) await persistLifecycleProgress({ delegationId: id, userId: cancelled.userId, kind: 'cancelled', eventKey: 'cancelled' });
      return;
    }

    const completed = await completeRunningPiDelegation({
      id,
      resultStatus: result.status === 'ok' ? 'ok' : result.status === 'timeout' ? 'timeout' : 'error',
      resultText: result.reply,
      errorText: result.error,
      runOwnerId: this.ownerId,
    });
    if (completed) {
      await persistLifecycleProgress({
        delegationId: id,
        userId: completed.userId,
        kind: completed.status === 'completed' ? 'completed' : 'failed',
        eventKey: 'terminal',
      });
      await this.deliver(completed.id);
    }
  }

  private async deliver(id: string): Promise<void> {
    const claimed = await claimPiDelegationDelivery(id, this.ownerId);
    if (!claimed) return;
    this.delivering.add(id);

    try {
      await this.deliverCompletionFn(claimed);
      await updatePiDelegationDelivery({ id, status: 'delivered', deliveryOwnerId: this.ownerId });
    } catch (error) {
      const message = errorMessage(error);
      await updatePiDelegationDelivery({
        id,
        status: 'failed',
        deliveryErrorText: message,
        deliveryOwnerId: this.ownerId,
      });
      console.error(`[delegation-dispatcher] Failed to deliver task ${id}:`, error);
    } finally {
      this.delivering.delete(id);
    }
  }

  private async deliverPending(): Promise<void> {
    const deliverable = await listDeliverablePiDelegations(this.maxConcurrency);
    await Promise.allSettled(deliverable.map((record) => this.deliver(record.id)));
  }
}

const globalDispatcher = globalThis as typeof globalThis & {
  __canvasPiDelegationDispatcher?: PiDelegationDispatcher;
};

function getDelegationDispatcher(): PiDelegationDispatcher {
  if (!globalDispatcher.__canvasPiDelegationDispatcher) {
    globalDispatcher.__canvasPiDelegationDispatcher = new PiDelegationDispatcher();
  }
  return globalDispatcher.__canvasPiDelegationDispatcher;
}

export async function initializeDelegationDispatcher(): Promise<void> {
  return getDelegationDispatcher().initialize();
}

export async function enqueueDelegatedTask(request: DelegateTaskRequest): Promise<DelegateTaskResult> {
  return getDelegationDispatcher().enqueue(request);
}

export async function cancelDelegatedTask(id: string, userId: string): Promise<PiDelegationRecord | null> {
  return getDelegationDispatcher().cancel(id, userId);
}
