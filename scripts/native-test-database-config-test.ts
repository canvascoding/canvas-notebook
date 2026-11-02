import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readNativeTestDatabaseConfig } from './helpers/native-test-database-config';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-native-config-'));
  const runId = crypto.randomUUID().replaceAll('-', '');
  const selected = `postgresql://fixture@127.0.0.1:55433/canvas_native_ci_${runId}`;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CI: 'true', CANVAS_NATIVE_TEST_DATABASE_URL: selected, CANVAS_NATIVE_TEST_RUN_ID: runId };
  let checks = 0;
  const denied = async (input: NodeJS.ProcessEnv) => {
    await assert.rejects(readNativeTestDatabaseConfig({ env: input, localConnectionString: 'postgresql://fixture@127.0.0.1:55433/canvas_notebook' })); checks++;
  };
  try {
    const actual = await readNativeTestDatabaseConfig({ env, localEnvironmentFile: path.join(root, 'does-not-exist') });
    assert.equal(actual.kind, 'owned-ci'); assert.equal(actual.runId, runId); assert.equal(actual.databaseName, `canvas_native_ci_${runId}`);
    assert(Object.isFrozen(actual)); checks++;
    await denied({ NODE_ENV: 'test', CI: 'true', DATABASE_URL: 'postgresql://fixture@127.0.0.1:55433/canvas_notebook' });
    await denied({ NODE_ENV: 'test', GITHUB_ACTIONS: 'true' });
    await denied({ ...env, NODE_ENV: 'production' });
    await denied({ ...env, CANVAS_NATIVE_TEST_RUN_ID: undefined });
    await denied({ ...env, CANVAS_NATIVE_TEST_RUN_ID: 'not-a-run-id' });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: '' });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected.replace('127.0.0.1', 'database.example.test') });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected.replace('127.0.0.1', 'localhost') });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected.replace(`canvas_native_ci_${runId}`, 'canvas_notebook') });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected.replace(runId, 'a'.repeat(32) === runId ? 'b'.repeat(32) : 'a'.repeat(32)) });
    for (const suffix of ['?options=-csearch_path=public', '#scope', ' ']) await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected + suffix });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: selected.replace(':55433', ':0') });
    await denied({ ...env, CANVAS_NATIVE_TEST_DATABASE_URL: 'not a PostgreSQL URL' });
    const file = path.join(root, 'private.env'), local = 'postgresql://fixture@127.0.0.1:55433/canvas_notebook';
    await writeFile(file, `DATABASE_URL=${local}\n`, { mode: 0o600 });
    const managed = await readNativeTestDatabaseConfig({ env: { NODE_ENV: 'test' }, localEnvironmentFile: file });
    assert.equal(managed.kind, 'managed-local'); assert.equal(managed.connectionString, local); checks++;
    await chmod(file, 0o644); await assert.rejects(readNativeTestDatabaseConfig({ env: { NODE_ENV: 'test' }, localEnvironmentFile: file })); checks++;
    await chmod(file, 0o600); const alias = path.join(root, 'alias.env'); await symlink(file, alias);
    await assert.rejects(readNativeTestDatabaseConfig({ env: { NODE_ENV: 'test' }, localEnvironmentFile: alias })); checks++;
    console.log(JSON.stringify({ suite: 'native-test-database-config', passed: true, checks,
      ciPrivateEnvironmentFallback: false, actualPostgresOwnershipAcceptance: false }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(() => { process.exitCode = 1; console.error('Native test database configuration contract failed.'); });
