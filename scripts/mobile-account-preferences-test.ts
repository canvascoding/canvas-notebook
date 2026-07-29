import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

const originalData = process.env.DATA;

type RouteSession = {
  user: { id: string; email: string; name: string; image: null; role: string };
  session: { id: string };
};

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-account-preferences-'));
  process.env.DATA = path.join(temporaryRoot, 'data');
  await fs.mkdir(process.env.DATA, { recursive: true });

  const { auth } = await import('../app/lib/auth');
  const { getUserPreferredLocale } = await import('../app/lib/user-preferences');
  let currentSession: RouteSession | null = null;
  assert.equal(Reflect.set(auth.api, 'getSession', async () => currentSession), true);
  const route = await import('../app/api/mobile/v1/account/preferences/route');

  const unauthorized = await route.GET(
    new NextRequest('http://localhost/api/mobile/v1/account/preferences'),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as { code?: string }).code, 'UNAUTHORIZED');

  currentSession = {
    user: {
      id: 'mobile-language-user',
      email: 'language@example.test',
      name: 'Language User',
      image: null,
      role: 'member',
    },
    session: { id: 'mobile-language-session' },
  };

  const initial = await route.GET(
    new NextRequest('http://localhost/api/mobile/v1/account/preferences'),
  );
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(await initial.json(), { success: true, data: { locale: 'de' } });

  const updated = await route.PATCH(new NextRequest(
    'http://localhost/api/mobile/v1/account/preferences',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en-US' }),
    },
  ));
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { success: true, data: { locale: 'en' } });
  assert.equal(await getUserPreferredLocale('mobile-language-user'), 'en');

  const invalid = await route.PATCH(new NextRequest(
    'http://localhost/api/mobile/v1/account/preferences',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'fr' }),
    },
  ));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code?: string }).code, 'UNSUPPORTED_LOCALE');

  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

main()
  .then(() => console.log('mobile-account-preferences-test: ok'))
  .finally(() => {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
  });
