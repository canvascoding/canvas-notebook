/* eslint-disable @typescript-eslint/no-require-imports -- Fixed native fixture launcher keeps PostgreSQL credentials in RAM. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const { Pool } = require('pg');

async function main() {
  assert(process.argv.length === 3 && process.argv[2] === 'run',
    'Use node scripts/agent-workflow-management-native-runner.cjs run');
  const repo = path.resolve(__dirname, '..');
  const source = path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
  const stat = fs.lstatSync(source);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0,
    'Existing PostgreSQL configuration must be a private regular file.');
  const values = dotenv.parse(fs.readFileSync(source));
  const maintenance = new URL(values.DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol)
    && maintenance.hostname === '127.0.0.1' && maintenance.port === '55433'
    && !maintenance.search && !maintenance.hash && maintenance.username,
  'Only the existing local PostgreSQL on port 55433 is supported.');
  maintenance.pathname = '/postgres';
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL']
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(childEnv, { NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: maintenance.toString(), CANVAS_DATABASE_PROVIDER: 'postgres',
    CANVAS_SHARED_CONNECTION_POSTGRES_TEST: '1' });
  const database = new Pool({ connectionString: maintenance.toString(), max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 30000 });
  const acknowledged = new Set();
  let running;
  let cancelled = false;
  const signalOwn = signal => {
    const child = running?.child;
    if (child && Number.isSafeInteger(child.pid) && child.pid > 0
      && !running.ended && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const cancel = () => {
    cancelled = true;
    signalOwn('SIGTERM');
  };
  const awaitOwnClose = async milliseconds => {
    if (!running || running.ended) return true;
    let timer;
    try {
      return await Promise.race([running.closed.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const redact = value => value.replaceAll(maintenance.toString(), '[redacted-postgres-url]')
    .replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
  try {
    for (const mode of ['', '--empty-profile-read-only', '--late-read-revoke', '--mcp-approval-retention', '--planning-metadata-only']) {
      assert(!cancelled, 'The native fixture was cancelled; preserve any unconfirmed database.');
      let created, cleaned, receiptError;
      console.log(`Native workflow management case: ${mode || 'base'}.`);
      const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        'scripts/agent-workflow-management-test.ts', '--native', ...(mode ? [mode] : [])],
      { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const record = { child, ended: false, closed: undefined };
      record.closed = new Promise(resolve => child.once('close', code => { record.ended = true; resolve(code); }));
      running = record;
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        const flush = line => {
          process.stdout.write(`${redact(line)}\n`);
          if (!line.startsWith('NATIVE_RECEIPT ')) return;
          try {
            const receipt = JSON.parse(line.slice('NATIVE_RECEIPT '.length));
            assert.deepEqual(Object.keys(receipt).sort(), ['databaseName', 'phase']);
            assert.match(receipt.databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
            if (receipt.phase === 'created') {
              assert(!created && !acknowledged.has(receipt.databaseName));
              created = receipt.databaseName; acknowledged.add(created);
            } else {
              assert.equal(receipt.phase, 'cleaned'); assert.equal(receipt.databaseName, created); assert(!cleaned);
              cleaned = receipt.databaseName;
            }
          } catch (error) { receiptError = error; }
        };
        stream.on('data', chunk => {
          pending += chunk.toString();
          const lines = pending.split('\n'); pending = lines.pop() || '';
          for (const line of lines) flush(line);
          if (pending.length > 32768) { process.stdout.write('[oversized fixture line omitted]\n'); pending = ''; }
        });
        stream.on('end', () => { if (pending) flush(pending); });
      }
      let timer;
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          cancel(); reject(new Error('The acknowledged child exceeded its deadline; no forced database cleanup is permitted.'));
        }, 180000);
        child.once('error', reject); record.closed.then(resolve);
      }).finally(() => clearTimeout(timer));
      running = undefined;
      if (receiptError) throw receiptError;
      assert.equal(code, 0, 'Native fixture did not pass.');
      assert(created && cleaned === created, 'Both native ownership and successful cleanup receipts are required.');
      const row = (await database.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [created])).rows[0];
      assert.equal(row.count, 0, 'The acknowledged own database must be absent after cleanup.');
      console.log('Independent native readback: acknowledged own database=0.');
    }
    console.log(`PASS native workflow management: ${acknowledged.size} isolated cases; all own databases absent; no container lifecycle actions.`);
  } finally {
    if (running && !running.ended) {
      signalOwn('SIGTERM');
      if (!await awaitOwnClose(15000)) {
        signalOwn('SIGKILL');
        if (!await awaitOwnClose(5000)) {
          // Preserve every unconfirmed database. Never discover or signal a
          // foreign PID, and never keep pipes open after bounded cancellation.
          running.child.stdout?.destroy(); running.child.stderr?.destroy(); running.child.unref();
          console.error('The own child close is unconfirmed; preserve its database and recovery log.');
        }
      }
    }
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await database.end();
  }
}

main().catch(error => {
  const message = String(error?.message || 'Native fixture failed.').replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
  console.error(message); process.exitCode = 1;
});
