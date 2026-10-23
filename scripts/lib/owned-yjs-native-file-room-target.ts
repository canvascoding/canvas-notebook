/** Narrow test adapter after the Parent's complete original build/target guard.
 * Neither the wire picks nor this observation grants application authority. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import type { Client } from 'pg';
import { assertDatabaseOwnership, assertOrigin, assertOwnedRoot, buildProofName, privateBytes,
  type DatabaseIdentity, type OwnedYjsBuildProof, type OwnedYjsReceipt } from './owned-yjs-authority-qa';

export type OwnedNativeFileRoomReadInput = Readonly<{
  version: 1;
  target: Readonly<Pick<OwnedYjsReceipt, 'nonce' | 'repo' | 'head' | 'sourceFingerprint' | 'buildFingerprint' | 'buildId'>
    & { receiptIdentity: string }>;
  room: Readonly<{ documentId: string; path: string; generation: number; expectedWorkspaceId: string }>;
  expectedSession: Readonly<{ documentSequence: number; stateProof: string; stateVector: string }>;
}>;
export type OwnedNativeFileRoomTarget = Readonly<{
  receipt: OwnedYjsReceipt; input: OwnedNativeFileRoomReadInput; connectionString: string; expectedVectorSha256: string;
}>;
const runtimeKeys = ['BASE_URL', 'BETTER_AUTH_BASE_URL', 'DATABASE_URL', 'DATA', 'CANVAS_DATA_ROOT',
  'CANVAS_INSTANCE_ID', 'CANVAS_ORGANIZATION_ID', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
  'TEST_LOGIN_EMAIL', 'TEST_LOGIN_PASSWORD', 'TEST_SECONDARY_EMAIL', 'TEST_SECONDARY_PASSWORD',
  'CANVAS_YJS_QA_RESTART_URL', 'CANVAS_YJS_QA_RESTART_TOKEN'] as const;
const environmentKeys = [...runtimeKeys, 'CANVAS_YJS_AUTHORITY_E2E', 'E2E_EXTERNAL_SERVER', 'NODE_ENV',
  'CANVAS_YJS_QA_RECEIPT', 'CANVAS_YJS_QA_RESULTS', 'CANVAS_DATABASE_PROVIDER', 'CANVAS_POSTGRES_MODE',
  'CANVAS_DEPLOYMENT_MODE', 'CANVAS_TEAM_FEATURES_ENABLED'] as const;
const receiptIdentityKeys = ['version', 'nonce', 'fixtureRoot', 'repo', 'head', 'buildId', 'sourceFingerprint', 'buildFingerprint',
  'ownerMarker', 'rootDevice', 'rootInode', 'dataRoot', 'dataDevice', 'dataInode', 'databaseName', 'databaseOid',
  'databaseOwner', 'createAcknowledged', 'parentPid', 'parentStart', 'serverPid', 'serverStart', 'issuerPid',
  'issuerDatabaseOid', 'issuerDatabaseOwner', 'issuerDatabaseMarker', 'port', 'actorId', 'controlPlaneRoot', 'controlPlaneHead'] as const;

/** Pure Parent/child identity comparison. Hash private values instead of putting
 * them in argv. Progress, phase and mutable completion arrays are not identity.
 * The original receipt has no mandatory issuerStart: bind an actual own value
 * if present, and bind its absence otherwise; never invent a historical start. */
export function ownedNativeFileRoomReceiptIdentity(receipt: OwnedYjsReceipt): string {
  assert(receipt && Object.getPrototypeOf(receipt) === Object.prototype);
  const values: Array<readonly [string, string | number | boolean | null]> = receiptIdentityKeys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(receipt, key);
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    const value: unknown = descriptor.value;
    assert(value === null || typeof value === 'string' && value.length <= 4096
      || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value));
    return [key, value as string | number | boolean | null] as const;
  });
  const issuerStart = Object.getOwnPropertyDescriptor(receipt, 'issuerStart');
  assert(!issuerStart || issuerStart.enumerable && Object.hasOwn(issuerStart, 'value')
    && (issuerStart.value === null || typeof issuerStart.value === 'string' && issuerStart.value.length <= 256));
  values.push(['issuerStartPresent', Boolean(issuerStart)], ['issuerStart', issuerStart?.value ?? null]);
  return createHash('sha256').update(JSON.stringify(['canvas-owned-native-file-room-receipt-v1', values])).digest('hex');
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype);
  assert.equal(Reflect.ownKeys(input).length, keys.length);
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    captured[key] = descriptor.value;
  }
  return captured;
}
function text(input: unknown, maximum = 4096): string {
  assert(typeof input === 'string' && input.length > 0 && input.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(input));
  return input;
}
function integer(input: unknown, minimum: number): number {
  assert(typeof input === 'number' && Number.isSafeInteger(input) && input >= minimum && input < Number.MAX_SAFE_INTEGER);
  return input;
}
function captureInput(input: unknown): Readonly<{ input: OwnedNativeFileRoomReadInput; expectedVectorSha256: string }> {
  const body = object(input, ['version', 'target', 'room', 'expectedSession']); assert.equal(body.version, 1);
  const target = object(body.target, ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId', 'receiptIdentity']);
  const room = object(body.room, ['documentId', 'path', 'generation', 'expectedWorkspaceId']);
  const session = object(body.expectedSession, ['documentSequence', 'stateProof', 'stateVector']);
  const capturedTarget = { nonce: text(target.nonce, 32), repo: text(target.repo), head: text(target.head, 40),
    sourceFingerprint: text(target.sourceFingerprint, 64), buildFingerprint: text(target.buildFingerprint, 64), buildId: text(target.buildId, 256),
    receiptIdentity: text(target.receiptIdentity, 64) };
  assert.match(capturedTarget.nonce, /^[a-f0-9]{32}$/u); assert.match(capturedTarget.head, /^[a-f0-9]{40}$/u);
  assert.match(capturedTarget.sourceFingerprint, /^[a-f0-9]{64}$/u); assert.match(capturedTarget.buildFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(capturedTarget.receiptIdentity, /^[a-f0-9]{64}$/u);
  assert(path.isAbsolute(capturedTarget.repo));
  const stateVector = text(session.stateVector, 4 * 256 * 1024 / 3 + 4), vector = Buffer.from(stateVector, 'base64');
  assert(vector.length > 0 && vector.length <= 256 * 1024); assert.equal(vector.toString('base64'), stateVector);
  const stateProof = text(session.stateProof, 128); assert.match(stateProof, /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
  const captured: OwnedNativeFileRoomReadInput = Object.freeze({ version: 1, target: Object.freeze(capturedTarget), room: Object.freeze({ documentId: text(room.documentId, 256),
    path: text(room.path), generation: integer(room.generation, 1), expectedWorkspaceId: text(room.expectedWorkspaceId, 256) }),
  expectedSession: Object.freeze({ documentSequence: integer(session.documentSequence, 0), stateProof, stateVector }) });
  return Object.freeze({ input: captured, expectedVectorSha256: createHash('sha256').update(vector).digest('hex') });
}
function command(file: string, args: string[], cwd: string): string {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
}

/** Fresh owned target checks without repeating the full artifact walk per poll.
 * The complete original guard in the Parent and supervisor pre/post gates remain
 * mandatory. All environment and wire values are captured before awaiting IO. */
export async function requireOwnedNativeFileRoomTarget(input: unknown,
  env: NodeJS.ProcessEnv = process.env): Promise<OwnedNativeFileRoomTarget> {
  const { input: captured, expectedVectorSha256 } = captureInput(input), cwd = process.cwd();
  const environment: Record<string, string | undefined> = {};
  for (const key of environmentKeys) environment[key] = env[key];
  Object.freeze(environment);
  assert.equal(environment.CANVAS_YJS_AUTHORITY_E2E, '1'); assert.equal(environment.E2E_EXTERNAL_SERVER, '1');
  assert.equal(environment.NODE_ENV, 'production');
  const receiptPath = environment.CANVAS_YJS_QA_RECEIPT ?? '';
  const receipt = JSON.parse((await privateBytes(receiptPath)).toString()) as OwnedYjsReceipt;
  assert.equal(receiptPath, path.join(receipt.fixtureRoot, 'recovery.json')); await assertOwnedRoot(receipt);
  assert.equal(receipt.phase, 'browser'); assert.equal(receipt.uncertain, false);
  assert.equal(receipt.activeSpec, 'tests/workspace-operation-native-delete.spec.ts');
  assert.equal(ownedNativeFileRoomReceiptIdentity(receipt), captured.target.receiptIdentity);
  for (const key of ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId'] as const) {
    assert.equal(receipt[key], captured.target[key]);
  }
  assert.equal(receipt.repo, await fs.realpath(cwd));
  const outputRoot = environment.CANVAS_YJS_QA_RESULTS ?? '', relativeOutput = path.relative(path.join(receipt.fixtureRoot, 'results'), outputRoot);
  assert(path.isAbsolute(outputRoot) && !path.isAbsolute(relativeOutput) && !relativeOutput.split(path.sep).includes('..'));
  assert.equal(await fs.realpath(outputRoot), outputRoot);
  const outputStat = await fs.lstat(outputRoot);
  assert(outputStat.isDirectory() && !outputStat.isSymbolicLink() && outputStat.uid === process.getuid?.() && (outputStat.mode & 0o777) === 0o700);
  const proof = JSON.parse((await privateBytes(path.join(receipt.repo, '.next', buildProofName))).toString()) as OwnedYjsBuildProof;
  object(proof, ['version', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId', 'createdAt']);
  assert.equal(proof.version, 1);
  for (const key of ['repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId'] as const) assert.equal(proof[key], captured.target[key]);
  assert(Number.isFinite(Date.parse(text(proof.createdAt, 64))));
  assert.equal(command('git', ['rev-parse', 'HEAD'], receipt.repo).trim(), captured.target.head);
  const published = parse(await privateBytes(path.join(receipt.fixtureRoot, 'runtime.env')));
  const origin = assertOrigin(environment.BASE_URL ?? '', receipt.port);
  for (const key of runtimeKeys) assert(environment[key] && environment[key] === published[key], 'Owned runtime configuration mismatch.');
  assert.equal(environment.TEST_LOGIN_EMAIL, environment.BOOTSTRAP_ADMIN_EMAIL);
  assert.equal(environment.TEST_LOGIN_PASSWORD, environment.BOOTSTRAP_ADMIN_PASSWORD);
  assert.notEqual(environment.TEST_LOGIN_EMAIL, environment.TEST_SECONDARY_EMAIL);
  assert.equal(origin.origin, published.BASE_URL); assert.equal(environment.DATA, receipt.dataRoot);
  assert.equal(environment.CANVAS_DATABASE_PROVIDER, 'postgres'); assert.equal(environment.CANVAS_POSTGRES_MODE, 'external');
  assert.equal(environment.CANVAS_DEPLOYMENT_MODE, 'team'); assert.equal(environment.CANVAS_TEAM_FEATURES_ENABLED, 'true');
  const connectionString = published.DATABASE_URL, url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '55433' && !url.search && !url.hash);
  assert.equal(url.pathname, `/${receipt.databaseName}`);
  assert(receipt.serverPid && receipt.serverStart && Number.isSafeInteger(receipt.parentPid) && receipt.parentPid > 0);
  assert.equal(command('ps', ['-p', String(receipt.parentPid), '-o', 'lstart='], receipt.repo).trim(), receipt.parentStart);
  assert.equal(command('ps', ['-p', String(receipt.serverPid), '-o', 'lstart='], receipt.repo).trim(), receipt.serverStart);
  const listeners = command('lsof', ['-nP', '-a', '-p', String(receipt.serverPid), '-iTCP:' + receipt.port, '-sTCP:LISTEN', '-Ftn'], receipt.repo);
  assert(listeners.split('\n').includes(`n127.0.0.1:${receipt.port}`));
  const serverCwd = command('lsof', ['-a', '-p', String(receipt.serverPid), '-d', 'cwd', '-Fn'], receipt.repo);
  assert(serverCwd.split('\n').includes(`n${receipt.repo}`));
  return Object.freeze({ receipt: Object.freeze(receipt), input: captured, connectionString, expectedVectorSha256 });
}

/** Borrowed READ ONLY identity observation; no checkout, mutation or capability.
 * Call on the exact RR transaction that will read the original room evidence. */
export async function assertOwnedNativeFileRoomDatabaseOnConnection(database: Pick<Client, 'query'>,
  receipt: OwnedYjsReceipt): Promise<void> {
  const expected = Object.freeze({ ...receipt });
  const identity = (await database.query(`SELECT pg_catalog.current_database() AS name,d.oid::text,pg_catalog.pg_get_userbyid(d.datdba) AS owner,
    current_user AS role,pg_catalog.shobj_description(d.oid,'pg_database') AS marker,
    pg_catalog.current_setting('transaction_read_only') AS read_only,pg_catalog.current_setting('transaction_isolation') AS isolation
    FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`)).rows[0] as DatabaseIdentity & { read_only: string; isolation: string };
  assert(identity); assertDatabaseOwnership(expected, identity);
  assert.equal(identity.read_only, 'on'); assert.equal(identity.isolation, 'repeatable read');
}
