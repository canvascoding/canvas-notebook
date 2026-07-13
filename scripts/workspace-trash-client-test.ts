import assert from 'node:assert/strict';

import { restoreWorkspaceTrashEntry } from '../app/lib/files/client';

async function main() {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedMethod = '';
  let capturedHeaders = new Headers();

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = init?.method ?? 'GET';
    capturedHeaders = new Headers(init?.headers);
    return Response.json({
      success: true,
      restored: {
        id: 'trash-entry-1',
        originalPath: 'docs/report.md',
        itemType: 'file',
        sizeBytes: 12,
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    });
  };

  try {
    const restored = await restoreWorkspaceTrashEntry('trash-entry-1', 'workspace-current');
    assert.equal(restored.originalPath, 'docs/report.md');
    assert.equal(capturedUrl, '/api/files/trash/trash-entry-1/restore');
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedHeaders.get('x-canvas-workspace-id'), 'workspace-current');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('workspace trash client test passed');
}

void main();
