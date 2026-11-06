import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertRegularCollaborationEnvironment, verifyRegularCollaborationTarget } from './lib/regular-collaboration-target.mjs';
import { regularCollaborationFiles } from '../tests/helpers/regular-collaboration-suites.mjs';

const configured = data => ({ BASE_URL: 'http://127.0.0.1:3000', DATA: data,
  E2E_EXTERNAL_SERVER: '1', COLLABORATION_E2E: '1', CANVAS_REGULAR_COLLABORATION_E2E: '1',
  TEST_LOGIN_EMAIL: 'primary@fixture.invalid', TEST_LOGIN_PASSWORD: 'private-primary-test-value',
  TEST_SECONDARY_EMAIL: 'secondary@fixture.invalid', TEST_SECONDARY_PASSWORD: 'private-secondary-test-value' });

test('missing fixtures, remote targets and Review opt-in are explicit prerequisite failures', () => {
  for (const override of [{ TEST_SECONDARY_EMAIL: '' }, { BASE_URL: 'https://customer.invalid' },
    { TEST_SECONDARY_EMAIL: 'primary@fixture.invalid' }, { CANVAS_DOCUMENT_REVIEW_E2E: '1' }, { DATA: 'relative' }]) {
    assert.throws(() => assertRegularCollaborationEnvironment({ ...configured('/tmp'), ...override }), /REGULAR_COLLABORATION_PREREQUISITE/);
  }
});

async function probe(t, variation = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-quality-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname, cookie = options.headers?.Cookie;
    calls.push({ route, method: options.method ?? 'GET' });
    let value;
    if (route === '/api/health') value = { status: 'healthy', database: { provider: 'postgres' },
      deployment: { teamFeaturesEnabled: true }, collaboration: { persistenceReady: true } };
    else if (route === '/api/auth/sign-in/email') {
      const identity = JSON.parse(options.body).email.startsWith('primary') ? 'primary' : 'secondary';
      return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=' + identity } });
    } else if (route === '/api/auth/get-session') {
      const id = cookie.includes('primary') ? 'primary' : 'secondary';
      value = { user: { id, email: id + '@fixture.invalid' } };
    } else if (route === '/api/workspaces') value = { workspaces: [{ id: variation.foreignPeer && cookie.includes('secondary') ? 'other' : 'shared',
      name: 'Shared Test Workspace', type: 'organization', permissions: {
        canWrite: !(variation.readOnlyPeer && cookie.includes('secondary')),
        canDelete: cookie.includes('primary') && !variation.noPrimaryDelete,
      } }] };
    else if (route === '/api/document-review/availability') value = { data: { documentReviewEnabled: variation.review ?? false } };
    else if (route === '/api/auth/sign-out') return new Response('{}', { status: variation.cleanupFails ? 500 : 200 });
    else throw new Error('Unexpected preflight request');
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  return { operation: () => verifyRegularCollaborationTarget(configured(root), fetcher), calls };
}

test('preflight uses both authentications and shared current rights without enabling features', async t => {
  const p = await probe(t);
  const result = await p.operation();
  assert.deepEqual(result.users, ['primary', 'secondary']); assert.equal(result.workspaceId, 'shared');
  assert.equal(result.reviewEnabled, false);
  assert.equal(p.calls.filter(call => call.route === '/api/auth/sign-out').length, 2);
  assert(p.calls.every(call => call.method === 'GET' || call.route.startsWith('/api/auth/')));
});

for (const variation of [{ foreignPeer: true }, { review: true }, { cleanupFails: true }, { readOnlyPeer: true }, { noPrimaryDelete: true }]) {
  test('invalid actual fixture facts or cleanup cannot admit the profile: ' + JSON.stringify(variation), async t => {
    const p = await probe(t, variation);
    await assert.rejects(p.operation(), /REGULAR_COLLABORATION_PREREQUISITE/);
    assert.equal(p.calls.filter(call => call.route === '/api/auth/sign-out').length, variation.noPrimaryDelete ? 1 : 2);
  });
}

test('the regular profile has real files and cannot import Review Center activation fixtures', async () => {
  assert.equal(new Set(regularCollaborationFiles).size, regularCollaborationFiles.length);
  for (const name of regularCollaborationFiles) {
    assert(!/file-version-center|document-review|file.*undo/u.test(name));
    const source = await readFile(new URL('../tests/' + name, import.meta.url), 'utf8');
    assert(!/document-review-experimental|withDocumentReviewEnabled|setScopedDocumentReview/u.test(source), name);
  }
});
