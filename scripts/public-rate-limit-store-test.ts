import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { createPublicRateLimitStore } from '../app/lib/security/public-rate-limit-store';

const execute = promisify(execFile);
const worker = process.argv[2] === '--worker';
const provider = (worker ? process.argv[3] : process.env.TEST_RATE_LIMIT_PROVIDER || 'sqlite') as 'sqlite' | 'postgres';
let pool: Pool | null = null;

function connectionFactory(location: string) {
  if (provider === 'postgres') {
    assert.match(location, /^security_rate_test_[a-z0-9]+$/u);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${location}`, max: 4, connectionTimeoutMillis: 5000 });
    return async (): Promise<SqlConnection> => {
      const client = await pool!.connect();
      const query = (sql: string, params?: unknown[]) => {
        let index = 0;
        return client.query(sql.replace(/\?/g, () => `$${++index}`), params);
      };
      return {
        get: async (sql, params) => (await query(sql, params)).rows[0],
        all: async (sql, params) => (await query(sql, params)).rows,
        run: async (sql, params) => query(sql, params),
        close: () => client.release(),
      };
    };
  }
  return async (): Promise<SqlConnection> => {
    const db = new Database(location);
    db.pragma('busy_timeout = 5000');
    return {
      get: (sql, params = []) => db.prepare(sql).get(...params),
      all: (sql, params = []) => db.prepare(sql).all(...params),
      run: (sql, params = []) => db.prepare(sql).run(...params),
      close: () => { db.close(); },
    };
  };
}

async function main() {
  if (worker) {
    const consume = createPublicRateLimitStore(connectionFactory(process.argv[4]), () => provider);
    let accepted = 0;
    try {
      for (let index = 0; index < 20; index++) {
        if ((await consume([{ key: 'multi-process', limit: 25, windowMs: 60_000 }])).ok) accepted++;
      }
      console.log(JSON.stringify({ accepted }));
    } finally { await pool?.end(); }
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-rate-store-'));
  const location = provider === 'postgres' ? `security_rate_test_${Date.now().toString(36)}` : path.join(root, 'limits.db');
  let control: Pool | null = null;
  if (provider === 'postgres') {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required for PostgreSQL verification');
    control = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    await control.query(`CREATE SCHEMA ${location}`);
  }
  try {
    const consume = createPublicRateLimitStore(connectionFactory(location), () => provider);
    const now = Date.now();
    const budget = (client: string) => [
      { key: 'global', limit: 100, windowMs: 60_000 },
      { key: `client:${client}`, limit: 2, windowMs: 60_000 },
    ];
    assert.equal((await consume(budget('a'), now)).ok, true);
    assert.equal((await consume(budget('a'), now)).ok, true);
    const denied = await consume(budget('a'), now);
    assert.deepEqual(denied, { ok: false, retryAfter: 60 });
    assert.equal((await consume(budget('b'), now)).ok, true);
    assert.equal((await consume(budget('a'), now + 60_000)).ok, true, 'expired budgets reset');
    const token = [{ key: 'resource:one-invitation', limit: 1, windowMs: 60_000 }];
    assert.equal((await consume(token)).ok, true);
    assert.equal((await consume(token)).ok, false, 'resource budgets apply across clients');

    const children = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), '--worker', provider, location],
      { env: process.env, timeout: 45_000 },
    )));
    const accepted = children.reduce((sum, child) => sum + JSON.parse(child.stdout.trim()).accepted, 0);
    assert.equal(accepted, 25, 'four processes must share exactly one atomic budget');
    const faulty = createPublicRateLimitStore(async () => { throw new Error('database unavailable'); }, () => provider);
    await assert.rejects(faulty(token), /database unavailable/);
    console.log(`public-rate-limit-store-test: ${provider} ok (4 processes, 25/80 admitted)`);
  } finally {
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${location} CASCADE`);
      await control.end();
    }
    await rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
