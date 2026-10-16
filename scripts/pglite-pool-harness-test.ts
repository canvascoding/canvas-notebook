import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { installPglitePoolHarness } from './helpers/pglite-pool-harness';

test('PGlite Pool callback and Promise checkouts execute actual SQL and support real openDb observers', async () => {
  const postgres = new PGlite(), harness = installPglitePoolHarness(postgres);
  const pool = new Pool();
  const originals = { CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER, DATABASE_URL: process.env.DATABASE_URL };
  Object.assign(process.env, { CANVAS_DATABASE_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://pglite-harness.invalid/canvas' });
  let closeDatabaseConnections: (() => Promise<void>) | undefined;
  try {
    await pool.query('CREATE TABLE actual_fixture (id integer PRIMARY KEY, value text NOT NULL)');
    const inserted = await pool.query('INSERT INTO actual_fixture VALUES($1,$2)', [1, 'actual']);
    assert.equal(inserted.rowCount, 1);
    let returned = false, callbacks = 0;
    const callbackClient = await new Promise<import('pg').PoolClient>((resolve, reject) => {
      const result = pool.connect((error, client, release) => {
        callbacks++; assert.equal(returned, true);
        if (error || !client) { reject(error ?? new Error('Missing callback client.')); return; }
        assert.equal(release, client.release); resolve(client);
      });
      assert.equal(result, undefined); returned = true;
    });
    assert(callbackClient instanceof EventEmitter); assert.equal(callbacks, 1); assert.equal(harness.activeClientCount, 1);
    assert.deepEqual((await callbackClient.query('SELECT value FROM actual_fixture WHERE id=$1', [1])).rows, [{ value: 'actual' }]);
    let observed = false;
    const observe = () => { observed = true; };
    callbackClient.once('end', observe); callbackClient.removeListener('end', observe); callbackClient.emit('end');
    assert.equal(observed, false);
    callbackClient.release(new Error('Actual fixture discard argument.'));
    assert.equal(harness.activeClientCount, 0); assert.throws(() => callbackClient.release(), /already released/u);
    const promiseClient = await pool.connect();
    assert(promiseClient instanceof EventEmitter); assert.equal(harness.activeClientCount, 1);
    assert.deepEqual((await promiseClient.query({ text: 'SELECT value,id FROM actual_fixture', rowMode: 'array' })).rows, [['actual', 1]]);
    await assert.rejects(promiseClient.query('INSERT INTO actual_fixture VALUES(1,\'duplicate\')'), error => Reflect.get(error as object, 'code') === '23505');
    promiseClient.release(); assert.equal(harness.activeClientCount, 0);
    const database = await import('../app/lib/db'); closeDatabaseConnections = database.closeDatabaseConnections;
    const actual = await database.openDb();
    assert.equal(harness.activeClientCount, 1);
    assert.deepEqual(await actual.get('SELECT value FROM actual_fixture WHERE id=$1', [1]), { value: 'actual' });
    await actual.close(); await actual.close(); assert.equal(harness.activeClientCount, 0);
  } finally {
    await closeDatabaseConnections?.(); await pool.end(); harness.restore(); harness.restore(); await postgres.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

const runChild = (operation: string) => spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--eval',
  `const {runPgliteFixture}=require(${JSON.stringify(path.resolve('scripts/helpers/pglite-pool-harness.ts'))});
   void runPgliteFixture({label:'completion-contract',successMessage:'ACTUAL_SUCCESS_MARKER',watchdogMs:40,operation:async()=>{${operation}}});`],
{ cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });

test('the success marker follows actual awaited cleanup', () => {
  const child = runChild("try { await Promise.resolve(); } finally { console.log('CLEANUP_SETTLED'); }");
  assert.equal(child.error, undefined); assert.equal(child.status, 0);
  assert(child.stdout.indexOf('CLEANUP_SETTLED') < child.stdout.indexOf('ACTUAL_SUCCESS_MARKER'));
  assert.match(child.stdout, /COMPLETED/u); assert.equal(child.stderr, '');
});

test('actual cleanup rejection fails without a success marker', () => {
  const child = runChild("try { await Promise.resolve(); } finally { throw new Error('cleanup rejected'); }");
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /ACTUAL_SUCCESS_MARKER|COMPLETED/u); assert.match(child.stderr, /cleanup rejected/u);
});

test('a pending fixture retains a bounded watchdog and fails', () => {
  const child = runChild('await new Promise(()=>{});');
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /ACTUAL_SUCCESS_MARKER|COMPLETED/u); assert.match(child.stderr, /INCOMPLETE \(watchdog\)/u);
});

test('a premature exit cannot report successful completion', () => {
  const child = runChild('process.exit(0);');
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /ACTUAL_SUCCESS_MARKER|COMPLETED/u); assert.match(child.stderr, /INCOMPLETE \(exit\)/u);
});

test('beforeExit while a fixture is pending fails closed', () => {
  const child = runChild("process.emit('beforeExit',0); await new Promise(()=>{});");
  assert.equal(child.error, undefined); assert.equal(child.status, 1);
  assert.doesNotMatch(child.stdout, /ACTUAL_SUCCESS_MARKER|COMPLETED/u); assert.match(child.stderr, /INCOMPLETE \(beforeExit\)/u);
});
