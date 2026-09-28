import 'server-only';

/** Content-free, low-cardinality outcomes for delegated worker operations. */
const OUTCOMES = {
  worker_compaction_attempt: ['started'],
  worker_compaction_result: [
    'succeeded', 'no_op', 'deferred', 'failed', 'aborted', 'stale',
    'already_running', 'cooldown_active', 'breaker_active',
  ],
  worker_context_overflow: ['compaction_exhausted', 'payload_guard'],
  steer_delivery: ['delivered', 'missed'],
  resume_rejection: ['authorization', 'binding', 'workspace'],
} as const;

export type PiDelegationObservation = {
  [Event in keyof typeof OUTCOMES]: {
    event: Event;
    outcome: (typeof OUTCOMES)[Event][number];
    count?: number;
  }
}[keyof typeof OUTCOMES];

export type PiDelegationMetricAdapter = {
  increment(name: string, labels: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels: Readonly<Record<string, string>>): void;
};

const runtime = globalThis as typeof globalThis & {
  __canvasPiDelegationMetrics?: PiDelegationMetricAdapter;
};

export function setPiDelegationMetricAdapter(adapter: PiDelegationMetricAdapter | undefined): void {
  runtime.__canvasPiDelegationMetrics = adapter;
}

/** Never accepts goal, instruction, transcript, error, user or session identifiers. */
export function observePiDelegation(input: PiDelegationObservation): void {
  if (!Object.hasOwn(OUTCOMES, input.event)) return;
  const allowed = OUTCOMES[input.event] as readonly string[] | undefined;
  if (!allowed?.includes(input.outcome)) return;
  const count = typeof input.count === 'number' && Number.isFinite(input.count) && input.count > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(input.count))
    : undefined;
  const event = {
    component: 'pi_delegation',
    version: 1,
    event: input.event,
    outcome: input.outcome,
    ...(count === undefined ? {} : { count }),
  } as const;
  const labels = { event: event.event, outcome: event.outcome };
  try {
    runtime.__canvasPiDelegationMetrics?.increment('pi_delegation_events_total', labels);
    if (count !== undefined) runtime.__canvasPiDelegationMetrics?.observe('pi_delegation_event_count', count, labels);
  } catch {
    // Telemetry must never affect a worker or a steering receipt.
  }
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Logging is best-effort and must never affect the delegated operation.
  }
}
