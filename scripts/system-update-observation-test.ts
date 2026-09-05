import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SystemUpdateObservation } from '../app/lib/system-updates/observation';
import type { SystemUpdateOperationView } from '../app/lib/system-updates/types';

const id = crypto.randomUUID();
const observation = new SystemUpdateObservation(id);
const base: SystemUpdateOperationView = { contractVersion: 1, operationId: id, currentVersion: '2026.9.5', targetVersion: '2026.9.6',
  status: 'running', stage: 'image_pull', startedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:02Z',
  completedAt: null, rolledBack: false, errorCode: null, error: null, lastSequence: 2 };
assert.equal(observation.acceptOperation(base), true);
assert.equal(observation.acceptOperation({ ...base, lastSequence: 1 }), false);
assert.equal(observation.acceptOperation({ ...base, updatedAt: '2026-09-05T00:00:01Z' }), false);
assert.equal(observation.acceptOperation({ ...base, operationId: crypto.randomUUID() }), false);
assert.equal(observation.acceptOperation({ ...base, status: 'succeeded', stage: 'completed', completedAt: base.updatedAt }), true);
assert.equal(observation.acceptOperation({ ...base, lastSequence: 3 }), false);
const event = (sequence: number) => ({ contractVersion: 1, operationId: id, eventId: crypto.randomUUID(), sequence,
  stage: 'image_pull', status: 'running', message: 'test', occurredAt: base.updatedAt });
observation.acceptEvents([event(2)]); assert.equal(observation.cursor, 0);
observation.acceptEvents([event(1)]); assert.equal(observation.cursor, 2);
observation.acceptEvents([event(2)]); assert.equal(observation.events.length, 2);
console.log('system-update-observation-test: ok');
