import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-studio-bulk-settings-'));
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const { readStudioBulkAvailability, subscribeStudioBulkAvailability } = await import('../app/lib/studio-bulk-availability');
    const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const { getServerSettings, setExperimentalFeatures, setServerPreferredTimeZone } = await import('../app/lib/server-settings');
    const { PATCH } = await import('../app/api/admin/experimental-settings/route');
    const { GET } = await import('../app/api/studio/bulk/availability/route');
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/admin/experimental-settings', {
      method: 'PATCH', body: JSON.stringify(body),
    }));
    const get = (stream = false) => GET(new NextRequest(`http://localhost/api/studio/bulk/availability${stream ? '?stream=1' : ''}`));

    assert.deepEqual(readStudioBulkAvailability(), { studioBulkEnabled: false, updatedAt: null });
    await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
    for (const contents of ['broken json', '{}', '{"settings":null}', '{"settings":{"studioBulkEnabled":"true"}}',
      '{"settings":{"studioBulkEnabled":true,"studioBulkUpdatedAt":"invalid"}}']) {
      await writeFile(serverPreferencesPath(), contents);
      assert.deepEqual(readStudioBulkAvailability(), { studioBulkEnabled: false, updatedAt: null }, contents);
    }
    for (const malformedTimestamp of ['invalid', 123, null]) {
      await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
        studioBulkEnabled: true, studioBulkUpdatedAt: malformedTimestamp,
      } }));
      assert.equal(readStudioBulkAvailability().studioBulkEnabled, false);
      assert.equal((await getServerSettings()).studioBulkEnabled, false);
      await setServerPreferredTimeZone('admin', 'UTC');
      assert.equal(readStudioBulkAvailability().studioBulkEnabled, false,
        'normalizing an unrelated update cannot activate malformed bulk policy');
    }
    await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
      terminalEnabled: true, terminalRevocationId: 'existing-terminal-revocation',
      terminalUpdatedAt: '2026-01-01T00:00:00.000Z', timeZone: 'Europe/Berlin', onboardingStep: 'review',
      documentReviewEnabled: true, documentReviewUpdatedAt: '2026-10-01T00:00:00.000Z', documentReviewUpdatedBy: 'previous-admin',
    } }));
    assert.equal(readStudioBulkAvailability().studioBulkEnabled, false, 'existing installations default to off');
    assert.equal((await get()).status, 401);
    assert.equal((await patch({ studioBulkEnabled: true })).status, 401);
    user = { id: 'member', role: 'user', email: 'bulk-member@example.test' };
    assert.equal((await patch({ studioBulkEnabled: true })).status, 403);
    const memberRead = await get();
    assert.equal(memberRead.status, 200);
    assert.equal(memberRead.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await memberRead.json()).data, { studioBulkEnabled: false, updatedAt: null });
    user = { id: 'admin', role: 'admin', email: 'bulk-admin@example.test' };
    for (const body of [null, {}, [], true, { studioBulkEnabled: 'true' }, { studioBulkEnabled: 1 },
      { studioBulkEnabled: true, documentReviewEnabled: null }, { studioBulkEnabled: true, unexpected: true }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    await assert.rejects(setExperimentalFeatures('admin', { studioBulkEnabled: 'true' } as never));
    const reviewBefore = readDocumentReviewAvailability();
    const enabled = await patch({ studioBulkEnabled: true });
    assert.equal(enabled.status, 200);
    const enabledState = (await enabled.json()).data;
    assert.equal(enabledState.studioBulkEnabled, true);
    assert.match(enabledState.studioBulkUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(enabledState.updatedAt, reviewBefore.updatedAt, 'updatedAt remains the document review timestamp');
    assert.deepEqual(readDocumentReviewAvailability(), reviewBefore, 'bulk-only patch does not touch document review');
    const persisted = await getServerSettings();
    assert.equal(persisted.studioBulkEnabled, true);
    assert.equal(persisted.studioBulkUpdatedBy, 'admin');
    assert.equal(persisted.documentReviewUpdatedBy, 'previous-admin');
    assert.equal(persisted.terminalEnabled, true);
    assert.equal(persisted.terminalRevocationId, 'existing-terminal-revocation');
    assert.equal(persisted.timeZone, 'Europe/Berlin');
    assert.equal(persisted.onboardingStep, 'review');
    await setServerPreferredTimeZone('admin', 'UTC');
    assert.equal(readStudioBulkAvailability().studioBulkEnabled, true, 'unrelated setting changes preserve bulk policy');
    await patch({ studioBulkEnabled: false, documentReviewEnabled: false });
    assert.equal(readStudioBulkAvailability().studioBulkEnabled, false);
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
    // Concurrent partial patches must be one serialized read/modify/atomic write each.
    const concurrent = await Promise.all([patch({ studioBulkEnabled: true }), patch({ documentReviewEnabled: true })]);
    assert.ok(concurrent.every(response => response.status === 200));
    assert.equal(readStudioBulkAvailability().studioBulkEnabled, true);
    assert.equal(readDocumentReviewAvailability().documentReviewEnabled, true);
    const bulkBeforeReviewOnly = readStudioBulkAvailability();
    await patch({ documentReviewEnabled: false });
    assert.deepEqual(readStudioBulkAvailability(), bulkBeforeReviewOnly, 'review-only patch preserves bulk timestamp');
    const originalNow = Date.now;
    const fixedNow = originalNow();
    let rapid: Response[];
    try {
      Date.now = () => fixedNow;
      rapid = await Promise.all([patch({ studioBulkEnabled: false }), patch({ studioBulkEnabled: true })]);
    } finally { Date.now = originalNow; }
    const firstRevision = (await rapid[0].json()).data.studioBulkUpdatedAt;
    const secondRevision = (await rapid[1].json()).data.studioBulkUpdatedAt;
    assert.ok(Date.parse(secondRevision) > Date.parse(firstRevision), 'rapid toggles have strictly increasing revisions');

    user = { id: 'member', role: 'user', email: 'bulk-member@example.test' };
    const stream = await get(true);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    assert.match(stream.headers.get('cache-control')!, /no-store/u);
    reader = stream.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"studioBulkEnabled":true/u);
    assert.doesNotMatch(initial, /studioBulkUpdatedBy|documentReviewEnabled|terminalEnabled|timeZone/u);
    const notified = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('cross-process bulk notification missing')); }, 4000);
      const stop = subscribeStudioBulkAvailability(state => { clearTimeout(timer); stop(); resolve(state.studioBulkEnabled); });
    });
    const next = JSON.parse(await readFile(serverPreferencesPath(), 'utf8'));
    next.settings.studioBulkEnabled = false;
    next.settings.studioBulkUpdatedAt = '2026-10-02T12:00:00.000Z';
    await writeFile(`${serverPreferencesPath()}.other-process`, JSON.stringify(next));
    await rename(`${serverPreferencesPath()}.other-process`, serverPreferencesPath());
    assert.equal(await notified, false);
    const change = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('bulk stream did not update')), 4000); timer.unref();
    })]);
    assert.match(new TextDecoder().decode(change.value), /"studioBulkEnabled":false/u);
    assert.equal((await patch({ studioBulkEnabled: true })).status, 403);
    console.log('studio-bulk-settings-test: default-off, admin policy, partial/combined/concurrent persistence, revisions and live availability passed');
  } finally {
    await reader?.cancel();
    internals._load = originalLoad;
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
