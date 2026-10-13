import assert from 'node:assert/strict';
import { useEditorStore } from '../app/store/editor-store';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const workspaceId = 'history-reopen-workspace';
const originalFetch = globalThis.fetch;
const file = (path: string, content: string) => ({ path, content,
  stats: { size: content.length, modified: 1, permissions: '100644' } });

function setup(path = 'same.txt') {
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useEditorStore.getState().clear();
  useFileStore.setState({ currentFile: file(path, 'cached'), currentFileWorkspaceId: workspaceId });
  useEditorStore.getState().setActiveFile(path, 'cached');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  try {
    for (const path of ['same.txt', 'same.png']) {
      setup(path);
      let reads = 0;
      globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/files/quick-access') return Response.json({ success: true });
        assert.equal(url.pathname, '/api/files/read');
        assert.equal(url.searchParams.get('path'), path);
        assert.equal(url.searchParams.get('meta'), path.endsWith('.png') ? '1' : null);
        assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceId);
        assert.equal(init?.cache, 'no-store');
        reads += 1;
        return Response.json({ success: true, data: file(path, 'fresh') });
      }) as typeof fetch;
      assert.equal((await useFileStore.getState().revealAndLoadFile(path, { revealInTree: false })).status, 'opened');
      assert.equal(reads, 0, 'Normal selection of the visible editor keeps its existing session.');
      assert.equal((await useFileStore.getState().revealAndLoadFile(path, { revealInTree: false, forceReload: true })).status, 'opened');
      assert.equal(reads, 1, 'History reopening performs a real scoped read for text and binary metadata.');
      assert.equal(useFileStore.getState().currentFile?.content, 'fresh');
    }

    setup();
    useEditorStore.getState().updateDraft('local draft');
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/files/quick-access') return Response.json({ success: true });
      requests.push(url.pathname);
      if (url.pathname === '/api/files/write') {
        assert.equal(JSON.parse(String(init?.body)).content, 'local draft');
        return Response.json({ success: true, data: file('same.txt', 'local draft') });
      }
      assert.equal(useEditorStore.getState().isDirty, false, 'Saving settles before revalidation.');
      return Response.json({ success: true, data: file('same.txt', 'local draft') });
    }) as typeof fetch;
    assert.equal((await useFileStore.getState().revealAndLoadFile('same.txt', { revealInTree: false, forceReload: true })).status, 'opened');
    assert.deepEqual(requests, ['/api/files/write', '/api/files/read']);

    setup();
    useEditorStore.getState().updateDraft('unsaved');
    globalThis.fetch = (async (input) => {
      assert.equal(new URL(String(input), 'http://localhost').pathname, '/api/files/write');
      return Response.json({ error: 'Save rejected' }, { status: 409 });
    }) as typeof fetch;
    assert.equal((await useFileStore.getState().revealAndLoadFile('same.txt', { revealInTree: false, forceReload: true })).status, 'failed');
    assert.equal(useEditorStore.getState().draft, 'unsaved');
    assert.equal(useEditorStore.getState().isDirty, true);

    setup();
    globalThis.fetch = (async () => Response.json({ error: 'Read permission revoked' }, { status: 403 })) as typeof fetch;
    const denied = await useFileStore.getState().revealAndLoadFile('same.txt', { revealInTree: false, forceReload: true });
    assert.equal(denied.status, 'failed', 'A denied revalidation cannot report the cached preview as opened.');
    assert.equal(useFileStore.getState().fileErrorPath, 'same.txt');

    for (const cancel of ['route', 'draft', 'workspace'] as const) {
      setup();
      const started = deferred<void>();
      const response = deferred<Response>();
      let isCurrent = true;
      globalThis.fetch = (async () => { started.resolve(); return response.promise; }) as typeof fetch;
      const opening = useFileStore.getState().revealAndLoadFile('same.txt', {
        revealInTree: false, forceReload: true, isCurrent: () => isCurrent,
      });
      await started.promise;
      if (cancel === 'route') isCurrent = false;
      if (cancel === 'draft') useEditorStore.getState().updateDraft('typed during revalidation');
      if (cancel === 'workspace') {
        useWorkspaceStore.setState({ activeWorkspaceId: 'other-workspace' });
        useFileStore.setState({ currentFile: file('same.txt', 'other workspace'), currentFileWorkspaceId: 'other-workspace' });
      }
      response.resolve(Response.json({ success: true, data: file('same.txt', 'late stale response') }));
      assert.equal((await opening).status, 'superseded');
      assert.equal(useFileStore.getState().currentFile?.content, cancel === 'workspace' ? 'other workspace' : 'cached');
      if (cancel === 'draft') assert.equal(useEditorStore.getState().draft, 'typed during revalidation');
      assert.equal(useFileStore.getState().isLoadingFile, false);
    }
    console.log('History reopen passed: normal selection cache, fresh text/binary reads, save barriers, denied read and draft/route/workspace races.');
  } finally {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(null);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
