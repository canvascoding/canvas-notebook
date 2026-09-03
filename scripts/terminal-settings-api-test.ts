import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'terminal-settings-api-'));
  const previousRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = root;
  const internal = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internal._load;
  let user: { id: string; role: string; email: string } | null = null;
  let syncCount = 0;
  let serviceUnavailable = false;
  let synchronizationBarrier: Promise<void> | null = null;
  let synchronizationStarted: (() => void) | null = null;
  internal._load = (name, ...args) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/auth' || name.endsWith('/app/lib/auth')) {
      return { auth: { api: { getSession: async () => user ? { user } : null } } };
    }
    if (name === '@/app/lib/terminal-client' || name.endsWith('/app/lib/terminal-client')) {
      return { getTerminalClient: () => ({ refreshPolicy: async () => {
        syncCount++;
        synchronizationStarted?.();
        if (synchronizationBarrier) await synchronizationBarrier;
        if (serviceUnavailable) throw new Error('test service unavailable');
      } }) };
    }
    return originalLoad(name, ...args);
  };
  try {
    const { PATCH } = await import('../app/api/admin/terminal-settings/route');
    const { GET } = await import('../app/api/terminal/availability/route');
    const { readTerminalAvailability, serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/admin/terminal-settings', {
      method: 'PATCH', body: JSON.stringify(body),
    }));
    const get = () => GET(new NextRequest('http://localhost/api/terminal/availability'));
    assert.equal((await patch({ terminalEnabled: true })).status, 401);
    assert.equal((await get()).status, 401);
    user = { id: 'member', role: 'user', email: 'terminal-member@example.test' };
    assert.equal((await patch({ terminalEnabled: true })).status, 403);
    assert.equal(syncCount, 0);
    assert.equal((await (await get()).json()).data.terminalEnabled, false);
    user = { id: 'admin', role: 'admin', email: 'terminal-admin@example.test' };
    for (const body of [null, {}, { terminalEnabled: 'true' }, { terminalEnabled: 1 }]) {
      assert.equal((await patch(body)).status, 400);
    }
    assert.equal(syncCount, 0);
    assert.equal((await patch({ terminalEnabled: true })).status, 200);
    assert.equal(readTerminalAvailability().terminalEnabled, true);
    assert.equal(JSON.parse(await readFile(serverPreferencesPath(), 'utf8')).settings.terminalUpdatedBy, 'admin');

    user = { id: 'member', role: 'user', email: 'terminal-member@example.test' };
    const streamRequest = new NextRequest('http://localhost/api/terminal/availability?stream=1');
    const stream = await GET(streamRequest);
    const reader = stream.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"terminalEnabled":true/);
    assert.doesNotMatch(initial, /terminalUpdatedBy|timeZone/);
    assert.equal((await patch({ terminalEnabled: false })).status, 403);
    user = { id: 'admin', role: 'admin', email: 'terminal-admin@example.test' };
    assert.equal((await patch({ terminalEnabled: false })).status, 200);
    const update = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('availability stream did not update')), 3000); timer.unref(); }),
    ]);
    assert.match(new TextDecoder().decode(update.value), /"terminalEnabled":false/);
    await reader.cancel();
    assert.equal(syncCount, 2);

    serviceUnavailable = true;
    const failed = await patch({ terminalEnabled: false });
    assert.equal(failed.status, 503, 'failed runtime synchronization must not report success');
    assert.equal(readTerminalAvailability().terminalEnabled, false, 'persisted denial survives a service failure');
    serviceUnavailable = false;
    let releaseSynchronization = () => {};
    const started = new Promise<void>(resolve => { synchronizationStarted = resolve; });
    synchronizationBarrier = new Promise<void>(resolve => { releaseSynchronization = resolve; });
    const disabling = patch({ terminalEnabled: false });
    await started;
    const enabling = patch({ terminalEnabled: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(readTerminalAvailability().terminalEnabled, false, 'enable must wait until disable has revoked running sessions');
    synchronizationBarrier = null;
    synchronizationStarted = null;
    releaseSynchronization();
    assert.equal((await disabling).status, 200);
    assert.equal((await enabling).status, 200);
    assert.equal(readTerminalAvailability().terminalEnabled, true, 'queued changes recover after a previous service error');
    console.log('terminal-settings-api-test: ok');
  } finally {
    internal._load = originalLoad;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
