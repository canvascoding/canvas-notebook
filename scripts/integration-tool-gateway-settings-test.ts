import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-integration-gateway-settings-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const internals = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internals._load;
  let user: { id: string; role: string; email: string } | null = null;
  internals._load = (name, ...args) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/auth' || name.endsWith('/app/lib/auth')) {
      return { auth: { api: { getSession: async () => user ? { user } : null } } };
    }
    return originalLoad(name, ...args);
  };
  try {
    const { readIntegrationToolGatewayAvailability } = await import('../app/lib/integration-tool-gateway-availability');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const { getServerSettings, setExperimentalFeatures, setServerPreferredTimeZone } = await import('../app/lib/server-settings');
    const { GET, PATCH } = await import('../app/api/admin/experimental-settings/route');
    const get = () => GET(new NextRequest('http://localhost/api/admin/experimental-settings'));
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/admin/experimental-settings', {
      method: 'PATCH', body: JSON.stringify(body),
    }));
    assert.deepEqual(readIntegrationToolGatewayAvailability(), { integrationToolGatewayEnabled: false, updatedAt: null });
    await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    for (const settings of [{}, { integrationToolGatewayEnabled: 'true' }, { integrationToolGatewayEnabled: 1 },
      ...['invalid', 123, null].map(value => ({ integrationToolGatewayEnabled: true, integrationToolGatewayUpdatedAt: value }))]) {
      await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings }));
      assert.equal(readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, false);
      assert.equal((await getServerSettings()).integrationToolGatewayEnabled, false);
      await setServerPreferredTimeZone('admin', 'UTC');
      assert.equal(readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, false,
        'An unrelated normalized write cannot enable malformed gateway preferences');
    }
    await writeFile(serverPreferencesPath(), 'broken JSON');
    assert.deepEqual(readIntegrationToolGatewayAvailability(), { integrationToolGatewayEnabled: false, updatedAt: null });
    await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
      terminalEnabled: true, terminalRevocationId: 'existing-terminal', timeZone: 'Europe/Berlin',
      documentReviewEnabled: true, documentReviewUpdatedAt: '2026-10-01T00:00:00.000Z', documentReviewUpdatedBy: 'review-admin',
      studioBulkEnabled: true, studioBulkUpdatedAt: '2026-10-02T00:00:00.000Z', studioBulkUpdatedBy: 'bulk-admin',
    } }));
    const before = await readFile(serverPreferencesPath(), 'utf8');
    assert.equal((await get()).status, 401);
    assert.equal((await patch({ integrationToolGatewayEnabled: true })).status, 401);
    user = { id: 'member', role: 'user', email: 'gateway-member@example.test' };
    assert.equal((await get()).status, 403);
    assert.equal((await patch({ integrationToolGatewayEnabled: true })).status, 403);
    assert.equal(await readFile(serverPreferencesPath(), 'utf8'), before, 'Unauthorized reads and writes cannot change preferences');
    user = { id: 'admin', role: 'admin', email: 'gateway-admin@example.test' };
    const defaultRead = await get();
    assert.equal(defaultRead.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await defaultRead.json()).data, { integrationToolGatewayEnabled: false, updatedAt: null });
    for (const body of [null, {}, [], { integrationToolGatewayEnabled: 'true' }, { integrationToolGatewayEnabled: null },
      { integrationToolGatewayEnabled: true, ownerUserId: 'member' }, { integrationToolGatewayEnabled: true, studioBulkEnabled: 1 }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    await assert.rejects(setExperimentalFeatures('admin', { integrationToolGatewayEnabled: 'true' } as never));
    const enabled = await patch({ integrationToolGatewayEnabled: true });
    assert.equal(enabled.status, 200);
    const enabledData = (await enabled.json()).data;
    assert.equal(enabledData.integrationToolGatewayEnabled, true);
    assert.match(enabledData.integrationToolGatewayUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    const persisted = await getServerSettings();
    assert.equal(persisted.integrationToolGatewayUpdatedBy, 'admin');
    assert.equal(persisted.documentReviewUpdatedBy, 'review-admin');
    assert.equal(persisted.studioBulkUpdatedBy, 'bulk-admin');
    assert.equal(persisted.terminalRevocationId, 'existing-terminal');
    assert.equal(persisted.timeZone, 'Europe/Berlin');
    assert.equal((await get()).status, 200);
    assert.deepEqual((await (await get()).json()).data, {
      integrationToolGatewayEnabled: true, updatedAt: enabledData.integrationToolGatewayUpdatedAt,
    });
    const concurrent = await Promise.all([patch({ integrationToolGatewayEnabled: false }), patch({ studioBulkEnabled: false }),
      patch({ documentReviewEnabled: false })]);
    assert.ok(concurrent.every(response => response.status === 200));
    const concurrentSettings = await getServerSettings();
    assert.equal(concurrentSettings.integrationToolGatewayEnabled, false);
    assert.equal(concurrentSettings.studioBulkEnabled, false);
    assert.equal(concurrentSettings.documentReviewEnabled, false);
    const gatewayBefore = readIntegrationToolGatewayAvailability();
    await patch({ studioBulkEnabled: true });
    assert.deepEqual(readIntegrationToolGatewayAvailability(), gatewayBefore, 'Unrelated patches preserve the gateway revision');
    const originalNow = Date.now;
    const fixedNow = originalNow();
    try {
      Date.now = () => fixedNow;
      const rapid = await Promise.all([patch({ integrationToolGatewayEnabled: true }), patch({ integrationToolGatewayEnabled: false })]);
      const first = (await rapid[0].json()).data.integrationToolGatewayUpdatedAt;
      const second = (await rapid[1].json()).data.integrationToolGatewayUpdatedAt;
      assert.ok(Date.parse(second) > Date.parse(first), 'Rapid toggles receive strictly increasing revisions');
    } finally { Date.now = originalNow; }
    assert.equal(readIntegrationToolGatewayAvailability().integrationToolGatewayEnabled, false);
    console.log('integration-tool-gateway-settings-test: default-off, malformed policy, actual admin boundary, atomic partial updates and revisions passed');
  } finally {
    internals._load = originalLoad;
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
