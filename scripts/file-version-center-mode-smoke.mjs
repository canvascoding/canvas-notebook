import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const { Pool } = pg;
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3100';
const databaseUrl = process.env.DATABASE_URL;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const mode = process.env.FILE_VERSION_CENTER_MODE;
const testPath = process.env.FVRC_ROLLOUT_FIXTURE_PATH || 'fvrc-702-rollout.md';
const offIoPath = 'fvrc-702-off-io.json';
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Rollout smoke is local-only');
assert.ok(mode === 'read_only' || mode === 'off', 'Mode smoke supports read_only and off only');
assert.ok(databaseUrl && email && password, 'Managed database and bootstrap credentials are required');

function cookies(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function jsonRequest(endpoint, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const payload = await response.json();
  return { response, payload, durationMs: Math.round(performance.now() - startedAt) };
}

async function aggregate(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM file_version_blobs) AS blobs,
      (SELECT COUNT(*)::bigint FROM file_revision_contents) AS contents,
      (SELECT COUNT(*)::bigint FROM collaboration_agent_operations
        WHERE status IN ('needs_review', 'partially_applied', 'semantic_conflict')) AS reviews,
      (SELECT COUNT(*)::bigint FROM file_agent_review_policies) AS policies,
      (SELECT COUNT(*)::bigint FROM file_version_restore_receipts) AS restore_receipts
  `);
  return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
}

async function login() {
  const response = await jsonRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.response.status, 200);
  const cookie = cookies(response.response);
  assert.ok(cookie);
  return cookie;
}

async function scope(cookie) {
  const spaces = await jsonRequest('/api/workspaces', { headers: { cookie, Origin: baseUrl } });
  assert.equal(spaces.response.status, 200);
  const workspace = spaces.payload.workspaces?.find((candidate) => (
    candidate.type === 'personal' && candidate.permissions?.canWrite
  ));
  assert.ok(workspace?.id, 'The managed writable personal workspace is required');
  return workspace.id;
}

async function resolve(cookie, workspaceId) {
  return jsonRequest('/api/files/version-center/v1/resolve', {
    method: 'POST',
    headers: {
      cookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'x-canvas-workspace-id': workspaceId,
    },
    body: JSON.stringify({
      contractVersion: 1,
      target: { kind: 'path', workspaceId, pathHint: testPath },
      initialView: 'history',
      source: 'deep_link',
    }),
  });
}

async function readOnlyChecks(cookie, workspaceId, headers) {
  const timeline = await resolve(cookie, workspaceId);
  assert.equal(timeline.response.status, 200);
  assert.equal(timeline.payload.capabilities.history, true);
  assert.equal(timeline.payload.capabilities.compare, true);
  assert.equal(timeline.payload.capabilities.restore, false);
  assert.equal(timeline.payload.capabilities.agentReviewPolicy, false);
  const current = timeline.payload.entries.find((entry) => entry.kind === 'current');
  const revision = timeline.payload.entries.find((entry) => (
    entry.kind === 'revision' && entry.content?.availability === 'available'
  ));
  assert.ok(current && revision, 'Read-only canary needs current and immutable revision entries');
  const target = { kind: 'path', workspaceId, pathHint: testPath };
  const expectedCurrent = {
    revisionId: current.revisionId,
    sha256: current.sha256,
    ...(current.stateVectorHash ? { stateVectorHash: current.stateVectorHash } : {}),
  };
  const comparison = await jsonRequest('/api/files/version-center/v1/compare', {
    method: 'POST', headers, body: JSON.stringify({
      contractVersion: 1,
      target,
      candidate: { kind: 'revision', id: revision.revisionId },
      expectedCurrent,
      limit: 20,
    }),
  });
  assert.equal(comparison.response.status, 200);
  const restore = await jsonRequest('/api/files/version-center/v1/restore', {
    method: 'POST', headers, body: JSON.stringify({
      contractVersion: 1,
      target,
      revisionId: revision.revisionId,
      expectedCurrent,
      idempotencyKey: `fvrc-702-${randomUUID()}`,
    }),
  });
  assert.equal(restore.response.status, 400);
  assert.equal(restore.payload.error?.code, 'FVRC_CAPABILITY_UNAVAILABLE');
  const policy = await jsonRequest('/api/files/version-center/v1/policy', {
    method: 'POST', headers, body: JSON.stringify({
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId, lineageId: timeline.payload.document.lineageId },
      requestedMode: 'safe_direct',
      expectedRevision: 0,
    }),
  });
  assert.equal(policy.response.status, 400);
  assert.equal(policy.payload.error?.code, 'FVRC_CAPABILITY_UNAVAILABLE');
  return {
    history: true,
    compare: true,
    restoreRejected: true,
    policyRejected: true,
    durationsMs: [timeline.durationMs, comparison.durationMs],
  };
}

async function offChecks(cookie, workspaceId, headers) {
  const existingIoFixture = await jsonRequest(`/api/files/read?path=${encodeURIComponent(offIoPath)}`, { headers });
  assert.ok([200, 404].includes(existingIoFixture.response.status));
  if (existingIoFixture.response.status === 200) {
    const cleanup = await jsonRequest('/api/files/delete', {
      method: 'DELETE', headers, body: JSON.stringify({ path: offIoPath }),
    });
    assert.equal(cleanup.response.status, 200);
  }
  const create = await jsonRequest('/api/files/create', {
    method: 'POST', headers, body: JSON.stringify({ path: offIoPath, type: 'file' }),
  });
  assert.equal(create.response.status, 200);
  const content = 'Rollback verification: document access remains available.\n';
  const write = await jsonRequest('/api/files/write', {
    method: 'POST', headers, body: JSON.stringify({
      path: offIoPath,
      content,
      expectedSha256: emptySha256,
    }),
  });
  assert.equal(write.response.status, 200);
  const read = await jsonRequest(`/api/files/read?path=${encodeURIComponent(offIoPath)}`, { headers });
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.data.content, content);
  const timeline = await resolve(cookie, workspaceId);
  assert.equal(timeline.response.status, 200);
  assert.equal(timeline.payload.capabilities.history, false);
  assert.equal(timeline.payload.capabilities.compare, false);
  assert.equal(timeline.payload.capabilities.restore, false);
  assert.equal(timeline.payload.capabilities.agentReviewPolicy, false);
  assert.equal(timeline.payload.capabilities.reason, 'rollout_disabled');
  assert.deepEqual(timeline.payload.entries, []);
  assert.deepEqual(timeline.payload.page, { hasMore: false, nextCursor: null });
  const ioDeletion = await jsonRequest('/api/files/delete', {
    method: 'DELETE', headers, body: JSON.stringify({ path: offIoPath }),
  });
  assert.equal(ioDeletion.response.status, 200);
  const deletion = await jsonRequest('/api/files/delete', {
    method: 'DELETE', headers, body: JSON.stringify({ path: testPath }),
  });
  assert.equal(deletion.response.status, 200);
  const deletedRead = await jsonRequest(`/api/files/read?path=${encodeURIComponent(testPath)}`, { headers });
  assert.equal(deletedRead.response.status, 404);
  return {
    documentReadWrite: true,
    fvrcCapabilitiesHidden: true,
    fixtureRemoved: true,
    durationsMs: [write.durationMs, read.durationMs, timeline.durationMs],
  };
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const cookie = await login();
  const workspaceId = await scope(cookie);
  const headers = {
    cookie,
    Origin: baseUrl,
    'Content-Type': 'application/json',
    'x-canvas-workspace-id': workspaceId,
  };
  try {
    const before = await aggregate(pool);
    const checks = mode === 'read_only'
      ? await readOnlyChecks(cookie, workspaceId, headers)
      : await offChecks(cookie, workspaceId, headers);
    const after = await aggregate(pool);
    assert.deepEqual(after, before, 'Mode transition checks must not alter stored FVRC/review state');
    console.log(JSON.stringify({
      component: 'file_version_center_rollout_transition',
      version: 1,
      mode,
      outcome: 'success',
      before,
      after,
      checks,
    }));
  } finally {
    if (mode === 'off') {
      for (const path of [testPath, offIoPath]) {
        await fetch(`${baseUrl}/api/files/delete`, {
          method: 'DELETE', headers, body: JSON.stringify({ path }),
        }).catch(() => undefined);
      }
    }
    await pool.end();
  }
}

main().catch(() => {
  console.error('file-version-center-mode-smoke: failed');
  process.exitCode = 1;
});
