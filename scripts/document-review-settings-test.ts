import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-document-review-settings-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  const moduleInternals = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = moduleInternals._load;
  let user: { id: string; role: string; email: string } | null = null;
  moduleInternals._load = (name, ...args) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/auth' || name.endsWith('/app/lib/auth')) {
      return { auth: { api: { getSession: async () => user ? { user } : null } } };
    }
    return originalLoad(name, ...args);
  };

  try {
    const { readDocumentReviewAvailability, subscribeDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const { getServerSettings, setDocumentReviewEnabled, setServerPreferredTimeZone } = await import('../app/lib/server-settings');
    const { PATCH } = await import('../app/api/admin/experimental-settings/route');
    const { GET } = await import('../app/api/document-review/availability/route');
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/admin/experimental-settings', {
      method: 'PATCH', body: JSON.stringify(body),
    }));
    const get = (stream = false) => GET(new NextRequest(`http://localhost/api/document-review/availability${stream ? '?stream=1' : ''}`));

    assert.deepEqual(readDocumentReviewAvailability(), { documentReviewEnabled: false, updatedAt: null });
    await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    for (const contents of ['broken json', '{}', '{"settings":null}', '{"settings":{"documentReviewEnabled":"true"}}']) {
      await writeFile(serverPreferencesPath(), contents);
      assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false, contents);
    }
    await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
      terminalEnabled: true, terminalRevocationId: 'terminal-revocation',
      terminalUpdatedAt: '2026-01-01T00:00:00.000Z', timeZone: 'Europe/Berlin',
      onboardingStep: 'review',
    } }));
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false, 'existing installations default to off');

    assert.equal((await patch({ documentReviewEnabled: true })).status, 401);
    assert.equal((await get()).status, 401);
    user = { id: 'member', role: 'user', email: 'document-review-member@example.test' };
    assert.equal((await patch({ documentReviewEnabled: true })).status, 403);
    assert.deepEqual((await (await get()).json()).data, { documentReviewEnabled: false, updatedAt: null });
    user = { id: 'admin', role: 'admin', email: 'document-review-admin@example.test' };
    for (const body of [null, {}, { documentReviewEnabled: 'true' }, { documentReviewEnabled: 1 }]) {
      assert.equal((await patch(body)).status, 400);
    }
    await assert.rejects(setDocumentReviewEnabled('admin', 'true' as unknown as boolean));
    const enabled = await patch({ documentReviewEnabled: true });
    assert.equal(enabled.status, 200);
    const enabledState = (await enabled.json()).data;
    assert.equal(enabledState.documentReviewEnabled, true);
    assert.match(enabledState.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    const persisted = await getServerSettings();
    assert.equal(persisted.documentReviewEnabled, true);
    assert.equal(persisted.documentReviewUpdatedBy, 'admin');
    assert.equal(persisted.terminalEnabled, true);
    assert.equal(persisted.terminalRevocationId, 'terminal-revocation');
    assert.equal(persisted.timeZone, 'Europe/Berlin');
    assert.equal(persisted.onboardingStep, 'review');
    await setServerPreferredTimeZone('admin', 'UTC');
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, true, 'other setting changes preserve review policy');

    user = { id: 'member', role: 'user', email: 'document-review-member@example.test' };
    const stream = await get(true);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"documentReviewEnabled":true/u);
    assert.doesNotMatch(initial, /documentReviewUpdatedBy|terminalEnabled|timeZone/u);

    const notified = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('cross-process availability notification missing')); }, 4000);
      const stop = subscribeDocumentReviewAvailability(state => {
        clearTimeout(timer);
        stop();
        resolve(state.documentReviewEnabled);
      });
    });
    // Simulate another process replacing the shared preferences file.
    const next = JSON.parse(await readFile(serverPreferencesPath(), 'utf8'));
    next.settings.documentReviewEnabled = false;
    next.settings.documentReviewUpdatedAt = '2026-09-30T12:00:00.000Z';
    await writeFile(`${serverPreferencesPath()}.other-process`, JSON.stringify(next));
    const { rename } = await import('node:fs/promises');
    await rename(`${serverPreferencesPath()}.other-process`, serverPreferencesPath());
    assert.equal(await notified, false);
    const update = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('availability stream did not update')), 4000); timer.unref(); }),
    ]);
    assert.match(new TextDecoder().decode(update.value), /"documentReviewEnabled":false/u);
    await reader.cancel();
    assert.deepEqual(readDocumentReviewAvailability(), {
      documentReviewEnabled: false, updatedAt: '2026-09-30T12:00:00.000Z',
    });
    assert.equal((await patch({ documentReviewEnabled: true })).status, 403);
    console.log('document-review-settings-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
