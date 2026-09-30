import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';

import { HUMAN_ACTIVITY_INTERVAL_MS, shouldReportHumanActivity } from '../app/lib/instance/human-activity-policy';

async function main() {
  if (process.env.CANVAS_HUMAN_ACTIVITY_READ_ONLY === '1') {
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
  const previousData = process.env.DATA;
  process.env.DATA = dataDir;
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  try {
    const { auth } = await import('../app/lib/auth');
    const { POST } = await import('../app/api/instance/human-activity/route');
    const { lastHumanActivityAt, recordHumanActivity } = await import('../app/lib/instance/human-activity');
    type RouteSession = Awaited<ReturnType<typeof auth.api.getSession>>;
    const originalGetSession = auth.api.getSession;
    let session: RouteSession = null;
    Reflect.set(auth.api, 'getSession', async () => session);
    try {
      const request = (origin?: string) => new NextRequest('http://localhost:3000/api/instance/human-activity', {
        method: 'POST', headers: origin ? { origin } : {},
      });
      assert.equal((await POST(request('http://localhost:3000'))).status, 401);
      assert.equal(await lastHumanActivityAt(), null);

      session = { user: { id: 'interactive-user' }, session: { id: 'interactive-session' } } as RouteSession;
      assert.equal((await POST(request())).status, 403);
      assert.equal((await POST(request('https://foreign.example.test'))).status, 403);
      assert.equal(await lastHumanActivityAt(), null);

      const response = await POST(request('http://localhost:3000'));
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { recorded: boolean }).recorded, true);
      const first = await lastHumanActivityAt();
      assert(first);
      assert.equal((await POST(request('http://localhost:3000')).then((item) => item.json()) as { recorded: boolean }).recorded, false);
      assert.equal(await lastHumanActivityAt(), first);

      assert.equal((await recordHumanActivity(new Date(Date.parse(first) + HUMAN_ACTIVITY_INTERVAL_MS - 1))).recorded, false);
      assert.equal((await recordHumanActivity(new Date(Date.parse(first) + HUMAN_ACTIVITY_INTERVAL_MS))).recorded, true);
      const persisted = await lastHumanActivityAt();
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
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataDir, { recursive: true, force: true });
  }
  console.info('human activity visibility/trust gate, unauthenticated request, throttle, and restart persistence passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
