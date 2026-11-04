import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { createNativeCiDatabase, cleanupNativeCiDatabase } from './native-api-sdk-ci-database';
import { assertNativeTestDatabaseTarget, readNativeTestDatabaseConfig } from './helpers/native-test-database-config';
let stage = 'setup', complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
async function main() {
  const flags = process.argv.slice(2);
  assert(flags.every(value => value === '--all-api' || value === '--sdk') && new Set(flags).size === flags.length);
  const allApi = process.argv.includes('--all-api');
  const sdk = process.argv.includes('--sdk');
  if (sdk) assert(process.env.CANVAS_SDK_TEST_PYTHON && path.isAbsolute(process.env.CANVAS_SDK_TEST_PYTHON)
    && process.env.CANVAS_SDK_TEST_WHEEL && path.isAbsolute(process.env.CANVAS_SDK_TEST_WHEEL));
  const local = await readNativeTestDatabaseConfig(), maintenance = new URL(local.connectionString);
  maintenance.hostname = '127.0.0.1'; maintenance.pathname = '/postgres';
  const output = await mkdtemp(path.join(tmpdir(), 'canvas-native-portability-'));
  const lease = await createNativeCiDatabase(maintenance.toString(), output);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', CI: 'true', CANVAS_POSTGRES_VECTOR_ENABLED: 'false',
    CANVAS_NATIVE_TEST_DATABASE_URL: lease.connectionString, CANVAS_NATIVE_TEST_RUN_ID: lease.receipt.runId };
  let primary: unknown, groups = 0;
  try {
    const config = await readNativeTestDatabaseConfig({ env, localEnvironmentFile: path.join(output, 'unavailable-private.env') });
    const target = new Client({ connectionString: lease.connectionString, connectionTimeoutMillis: 5000 });
    const administration = new Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
    try {
      await target.connect(); await administration.connect(); stage = 'actual_target_identity';
      const identity = await assertNativeTestDatabaseTarget(target, config);
      assert.equal(identity.databaseOid, lease.receipt.databaseOid); await assert.rejects(assertNativeTestDatabaseTarget(administration, config)); groups++;
      const sentinel = crypto.randomUUID(); await target.query('CREATE TABLE native_ci_guard_probe(value text NOT NULL)');
      await target.query('INSERT INTO native_ci_guard_probe(value) VALUES($1)', [sentinel]);
      stage = 'wrong_marker_preserves_database_and_sentinel';
      await administration.query(`COMMENT ON DATABASE "${lease.receipt.databaseName}" IS 'different-test-run'`);
      await assert.rejects(assertNativeTestDatabaseTarget(target, config));
      await assert.rejects(cleanupNativeCiDatabase(maintenance.toString(), lease.receiptFile));
      assert.equal((await target.query('SELECT value FROM native_ci_guard_probe')).rows[0].value, sentinel);
      await administration.query(`COMMENT ON DATABASE "${lease.receipt.databaseName}" IS 'canvas-native-tests:${lease.receipt.runId}'`); groups++;
      stage = 'wrong_receipt_oid_preserves_database_and_sentinel';
      const original = await readFile(lease.receiptFile, 'utf8');
      try {
        await writeFile(lease.receiptFile, JSON.stringify({ ...lease.receipt, databaseOid: String(Number(lease.receipt.databaseOid) + 1) }) + '\n');
        await assert.rejects(cleanupNativeCiDatabase(maintenance.toString(), lease.receiptFile));
        assert.equal((await target.query('SELECT value FROM native_ci_guard_probe')).rows[0].value, sentinel);
      } finally { await writeFile(lease.receiptFile, original); }
      await target.query('DROP TABLE native_ci_guard_probe'); groups++;
    } finally { await target.end(); await administration.end(); }
    const cases: Array<readonly [string, readonly string[]]> = allApi ? [
      ['all-native-api', ['npm', 'run', 'test:api-keys:native']],
      ['native-agent-list', ['npm', 'run', 'test:pi:workspace-tree:native']],
      ['native-agent-read', ['npm', 'run', 'test:pi:read:native']],
      ['native-agent-prompt', ['npm', 'run', 'test:pi:workspace-tree:prompt:native']],
    ] : [
      ['dispatch', [process.execPath, 'scripts/run-document-read-tool-dispatch-test.mjs', 'scripts/agent-workspace-prompt-postgres-test.ts']],
      ['metadata', [process.execPath, 'scripts/run-document-read-tool-dispatch-test.mjs', 'scripts/api-key-original-markdown-import-owner-postgres-test.ts']],
      ['management', [process.execPath, 'node_modules/tsx/dist/cli.mjs', '--conditions', 'react-server', 'scripts/api-key-management-test.ts', '--native']],
      ['authentication', [process.execPath, 'node_modules/tsx/dist/cli.mjs', '--conditions', 'react-server', 'scripts/api-key-authentication-test.ts', '--native']],
    ];
    if (sdk) cases.push(['installed-sdk', ['npm', 'run', 'test:api-keys:sdk:native']]);
    for (const [name, command] of cases) {
      stage = `actual_${name}_fixture_on_owned_ci_database`; const log = path.join(output, `${name}.log`), handle = await open(log, 'wx', 0o600);
      try {
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          const child = spawn(command[0], command.slice(1), { env: { ...env,
            ...(['management', 'authentication'].includes(name) ? { CANVAS_SHARED_CONNECTION_POSTGRES_TEST: '1' } : {}) },
            cwd: process.cwd(), stdio: ['ignore', handle.fd, handle.fd] });
          child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.equal(result.signal, null); assert.equal(result.code, 0); groups++;
        console.log(JSON.stringify({ suite: 'native-ci-fixture-portability-group', name, passed: true, log }));
      } finally { await handle.close(); }
    }
  } catch (error) { primary = error; }
  finally {
    stage = primary ? stage : 'actual_owned_cleanup';
    const cleanup = await cleanupNativeCiDatabase(maintenance.toString(), lease.receiptFile);
    assert.equal(cleanup.removed, true); assert.equal(cleanup.noLeaks, true);
    console.log(JSON.stringify({ suite: 'native-ci-fixture-portability-cleanup', ...cleanup }));
  }
  if (primary) throw primary;
  complete = true; console.log(JSON.stringify({ suite: 'native-ci-fixture-portability', passed: true, groups,
    actualPostgres18: true, ciDatabaseDifferentFromManagedData: true, originalSentinelsPreservedOnRefusedCleanup: true,
    privateEnvironmentFallback: false, allThreeFixtureFamiliesAccepted: true, fullNativeApiPackage: allApi,
    githubRunnerAcceptance: false, installedSdkAcceptance: sdk, output }));
}
main().catch(error => { process.exitCode = 1;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ suite: 'native-ci-fixture-portability', stage, error: error instanceof Error ? error.name : 'UnknownError', code })); });
