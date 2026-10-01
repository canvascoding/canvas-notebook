import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-developer-preferences-'));
  process.env.DATA = root;
  process.env.CANVAS_DATA_ROOT = root;
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/auth' || /(?:^|\/)app\/lib\/auth$/u.test(name)) return {
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id && ['alice', 'bob'].includes(id) ? { user: { id, role: 'member' } } : null;
      } } },
    };
    if (name === '@/app/lib/agents/registry' || name === '@/app/lib/agents/access') return {};
    return originalLoad(name, parent, isMain);
  };
  try {
    const preferences = await import('../app/lib/user-preferences');
    const storage = await import('../app/lib/settings-storage');
    const route = await import('../app/api/user-preferences/route');
    const preferencesPath = storage.resolveSettingsStoragePath('user-preferences.json');
    const request = (actor?: string, body?: unknown) => new NextRequest('http://canvas.test/api/user-preferences?userId=alice', {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { ...(actor ? { 'x-test-user': actor } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await route.GET(request())).status, 401);
    assert.equal((await route.PATCH(request(undefined, { developerMode: true }))).status, 401);
    assert.equal((await preferences.getUserPreferences('alice')).developerMode, false);
    assert.equal((await (await route.GET(request('alice'))).json()).data.developerMode, false);
    await fs.mkdir(path.dirname(preferencesPath), { recursive: true });
    await fs.writeFile(preferencesPath, JSON.stringify({ version: 1, users: {
      alice: { locale: 'en', teamLicenseNotificationsEnabled: false },
      bob: { developerMode: 'true', emailAllowRemoteImages: false },
    } }));
    assert.equal((await preferences.getUserPreferences('alice')).developerMode, false, 'legacy preferences default to false');
    assert.equal((await preferences.getUserPreferences('bob')).developerMode, false, 'truthy persisted values cannot enable developer mode');
    const enabled = await route.PATCH(request('alice', { developerMode: true, userId: 'bob', role: 'admin' }));
    assert.equal(enabled.status, 200);
    const enabledData = (await enabled.json()).data;
    assert.equal(enabledData.developerMode, true);
    assert.equal(enabledData.locale, 'en');
    assert.equal(enabledData.teamLicenseNotificationsEnabled, false);
    assert.equal('role' in enabledData, false, 'developer preference grants no authorization roles');
    assert.equal((await (await route.GET(request('bob'))).json()).data.developerMode, false, 'query and payload IDs never target another account');
    const beforeInvalid = await fs.readFile(preferencesPath);
    for (const developerMode of ['true', 'false', 1, 0, null, [], {}, undefined]) {
      const response = await route.PATCH(request('alice', { developerMode }));
      assert.equal(response.status, 400, 'API accepts only explicit boolean values');
      assert.deepEqual(await fs.readFile(preferencesPath), beforeInvalid);
    }
    await assert.rejects(() => preferences.updateUserPreferences('alice', { developerMode: 'true' } as unknown as Parameters<typeof preferences.updateUserPreferences>[1]), /Unsupported developer mode/u);
    assert.deepEqual(await fs.readFile(preferencesPath), beforeInvalid, 'service validation prevents accidental coercion');
    await Promise.all([
      preferences.updateUserPreferences('alice', { developerMode: false }),
      preferences.updateUserPreferences('alice', { emailAllowRemoteImages: true }),
    ]);
    const final = await preferences.getUserPreferences('alice');
    assert.equal(final.developerMode, false);
    assert.equal(final.emailAllowRemoteImages, true);
    assert.equal(final.locale, 'en');
    assert.equal(final.teamLicenseNotificationsEnabled, false);
    assert.equal((await preferences.getUserPreferences('bob')).developerMode, false);
    console.log('developer-mode-preferences-test: PASS (false default, strict booleans, personal ownership, no role grant, durable update and concurrent preference preservation)');
  } finally {
    internals._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
