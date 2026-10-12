import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';

import { HUMAN_ACTIVITY_INTERVAL_MS, shouldReportHumanActivity } from '../app/lib/instance/human-activity-policy';

async function main() {
  if (process.env.CANVAS_HUMAN_ACTIVITY_READ_ONLY === '1') {
    assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'sqlite');
    assert.equal(process.env.CANVAS_DEPLOYMENT_MODE, 'community');
    assert.equal(process.env.DATABASE_URL, undefined);
    assert.ok(process.env.DATA?.startsWith(join(tmpdir(), 'canvas-human-activity-')),
      'The restart check must read only its parent-owned temporary DATA directory.');
    const { lastHumanActivityAt } = await import('../app/lib/instance/human-activity');
    process.stdout.write(`${await lastHumanActivityAt()}\n`);
    return;
  }

  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const base = { visible: true, trusted: true, repeating: false, now, lastAttemptAt: now - HUMAN_ACTIVITY_INTERVAL_MS };
  assert.equal(shouldReportHumanActivity(base), true);
  assert.equal(shouldReportHumanActivity({ ...base, visible: false }), false);
  assert.equal(shouldReportHumanActivity({ ...base, trusted: false }), false);
  assert.equal(shouldReportHumanActivity({ ...base, repeating: true }), false);
  assert.equal(shouldReportHumanActivity({ ...base, lastAttemptAt: now - HUMAN_ACTIVITY_INTERVAL_MS + 1 }), false);

  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-human-activity-'));
  const environmentKeys = ['DATA', 'CANVAS_DATABASE_PROVIDER', 'CANVAS_DEPLOYMENT_MODE', 'DATABASE_URL',
    'CANVAS_MCP_DIRECT_ENABLED', 'BETTER_AUTH_BASE_URL', 'BASE_URL', 'BETTER_AUTH_TRUSTED_ORIGINS', 'NODE_ENV'] as const;
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.DATA = dataDir;
  // Runtime persistence is PostgreSQL-only. With no URL, this rejected provider
  // marker prevents an accidental canonical connection; this test stores only
  // the real human-activity JSON file and mocks the authentication lookup.
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'community';
  delete process.env.DATABASE_URL;
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  process.env.BASE_URL = 'http://127.0.0.1:3100';
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  Reflect.set(process.env, 'NODE_ENV', 'test');
  try {
    const { auth } = await import('../app/lib/auth');
    const { POST } = await import('../app/api/instance/human-activity/route');
    const { lastHumanActivityAt, recordHumanActivity } = await import('../app/lib/instance/human-activity');
    type RouteSession = Awaited<ReturnType<typeof auth.api.getSession>>;
    const originalGetSession = auth.api.getSession;
    let session: RouteSession = null;
    Reflect.set(auth.api, 'getSession', async () => session);
    try {
      const request = (origin?: string, options: { url?: string; headers?: Record<string, string> } = {}) => {
        const headers = new Headers(options.headers);
        if (origin) headers.set('origin', origin);
        return new NextRequest(options.url ?? 'http://localhost:3000/api/instance/human-activity', {
          method: 'POST', headers,
        });
      };
      const internalUrl = 'http://0.0.0.0:3000/api/instance/human-activity';
      const publicOrigin = 'http://127.0.0.1:3100';
      assert.equal((await POST(request('http://localhost:3000'))).status, 401);
      assert.equal((await POST(request(publicOrigin, { url: internalUrl }))).status, 401);
      assert.equal((await POST(request())).status, 401, 'Authentication must be checked before Origin.');
      assert.equal(await lastHumanActivityAt(), null);

      session = { user: { id: 'interactive-user' }, session: { id: 'interactive-session' } } as RouteSession;
      const forwardedHeaders = {
        forwarded: 'for=192.0.2.10;host=127.0.0.1:3100;proto=http',
        'x-forwarded-host': '127.0.0.1:3100', 'x-forwarded-proto': 'http', 'x-forwarded-port': '3100',
      };
      const deniedRequests: Array<{
        name: string; origin?: string; options: { url?: string; headers?: Record<string, string> };
      }> = [
        { name: 'missing Origin', origin: undefined, options: {} },
        { name: 'foreign Origin', origin: 'https://foreign.example.test', options: {} },
        { name: 'unconfigured internal Origin', origin: 'http://0.0.0.0:3000', options: { url: internalUrl } },
        { name: 'missing Origin with forged forwarded headers', origin: undefined,
          options: { url: internalUrl, headers: forwardedHeaders } },
        { name: 'foreign Origin with forged forwarded headers', origin: 'https://foreign.example.test',
          options: { url: internalUrl, headers: forwardedHeaders } },
        { name: 'cross-site public Origin', origin: publicOrigin,
          options: { url: internalUrl, headers: { 'sec-fetch-site': 'cross-site' } } },
      ];
      const assertDeniedDoesNotWrite = async () => {
        for (const item of deniedRequests) {
          const before = await lastHumanActivityAt();
          const response = await POST(request(item.origin, item.options));
          assert.equal(response.status, 403, item.name);
          assert.equal((await response.json() as { code: string }).code, 'CSRF_ORIGIN_INVALID', item.name);
          assert.equal(await lastHumanActivityAt(), before, `${item.name} must not change the persisted timestamp.`);
        }
      };
      await assertDeniedDoesNotWrite();

      const response = await POST(request('http://localhost:3000'));
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { recorded: boolean }).recorded, true);
      const first = await lastHumanActivityAt();
      assert(first);
      const proxied = await POST(request(publicOrigin, { url: internalUrl, headers: { 'sec-fetch-site': 'same-origin' } }));
      assert.equal(proxied.status, 200, 'Configured public Origin must work through the internal container URL.');
      assert.equal(proxied.headers.get('cache-control'), 'no-store');
      assert.equal((await proxied.json() as { recorded: boolean }).recorded, false);
      assert.equal(await lastHumanActivityAt(), first);
      assert.equal((await POST(request('http://localhost:3000')).then((item) => item.json()) as { recorded: boolean }).recorded, false);
      assert.equal(await lastHumanActivityAt(), first);

      assert.equal((await recordHumanActivity(new Date(Date.parse(first) + HUMAN_ACTIVITY_INTERVAL_MS - 1))).recorded, false);
      assert.equal((await recordHumanActivity(new Date(Date.parse(first) + HUMAN_ACTIVITY_INTERVAL_MS))).recorded, true);
      const persisted = await lastHumanActivityAt();
      await assertDeniedDoesNotWrite();
      assert.equal(await lastHumanActivityAt(), persisted);
      const runner = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const child = spawnSync(runner, ['--conditions', 'react-server', 'scripts/human-activity-test.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, CANVAS_HUMAN_ACTIVITY_READ_ONLY: '1' },
        encoding: 'utf8',
      });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim(), persisted);
    } finally {
      Reflect.set(auth.api, 'getSession', originalGetSession);
    }
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else Reflect.set(process.env, key, value);
    }
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('human activity trusted public/proxy Origin, rejection without writes, authentication, throttle, and isolated restart persistence passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
