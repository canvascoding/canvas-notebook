import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

const verifiedRollback = reporter.emit('rollback', 'succeeded', 'Previous image verified.', undefined, true);
assert.equal(verifiedRollback?.rollbackImageVerified, true);
assert.equal(validateSystemUpdateEvent({ ...verifiedRollback, rollbackImageVerified: false }).ok, false);
assert.equal(validateSystemUpdateEvent({ ...verifiedRollback, stage: 'completed' }).ok, false);
assert.equal(validateSystemUpdateEvent({ ...verifiedRollback, status: 'failed' }).ok, false);
assert.equal(validateSystemUpdateEvent({ ...verifiedRollback, rollbackImageVerified: undefined }).ok, true);

async function testActivity() {
  const capabilities = JSON.parse(execFileSync(process.execPath, [
    '--import', 'tsx', path.resolve('cli/src/main.ts'), 'capabilities', '--json',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    // No executable (including Docker) can be found; negotiation must still succeed.
    env: { ...process.env, PATH: '/nonexistent-canvas-capability-test', CANVAS_CONFIG_JSON: '/nonexistent/config.json' },
  }));
  assert.equal(capabilities.cliGeneration, 'typescript');
  assert.deepEqual(capabilities.updateEventStream, { format: 'ndjson', contractVersion: 1, activityIntervalMs: 5000 });
  const output: string[] = [];
  const active = new SystemUpdateEventReporter({ enabled: true, write: (line) => output.push(line), activityIntervalMs: 10 });
  active.running('image_pull', 'Pulling image');
  await delay(35);
  assert.ok(output.length > 1, 'long operations emit activity without subprocess output');
  const keepalive = JSON.parse(output[1]);
  assert.equal(keepalive.activity.kind, 'keepalive');
  assert.ok(keepalive.activity.elapsedMs >= 0);
  assert.equal(keepalive.stage, 'image_pull');
  active.failed('image_pull', 'Pull failed', 'image_pull_failed');
  const failedCount = output.length;
  await delay(30);
  assert.equal(output.length, failedCount, 'failed stages clear the activity timer');
  active.running('rollback', 'Restoring image');
  await delay(25);
  assert.ok(output.slice(failedCount).some((line) => JSON.parse(line).activity?.kind === 'keepalive'));
  assert.ok(output.slice(failedCount).every((line) => JSON.parse(line).stage === 'rollback'), 'rollback replaces the active stage');
  active.succeeded('rollback', 'Restored image');
  const restoredCount = output.length;
  await delay(30);
  assert.equal(output.length, restoredCount, 'successful stages clear the activity timer');
  active.running('health_verification', 'Checking health');
  active.healthCheck({ elapsedMs: 3, attempt: 1, maxAttempts: 180, healthy: false, remainingMs: 999 });
  const observedCount = output.length;
  active.healthCheck({ elapsedMs: 4, attempt: 2, maxAttempts: 180, healthy: false });
  assert.equal(output.length, observedCount, 'health checks are throttled');
  active.healthCheck({ elapsedMs: 5, attempt: 3, maxAttempts: 180, healthy: true });
  assert.equal(JSON.parse(output.at(-1)!).activity.healthy, true, 'health success is observed immediately');
  active.dispose();
  const disposedCount = output.length;
  await delay(30);
  assert.equal(output.length, disposedCount, 'finally/dispose prevents activity after exceptional exits');
  const parsed = output.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((event) => event.sequence), parsed.map((_, index) => index + 1));
  for (const event of parsed) assert.equal(validateSystemUpdateEvent(event).ok, true);
  const observation = parsed.find((event) => event.activity?.kind === 'health_check');
  assert.deepEqual(validateSystemUpdateEvent(observation), { ok: true, value: observation });
  for (const invalid of [
    { ...observation, status: 'succeeded' },
    { ...observation, activity: { kind: 'keepalive', elapsedMs: -1 } },
    { ...observation, activity: { kind: 'keepalive', elapsedMs: 0, remainingMs: Infinity } },
    { ...observation, activity: { kind: 'health_check', elapsedMs: 0, attempt: 3, maxAttempts: 2 } },
  ]) assert.equal(validateSystemUpdateEvent(invalid).ok, false);
  const disabledOutput: string[] = [];
  const disabled = new SystemUpdateEventReporter({ enabled: false, write: (line) => disabledOutput.push(line), activityIntervalMs: 1 });
  disabled.running('image_pull', 'Quiet');
  await delay(10);
  assert.equal(disabledOutput.length, 0);
  console.log('System update reporter tests passed.');
}

void testActivity().catch((error) => { console.error(error); process.exitCode = 1; });
