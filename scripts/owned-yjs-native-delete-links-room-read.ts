/** Test-only phased observation; the genuine target and room checks are retained. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { writePrivateJson } from './lib/owned-yjs-authority-qa';
import { assertOwnedNativeFileRoomDatabaseOnConnection, requireOwnedNativeFileRoomTarget } from './lib/owned-yjs-native-delete-links-room-target';
import type { OwnedRestartRoomEvidence } from './lib/owned-yjs-restart-room-read';

async function main(): Promise<void> {
  assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8 * 1024);
  const started = performance.now();
  const target = await requireOwnedNativeFileRoomTarget(JSON.parse(Buffer.from(process.argv[2], 'base64url').toString()));
  const observation = path.join(target.receipt.fixtureRoot, `native-room-observation-${randomUUID()}.json`);
  const phases: { phase: string; milliseconds: number; activeResources?: string[] }[] = [];
  const record = async (phase: string, resources = false) => {
    phases.push({ phase, milliseconds: performance.now() - started,
      ...(resources ? { activeResources: process.getActiveResourcesInfo().slice(0, 256) } : {}) });
    await writePrivateJson(observation, { version: 1, phases }, phases.length === 1);
  };
  await record('narrow-target-guard-complete');
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const database = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  let result: OwnedRestartRoomEvidence | undefined, beginAttempted = false, failed = false, primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await database.connect(); await record('client-connected');
    beginAttempted = true; await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await record('readonly-transaction-open');
    await assertOwnedNativeFileRoomDatabaseOnConnection(database, target.receipt); await record('database-identity-confirmed');
    result = await readOwnedRestartRoomOnConnection(database, target.input.room);
    assert.equal(result.version.sequence, target.input.expectedSession.documentSequence);
    assert.equal(result.version.stateProof, target.input.expectedSession.stateProof);
    assert.equal(result.version.vectorSha256, target.expectedVectorSha256);
    await record('original-room-read-complete');
  } catch (error) {
    failed = true; primaryError = error;
  } finally {
    if (beginAttempted) {
      try { await database.query('ROLLBACK'); await record('readonly-transaction-closed'); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await database.end(); await record('client-closed'); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Owned native file room observation cleanup failed.');
  if (failed) throw primaryError;
  assert(result);
  process.stdout.write(JSON.stringify(result));
  await record('result-written', true);
}

void main().catch(() => {
  console.error('Owned native file room observation remained unavailable.'); process.exitCode = 1;
});
