import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { useEditorStore } from '../app/store/editor-store';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const originalFetch = globalThis.fetch;
const workspaceId = 'tab-explorer-workspace';
const selectedFile = { name: 'selected.md', path: 'notes/selected.md', type: 'file' as const };
const targetFile = { name: 'target.md', path: 'docs/nested/target.md', type: 'file' as const };

function setupExplorerState() {
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useEditorStore.getState().clear();
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useFileStore.setState({
    fileTree: [
      { name: 'notes', path: 'notes', type: 'directory', children: [selectedFile] },
      {
        name: 'docs',
        path: 'docs',
        type: 'directory',
        children: [{ name: 'nested', path: 'docs/nested', type: 'directory', children: [targetFile] }],
      },
    ],
    fileTreeWorkspaceId: workspaceId,
    currentDirectory: 'notes',
    expandedDirs: new Set(['notes']),
    selectedNode: selectedFile,
    searchQuery: 'keep this search',
    isMultiSelectMode: true,
    multiSelectPaths: new Set(['notes/selected.md', 'notes/other.md']),
    lastSelectedPath: 'notes/selected.md',
    currentFile: { path: 'notes/selected.md', content: '# Selected' },
    currentFileWorkspaceId: workspaceId,
  });
}

async function testPreservedExplorerState() {
  setupExplorerState();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.pathname, '/api/files/read');
    assert.equal(url.searchParams.get('path'), targetFile.path);
    return Response.json({
      success: true,
      data: { path: targetFile.path, content: '# Target', stats: { size: 8, modified: 1, permissions: '100644' } },
    });
  }) as typeof fetch;

  const result = await useFileStore.getState().revealAndLoadFile(targetFile.path, {
    workspaceId,
    explorerBehavior: 'preserve',
  });

  assert.equal(result.status, 'opened');
  const state = useFileStore.getState();
  assert.equal(state.currentFile?.path, targetFile.path);
  assert.equal(state.selectedNode?.path, selectedFile.path);
  assert.equal(state.currentDirectory, 'notes');
  assert.deepEqual([...state.expandedDirs], ['notes']);
  assert.equal(state.searchQuery, 'keep this search');
  assert.equal(state.isMultiSelectMode, true);
  assert.deepEqual([...state.multiSelectPaths], ['notes/selected.md', 'notes/other.md']);
  assert.equal(state.lastSelectedPath, 'notes/selected.md');
  assert.equal(state.browserReveal, null);
}

async function testExplicitRevealStillFollowsTheDocument() {
  useFileStore.setState({ searchQuery: 'clear me' });
  globalThis.fetch = (async () => {
    throw new Error('Revealing the already open document must not read it again.');
  }) as typeof fetch;

  const result = await useFileStore.getState().revealAndLoadFile(targetFile.path, { workspaceId });

  assert.equal(result.status, 'opened');
  const state = useFileStore.getState();
  assert.equal(state.selectedNode?.path, targetFile.path);
  assert.equal(state.currentDirectory, 'docs/nested');
  assert.equal(state.expandedDirs.has('docs'), true);
  assert.equal(state.expandedDirs.has('docs/nested'), true);
  assert.equal(state.searchQuery, '');
  assert.equal(state.isMultiSelectMode, false);
  assert.equal(state.multiSelectPaths.size, 0);
}

async function testTabAndEditorWiring() {
  const [dashboard, editor, actions] = await Promise.all([
    fs.readFile('app/components/DashboardShell.tsx', 'utf8'),
    fs.readFile('app/components/editor/FileEditor.tsx', 'utf8'),
    fs.readFile('app/components/file-browser/FileActionsDropdown.tsx', 'utf8'),
  ]);
  const tabHandlerStart = dashboard.indexOf('const handleSelectDocumentTab');
  const tabHandlerEnd = dashboard.indexOf('const handleRevealCurrentDocument', tabHandlerStart);
  assert.ok(tabHandlerStart >= 0 && tabHandlerEnd > tabHandlerStart);
  const tabHandler = dashboard.slice(tabHandlerStart, tabHandlerEnd);
  assert.match(tabHandler, /explorerBehavior: 'preserve'/u);
  assert.match(dashboard, /onRevealInExplorer=\{handleRevealCurrentDocument\}/u);
  assert.match(editor, /onRevealInExplorer=\{onRevealInExplorer\}/u);
  assert.match(actions, /t\('revealInFileBrowser'\)/u);
}

async function main() {
  try {
    await testPreservedExplorerState();
    await testExplicitRevealStillFollowsTheDocument();
    await testTabAndEditorWiring();
    console.log('notebook-tab-explorer-behavior-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(workspaceId);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
