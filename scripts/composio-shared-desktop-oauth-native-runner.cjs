/* eslint-disable @typescript-eslint/no-require-imports -- Fixed local launcher keeps PostgreSQL credentials in process memory. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const { Pool } = require('pg');

async function main() {
  assert.deepEqual(process.argv.slice(2), ['run']);
  const repo = path.resolve(__dirname, '..');
  const source = path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
  const stat = fs.lstatSync(source);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0);
  const values = dotenv.parse(fs.readFileSync(source));
  const maintenance = new URL(values.DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol) && maintenance.hostname === '127.0.0.1'
    && maintenance.port === '55433' && !maintenance.search && !maintenance.hash && maintenance.username);
  maintenance.pathname = '/postgres';
  const controlPlane = path.resolve(repo, '../canvas-control-plane');
  assert(fs.statSync(path.join(controlPlane, 'apps/api/src/routes/managedServices.ts')).isFile());
  const environment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(environment, { NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: maintenance.toString(), CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_SHARED_CONNECTION_POSTGRES_TEST: '1',
    CANVAS_CONTROL_PLANE_TEST_ROOT: controlPlane });
  const administration = new Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5000, query_timeout: 30_000 });
  const redact = value => value.replaceAll(maintenance.toString(), '[private-postgres-url]').replace(/postgres(?:ql)?:\/\/\S+/gu, '[private-postgres-url]');
  let current, cancelled = false;
  const cancel = () => { cancelled = true; if (current && current.exitCode === null && current.signalCode === null) current.kill('SIGTERM'); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    for (const mode of [[], ['--managed']]) {
      assert(!cancelled, 'A cancelled fixture cannot start a second test.');
      let created, cleaned, receiptError, pending = '';
      const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--conditions=react-server', '--import', 'tsx',
        'scripts/composio-shared-desktop-oauth-test.ts', ...mode], { cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      current = child;
      const consume = line => {
        process.stdout.write(`${redact(line)}\n`);
        if (!line.startsWith('NATIVE_RECEIPT ')) return;
        try {
          const receipt = JSON.parse(line.slice('NATIVE_RECEIPT '.length));
          assert.deepEqual(Object.keys(receipt).sort(), ['databaseName', 'phase', 'root']);
          assert.match(receipt.databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
          assert(path.isAbsolute(receipt.root) && /^canvas-composio-desktop-engine-[A-Za-z0-9]{6}$/u.test(path.basename(receipt.root)));
          if (receipt.phase === 'created') { assert(!created); created = receipt; }
          else { assert.equal(receipt.phase, 'cleaned'); assert(created && !cleaned); assert.equal(receipt.databaseName, created.databaseName); assert.equal(receipt.root, created.root); cleaned = receipt; }
        } catch (error) { receiptError = error; }
      };
      child.stdout.on('data', chunk => {
        pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop() || '';
        for (const line of lines) consume(line);
        if (pending.length > 32768) { receiptError = new Error('Oversized fixture output.'); pending = ''; }
      });
      child.stdout.on('end', () => { if (pending) consume(pending); });
      child.stderr.on('data', chunk => process.stderr.write(redact(chunk.toString())));
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 240_000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearTimeout(deadline); current = undefined; }
      assert(!timedOut && !cancelled && !receiptError && code === 0 && created && cleaned,
        'Native acceptance or cleanup acknowledgement is incomplete; preserve unconfirmed fixture data.');
      assert.equal((await administration.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [created.databaseName])).rows[0].count, 0);
      assert(!fs.existsSync(created.root), 'Acknowledged own private DATA/TMP must be independently absent.');
      console.log(`PASS independent native ${mode.length ? 'controlled-managed' : 'local'} database/DATA/TMP absence after normal DROP.`);
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await administration.end(); }
}

main().catch(() => { console.error('FAIL shared Composio native runner; unconfirmed fixture ownership/cleanup is preserved.'); process.exitCode = 1; });
