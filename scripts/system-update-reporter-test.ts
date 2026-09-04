import assert from 'node:assert/strict';

import { validateSystemUpdateEvent } from '../cli/src/core/systemUpdateContract';
import { SystemUpdateEventReporter } from '../cli/src/core/systemUpdateReporter';

const lines: string[] = [];
const operationId = '8767a5c7-1a6d-4768-b760-d1c7d42fe095';
const reporter = new SystemUpdateEventReporter({
  enabled: true,
  operationId,
  write: (line) => lines.push(line),
  now: () => new Date('2026-09-04T12:00:00.000Z'),
});

reporter.running('image_pull', 'Pulling image\nwithout raw line breaks');
reporter.succeeded('image_pull', 'Image pulled');
reporter.failed('health_verification', 'Health check failed', 'health_verification_failed');

assert.equal(lines.length, 3);
const events = lines.map((line) => JSON.parse(line) as unknown);
for (const event of events) assert.equal(validateSystemUpdateEvent(event).ok, true);
assert.deepEqual(events.map((event) => (event as { sequence: number }).sequence), [1, 2, 3]);
assert.equal((events[0] as { operationId: string }).operationId, operationId);
assert.equal((events[0] as { message: string }).message, 'Pulling image without raw line breaks');
assert.equal((events[2] as { errorCode: string }).errorCode, 'health_verification_failed');

assert.throws(
  () => new SystemUpdateEventReporter({ enabled: true, operationId: 'not-a-uuid' }),
  /must be a UUID/u,
);

console.log('System update reporter tests passed.');
