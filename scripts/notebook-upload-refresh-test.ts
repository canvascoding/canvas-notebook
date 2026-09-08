import assert from 'node:assert/strict';
import { DirectoryRefreshQueue } from '../app/lib/files/directory-refresh-queue';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function main() {
  const queue = new DirectoryRefreshQueue(15);
  let reads = 0;
  await Promise.all(Array.from({ length: 100 }, () => queue.request('a/docs', async () => { reads++; })));
  assert.equal(reads, 1, '100 requests share one read');
  await queue.request('a/docs', async () => { reads++; }, true).then(() => queue.request('a/docs', async () => { reads++; }, true));
  assert.equal(reads, 3, 'a resolved request is removed before its consumers run');

  useWorkspaceStore.setState({ activeWorkspaceId: 'a' });
  useFileStore.getState().resetWorkspaceView('a');
  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [] }] });
  const originalFetch = globalThis.fetch;
  const responses: Array<(response: Response) => void> = [];
  globalThis.fetch = (async () => new Promise<Response>((resolve) => responses.push(resolve))) as typeof fetch;
  try {
    const first = useFileStore.getState().revalidateDirectory('docs', 'a', true);
    await tick();
    const second = useFileStore.getState().revalidateDirectory('docs', 'a', true);
    responses[0](Response.json({ success: true, data: [] }));
    await Promise.all([first, second]);
    assert.equal(responses.length, 1, 'joining a fresh read is not a mutation');
    await useFileStore.getState().revalidateDirectory('docs', 'a', true);
    assert.equal(responses.length, 1, 'a delayed watcher refresh reuses the already reconciled directory');

    useFileStore.getState().markDirectoryStale('docs');
    const changed = useFileStore.getState().revalidateDirectory('docs', 'a', true);
    await tick();
    useFileStore.getState().markDirectoryStale('docs');
    responses[1](Response.json({ success: true, data: [{ path: 'docs/obsolete', name: 'obsolete', type: 'file' }] }));
    await new Promise((resolve) => setTimeout(resolve, 530));
    assert.equal(responses.length, 3);
    assert.equal(useFileStore.getState().fileTree[0].children?.length, 0, 'obsolete snapshot was never published');
    responses[2](Response.json({ success: true, data: [{ path: 'docs/final', name: 'final', type: 'file' }] }));
    await changed;
    assert.equal(useFileStore.getState().fileTree[0].children?.[0].name, 'final');

    useFileStore.getState().markDirectoryStale('docs');
    const oldWorkspace = useFileStore.getState().revalidateDirectory('docs', 'a');
    useWorkspaceStore.setState({ activeWorkspaceId: 'b' });
    useFileStore.getState().resetWorkspaceView('b');
    await oldWorkspace;
    assert.equal(responses.length, 3, 'queued old-workspace work never sends a request');
  } finally { globalThis.fetch = originalFetch; }
  console.log('notebook-upload-refresh-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
