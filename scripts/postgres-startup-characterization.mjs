// Offline characterization of the startup failure, not a PostgreSQL integration test.
// Uses the installed pg/Better Auth implementations and a loopback protocol fixture.
// Run: node scripts/postgres-startup-characterization.mjs
// Optional: CANVAS_TEST_DEPENDENCY_ROOT=/path/to/linux/checkout on Ubuntu ARM64.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const dependencyRoot = process.env.CANVAS_TEST_DEPENDENCY_ROOT || process.cwd();
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const { Pool } = require('pg');
const CONNECT_TIMEOUT = 40;

async function silentPostgres() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume(); // Accept TCP but deliberately never complete PostgreSQL startup.
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    options: { host: '127.0.0.1', port: server.address().port, user: 'fixture', database: 'fixture', ssl: false },
    disconnect: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function characterizeConnectionTimeout() {
  const fixture = await silentPostgres();
  for (const timeout of [CONNECT_TIMEOUT, 0]) {
    const pool = new Pool({ ...fixture.options, max: 1, connectionTimeoutMillis: timeout });
    let outcome = null;
    const query = pool.query('SELECT 1').then(
      () => { outcome = { ok: true }; },
      (error) => { outcome = { ok: false, message: error.message }; },
    );
    try {
      if (timeout) {
        await query;
        assert.equal(outcome.message, 'Connection terminated due to connection timeout');
      } else {
        await delay(CONNECT_TIMEOUT * 4);
        assert.equal(outcome, null, 'timeout 0 must leave a slow handshake pending');
        fixture.disconnect();
        await query;
        assert.equal(outcome.ok, false, 'a real disconnect must still reject with timeout 0');
      }
      assert.equal(pool.waitingCount, 0);
    } finally {
      fixture.disconnect();
      await pool.end();
    }
  }
  await fixture.close();
}

// Fake only the transport; exercise the real pg Pool queue and release handling.
class ReadyClient extends EventEmitter {
  _queryable = true;
  connect(callback) { queueMicrotask(() => callback(null)); }
  end(callback) { callback?.(); }
  ref() {}
  unref() {}
}

async function characterizePoolQueue() {
  for (const timeout of [CONNECT_TIMEOUT, 0]) {
    const pool = new Pool({ Client: ReadyClient, max: 1, connectionTimeoutMillis: timeout });
    const first = await pool.connect();
    let outcome = null;
    const next = pool.connect().then(
      (client) => { outcome = { ok: true }; client.release(); },
      (error) => { outcome = { ok: false, message: error.message }; },
    );
    await delay(CONNECT_TIMEOUT * 4);
    if (timeout) assert.equal(outcome.message, 'timeout exceeded when trying to connect');
    else assert.equal(outcome, null);
    first.release();
    await next;
    if (!timeout) assert.equal(outcome.ok, true);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 1);
    await pool.end();
  }
}

async function authChild(owned) {
  const { betterAuth } = await import(pathToFileURL(require.resolve('better-auth')).href);
  const { oauthProvider } = await import(pathToFileURL(require.resolve('@better-auth/oauth-provider')).href);
  const fixture = await silentPostgres();
  const pool = new Pool({ ...fixture.options, max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT });
  process.on('unhandledRejection', (error) => {
    console.log(JSON.stringify({ event: 'unhandledRejection', message: error.message }));
    process.exit(17); // Model server.js's fatal policy without changing the real process.
  });
  const plugin = oauthProvider({
    loginPage: '/login', consentPage: '/consent', disableJwtPlugin: true,
    resources: ['http://localhost:3000/mcp'],
    silenceWarnings: { oauthAuthServerConfig: true },
  });
  const originalInit = plugin.init;
  plugin.init = (context) => originalInit({
    ...context,
    adapter: {
      ...context.adapter,
      findOne: async (input) => {
        assert.equal(input.model, 'oauthResource');
        // Real OAuth seeding and auth.$context; replace only storage with fault injection.
        return pool.query('SELECT * FROM oauth_resource WHERE identifier = $1', ['http://localhost:3000/mcp']);
      },
    },
  });
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'offline-characterization-secret-8b6cb617-a8ae-49b2-90e7',
    plugins: [plugin], logger: { disabled: true }, telemetry: { enabled: false },
  });
  // Keep the original rejected auth context intact; store a fulfilled outcome immediately.
  const initialization = owned ? auth.$context.then(
    () => ({ ok: true }), (error) => ({ ok: false, error }),
  ) : null;
  await delay(CONNECT_TIMEOUT * 5); // A later startup phase reaches the auth consumer.
  assert.ok(initialization, 'unowned auth should already have terminated this child');
  const outcome = await initialization;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.message, 'Connection terminated due to connection timeout');
  await assert.rejects(auth.$context, /Connection terminated due to connection timeout/);
  await pool.end();
  await fixture.close();
  console.log(JSON.stringify({ event: 'ownedStartupFailure', originalContextStillRejected: true }));
}

async function main() {
  if (process.argv[2] === '--auth-child') return authChild(process.argv[3] === 'owned');
  await characterizeConnectionTimeout();
  await characterizePoolQueue();
  for (const mode of ['unowned', 'owned']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--auth-child', mode], {
      env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, mode === 'unowned' ? 17 : 0, child.stderr + child.stdout);
    assert.match(child.stdout, mode === 'unowned' ? /unhandledRejection/ : /ownedStartupFailure/);
    if (mode === 'unowned') assert.match(child.stdout, /Connection terminated due to connection timeout/);
  }
  console.log(JSON.stringify({
    result: 'passed', platform: process.platform, architecture: process.arch, node: process.version,
    pg: require('pg/package.json').version,
    cases: ['new-connection timeout', 'timeout 0 waits', 'queue timeout differs', 'queue drains after release', 'OAuth init is fatal if unowned', 'owned OAuth failure remains rejected'],
  }, null, 2));
}

const watchdog = setTimeout(() => {
  console.error('PostgreSQL startup characterization exceeded its 30-second test budget.');
  process.exit(1);
}, 30_000);
try {
  await main();
} finally {
  clearTimeout(watchdog);
}
