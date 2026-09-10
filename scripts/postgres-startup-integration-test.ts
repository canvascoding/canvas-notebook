// Native PostgreSQL/pg integration, not a full Notebook/container startup test.
// Explicit local test URL only; all database sessions are server-side read-only.
import assert from 'node:assert/strict';
import net from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { betterAuth } from 'better-auth';
import { oauthProvider } from '@better-auth/oauth-provider';
import { createPostgresPool } from '../app/lib/db/postgres';
import { postgresFailureCode } from '../app/lib/db/postgres-diagnostics';
import { observeStartupTask } from '../app/lib/startup/observed-task';
import { directMcpOAuthResourceOptions } from '../app/lib/mcp/server/oauth-resource-config';

async function delayedProxy(target: URL) {
  const sockets = new Set<net.Socket>();
  let delayMillis = 0;
  const server = net.createServer((client) => {
    sockets.add(client);
    let upstream: net.Socket | undefined;
    const timer = setTimeout(() => {
      if (client.destroyed) return;
      upstream = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 5432) });
      sockets.add(upstream);
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { sockets.delete(upstream!); client.destroy(); });
      client.pipe(upstream).pipe(client);
    }, delayMillis);
    client.on('error', () => {});
    client.on('close', () => { clearTimeout(timer); sockets.delete(client); upstream?.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url,
    setDelay: (millis: number) => { delayMillis = millis; },
    disconnect: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  const configured = process.env.CANVAS_TEST_POSTGRES_URL;
  if (!configured) throw new Error('Set CANVAS_TEST_POSTGRES_URL to an explicitly selected local test database (no DATABASE_URL fallback).');
  const target = new URL(configured);
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]', 'host.orb.internal'].includes(target.hostname), 'Only a local test server is permitted');
  target.searchParams.set('options', '-c default_transaction_read_only=on -c statement_timeout=5000');
  target.searchParams.set('application_name', `canvas-startup-regression-${process.pid}`);
  const proxy = await delayedProxy(target);
  const metrics: Record<string, unknown>[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  process.on('unhandledRejection', onUnhandled);
  const previous = Object.fromEntries(['DATABASE_URL', 'CANVAS_POSTGRES_POOL_MAX', 'CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS'].map((key) => [key, process.env[key]]));
  let postgresVersion = '';

  const withPool = async (name: string, url: URL, timeout: number, max: number, run: (pool: Pool) => Promise<void>) => {
    process.env.DATABASE_URL = url.toString();
    process.env.CANVAS_POSTGRES_POOL_MAX = String(max);
    process.env.CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS = String(timeout);
    const started = performance.now();
    const pool = createPostgresPool();
    let connected = 0;
    let maxTotal = 0;
    let maxWaiting = 0;
    const connectedAfterMillis: number[] = [];
    const sample = () => { maxTotal = Math.max(maxTotal, pool.totalCount); maxWaiting = Math.max(maxWaiting, pool.waitingCount); };
    pool.on('connect', () => { connected++; connectedAfterMillis.push(Math.round(performance.now() - started)); sample(); });
    const sampler = setInterval(sample, 5);
    try {
      await run(pool);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.totalCount, pool.idleCount, `${name}: no leased clients after the test`);
      assert.deepEqual(unhandled, []);
      metrics.push({ name, max, timeout, connected, maxTotal, maxWaiting, connectedAfterMillis, elapsedMillis: Math.round(performance.now() - started) });
    } finally {
      clearInterval(sampler);
      await pool.end();
    }
  };

  try {
    await withPool('read-only preflight', target, 0, 1, async (pool) => {
      const result = await pool.query("SELECT current_setting('default_transaction_read_only') AS read_only, current_setting('server_version') AS version");
      assert.equal(result.rows[0].read_only, 'on');
      postgresVersion = result.rows[0].version;
    });
    for (const max of [1, 10]) {
      for (const timeout of [0, 150]) {
        await withPool(`queue max=${max} timeout=${timeout}`, target, timeout, max, async (pool) => {
          const held: PoolClient[] = [];
          try {
            const initial = await Promise.allSettled(Array.from({ length: max }, async () => { held.push(await pool.connect()); }));
            assert.ok(initial.every((result) => result.status === 'fulfilled'));
            const wait = observeStartupTask(pool.connect().then((client) => { client.release(); return 'acquired'; }));
            assert.equal(pool.waitingCount, 1);
            await delay(200);
            if (timeout) await assert.rejects(wait(), /timeout exceeded when trying to connect/);
            else assert.equal(pool.waitingCount, 1, 'timeout 0 must keep waiting for a real release');
            held.pop()!.release();
            if (!timeout) assert.equal(await wait(), 'acquired');
          } finally {
            for (const client of held) client.release();
          }
        });
      }
    }

    const faults = process.argv.includes('--slow') ? [[3_000, 4_000], [15_000, 16_000]] : [[80, 200]];
    for (const [timeout, handshakeDelay] of faults) {
      proxy.setDelay(handshakeDelay);
      await withPool(`handshake delayed ${handshakeDelay}ms`, proxy.url, timeout, 1, async (pool) => {
        await assert.rejects(pool.query('SELECT 1'), /Connection terminated due to connection timeout/);
      });
      await withPool(`timeout 0 survives ${handshakeDelay}ms handshake`, proxy.url, 0, 1, async (pool) => {
        assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
      });
    }

    proxy.setDelay(0);
    await withPool('connected query is not a connection timeout', proxy.url, 0, 1, async (pool) => {
      await pool.query('SELECT 1');
      // Change only the driver's acquisition limit after connecting, to avoid
      // conflating connection establishment and statement execution in this test.
      pool.options.connectionTimeoutMillis = 40;
      await pool.query('SELECT pg_sleep(0.12)');
    });
    await withPool('idle disconnect and reconnect', proxy.url, 0, 1, async (pool) => {
      await pool.query('SELECT 1');
      const failed = new Promise<Error>((resolve) => pool.once('error', resolve));
      proxy.disconnect();
      assert.equal(postgresFailureCode(await failed), 'postgres_unavailable');
      assert.equal(pool.totalCount, 0);
      assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
    });

    proxy.setDelay(200);
    await withPool('owned OAuth init failure on native PostgreSQL path', proxy.url, 80, 1, async (pool) => {
      const resource = 'http://localhost:3000/mcp';
      const plugin = oauthProvider({
        loginPage: '/login', consentPage: '/consent', disableJwtPlugin: true,
        ...directMcpOAuthResourceOptions(resource), silenceWarnings: { oauthAuthServerConfig: true },
      });
      const init = plugin.init!;
      plugin.init = (context) => init({
        ...context,
        adapter: {
          ...context.adapter,
          findOne: async <T>(query: { model: string }) => {
            assert.equal(query.model, 'oauthResource');
            await pool.query('SELECT 1 FROM oauth_resource WHERE identifier = $1 LIMIT 1', [resource]);
            // This fixture never changes persisted resource policy.
            return { id: 'fixture', identifier: resource, name: 'Fixture' } as T;
          },
        },
      });
      const auth = betterAuth({
        baseURL: 'http://localhost:3000', secret: 'offline-native-postgres-test-at-least-32-characters',
        plugins: [plugin], logger: { disabled: true }, telemetry: { enabled: false },
      });
      const wait = observeStartupTask(auth.$context);
      await delay(160);
      assert.deepEqual(unhandled, []);
      await assert.rejects(wait(), /Connection terminated due to connection timeout/);
      await assert.rejects(auth.$context, /Connection terminated due to connection timeout/);
    });
    console.log(JSON.stringify({ result: 'passed', platform: process.platform, arch: process.arch, node: process.version, postgresVersion,
      readOnly: true, eventLoopP95Millis: Math.round(eventLoop.percentile(95) / 1e6), metrics }, null, 2));
  } finally {
    eventLoop.disable();
    process.removeListener('unhandledRejection', onUnhandled);
    await proxy.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const watchdog = setTimeout(() => { console.error('Native PostgreSQL startup test exceeded its 120-second budget.'); process.exit(1); }, 120_000);
void main().catch((error) => {
  // Do not print database connection details from driver failures.
  console.error('Native PostgreSQL startup test failed.', { code: postgresFailureCode(error), assertion: error instanceof assert.AssertionError ? error.message : undefined,
    configured: Boolean(process.env.CANVAS_TEST_POSTGRES_URL) });
  process.exitCode = 1;
}).finally(() => clearTimeout(watchdog));
