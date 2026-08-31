import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import sharp from 'sharp';

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

function request(
  url: string,
  init?: { body?: BodyInit | null; headers?: HeadersInit; method?: string },
): NextRequest {
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== 'GET') {
    headers.set('Origin', 'http://localhost:3000');
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  return new NextRequest(url, { ...init, headers });
}

async function main() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-user-profile-api-'));
  process.env.DATA = dataRoot;
  delete process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.BASE_URL = 'http://localhost:3000';

  try {
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    runMigrations(sqlite);
    const now = Date.now();
    for (const [id, name, email] of [
      ['profile-api-a', 'Alex Weber', 'alex@example.test'],
      ['profile-api-b', 'Berta Beispiel', 'berta@example.test'],
    ]) {
      sqlite.prepare(`
        INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
        VALUES (?, ?, ?, 1, NULL, 'user', ?, ?)
      `).run(id, name, email, now, now);
    }
    sqlite.close();

    const { auth } = await import('../app/lib/auth');
    let currentSession: RouteSession | null = null;
    const originalGetSession = auth.api.getSession;
    assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);

    try {
      const profileRoute = await importServerModule<typeof import('../app/api/account/profile/route')>(
        '../app/api/account/profile/route',
      );
      const avatarRoute = await importServerModule<typeof import('../app/api/account/profile/avatar/route')>(
        '../app/api/account/profile/avatar/route',
      );

      const unauthorized = await profileRoute.GET(request('http://localhost:3000/api/account/profile'));
      assert.equal(unauthorized.status, 401);

      currentSession = {
        user: {
          id: 'profile-api-a',
          email: 'alex@example.test',
          name: 'Alex Weber',
          image: null,
          role: 'user',
        },
        session: { id: 'profile-api-session-a' },
      };

      const initial = await profileRoute.GET(request('http://localhost:3000/api/account/profile'));
      assert.equal(initial.status, 200);
      assert.equal(initial.headers.get('cache-control'), 'no-store, max-age=0');
      assert.deepEqual((await initial.json() as { data: { initials: string; avatarKind: string } }).data, {
        name: 'Alex Weber',
        avatarKind: 'initials',
        iconId: null,
        initials: 'AW',
        imageUrl: null,
        revision: 0,
      });

      const crossOrigin = await profileRoute.PATCH(new NextRequest(
        'http://localhost:3000/api/account/profile',
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://attacker.example.test',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify({ avatarKind: 'icon', iconId: 'rocket' }),
        },
      ));
      assert.equal(crossOrigin.status, 403);

      const icon = await profileRoute.PATCH(request('http://localhost:3000/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarKind: 'icon', iconId: 'rocket', userId: 'profile-api-b', role: 'admin' }),
      }));
      assert.equal(icon.status, 200);
      assert.equal((await icon.json() as { data: { iconId: string } }).data.iconId, 'rocket');

      const invalidIcon = await profileRoute.PATCH(request('http://localhost:3000/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarKind: 'icon', iconId: '../escape' }),
      }));
      assert.equal(invalidIcon.status, 400);

      const oversized = await avatarRoute.POST(request('http://localhost:3000/api/account/profile/avatar', {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=test',
          'Content-Length': String(6 * 1024 * 1024),
        },
        body: '--test--',
      }));
      assert.equal(oversized.status, 413);

      const invalidForm = new FormData();
      invalidForm.append('avatar', new File([Buffer.from('not an image')], 'avatar.png', { type: 'image/png' }));
      const invalidImage = await avatarRoute.POST(request('http://localhost:3000/api/account/profile/avatar', {
        method: 'POST',
        body: invalidForm,
      }));
      assert.equal(invalidImage.status, 400);

      const sourceImage = await sharp({
        create: {
          width: 640,
          height: 360,
          channels: 4,
          background: { r: 10, g: 99, b: 172, alpha: 1 },
        },
      }).png().toBuffer();
      const form = new FormData();
      form.append('avatar', new File([sourceImage], 'alex.png', { type: 'image/png' }));
      const uploaded = await avatarRoute.POST(request('http://localhost:3000/api/account/profile/avatar', {
        method: 'POST',
        body: form,
      }));
      assert.equal(uploaded.status, 200);
      const uploadedData = (await uploaded.json() as { data: { avatarKind: string; imageUrl: string } }).data;
      assert.equal(uploadedData.avatarKind, 'image');
      assert.match(uploadedData.imageUrl, /^\/api\/account\/profile\/avatar\?v=\d+$/u);

      const image = await avatarRoute.GET(request('http://localhost:3000/api/account/profile/avatar?v=2'));
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/webp');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.match(image.headers.get('cache-control') ?? '', /private/u);
      const imageBuffer = Buffer.from(await image.arrayBuffer());
      const metadata = await sharp(imageBuffer).metadata();
      assert.equal(metadata.width, 256);
      assert.equal(metadata.height, 256);
      assert.equal(metadata.format, 'webp');

      const notModified = await avatarRoute.GET(request(
        'http://localhost:3000/api/account/profile/avatar?v=2',
        { headers: { 'If-None-Match': image.headers.get('etag') ?? '' } },
      ));
      assert.equal(notModified.status, 304);

      currentSession = {
        user: {
          id: 'profile-api-b',
          email: 'berta@example.test',
          name: 'Berta Beispiel',
          image: null,
          role: 'user',
        },
        session: { id: 'profile-api-session-b' },
      };
      assert.equal(
        (await avatarRoute.GET(request('http://localhost:3000/api/account/profile/avatar'))).status,
        404,
      );

      currentSession = {
        user: {
          id: 'profile-api-a',
          email: 'alex@example.test',
          name: 'Alex Weber',
          image: uploadedData.imageUrl,
          role: 'user',
        },
        session: { id: 'profile-api-session-a' },
      };
      const removed = await avatarRoute.DELETE(request('http://localhost:3000/api/account/profile/avatar', {
        method: 'DELETE',
      }));
      assert.equal(removed.status, 200);
      assert.equal((await removed.json() as { data: { avatarKind: string } }).data.avatarKind, 'initials');
      assert.equal(
        (await avatarRoute.GET(request('http://localhost:3000/api/account/profile/avatar'))).status,
        404,
      );

      const verificationDb = new Database(path.join(dataRoot, 'sqlite.db'));
      try {
        const rows = verificationDb.prepare('SELECT id, image FROM user ORDER BY id').all() as Array<{ id: string; image: string | null }>;
        assert.deepEqual(rows, [
          { id: 'profile-api-a', image: null },
          { id: 'profile-api-b', image: null },
        ]);
      } finally {
        verificationDb.close();
      }
    } finally {
      Reflect.set(auth.api, 'getSession', originalGetSession);
    }

    console.log('user-profile-api-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
