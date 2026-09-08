import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const originalFetch = globalThis.fetch;
async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'reveal-workspace' });
  useFileStore.getState().resetWorkspaceView('reveal-workspace');
  const file = { path: 'docs/file.ts', name: 'file.ts', type: 'file' as const };
  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [file] }],
    currentFile: { path: file.path, content: 'saved' }, currentFileWorkspaceId: 'reveal-workspace',
    isMultiSelectMode: true, multiSelectPaths: new Set(['other.ts']), searchQuery: 'unrelated' });
  useEditorStore.getState().setActiveFile(file.path, 'saved');
  useEditorStore.getState().updateDraft('local draft');
  globalThis.fetch = (async () => { throw new Error('A cached reveal must preserve the editor without reading or saving.'); }) as typeof fetch;
  const opened = await useFileStore.getState().revealAndLoadFile(file.path);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.status === 'opened' && opened.reveal?.status, 'ready');
  assert.equal(useFileStore.getState().browserReveal?.status, 'ready', 'tree prepared does not claim a mounted browser scrolled');
  assert.equal(useFileStore.getState().selectedNode?.path, file.path);
  assert.equal(useFileStore.getState().currentDirectory, 'docs');
  assert.equal(useFileStore.getState().isMultiSelectMode, false);
  assert.equal(useFileStore.getState().multiSelectPaths.size, 0);
  assert.equal(useFileStore.getState().searchQuery, '');
  assert.ok(useFileStore.getState().expandedDirs.has('docs'));
  assert.equal(useEditorStore.getState().draft, 'local draft');

  useFileStore.setState({ searchQuery: 'keep me' });
  const requestId = useFileStore.getState().openFileRequestId;
  assert.equal((await useFileStore.getState().revealAndLoadFile(file.path, { workspaceId: 'other' })).status, 'superseded');
  assert.equal(useFileStore.getState().searchQuery, 'keep me');
  assert.equal(useFileStore.getState().openFileRequestId, requestId);

  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory' }] });
  globalThis.fetch = (async () => Response.json({ error: 'Directory unavailable' }, { status: 503 })) as typeof fetch;
  const partial = await useFileStore.getState().revealAndLoadFile(file.path);
  assert.equal(partial.status, 'opened');
  assert.equal(partial.status === 'opened' && partial.reveal?.status, 'failed');
  assert.equal(useFileStore.getState().browserReveal?.status, 'failed');
  assert.equal(useEditorStore.getState().draft, 'local draft');
  globalThis.fetch = (async () => Response.json({ success: true, data: [file] })) as typeof fetch;
  const retry = await useFileStore.getState().revealAndLoadFile(file.path);
  assert.equal(retry.status === 'opened' && retry.reveal?.status, 'ready');
  assert.equal(useEditorStore.getState().draft, 'local draft');
  console.log('notebook-chat-reveal-test: ok');
}
void main().finally(() => { globalThis.fetch = originalFetch; useEditorStore.getState().clear(); });
