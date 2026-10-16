import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';

type SchedulingHooks = Readonly<{
  pauseAndDrain: () => Promise<void>;
  resume: () => Promise<void>;
}>;
type Scheduling = {
  claim: WorkspaceOperationBatchClaim; binding: WorkspaceOperationBatchClaimBinding;
  hooks: SchedulingHooks; active: boolean; accepting: boolean;
  pending: Set<Promise<unknown>>; failure?: Error;
};
type Phase = {
  claim: WorkspaceOperationBatchClaim; binding: WorkspaceOperationBatchClaimBinding;
  scheduling?: Scheduling; active: boolean; failure?: Error;
};
const schedulingContext = new AsyncLocalStorage<Scheduling>();
const phaseContext = new AsyncLocalStorage<Phase>();
const schedules = new WeakMap<WorkspaceOperationBatchClaim, Scheduling>();
const phases = new WeakMap<WorkspaceOperationBatchClaim, Phase>();

export class WorkspaceOperationJobPhaseSchedulingError extends Error {
  readonly status = 409;
  constructor(readonly code: 'JOB_PHASE_SCHEDULING_REQUIRED' | 'JOB_PHASE_SCHEDULING_REENTRANT'
    | 'JOB_PHASE_SCHEDULING_DETACHED' | 'JOB_PHASE_SCHEDULING_CHANGED' | 'JOB_PHASE_SCHEDULING_FAILED') {
    super(code); this.name = 'WorkspaceOperationJobPhaseSchedulingError';
  }
}
const failure = (error: unknown): Error => error instanceof Error ? error
  : new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_FAILED');
function contains(error: Error, target: Error): boolean {
  return error === target || error instanceof AggregateError && error.errors.some(child => child instanceof Error && contains(child, target));
}
function combine(primary: Error | undefined, later: Error): Error {
  if (!primary || contains(later, primary)) return later;
  if (contains(primary, later)) return primary;
  const field = (error: Error, key: string) => Object.getOwnPropertyDescriptor(error, key)?.value;
  const preferred = field(primary, 'status') === 503 ? primary : field(later, 'status') === 503 ? later : primary;
  return Object.assign(new AggregateError([primary, later], 'File action phase and scheduling cleanup failed.'), {
    code: field(preferred, 'code') ?? field(primary, 'code') ?? field(later, 'code'),
    status: field(preferred, 'status') ?? field(primary, 'status') ?? field(later, 'status'),
  });
}
function poison(error: unknown, scheduling?: Scheduling, phase?: Phase): Error {
  const normalized = failure(error);
  for (const captured of new Set([scheduling, phase?.scheduling, schedulingContext.getStore()])) {
    if (captured) captured.failure = combine(captured.failure, normalized);
  }
  for (const captured of new Set([phase, phaseContext.getStore()])) {
    if (captured) captured.failure = combine(captured.failure, normalized);
  }
  return normalized;
}
function checkClaim(claim: WorkspaceOperationBatchClaim, binding: WorkspaceOperationBatchClaimBinding): void {
  if (readWorkspaceOperationBatchClaimBinding(claim) !== binding) {
    throw new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_CHANGED');
  }
}
function captureHooks(hooks: SchedulingHooks): SchedulingHooks {
  if (!hooks || Object.getPrototypeOf(hooks) !== Object.prototype || Reflect.ownKeys(hooks).length !== 2) {
    throw new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_REQUIRED');
  }
  const captured = ['pauseAndDrain', 'resume'].map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(hooks, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_REQUIRED');
    }
    return descriptor.value as () => Promise<void>;
  });
  return Object.freeze({ pauseAndDrain: captured[0], resume: captured[1] });
}

/** Worker scheduling only. The genuine Store claim is required, but this grants
 * no actor rights, SQL access, owner-B identity or lifecycle-lock bypass. */
export async function withWorkspaceOperationJobClaimScheduling<T>(claim: WorkspaceOperationBatchClaim,
  hooks: SchedulingHooks, operation: () => Promise<T>): Promise<T> {
  let captured: Scheduling;
  try {
    const binding = readWorkspaceOperationBatchClaimBinding(claim);
    if (schedulingContext.getStore() || phaseContext.getStore() || schedules.has(claim) || phases.has(claim)
      || typeof operation !== 'function') throw new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_REENTRANT');
    captured = { claim, binding, hooks: captureHooks(hooks), active: true, accepting: true, pending: new Set() };
    schedules.set(claim, captured);
  } catch (error) { throw poison(error); }
  return schedulingContext.run(captured, async () => {
    let value: T | undefined;
    try {
      try { value = await operation(); } catch (error) { poison(error, captured); }
      captured.accepting = false;
      if (captured.pending.size) {
        poison(new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_DETACHED'), captured);
        await Promise.allSettled([...captured.pending]);
      }
      // This also drains an interval heartbeat that started after the last
      // completed phase. A failure here must not mask an uncertain COMMIT.
      try { await captured.hooks.pauseAndDrain(); } catch (error) { poison(error, captured); }
      try { checkClaim(claim, captured.binding); } catch (error) { poison(error, captured); }
      if (captured.failure) throw captured.failure;
      return value as T;
    } finally { captured.accepting = false; captured.active = false; }
  });
}

/** Wrap the complete owner phase, including rollback/disposal. With no Worker
 * registration a real current claim may still run standalone service phases;
 * there is then no periodic heartbeat to suspend and no authority is added. */
export function withWorkspaceOperationJobClaimPhase<T>(claim: WorkspaceOperationBatchClaim,
  operation: () => Promise<T>): Promise<T> {
  let phase: Phase;
  try {
    const binding = readWorkspaceOperationBatchClaimBinding(claim), scheduling = schedules.get(claim);
    const existing = phases.get(claim);
    if (phaseContext.getStore() || existing || typeof operation !== 'function') {
      throw poison(new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_REENTRANT'), scheduling, existing);
    }
    if (scheduling && (!scheduling.active || !scheduling.accepting || schedulingContext.getStore() !== scheduling)
      || !scheduling && schedulingContext.getStore()) {
      throw poison(new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_REQUIRED'), scheduling);
    }
    if (scheduling?.failure) throw scheduling.failure;
    phase = { claim, binding, scheduling, active: true }; phases.set(claim, phase);
  } catch (error) { return Promise.reject(poison(error)); }
  const pending = phaseContext.run(phase, async () => {
    let value: T | undefined, entered = false;
    try {
      try {
        await phase.scheduling?.hooks.pauseAndDrain();
        checkClaim(claim, phase.binding);
        if (phase.failure || phase.scheduling?.failure) throw phase.failure ?? phase.scheduling!.failure;
        entered = true; value = await operation();
      } catch (error) { poison(error, phase.scheduling, phase); }
      // Root's complete phase operation settles COMMIT/ROLLBACK/disposal before
      // this actual A heartbeat runs. Never renew while B still owns row SHARE.
      if (entered) {
        try { await phase.scheduling?.hooks.resume(); } catch (error) { poison(error, phase.scheduling, phase); }
      }
      try { checkClaim(claim, phase.binding); } catch (error) { poison(error, phase.scheduling, phase); }
      if (phase.failure) throw phase.failure;
      if (phase.scheduling?.failure) throw phase.scheduling.failure;
      return value as T;
    } finally { phase.active = false; if (phases.get(claim) === phase) phases.delete(claim); }
  });
  phase.scheduling?.pending.add(pending);
  void pending.then(() => phase.scheduling?.pending.delete(pending), () => phase.scheduling?.pending.delete(pending));
  return pending;
}
