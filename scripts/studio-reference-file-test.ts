import assert from 'node:assert/strict';
import { downloadStudioReferenceFile } from '../app/apps/studio/utils/studio-reference-file';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const image = new Uint8Array([1, 2, 3]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://canvas.test' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'active-workspace' });
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(image, { headers: { 'Content-Type': 'image/png' } });
  };
  try {
    const reference = '/api/media/Products/Terra%20%23%201.png?workspaceId=source-workspace';
    const workspaceFile = await downloadStudioReferenceFile(reference);
    assert.equal(requests[0].url, reference, 'The source workspace URL must survive selection unchanged.');
    assert.equal(requests[0].init?.credentials, 'include');
    assert.equal(new Headers(requests[0].init?.headers).has('x-canvas-workspace-id'), false,
      'The active workspace must not override the selected source workspace.');
    assert.equal(workspaceFile.name, 'Terra # 1.png', 'Only the decoded filename belongs in the upload.');
    assert.equal(workspaceFile.type, 'image/png');
    assert.deepEqual(new Uint8Array(await workspaceFile.arrayBuffer()), image);

    const studioFile = await downloadStudioReferenceFile('studio/outputs/reference.png');
    assert.equal(requests[1].url, '/api/studio/media/studio/outputs/reference.png');
    assert.equal(new Headers(requests[1].init?.headers).get('x-canvas-workspace-id'), 'active-workspace');
    assert.equal(studioFile.name, 'reference.png');
    assert.equal(studioFile.type, 'image/png');

    globalThis.fetch = async () => new Response(null, { status: 403 });
    await assert.rejects(downloadStudioReferenceFile(reference), /Failed to download reference image/);
    console.log('studio-reference-file-test: source workspace, encoded filenames, studio paths and denied access passed');
  } finally {
    globalThis.fetch = originalFetch;
    useWorkspaceStore.setState({ activeWorkspaceId });
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
