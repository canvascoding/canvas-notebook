import assert from 'node:assert/strict';
import { createWorkspacePath, WorkspaceFileApiError } from '../app/lib/files/client';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const requests: Array<{ workspaceId: string | null; body: unknown }> = [];
  let response = Response.json({ success: true });
  globalThis.fetch = async (_url, init) => {
    requests.push({
      workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'),
      body: JSON.parse(String(init?.body)),
    });
    return response.clone();
  };
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'source-workspace' });
    await createWorkspacePath('Projects/Launch', 'directory', { workspaceId: 'target-workspace' });
    assert.deepEqual(requests.pop(), {
      workspaceId: 'target-workspace', body: { path: 'Projects/Launch', type: 'directory' },
    });
    await createWorkspacePath('Drawing.excalidraw', 'file', { template: 'excalidraw' });
    assert.deepEqual(requests.pop(), {
      workspaceId: 'source-workspace', body: { path: 'Drawing.excalidraw', type: 'file', template: 'excalidraw' },
    });
    response = Response.json({ success: false, error: 'Path already exists', code: 'PATH_EXISTS', path: 'Projects/Launch' }, { status: 409 });
    await assert.rejects(createWorkspacePath('Projects/Launch', 'directory', { workspaceId: 'target-workspace' }), (error: unknown) => {
      assert.ok(error instanceof WorkspaceFileApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'PATH_EXISTS');
      assert.equal(error.path, 'Projects/Launch');
      return true;
    });
    console.log('workspace-path-create-client-test: workspace binding, templates and structured conflicts passed');
  } finally {
    globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId: originalWorkspaceId });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
