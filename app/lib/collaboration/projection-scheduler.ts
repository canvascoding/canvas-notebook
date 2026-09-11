export type CollaborationProjectionRequest = {
  documentId: string;
  lifecycleGeneration: number;
  documentSequence: number;
};

type PendingProjection = {
  request: CollaborationProjectionRequest;
  firstQueuedAt: number;
  dueAt: number;
  attempts: number;
};

/**
 * Schedules derived files, never owns document data. The durable sequence gap is
 * the outbox; a restart/recovery scan can enqueue it again without a live room.
 */
export function createCollaborationProjectionScheduler(input: {
  project: (request: CollaborationProjectionRequest) => Promise<void>;
  onError: (error: unknown, request: CollaborationProjectionRequest, attempt: number) => void;
  idleMs?: number;
  maxDelayMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const now = input.now ?? Date.now;
  const setTimer = input.setTimer ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  });
  const clearTimer = input.clearTimer ?? clearTimeout;
  const idleMs = Math.max(0, input.idleMs ?? 2_000);
  const maxDelayMs = Math.max(idleMs, input.maxDelayMs ?? 10_000);
  const maxConcurrent = Math.max(1, Math.floor(input.maxConcurrent ?? 2));
  const pending = new Map<string, PendingProjection>();
  const running = new Map<string, CollaborationProjectionRequest>();
  const observedGenerations = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const newer = (next: CollaborationProjectionRequest, previous: CollaborationProjectionRequest) => (
    next.lifecycleGeneration > previous.lifecycleGeneration
    || (next.lifecycleGeneration === previous.lifecycleGeneration && next.documentSequence > previous.documentSequence)
  );

  const schedule = () => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    if (disposed || running.size >= maxConcurrent) return;
    const due = [...pending.values()].filter((job) => !running.has(job.request.documentId))
      .reduce((earliest, job) => Math.min(earliest, job.dueAt), Infinity);
    if (due !== Infinity) timer = setTimer(drain, Math.max(0, due - now()));
  };

  const complete = (job: PendingProjection, error?: { value: unknown }) => {
    const id = job.request.documentId;
    running.delete(id);
    if (disposed) return;
    if (error) {
      const attempts = job.attempts + 1;
      // Do not replace a newer pending state with the failed snapshot. After
      // five quick attempts, retry only every five minutes until state changes.
      if (!pending.has(id)) pending.set(id, {
        ...job,
        attempts,
        dueAt: now() + (attempts < 5 ? Math.min(30_000, 1_000 * 2 ** (attempts - 1)) : 300_000),
      });
      try { input.onError(error.value, job.request, attempts); } catch { /* Diagnostics cannot stop the worker. */ }
    }
    schedule();
  };

  function drain() {
    timer = undefined;
    if (disposed) return;
    for (const [id, job] of pending) {
      if (running.size >= maxConcurrent) break;
      if (running.has(id) || job.dueAt > now()) continue;
      pending.delete(id);
      running.set(id, job.request);
      void Promise.resolve().then(() => input.project(job.request)).then(
        () => complete(job),
        (error: unknown) => complete(job, { value: error }),
      );
    }
    schedule();
  }

  return {
    enqueue(request: CollaborationProjectionRequest, options: { immediately?: boolean } = {}) {
      if (disposed) return;
      const knownGeneration = observedGenerations.get(request.documentId);
      if (knownGeneration !== undefined && request.lifecycleGeneration < knownGeneration) return;
      observedGenerations.delete(request.documentId);
      observedGenerations.set(request.documentId, request.lifecycleGeneration);
      // The authoritative database fence also checks generation. Bound this
      // optimization so visiting documents cannot grow a permanent registry.
      if (observedGenerations.size > 10_000) observedGenerations.delete(observedGenerations.keys().next().value!);
      const previous = pending.get(request.documentId);
      const inFlight = running.get(request.documentId);
      if (previous && !newer(request, previous.request)) return;
      if (inFlight && !newer(request, inFlight)) return;
      const sameGeneration = previous?.request.lifecycleGeneration === request.lifecycleGeneration && previous.attempts === 0;
      const firstQueuedAt = sameGeneration ? previous.firstQueuedAt : now();
      pending.set(request.documentId, {
        request: { ...request }, firstQueuedAt, attempts: 0,
        dueAt: options.immediately ? now() : Math.min(now() + idleMs, firstQueuedAt + maxDelayMs),
      });
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      pending.clear();
      observedGenerations.clear();
      // Already-running filesystem operations keep their fences until finished.
    },
  };
}
