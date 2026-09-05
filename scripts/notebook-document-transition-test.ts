import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { handleOpenChatSessionEvent } from '../app/lib/chat/open-chat-session-event';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'a', workspaces: ['a', 'b', 'c'].map((id) => ({
    id, name: id, status: 'active', type: 'personal', permissions: { canRead: true },
  })) as ReturnType<typeof useWorkspaceStore.getState>['workspaces'] });
  useFileStore.getState().resetWorkspaceView('a');
  useFileStore.setState({ currentFile: { path: 'a.txt', content: 'base' }, currentFileWorkspaceId: 'a' });
  useEditorStore.getState().setActiveFile('a.txt', 'base');
  useEditorStore.getState().updateDraft('draft');
}
async function main() {
  const originalFetch = globalThis.fetch;
  try {
    setup();
    const write = deferred<Response>();
    const started = deferred<void>();
    let savedWorkspace: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      savedWorkspace = new Headers(init?.headers).get('x-canvas-workspace-id');
      started.resolve();
      return write.promise;
    }) as typeof fetch;
    const switching = useWorkspaceStore.getState().setActiveWorkspace('b');
    await started.promise;
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'a');
    assert.equal(useEditorStore.getState().draft, 'draft');
    write.resolve(Response.json({ data: { path: 'a.txt' } }));
    assert.equal(await switching, true);
    assert.equal(savedWorkspace, 'a');
    assert.equal(useEditorStore.getState().isDirty, false);

    setup();
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(await useWorkspaceStore.getState().setActiveWorkspace('b'), false);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'a');
    assert.equal(useEditorStore.getState().draft, 'draft');
    assert.equal(useEditorStore.getState().isDirty, true);

    setup();
    const closingWrite = deferred<Response>();
    const closingStarted = deferred<void>();
    globalThis.fetch = (async () => { closingStarted.resolve(); return closingWrite.promise; }) as typeof fetch;
    const closing = useFileStore.getState().closeFile('a.txt');
    await closingStarted.promise;
    useEditorStore.getState().updateDraft('new typing');
    closingWrite.resolve(Response.json({ data: { path: 'a.txt' } }));
    await assert.rejects(closing, /changed while saving/);
    assert.equal(useFileStore.getState().currentFile?.path, 'a.txt');
    assert.equal(useEditorStore.getState().draft, 'new typing');
    assert.equal(useEditorStore.getState().isDirty, true);

    setup();
    const checkpoint = deferred<void>();
    let prepared = false;
    const unregister = registerDocumentTransitionGuard('a', 'a.txt', {
      hasPendingChanges: () => true,
      prepare: async () => { prepared = true; await checkpoint.promise; },
    });
    useEditorStore.getState().markSaved();
    const staleClose = useFileStore.getState().closeFile('a.txt');
    assert.equal(prepared, true);
    useFileStore.getState().clearCurrentFile();
    useFileStore.setState({ currentFile: { path: 'b.txt', content: 'B' }, currentFileWorkspaceId: 'a' });
    useEditorStore.getState().setActiveFile('b.txt', 'B');
    checkpoint.resolve();
    await assert.rejects(staleClose, /document changed/);
    assert.equal(useFileStore.getState().currentFile?.path, 'b.txt');
    unregister();

    const switched = deferred<boolean>();
    let opened = false;
    const event = { detail: { sessionId: 'session', workspaceId: 'b' } } as unknown as Event;
    assert.equal(handleOpenChatSessionEvent(event, {
      activeWorkspaceId: 'a', switchWorkspace: () => switched.promise,
      openSession: () => { opened = true; },
    }), true);
    assert.equal(opened, false);
    switched.resolve(false);
    await Promise.resolve();
    assert.equal(opened, false, 'a blocked workspace switch must not open its chat in the old workspace');
    console.log('notebook-document-transition-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().clearCurrentFile();
  }
}
void main();
