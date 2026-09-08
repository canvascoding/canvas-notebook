import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  const originalFetch = globalThis.fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: 'identity-workspace' });
  useFileStore.getState().resetWorkspaceView('identity-workspace');
  useEditorStore.getState().clear();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/rename') return Response.json({ success: true });
    assert.equal(url.pathname, '/api/files/read');
    return Response.json({ success: true, data: { path: url.searchParams.get('path'), content: 'AAA\n',
      stats: { size: 4, modified: 1, permissions: '100644' } } });
  };
  try {
    assert.equal((await useFileStore.getState().loadFile('folder/before.md')).status, 'loaded');
    const identity = useFileStore.getState().currentFile?.editorIdentity;
    assert(identity);
    useEditorStore.getState().setActiveFile('folder/before.md', 'AAA\n');
    const session = useEditorStore.getState().sessionId;
    await useFileStore.getState().renamePath('folder', 'renamed', false, false);
    assert.equal(useFileStore.getState().currentFile?.path, 'renamed/before.md');
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, identity);
    assert.equal(useEditorStore.getState().activePath, 'renamed/before.md');
    assert(useEditorStore.getState().sessionId > session, 'old save callbacks are still revoked on rename');
    await useFileStore.getState().renamePath('renamed/before.md', 'renamed/after.md', false, false);
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, identity);
    await useFileStore.getState().refreshCurrentFileContent('renamed/after.md');
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, identity, 'refresh retains the open lifetime');
    assert.equal((await useFileStore.getState().loadFile('renamed/after.md')).status, 'loaded');
    assert.notEqual(useFileStore.getState().currentFile?.editorIdentity, identity, 'a new load starts a new lifetime at the same path');
    console.log('File editor identity survives file/folder rename and refresh; new loads and stale save callbacks remain isolated.');
  } finally {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(null);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
