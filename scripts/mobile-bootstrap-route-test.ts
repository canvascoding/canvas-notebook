import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const environmentKeys = [
  'CANVAS_DATABASE_PROVIDER',
  'CANVAS_DEPLOYMENT_MODE',
  'CANVAS_INSTANCE_ID',
  'CANVAS_INSTANCE_NAME',
  'CANVAS_TEAM_FEATURES_ENABLED',
  'DATA',
] as const;
const originalEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    image: null;
    role: string;
  };
  session: { id: string };
};

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-bootstrap-'));
  const dataRoot = path.join(temporaryRoot, 'data');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'self-hosted';
  process.env.CANVAS_INSTANCE_ID = 'mobile-bootstrap-private-instance';
  process.env.CANVAS_INSTANCE_NAME = 'Mobile Route Canvas';
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'false';
  await fs.mkdir(dataRoot, { recursive: true });

  const { runMigrations } = await import('../app/lib/db/migrate');
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    const now = Date.now();
    runMigrations(sqlite);
    sqlite.prepare(`
      INSERT INTO user (
        id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
      ) VALUES (?, ?, ?, 1, NULL, ?, NULL, NULL, NULL, ?, ?)
    `).run('mobile-user', 'Mobile User', 'mobile@example.test', 'admin', now, now);
  } finally {
    sqlite.close();
  }

  const { auth } = await import('../app/lib/auth');
  let currentSession: RouteSession | null = null;
  assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);
  const route = await import('../app/api/mobile/v1/bootstrap/route');

  const unauthorized = await route.GET(new Request('http://localhost/api/mobile/v1/bootstrap'));
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as { code?: string }).code, 'UNAUTHORIZED');

  currentSession = {
    user: {
      id: 'mobile-user',
      email: 'mobile@example.test',
      name: 'Mobile User',
      image: null,
      role: 'admin',
    },
    session: { id: 'mobile-session' },
  };
  const response = await route.GET(new Request('http://localhost/api/mobile/v1/bootstrap'));
  const payload = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.equal(payload.product, 'canvas-notebook');
  const user = payload.user as Record<string, unknown>;
  assert.equal(user.email, 'mobile@example.test');
  assert.deepEqual(user.profile, {
    name: 'Mobile User',
    avatarKind: 'initials',
    iconId: null,
    initials: 'MU',
    imagePath: null,
    revision: 0,
  });
  const workspace = payload.workspace as Record<string, unknown>;
  assert.equal(typeof workspace.activeWorkspaceId, 'string');
  assert.equal(Array.isArray(workspace.items), true);
  assert.equal((workspace.items as unknown[]).length, 1);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(dataRoot), false);
  assert.equal(serialized.includes('rootRelativePath'), false);
  assert.equal(serialized.includes('mobile-bootstrap-private-instance'), false);

  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

main()
  .then(() => console.log('mobile-bootstrap-route-test: ok'))
  .finally(() => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
