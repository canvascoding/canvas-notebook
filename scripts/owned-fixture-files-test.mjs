import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteOwnedFixtureFiles } from '../tests/helpers/owned-fixture-files.ts';

function target(responses) {
  const calls = [];
  return { calls, api: { delete: async (route, options) => {
    calls.push({ route, ...options });
    const [status, payload] = responses.shift();
    return { status: () => status, json: async () => payload };
  } } };
}

for (const code of ['COLLABORATION_FILE_LIFECYCLE_BUSY', 'PATH_IMPORT_PREVIEW_BUSY']) {
  test(`cleanup retries only uncommitted busy with the original identity (${code})`, async () => {
    const t = target([[409, { code }], [200, { success: true, deleted: ['owned.md'], failed: [] }]]);
    await deleteOwnedFixtureFiles(t.api, 'workspace', ['owned.md']);
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls[0].data, t.calls[1].data);
    assert.equal(t.calls[0].headers['x-canvas-workspace-id'], 'workspace');
  });
}

test('cleanup uses one selection per request and distinct identities per exact path', async () => {
  const t = target(['a.md', 'b.md'].map(file => [200, { success: true, deleted: [file], failed: [] }]));
  await deleteOwnedFixtureFiles(t.api, 'workspace', ['a.md', 'b.md', 'a.md']);
  assert.deepEqual(t.calls.map(call => call.data.path), ['a.md', 'b.md']);
  assert.notEqual(t.calls[0].data.idempotencyKey, t.calls[1].data.idempotencyKey);
});

for (const [status, payload] of [[403, { code: 'FORBIDDEN' }], [409, { code: 'COHORT_DELETE_UNSUPPORTED' }],
  [409, { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY', operation: { status: 'failed' } }],
  [409, { code: 'PATH_IMPORT_PREVIEW_BUSY', operation: { status: 'queued' } }],
  [409, { code: 'PATH_IMPORT_PREVIEW_BUSY', operation: null }],
  [409, { code: 'PATH_IMPORT_PREVIEW_BUSY', operation: false }],
  [409, { code: 'PATH_IMPORT_PREVIEW_UNAVAILABLE' }], [503, { code: 'PATH_IMPORT_PREVIEW_BUSY' }]]) {
  test(`cleanup retains rejected or already-started operations (${status}/${payload.code})`, async () => {
    const t = target([[status, payload]]);
    await assert.rejects(deleteOwnedFixtureFiles(t.api, 'workspace', ['owned.md']), /retain its data/u);
    assert.equal(t.calls.length, 1);
  });
}

test('unexpected completion paths and transport ambiguity cannot pass cleanup', async () => {
  const t = target([[200, { success: true, deleted: ['different.md'], failed: [] }]]);
  await assert.rejects(deleteOwnedFixtureFiles(t.api, 'workspace', ['owned.md']));
  let calls = 0;
  await assert.rejects(deleteOwnedFixtureFiles({ delete: async () => { calls++; throw new Error('connection lost'); } },
    'workspace', ['owned.md']), /connection lost/u);
  assert.equal(calls, 1);
});

test('deadline and invalid relative paths retain data without unbounded work', async () => {
  const t = target([[409, { code: 'COLLABORATION_FILE_LIFECYCLE_BUSY' }]]);
  await assert.rejects(deleteOwnedFixtureFiles(t.api, 'workspace', ['owned.md'], 100), /retain its data/u);
  assert.equal(t.calls.length, 1);
  for (const path of ['/root', '../other', 'a/../other', '']) {
    const invalid = target([]);
    await assert.rejects(deleteOwnedFixtureFiles(invalid.api, 'workspace', ['owned.md', path]));
    assert.equal(invalid.calls.length, 0);
  }
});
