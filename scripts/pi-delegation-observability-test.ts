import assert from 'node:assert/strict';

import {
  observePiDelegation,
  setPiDelegationMetricAdapter,
  type PiDelegationObservation,
} from '../app/lib/pi/delegation-observability';

const logs: string[] = [];
const metrics: Array<{ name: string; value?: number; labels: Readonly<Record<string, string>> }> = [];
const originalInfo = console.info;
console.info = (...args: unknown[]) => { logs.push(args.join(' ')); };
setPiDelegationMetricAdapter({
  increment: (name, labels) => { metrics.push({ name, labels }); },
  observe: (name, value, labels) => { metrics.push({ name, value, labels }); },
});

try {
  const privateText = 'PRIVATE goal, correction and secret';
  const samples: PiDelegationObservation[] = [
    { event: 'worker_compaction_attempt', outcome: 'started' },
    { event: 'worker_compaction_result', outcome: 'succeeded' },
    { event: 'worker_context_overflow', outcome: 'compaction_exhausted' },
    { event: 'steer_delivery', outcome: 'delivered' },
    { event: 'steer_delivery', outcome: 'missed', count: 2 },
    { event: 'resume_rejection', outcome: 'binding' },
  ];
  for (const sample of samples) {
    observePiDelegation({ ...sample, goal: privateText, message: privateText,
      sessionId: privateText, error: privateText } as unknown as PiDelegationObservation);
  }
  assert.equal(logs.length, samples.length);
  assert.equal(metrics.filter(metric => metric.name === 'pi_delegation_events_total').length, samples.length);
  assert.deepEqual(metrics.filter(metric => metric.name === 'pi_delegation_event_count')
    .map(metric => metric.value), [2]);
  for (const log of logs) {
    const event = JSON.parse(log) as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(),
      Object.hasOwn(event, 'count')
        ? ['component', 'count', 'event', 'outcome', 'version']
        : ['component', 'event', 'outcome', 'version']);
  }
  for (const metric of metrics) assert.deepEqual(Object.keys(metric.labels).sort(), ['event', 'outcome']);
  assert.doesNotMatch(JSON.stringify({ logs, metrics }), /PRIVATE|goal|message|sessionId|secret/u);

  const accepted = logs.length;
  observePiDelegation({ event: 'steer_delivery', outcome: privateText } as unknown as PiDelegationObservation);
  observePiDelegation({ event: 'constructor', outcome: privateText } as unknown as PiDelegationObservation);
  assert.equal(logs.length, accepted, 'unknown outcomes must be rejected at runtime');

  setPiDelegationMetricAdapter({ increment: () => { throw new Error(privateText); }, observe: () => {} });
  observePiDelegation({ event: 'resume_rejection', outcome: 'authorization' });
  assert.equal(logs.length, accepted + 1, 'metric backend failure cannot interrupt operations');
  assert.doesNotMatch(logs.at(-1) ?? '', /PRIVATE|secret/u);
  console.log('pi-delegation-observability-test: ok');
} finally {
  setPiDelegationMetricAdapter(undefined);
  console.info = originalInfo;
}
