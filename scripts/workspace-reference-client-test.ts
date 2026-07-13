import assert from 'node:assert/strict';

import { listWorkspaceFileReferences, searchWorkspaceFileReferences } from '../app/lib/files/client';

async function main() {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders = new Headers();

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      success: true,
      files: [{ name: 'notes.md', path: 'notes.md', type: 'file', isImage: false }],
      total: 7,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const files = await listWorkspaceFileReferences({
      query: 'notes',
      limit: 20,
      workspaceId: 'workspace-current',
    });
    assert.equal(files[0]?.path, 'notes.md');
    assert.match(capturedUrl, /workspaceId=workspace-current/);
    assert.match(capturedUrl, /q=notes/);
    assert.equal(capturedHeaders.get('x-canvas-workspace-id'), 'workspace-current');

    const page = await searchWorkspaceFileReferences({
      query: 'notes',
      limit: 20,
      workspaceId: 'workspace-current',
    });
    assert.equal(page.files[0]?.path, 'notes.md');
    assert.equal(page.total, 7);

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('unexpected fetch');
    };
    await assert.rejects(
      () => listWorkspaceFileReferences({ workspaceId: '   ' }),
      /Workspace context is not ready/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('workspace reference client test passed');
}

void main();
