/** Test-only phased observation; the genuine target and room checks are retained. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { assertOwnedRoot, privateBytes, requireOwnedYjsQaTarget, writePrivateJson,
  type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';
import type { OwnedRestartRoomInput } from './lib/owned-yjs-restart-room-read';

async function main(): Promise<void> {
  assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8 * 1024);
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString()) as OwnedRestartRoomInput;
  const receiptPath = process.env.CANVAS_YJS_QA_RECEIPT ?? '';
  const original = JSON.parse((await privateBytes(receiptPath)).toString()) as OwnedYjsReceipt;
  assert.equal(receiptPath, path.join(original.fixtureRoot, 'recovery.json'));
  await assertOwnedRoot(original);
  const observation = path.join(original.fixtureRoot, `native-room-observation-${randomUUID()}.json`);
  const started = performance.now();
  const phases: { phase: string; milliseconds: number; activeResources?: string[] }[] = [];
  const record = async (phase: string, resources = false) => {
    phases.push({ phase, milliseconds: performance.now() - started,
      ...(resources ? { activeResources: process.getActiveResourcesInfo() } : {}) });
    await writePrivateJson(observation, { version: 1, phases }, phases.length === 1);
  };
  await record('owned-root-bound');
  const current = await requireOwnedYjsQaTarget();
  assert.equal(current.nonce, original.nonce);
  assert.equal(current.activeSpec, 'tests/workspace-operation-native-delete.spec.ts');
  await record('full-target-guard-complete');
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  let result;
  try {
    await database.connect(); await record('client-connected');
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await record('readonly-transaction-open');
    result = await readOwnedRestartRoomOnConnection(database, input);
    await record('original-room-read-complete');
  } finally {
    await database.end(); await record('client-closed');
  }
  process.stdout.write(JSON.stringify(result));
  await record('result-written', true);
}

void main().catch(() => {
  console.error('Owned native file room observation remained unavailable.'); process.exitCode = 1;
});
