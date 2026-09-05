import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useEditorStore } from '../app/store/editor-store';
import { notifyWorkspacePathRenamed, notifyWorkspacePathsDeleted } from '../app/lib/files/workspace-file-events';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const stats = (sha256: string) => ({ size: 1, modified: 1, permissions: '100644', sha256 });
function open(workspaceId: string, hash: string) {
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useFileStore.setState({ currentFile: { path: 'same.txt', content: hash, stats: stats(hash) },
    currentFileWorkspaceId: workspaceId, fileRevisions: { 'same.txt': hash } });
}
async function main() {
  const originalFetch = globalThis.fetch;
  try {
    open('a', 'hash-a');
    const started = deferred<void>();
    const firstResponse = deferred<Response>();
    const writes: { workspaceId: string | null; expectedSha256: string }[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      writes.push({ workspaceId: new Headers(init?.headers).get('x-canvas-workspace-id'), expectedSha256: body.expectedSha256 });
      if (writes.length === 1) { started.resolve(); return firstResponse.promise; }
      return Response.json({ data: { path: 'same.txt', stats: stats('hash-a-2') } });
    }) as typeof fetch;
    const first = useFileStore.getState().saveFile('same.txt', 'one', 'a');
    await started.promise;
    const second = useFileStore.getState().saveFile('same.txt', 'two', 'a');
    open('b', 'hash-b');
    firstResponse.resolve(Response.json({ data: { path: 'same.txt', stats: stats('hash-a-1') } }));
    await Promise.all([first, second]);
    assert.deepEqual(writes, [
      { workspaceId: 'a', expectedSha256: 'hash-a' },
      { workspaceId: 'a', expectedSha256: 'hash-a-1' },
    ]);
    assert.equal(useFileStore.getState().currentFile?.content, 'hash-b');
    assert.equal(useFileStore.getState().fileRevisions['same.txt'], 'hash-b');

    open('a', 'original');
    const late = deferred<Response>();
    const lateStarted = deferred<void>();
    globalThis.fetch = (async () => { lateStarted.resolve(); return late.promise; }) as typeof fetch;
    const saving = useFileStore.getState().saveFile('same.txt', 'late', 'a');
    await lateStarted.promise;
    open('b', 'B');
    open('a', 'reopened');
    late.resolve(Response.json({ data: { path: 'same.txt', stats: stats('late') } }));
    await saving;
    assert.equal(useFileStore.getState().currentFile?.content, 'reopened');

    open('a', 'rename-base');
    useEditorStore.getState().setActiveFile('same.txt', 'rename-base');
    const renamed = deferred<Response>();
    globalThis.fetch = (async () => renamed.promise) as typeof fetch;
    const rename = useFileStore.getState().renamePath('same.txt', 'new.txt', false, false);
    await Promise.resolve();
    useEditorStore.getState().updateDraft('typed during rename');
    renamed.resolve(Response.json({ success: true }));
    await rename;
    assert.equal(useEditorStore.getState().activePath, 'new.txt');
    assert.equal(useEditorStore.getState().draft, 'typed during rename');
    assert.equal(useEditorStore.getState().isDirty, true);

    const oldWindow = globalThis.window;
    const events: CustomEvent[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: CustomEvent) => events.push(event) } });
    try {
      notifyWorkspacePathRenamed('old.txt', 'new.txt', 'a');
      notifyWorkspacePathsDeleted(['old.txt'], 'a');
      assert.equal(events[0].detail.workspaceId, 'a');
      assert.equal(events[1].detail.workspaceId, 'a');
    } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow }); }
    console.log('notebook-workspace-isolation-test: ok');
  } finally { globalThis.fetch = originalFetch; }
}
void main();
