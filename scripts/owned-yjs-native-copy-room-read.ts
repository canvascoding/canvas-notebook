/** Copy-only room observation. No existing spec identity or reader is changed. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { assertOrigin, assertOwnedRoot, buildProofName, privateBytes, writePrivateJson,
  type OwnedYjsReceipt, type OwnedYjsBuildProof } from './lib/owned-yjs-authority-qa';
import { assertOwnedNativeFileRoomDatabaseOnConnection, ownedNativeFileRoomReceiptIdentity,
  type OwnedNativeFileRoomReadInput } from './lib/owned-yjs-native-delete-links-room-target';
import type { OwnedRestartRoomEvidence } from './lib/owned-yjs-restart-room-read';

const spec = 'tests/workspace-operation-native-copy.spec.ts';
const runtimeKeys = ['BASE_URL', 'BETTER_AUTH_BASE_URL', 'DATABASE_URL', 'DATA', 'CANVAS_DATA_ROOT',
  'CANVAS_INSTANCE_ID', 'CANVAS_ORGANIZATION_ID', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
  'TEST_LOGIN_EMAIL', 'TEST_LOGIN_PASSWORD', 'TEST_SECONDARY_EMAIL', 'TEST_SECONDARY_PASSWORD',
  'CANVAS_YJS_QA_RESTART_URL', 'CANVAS_YJS_QA_RESTART_TOKEN'] as const;
const environmentKeys = [...runtimeKeys, 'CANVAS_YJS_AUTHORITY_E2E', 'E2E_EXTERNAL_SERVER', 'NODE_ENV',
  'CANVAS_YJS_QA_RECEIPT', 'CANVAS_YJS_QA_RESULTS', 'CANVAS_DATABASE_PROVIDER', 'CANVAS_POSTGRES_MODE',
  'CANVAS_DEPLOYMENT_MODE', 'CANVAS_TEAM_FEATURES_ENABLED'] as const;
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype);
  assert.equal(Reflect.ownKeys(input).length, keys.length); const value: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value')); value[key] = descriptor.value;
  } return value;
}
function text(input: unknown, maximum = 4096): string {
  assert(typeof input === 'string' && input.length > 0 && input.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(input)); return input;
}
function integer(input: unknown, minimum: number): number {
  assert(typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum && input < Number.MAX_SAFE_INTEGER); return input;
}
function capture(input: unknown): { input: OwnedNativeFileRoomReadInput; vectorSha256: string } {
  const body = object(input, ['version', 'target', 'room', 'expectedSession']); assert.equal(body.version, 1);
  const target = object(body.target, ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId', 'receiptIdentity']);
  const room = object(body.room, ['documentId', 'path', 'generation', 'expectedWorkspaceId']);
  const expected = object(body.expectedSession, ['documentSequence', 'stateProof', 'stateVector']);
  const capturedTarget = { nonce: text(target.nonce, 32), repo: text(target.repo), head: text(target.head, 40),
    sourceFingerprint: text(target.sourceFingerprint, 64), buildFingerprint: text(target.buildFingerprint, 64),
    buildId: text(target.buildId, 256), receiptIdentity: text(target.receiptIdentity, 64) };
  assert.match(capturedTarget.nonce, /^[a-f0-9]{32}$/u); assert.match(capturedTarget.head, /^[a-f0-9]{40}$/u);
  for (const digest of [capturedTarget.sourceFingerprint, capturedTarget.buildFingerprint, capturedTarget.receiptIdentity]) assert.match(digest, /^[a-f0-9]{64}$/u);
  assert(path.isAbsolute(capturedTarget.repo));
  const stateVector = text(expected.stateVector, 4 * 256 * 1024 / 3 + 4), vector = Buffer.from(stateVector, 'base64');
  assert(vector.length > 0 && vector.length <= 256 * 1024); assert.equal(vector.toString('base64'), stateVector);
  const stateProof = text(expected.stateProof, 128); assert.match(stateProof, /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
  const captured = { version: 1 as const, target: Object.freeze(capturedTarget), room: Object.freeze({
    documentId: text(room.documentId, 256), path: text(room.path), generation: integer(room.generation, 1), expectedWorkspaceId: text(room.expectedWorkspaceId, 256) }),
  expectedSession: Object.freeze({ documentSequence: integer(expected.documentSequence, 0), stateProof, stateVector }) };
  assert.match(captured.room.path, /^(?:owned-yjs-restart-[a-f0-9-]+\/)?owned-yjs-restart-[a-f0-9-]+\.md$/u);
  return { input: Object.freeze(captured), vectorSha256: createHash('sha256').update(vector).digest('hex') };
}
function command(file: string, args: string[], cwd: string): string {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
}
async function target(wire: unknown) {
  // The original complete Parent/supervisor source and artifact guards remain
  // mandatory. As with the Move adapter, these per-poll checks bind the current
  // owned target without repeating the complete artifact traversal each time.
  const captured = capture(wire), env: Record<string, string | undefined> = {};
  for (const key of environmentKeys) env[key] = process.env[key]; Object.freeze(env);
  assert.equal(env.CANVAS_YJS_AUTHORITY_E2E, '1'); assert.equal(env.E2E_EXTERNAL_SERVER, '1'); assert.equal(env.NODE_ENV, 'production');
  const receiptPath = env.CANVAS_YJS_QA_RECEIPT ?? '', receipt = JSON.parse((await privateBytes(receiptPath)).toString()) as OwnedYjsReceipt;
  assert.equal(receiptPath, path.join(receipt.fixtureRoot, 'recovery.json')); await assertOwnedRoot(receipt);
  assert.equal(receipt.phase, 'browser'); assert.equal(receipt.uncertain, false); assert.equal(receipt.activeSpec, spec);
  assert.equal(ownedNativeFileRoomReceiptIdentity(receipt), captured.input.target.receiptIdentity);
  for (const key of ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId'] as const) assert.equal(receipt[key], captured.input.target[key]);
  assert.equal(receipt.repo, await fs.realpath(process.cwd()));
  const output = env.CANVAS_YJS_QA_RESULTS ?? '', relative = path.relative(path.join(receipt.fixtureRoot, 'results'), output);
  assert(path.isAbsolute(output) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
  assert.equal(await fs.realpath(output), output); const stat = await fs.lstat(output);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  const proof = JSON.parse((await privateBytes(path.join(receipt.repo, '.next', buildProofName))).toString()) as OwnedYjsBuildProof;
  object(proof, ['version', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId', 'createdAt']); assert.equal(proof.version, 1);
  for (const key of ['repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId'] as const) assert.equal(proof[key], captured.input.target[key]);
  assert(Number.isFinite(Date.parse(text(proof.createdAt, 64)))); assert.equal(command('git', ['rev-parse', 'HEAD'], receipt.repo).trim(), receipt.head);
  const published = parse(await privateBytes(path.join(receipt.fixtureRoot, 'runtime.env'))), origin = assertOrigin(env.BASE_URL ?? '', receipt.port);
  for (const key of runtimeKeys) assert(env[key] && env[key] === published[key], 'Owned Copy runtime configuration mismatch.');
  assert.equal(env.TEST_LOGIN_EMAIL, env.BOOTSTRAP_ADMIN_EMAIL); assert.equal(env.TEST_LOGIN_PASSWORD, env.BOOTSTRAP_ADMIN_PASSWORD);
  assert.notEqual(env.TEST_LOGIN_EMAIL, env.TEST_SECONDARY_EMAIL); assert.equal(origin.origin, published.BASE_URL); assert.equal(env.DATA, receipt.dataRoot);
  assert.equal(env.CANVAS_DATABASE_PROVIDER, 'postgres'); assert.equal(env.CANVAS_POSTGRES_MODE, 'external');
  assert.equal(env.CANVAS_DEPLOYMENT_MODE, 'team'); assert.equal(env.CANVAS_TEAM_FEATURES_ENABLED, 'true');
  const url = new URL(published.DATABASE_URL); assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert(!url.search && !url.hash); assert.equal(url.pathname, `/${receipt.databaseName}`);
  assert(receipt.serverPid && receipt.serverStart && Number.isSafeInteger(receipt.parentPid) && receipt.parentPid > 0);
  assert.equal(command('ps', ['-p', String(receipt.parentPid), '-o', 'lstart='], receipt.repo).trim(), receipt.parentStart);
  assert.equal(command('ps', ['-p', String(receipt.serverPid), '-o', 'lstart='], receipt.repo).trim(), receipt.serverStart);
  const listeners = command('lsof', ['-nP', '-a', '-p', String(receipt.serverPid), '-iTCP:' + receipt.port, '-sTCP:LISTEN', '-Ftn'], receipt.repo);
  assert(listeners.split('\n').includes(`n127.0.0.1:${receipt.port}`));
  assert(command('lsof', ['-a', '-p', String(receipt.serverPid), '-d', 'cwd', '-Fn'], receipt.repo).split('\n').includes(`n${receipt.repo}`));
  return { ...captured, receipt, connectionString: url.href };
}
async function main(): Promise<void> {
  assert.equal(process.argv.length, 3); assert(process.argv[2].length <= 8 * 1024);
  const wire = Buffer.from(process.argv[2], 'base64url'); assert.equal(wire.toString('base64url'), process.argv[2]);
  const selected = await target(JSON.parse(wire.toString())), started = performance.now();
  const observation = path.join(selected.receipt.fixtureRoot, `native-room-observation-${randomUUID()}.json`);
  const phases: { phase: string; milliseconds: number }[] = [];
  const record = async (phase: string) => { phases.push({ phase, milliseconds: performance.now() - started });
    await writePrivateJson(observation, { version: 1, phases }, phases.length === 1); };
  await record('copy-only-target-guard-complete');
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const database = new Client({ connectionString: selected.connectionString, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  let result: OwnedRestartRoomEvidence | undefined, beginAttempted = false, failed = false, primary: unknown;
  const cleanup: unknown[] = [];
  try {
    await database.connect(); await record('client-connected'); beginAttempted = true;
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertOwnedNativeFileRoomDatabaseOnConnection(database, selected.receipt); await record('readonly-database-identity-confirmed');
    result = await readOwnedRestartRoomOnConnection(database, selected.input.room);
    assert.equal(result.version.sequence, selected.input.expectedSession.documentSequence);
    assert.equal(result.version.stateProof, selected.input.expectedSession.stateProof); assert.equal(result.version.vectorSha256, selected.vectorSha256);
    await record('original-room-read-complete');
  } catch (error) { failed = true; primary = error; }
  finally {
    if (beginAttempted) try { await database.query('ROLLBACK'); await record('readonly-transaction-closed'); } catch (error) { cleanup.push(error); }
    try { await database.end(); await record('client-closed'); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned Copy room observation cleanup failed.');
  if (failed) throw primary; assert(result); process.stdout.write(JSON.stringify(result)); await record('result-written');
}
void main().catch(() => { console.error('Owned native Copy room observation remained unavailable.'); process.exitCode = 1; });
