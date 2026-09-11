import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { findNodeInTree } from '../app/lib/files/tree-utils';
import type { WorkspacePathRenameMutation } from '../app/lib/files/file-events';

class Source extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  static latest: Source;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { super(); Source.latest = this; }
  close() {}
  emit(data: unknown) { this.dispatchEvent(new MessageEvent('filechange', { data: JSON.stringify(data) })); }
}
function setup() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.getState().resetWorkspaceView('ws-a');
  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [
    { path: 'docs/a.txt', name: 'a.txt', type: 'file' },
  ] }], currentDirectory: 'docs', expandedDirs: new Set(['docs']),
  currentFile: { path: 'docs/a.txt', content: 'base', stats: { size: 4, modified: 1, permissions: '100644' } },
  currentFileWorkspaceId: 'ws-a' });
  useEditorStore.getState().setActiveFile('docs/a.txt', 'base');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function main() {
  for (const eventFirst of [true, false]) {
    setup();
    const client = new FileWatcherClient(() => new Source());
    client.acquire();
    const response = deferred<Response>();
    const mutation: WorkspacePathRenameMutation = { type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-a', oldPath: 'docs/a.txt', newPath: 'docs/b.txt' };
    globalThis.fetch = (async (input) => String(input).includes('/rename') ? response.promise : Response.json({ success: true, data: [] })) as typeof fetch;
    const rename = useFileStore.getState().renamePath(mutation.oldPath, mutation.newPath, false, false);
    await tick();
    // Local edits after the request starts must survive both delivery orders.
    useEditorStore.getState().updateDraft('local changes during rename');
    const emit = () => Source.latest.emit({ type: 'rename', workspaceId: 'ws-a', path: mutation.newPath, relativePath: mutation.newPath, dir: 'docs', timestamp: Date.now(), mutation });
    if (eventFirst) emit();
    response.resolve(Response.json({ success: true, mutation }));
    await rename;
    if (!eventFirst) emit();
    emit();
    assert.equal(useFileStore.getState().currentFile?.path, 'docs/b.txt');
    assert.equal(useEditorStore.getState().draft, 'local changes during rename');
    assert.equal(useEditorStore.getState().activePath, 'docs/b.txt');
    assert.ok(findNodeInTree('docs/b.txt', useFileStore.getState().fileTree));
    assert.equal(findNodeInTree('docs/a.txt', useFileStore.getState().fileTree), null);
    client.disconnect();
  }

  setup();
  useEditorStore.getState().updateDraft('keep me');
  const client = new FileWatcherClient(() => new Source());
  client.acquire();
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  Source.latest.emit({ type: 'unlinkDir', workspaceId: 'ws-a', path: 'docs', relativePath: 'docs', dir: '.', timestamp: Date.now() });
  await tick();
  assert.equal(useFileStore.getState().currentFile?.unavailable, 'deleted');
  assert.equal(useEditorStore.getState().draft, 'keep me');
  await assert.rejects(useFileStore.getState().prepareCurrentFileForTransition(), /no longer available/);
  await assert.rejects(useFileStore.getState().saveFile('docs/a.txt', 'keep me'), /moved or deleted/);
  client.disconnect();

  setup();
  const replacement = new FileWatcherClient(() => new Source());
  replacement.acquire();
  globalThis.fetch = (async () => Response.json({ success: true, data: { content: '', stats: { size: 4, modified: 2, permissions: '100644' } } })) as typeof fetch;
  Source.latest.emit({ type: 'unlink', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  await tick();
  assert.equal(useFileStore.getState().currentFile?.unavailable, undefined, 'atomic replacement must not detach an existing file');
  replacement.disconnect();

  setup();
  const delayed = new FileWatcherClient(() => new Source());
  delayed.acquire();
  const missing = deferred<Response>();
  let missingReads = 0;
  globalThis.fetch = (async () => ++missingReads === 1 ? missing.promise : Response.json({ success: true, data: { content: 'recreated', stats: { size: 9, modified: 2, permissions: '100644' } } })) as typeof fetch;
  Source.latest.emit({ type: 'unlink', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  Source.latest.emit({ type: 'add', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  missing.resolve(new Response('', { status: 404 }));
  await tick();
  assert.equal(useFileStore.getState().currentFile?.unavailable, undefined, 'a newer creation invalidates the earlier absence check');
  delayed.disconnect();

  setup();
  useEditorStore.getState().updateDraft('folder draft');
  const folderMutation: WorkspacePathRenameMutation = { type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-a', oldPath: 'docs', newPath: 'archive' };
  useFileStore.getState().applyPathRename(folderMutation);
  assert.equal(useFileStore.getState().currentFile?.path, 'archive/a.txt');
  assert.equal(useEditorStore.getState().draft, 'folder draft');
  assert.equal(useFileStore.getState().currentDirectory, 'archive');
  assert.ok(findNodeInTree('archive/a.txt', useFileStore.getState().fileTree));
  assert.equal(useFileStore.getState().applyPathRename(folderMutation), false);

  setup();
  useFileStore.getState().applyPathRename({ type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-other', oldPath: 'docs', newPath: 'elsewhere' });
  assert.equal(useFileStore.getState().currentFile?.path, 'docs/a.txt');
  console.log('notebook-path-mutations-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
