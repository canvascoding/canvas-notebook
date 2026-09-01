import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

type RouteSession = {
  user: { id: string; email: string; name: string; image: string | null; role: string };
  session: { id: string };
};

async function importServerModule<T>(specifier: string): Promise<T> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => (
    request === 'server-only' ? {} : originalLoad(request, parent, isMain)
  );
  try {
    return await import(specifier) as T;
  } finally {
    moduleInternals._load = originalLoad;
  }
}

function request(url: string, init?: { body?: BodyInit | null; headers?: HeadersInit; method?: string }) {
  return new NextRequest(url, init);
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-account-profile-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
    `).run('mobile-profile-a', 'Alex Weber', 'alex@example.test', now, now);
    sqlite.close();

    const { auth } = await import('../app/lib/auth');
    let currentSession: RouteSession | null = null;
    const originalGetSession = auth.api.getSession;
    assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);

    try {
      const route = await importServerModule<typeof import('../app/api/mobile/v1/account/profile/route')>(
        '../app/api/mobile/v1/account/profile/route',
      );

      assert.equal((await route.GET(request('http://localhost/api/mobile/v1/account/profile'))).status, 401);
      currentSession = {
        user: {
          id: 'mobile-profile-a',
          email: 'alex@example.test',
          name: 'Alex Weber',
          image: null,
          role: 'user',
        },
        session: { id: 'mobile-profile-session-a' },
      };

      const initial = await route.GET(request('http://localhost/api/mobile/v1/account/profile'));
      assert.equal(initial.status, 200);
      assert.deepEqual((await initial.json() as { data: unknown }).data, {
        name: 'Alex Weber',
        avatarKind: 'initials',
        iconId: null,
        initials: 'AW',
        imagePath: null,
        revision: 0,
      });

      const icon = await route.PATCH(request('http://localhost/api/mobile/v1/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarKind: 'icon', iconId: 'rocket' }),
      }));
      assert.equal(icon.status, 200);
      assert.deepEqual((await icon.json() as { data: unknown }).data, {
        name: 'Alex Weber',
        avatarKind: 'icon',
        iconId: 'rocket',
        initials: 'AW',
        imagePath: null,
        revision: 1,
      });

      const invalid = await route.PATCH(request('http://localhost/api/mobile/v1/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarKind: 'icon', iconId: '../escape' }),
      }));
      assert.equal(invalid.status, 400);
    } finally {
      Reflect.set(auth.api, 'getSession', originalGetSession);
    }
    console.log('mobile-account-profile-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
