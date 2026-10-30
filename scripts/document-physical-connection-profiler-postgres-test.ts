import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, Pool, type PoolClient } from 'pg';
import { installDocumentClientQueryMetrics, installDocumentDatabaseMetrics, measureDocumentDatabaseActivity } from '../app/lib/observability/document-operation-metrics';

assert.equal(process.env.NODE_ENV, 'test');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
assert(output && path.isAbsolute(output));
const config = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
assert.equal((await fs.stat(config)).mode & 0o077, 0);
const connectionString = parse(await fs.readFile(config, 'utf8')).DATABASE_URL;
assert(connectionString);
const url = new URL(connectionString);
assert(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.port, '55433');
assert.equal(url.pathname, '/canvas_notebook');
const prefix = 'physical-' + crypto.randomUUID();
const runtimeNames = [prefix + '-pool', prefix + '-direct'];
const admin = new Client({ connectionString, application_name: prefix + '-admin', connectionTimeoutMillis: 5000 });
const pool = new Pool({ connectionString, application_name: runtimeNames[0], max: 3, connectionTimeoutMillis: 5000 });
installDocumentDatabaseMetrics(pool);
const clients: Client[] = [], borrowed = new Set<PoolClient>();
const expected: Array<{ label: string; start: number; peak: number; end: number; dedicatedPeak: number; pooledPeak: number }> = [];
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const direct = (registered = true, database?: string) => {
  const target = new URL(connectionString); if (database) target.pathname = '/' + database;
  const client = new Client({ connectionString: target.href, application_name: runtimeNames[1], connectionTimeoutMillis: 5000 });
  clients.push(client); if (registered) installDocumentClientQueryMetrics(client); return client;
};
const close = async (client: Client) => {
  const ended = new Promise<void>(resolve => client.once('end', resolve));
  await client.end(); await ended;
};
const serverCount = async (n: number) => assert.equal(Number((await admin.query(
  'SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=ANY($1::text[])', [runtimeNames])).rows[0].n), n);
const window = async (spec: typeof expected[number], execute: () => Promise<void>) => {
  expected.push(spec);
  await measureDocumentDatabaseActivity('read', 'system', execute, value => assert.equal(value.outcome, 'succeeded'));
};
try {
  await admin.connect(); assert.equal(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 18);
  const initial = await Promise.all([pool.connect(), pool.connect()]);
  for (const client of initial) client.release();
  const a = direct(); await a.connect(); await serverCount(3);
  await window({ label: 'idle-pool-and-temporary-dedicated', start: 3, peak: 4, end: 3, dedicatedPeak: 2, pooledPeak: 2 }, async () => {
    const b = direct();
    await new Promise<void>((resolve, reject) => {
      const returned = b.connect((error: Error | null | undefined) => error ? reject(error) : resolve()); assert.equal(returned, undefined);
    });
    await serverCount(4); await close(b); await serverCount(3);
  });
  await window({ label: 'pool-growth-callback-and-promise', start: 3, peak: 4, end: 4, dedicatedPeak: 1, pooledPeak: 3 }, async () => {
    const first = await pool.connect(), second = await pool.connect(); borrowed.add(first); borrowed.add(second);
    const third = await new Promise<PoolClient>((resolve, reject) => {
      const returned = pool.connect((error, client) => error ? reject(error) : resolve(client!)); assert.equal(returned, undefined);
    }); borrowed.add(third);
    const secret = 'PRIVATE-PHYSICAL-PROFILER-' + crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const returned = third.query('SELECT $1::text AS value', [secret], (error, reply) => {
        if (error) return reject(error); assert.equal(reply.rows[0].value, secret); resolve();
      }); assert.equal(returned, undefined);
    });
    await assert.rejects(third.query('SELECT 1/0'), (error: unknown) => Reflect.get(error as object, 'code') === '22012');
    await serverCount(4);
    for (const client of borrowed) client.release(); borrowed.clear();
  });
  const c = direct(), pending = c.connect();
  await window({ label: 'connect-starts-before-window', start: 4, peak: 5, end: 5, dedicatedPeak: 2, pooledPeak: 3 }, async () => {
    await pending; await serverCount(5);
  }); await close(c);
  await window({ label: 'outer-overlap', start: 4, peak: 5, end: 4, dedicatedPeak: 2, pooledPeak: 3 }, async () => {
    await window({ label: 'inner-overlap', start: 4, peak: 5, end: 4, dedicatedPeak: 2, pooledPeak: 3 }, async () => {
      const d = direct(); await d.connect(); await serverCount(5); await close(d);
    });
  });
  const late = direct(false); await late.connect();
  await window({ label: 'registration-followed-by-close-without-query', start: 4, peak: 5, end: 4, dedicatedPeak: 2, pooledPeak: 3 }, async () => {
    installDocumentClientQueryMetrics(late); await close(late);
  });
  const missing = 'physical_absent_' + crypto.randomUUID().replaceAll('-', '');
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [missing])).rowCount, 0);
  await window({ label: 'failed-connect-is-not-ready', start: 4, peak: 4, end: 4, dedicatedPeak: 1, pooledPeak: 3 }, async () => {
    const failed = direct(true, missing), ended = new Promise<void>(resolve => failed.once('end', resolve));
    await assert.rejects(failed.connect(), (error: unknown) => Reflect.get(error as object, 'code') === '3D000'); await ended;
    await serverCount(4);
  });
  await close(a); await pool.end(); await serverCount(0);
  await fs.writeFile(output, JSON.stringify({ expected, realPostgres18: true, callbacksAndPromisesRetained: true,
    originalQueryAndConnectErrorsRetained: true, serverCountsVerified: true, noTableOrDocumentWrites: true }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  completed = true;
} finally {
  for (const client of borrowed) client.release();
  await pool.end().catch(() => undefined);
  for (const client of clients) await client.end().catch(() => undefined);
  await admin.end();
}
