import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

async function main() {
  const originalFetch = globalThis.fetch;
  const visits: { path: string; workspace: string | null }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const slowStarted = new Promise<void>((resolve) => { started = resolve; });
  useWorkspaceStore.setState({ activeWorkspaceId: 'first' });
  useEditorStore.getState().clear();
  useFileStore.setState({ currentFile: null, currentFileWorkspaceId: null, fileTree: [], fileTreeWorkspaceId: 'first' });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files/quick-access') {
      visits.push({ path: JSON.parse(String(init?.body)).path, workspace: new Headers(init?.headers).get(WORKSPACE_ID_HEADER) });
      return Response.json({ success: true });
    }
    if (url.pathname === '/api/files/read') {
      const path = url.searchParams.get('path');
      if (path === 'missing.md') return Response.json({ error: 'File not found' }, { status: 404 });
      if (path === 'slow.md') { started(); await gate; }
      return Response.json({ success: true, data: { path, content: '# Test', stats: { size: 6, modified: 1, permissions: '100644' } } });
    }
    throw new Error(`Unexpected fetch ${url.pathname}`);
  };
  try {
    const options = { workspaceId: 'first', revealInTree: false };
    assert.equal((await useFileStore.getState().revealAndLoadFile('one.md', options)).status, 'opened');
    assert.deepEqual(visits, [{ path: 'one.md', workspace: 'first' }]);
    assert.equal((await useFileStore.getState().revealAndLoadFile('missing.md', options)).status, 'missing');
    assert.equal(visits.length, 1, 'failed reads must not enter history');
    const slowOpen = useFileStore.getState().revealAndLoadFile('slow.md', options);
    await slowStarted;
    useWorkspaceStore.setState({ activeWorkspaceId: 'second' });
    release();
    assert.equal((await slowOpen).status, 'superseded');
    assert.equal(visits.length, 1, 'a workspace switch during loading must not record a visit');
    console.log('File visit recording: successful opens only, explicit workspace and superseded read isolation passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
void main();
