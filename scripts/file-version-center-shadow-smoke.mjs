import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

const { Pool } = pg;
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3100';
const databaseUrl = process.env.DATABASE_URL;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
let currentStage = 'startup';
let lastHttpStatus = 0;
let lastErrorCode = '';

assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Shadow smoke is local-only');
assert.equal(process.env.FILE_VERSION_CENTER_MODE, 'shadow', 'Run the smoke only against shadow mode');
assert.ok(databaseUrl && email && password, 'Managed database and bootstrap credentials are required');

function cookies(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

async function jsonRequest(endpoint, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const payload = await response.json();
  lastHttpStatus = response.status;
  lastErrorCode = typeof payload?.error?.code === 'string'
    ? payload.error.code
    : (typeof payload?.code === 'string' ? payload.code : '');
  return { response, payload, durationMs: Math.round(performance.now() - startedAt) };
}

async function storage(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM file_revision_contents) AS captured_versions,
      (SELECT COUNT(*)::bigint FROM file_version_blobs) AS unique_blobs,
      (SELECT COALESCE(SUM(stored_size_bytes), 0)::bigint FROM file_version_blobs) AS stored_bytes,
      (SELECT COUNT(*)::bigint FROM collaboration_agent_operations
        WHERE status IN ('needs_review', 'partially_applied', 'semantic_conflict')) AS pending_reviews,
      (SELECT COUNT(*)::bigint FROM file_agent_review_policies) AS policies,
      (SELECT COUNT(*)::bigint FROM file_version_restore_receipts) AS restore_receipts
  `);
  const row = result.rows[0];
  return {
    capturedVersions: Number(row.captured_versions),
    uniqueBlobs: Number(row.unique_blobs),
    storedBytes: Number(row.stored_bytes),
    pendingReviews: Number(row.pending_reviews),
    policies: Number(row.policies),
    restoreReceipts: Number(row.restore_receipts),
  };
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let cookie = '';
  let workspaceId = '';
  let testPath = '';
  let completed = false;
  try {
    currentStage = 'login';
    const login = await jsonRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.response.status, 200, 'Managed bootstrap login must succeed');
    cookie = cookies(login.response);
    assert.ok(cookie);

    currentStage = 'workspace';
    const spaces = await jsonRequest('/api/workspaces', { headers: { cookie, Origin: baseUrl } });
    assert.equal(spaces.response.status, 200);
    const workspace = spaces.payload.workspaces?.find((candidate) => (
      candidate.type === 'personal' && candidate.permissions?.canWrite
    ));
    assert.ok(workspace?.id, 'The managed writable personal workspace is required');
    workspaceId = workspace.id;
    testPath = process.env.FVRC_ROLLOUT_FIXTURE_PATH || `fvrc-shadow-${randomUUID()}.md`;
    const headers = {
      cookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'x-canvas-workspace-id': workspaceId,
    };
    currentStage = 'fixture_preflight';
    for (const path of [testPath]) {
      const fixturePreflight = await jsonRequest(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
      assert.ok([200, 404].includes(fixturePreflight.response.status));
      if (fixturePreflight.response.status === 200) {
        const cleanup = await jsonRequest('/api/files/delete', {
          method: 'DELETE', headers, body: JSON.stringify({ path }),
        });
        assert.equal(cleanup.response.status, 200);
      }
    }
    const before = await storage(pool);

    currentStage = 'upload';
    const formData = new FormData();
    formData.append('path', '.');
    formData.append('files', new File(
      ['# Shadow capture\n\nMeasured revision.\n'],
      testPath,
      { type: 'text/markdown' },
    ));
    const upload = await jsonRequest('/api/files/upload', {
      method: 'POST',
      headers: {
        cookie,
        Origin: baseUrl,
        'x-canvas-workspace-id': workspaceId,
      },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    currentStage = 'collaboration_session';
    const collaborationSession = await jsonRequest('/api/files/collaboration/session', {
      method: 'POST', headers, body: JSON.stringify({
        path: testPath,
        provider: 'yjs',
        representation: 'auto',
      }),
    });
    assert.equal(collaborationSession.response.status, 200);

    currentStage = 'final_read';
    const finalRead = await jsonRequest(`/api/files/read?path=${encodeURIComponent(testPath)}`, { headers });
    assert.equal(finalRead.response.status, 200);
    assert.equal(finalRead.payload.data.content, '# Shadow capture\n\nMeasured revision.\n');

    currentStage = 'resolve';
    const resolution = await jsonRequest('/api/files/version-center/v1/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contractVersion: 1,
        target: { kind: 'path', workspaceId, pathHint: testPath },
        initialView: 'history',
        source: 'deep_link',
      }),
    });
    assert.equal(resolution.response.status, 200);
    assert.equal(resolution.payload.capabilities.history, false);
    assert.equal(resolution.payload.capabilities.restore, false);
    assert.equal(resolution.payload.capabilities.reason, 'rollout_disabled');

    currentStage = 'aggregate';
    const after = await storage(pool);
    const capturedBindingsDelta = after.capturedVersions - before.capturedVersions;
    const uniqueBlobDelta = after.uniqueBlobs - before.uniqueBlobs;
    const storedBytesDelta = after.storedBytes - before.storedBytes;
    assert.ok(capturedBindingsDelta >= 1, 'The measured import must capture an immutable version');
    assert.ok(uniqueBlobDelta >= 0 && storedBytesDelta >= 0, 'Cross-lineage deduplication must not grow counters negatively');

    console.log(JSON.stringify({
      component: 'file_version_center_shadow_capture',
      version: 1,
      mode: 'shadow',
      outcome: 'success',
      capturedBindingsDelta,
      uniqueBlobDelta,
      storedBytesDelta,
      storageBefore: before,
      storageAfter: after,
      durationsMs: [upload.durationMs],
      documentAccessVerified: true,
      uiHiddenVerified: true,
    }));
    completed = true;
  } finally {
    if ((process.env.FVRC_SHADOW_PRESERVE_FIXTURE !== 'true' || !completed) && cookie && workspaceId && testPath) {
      for (const path of [testPath]) {
        await fetch(`${baseUrl}/api/files/delete`, {
          method: 'DELETE',
          headers: {
            cookie,
            Origin: baseUrl,
            'Content-Type': 'application/json',
            'x-canvas-workspace-id': workspaceId,
          },
          body: JSON.stringify({ path }),
        }).catch(() => undefined);
      }
    }
    await pool.end();
  }
}

main().catch(() => {
  console.error(JSON.stringify({
    component: 'file_version_center_shadow_smoke_failure',
    stage: currentStage,
    httpStatus: lastHttpStatus || undefined,
    errorCode: lastErrorCode || undefined,
  }));
  process.exitCode = 1;
});
