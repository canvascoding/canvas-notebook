import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { WorkspaceDeletePartialError } from '../app/lib/files/client';
import { findNodeInTree } from '../app/lib/files/tree-utils';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';

function setup() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.getState().resetWorkspaceView('ws-a');
  const selected = { path: 'docs/nested/a.txt', name: 'a.txt', type: 'file' as const };
  useFileStore.setState({ fileTree: [
    { path: 'docs', name: 'docs', type: 'directory', children: [
      { path: 'docs/nested', name: 'nested', type: 'directory', children: [selected] },
    ] },
    { path: 'remaining.txt', name: 'remaining.txt', type: 'file' },
  ], currentDirectory: 'docs/nested', selectedNode: selected,
  expandedDirs: new Set(['docs', 'docs/nested']), multiSelectPaths: new Set([selected.path, 'remaining.txt']), isMultiSelectMode: true,
  lastSelectedPath: selected.path, clipboardPaths: new Set([selected.path]), clipboardMode: 'copy',
  contextMenuNode: selected, isContextMenuOpen: true, backgroundContextMenuDirectory: 'docs/nested', isBackgroundContextMenuOpen: true,
  directoryErrors: { 'docs/nested': 'retry' }, directoryLoadStates: { docs: 'ready', 'docs/nested': 'error' },
  fileRevisions: { [selected.path]: 'source-hash', 'archive/nested/a.txt': 'replaced-hash' } });
}

async function main() {
  setup();
  useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'ws-a', operationId: crypto.randomUUID(), oldPath: 'docs', newPath: 'archive' });
  let state = useFileStore.getState();
  assert.equal(state.currentDirectory, 'archive/nested');
  assert.equal(state.selectedNode?.path, 'archive/nested/a.txt');
  assert.equal(state.lastSelectedPath, 'archive/nested/a.txt');
  assert.deepEqual([...state.clipboardPaths], ['archive/nested/a.txt']);
  assert.deepEqual([...state.multiSelectPaths], ['archive/nested/a.txt', 'remaining.txt']);
  assert.equal(state.contextMenuNode?.path, 'archive/nested/a.txt');
  assert.equal(state.backgroundContextMenuDirectory, 'archive/nested');
  assert.equal(state.directoryErrors['archive/nested'], 'retry');
  assert.equal(state.directoryErrors['docs/nested'], undefined);
  assert.equal(state.fileRevisions['archive/nested/a.txt'], 'source-hash', 'source revision wins an overwrite collision');
  useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'ws-a', operationId: crypto.randomUUID(), oldPath: 'archive/nested/a.txt', newPath: 'archive/nested/b.txt' });
  assert.equal(useFileStore.getState().selectedNode?.name, 'b.txt');

  setup();
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/delete')) {
      assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), 'ws-a');
      return Response.json({ deleted: ['docs'], failed: [{ path: 'remaining.txt', error: 'Permission denied' }], trashEntries: [{ id: 'undo-docs', originalPath: 'docs' }] });
    }
    return Response.json({ success: true, data: [{ path: 'remaining.txt', name: 'remaining.txt', type: 'file' }] });
  }) as typeof fetch;
  await assert.rejects(useFileStore.getState().deletePath(['docs', 'remaining.txt']), (error) => {
    assert.ok(error instanceof WorkspaceDeletePartialError, String(error));
    assert.equal(error.result.trashEntries?.[0].id, 'undo-docs');
    return true;
  });
  state = useFileStore.getState();
  assert.equal(findNodeInTree('docs', state.fileTree), null);
  assert.equal(state.currentDirectory, '.');
  assert.equal(state.selectedNode, null);
  assert.equal(state.lastSelectedPath, null);
  assert.equal(state.contextMenuNode, null);
  assert.equal(state.isContextMenuOpen, false);
  assert.equal(state.backgroundContextMenuDirectory, '.');
  assert.equal(state.isBackgroundContextMenuOpen, false);
  assert.deepEqual([...state.multiSelectPaths], ['remaining.txt'], 'failed paths remain selected for retry');
  assert.equal(state.isMultiSelectMode, true);
  assert.equal(state.clipboardPaths.size, 0);
  assert.equal(state.clipboardMode, null);
  assert.equal(state.expandedDirs.size, 0);
  assert.equal(state.directoryErrors['docs/nested'], undefined);
  assert.equal(state.fileRevisions['docs/nested/a.txt'], undefined);

  setup();
  let respond!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  const oldRead = useFileStore.getState().loadSubdirectory('docs/nested', true, false);
  useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'ws-a', operationId: crypto.randomUUID(), oldPath: 'docs', newPath: 'archive' });
  respond(Response.json({ success: true, data: [{ path: 'docs/nested/obsolete.txt', name: 'obsolete.txt', type: 'file' }] }));
  await oldRead;
  assert.equal(useFileStore.getState().loadingDirs.has('docs/nested'), false);
  assert.equal(useFileStore.getState().loadingDirs.has('archive/nested'), false, 'a moved request must not leave a permanent spinner');
  assert.equal(findNodeInTree('docs/nested/obsolete.txt', useFileStore.getState().fileTree), null);
  assert.equal(useFileStore.getState().staleDirs.has('archive/nested'), true);

  setup();
  const loadingDestination = useFileStore.getState().loadFile('target.txt');
  useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'ws-a', operationId: crypto.randomUUID(), oldPath: 'remaining.txt', newPath: 'target.txt' });
  respond(Response.json({ success: true, data: { content: 'obsolete destination', stats: { size: 20, modified: 1, permissions: '100644' } } }));
  assert.equal((await loadingDestination).status, 'superseded', 'rename invalidates an in-flight read of the overwritten destination');
  assert.equal(useFileStore.getState().currentFile, null);
  let unexpectedDelete = false;
  globalThis.fetch = (async () => { unexpectedDelete = true; return Response.json({ deleted: ['docs'] }); }) as typeof fetch;
  await assert.rejects(useFileStore.getState().deletePath('docs', 'ws-previous'), /workspace changed/);
  assert.equal(unexpectedDelete, false, 'a stale delete dialog must not submit in the new workspace');
  console.log('notebook-explorer-path-state-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
