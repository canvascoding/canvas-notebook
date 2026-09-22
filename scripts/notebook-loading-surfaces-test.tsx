import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { FileGridView } from '../app/components/file-browser/FileGridView';
import { DocumentLoadingSkeleton } from '../app/components/editor/DocumentLoadingSkeleton';
import { MarkdownEditor } from '../app/components/editor/MarkdownEditorClient';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { TooltipProvider } from '../components/ui/tooltip';
import type { WorkspaceMoveController } from '../app/components/file-browser/useWorkspaceMove';

const controller = { conflict: null, isMoving: false, startMove: async () => undefined,
  resolveConflict: async () => undefined } as unknown as WorkspaceMoveController;
const file = { name: 'existing.txt', path: 'existing.txt', type: 'file' as const };
const folder = (name: string) => ({ name, path: name, type: 'directory' as const, children: [] });
async function main() {
  const initialFileState = useFileStore.getState();
  const initialWorkspaceState = useWorkspaceStore.getState();
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'getComputedStyle'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
    WebSocket: class { readyState = 0; close() {} send() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const roots: Array<{ workspaceId: string | null | undefined; resolve: () => void }> = [];
  const directories: Array<{ workspaceId: string | null | undefined; resolve: () => void }> = [];
  const expansionWrites: string[] = [];
  const rootRead = (_path?: string, _depth?: number, _noCache?: boolean, workspaceId?: string | null) => new Promise<void>((resolve) => {
    roots.push({ workspaceId, resolve: () => {
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        useFileStore.setState({ isLoadingTree: false, directoryLoadStates: { '.': 'ready' } });
      }
      resolve();
    } });
  });
  useWorkspaceStore.setState({ activeWorkspaceId: null, initialized: false });
  useFileStore.getState().resetWorkspaceView(null);
  useFileStore.setState({ browserMode: 'grid', hydrateClientPreferences: () => undefined,
    loadFileTree: rootRead,
    refreshRootTree: (_noCache, workspaceId) => rootRead('.', 0, true, workspaceId),
    loadSubdirectory: (_path, _force, _noCache, workspaceId) => new Promise<void>((resolve) => { directories.push({ workspaceId, resolve }); }),
    setExpandedDirs: (value) => { expansionWrites.push(useWorkspaceStore.getState().activeWorkspaceId || 'none'); initialFileState.setExpandedDirs(value); },
  });
  const root = createRoot(document.getElementById('root')!);
  const render = (variant: 'default' | 'fullscreen' = 'default') => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <TooltipProvider><FileGridView variant={variant} moveController={controller} /></TooltipProvider>
    </NextIntlClientProvider>,
  );
  try {
    await act(async () => { render(); });
    assert.equal(roots.length, 0, 'uninitialized/null workspace cannot start explorer queries');
    assert.ok(document.querySelector('[data-testid="file-tree-loading-skeleton"]'));
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a', initialized: false });
    });
    assert.equal(roots.length, 0, 'cached workspace ID still waits for workspace authorization');
    await act(async () => {
      useWorkspaceStore.setState({ initialized: true });
      useFileStore.setState({ fileTreeWorkspaceId: 'workspace-a', fileTree: [file], isLoadingTree: true,
        directoryLoadStates: { '.': 'ready' }, treeError: null });
    });
    assert.equal(roots.length, 1);
    const visibleRow = document.querySelector('[data-file-path="existing.txt"]');
    assert.ok(visibleRow, 'cached rows render while root/restoration reads run');
    assert.equal(document.querySelector('[data-testid="file-tree-loading-skeleton"]'), null);
    assert.ok(document.querySelector('[data-testid="file-tree-refresh-status"]'));
    await act(async () => { roots.shift()!.resolve(); });
    assert.equal(document.querySelector('[data-file-path="existing.txt"]'), visibleRow, 'background completion preserves the row DOM');

    await act(async () => {
      useFileStore.setState({ fileTree: [], directoryLoadStates: { '.': 'ready' } });
      render('fullscreen');
    });
    assert.equal(document.querySelector('[data-testid="file-tree-loading-skeleton"]'), null, 'successful empty directory remains an empty state during refresh');
    assert.ok(document.querySelector('[data-file-scroll-container]'));
    await act(async () => { roots.shift()!.resolve(); });
    await act(async () => { useFileStore.setState({ treeError: 'Refresh unavailable', directoryLoadStates: { '.': 'error' } }); });
    assert.equal(document.querySelector('[data-testid="file-tree-loading-skeleton"]'), null, 'failed background refresh retains known empty snapshot');
    const retry = document.querySelector('[role="alert"] button') as HTMLButtonElement | null;
    assert.ok(retry, 'background errors offer an immediate retry');
    await act(async () => { retry.click(); });
    assert.equal(roots.length, 1, 'retry starts a root request');
    await act(async () => { roots.shift()!.resolve(); useFileStore.setState({ treeError: null }); });

    await act(async () => {
      useFileStore.setState({ fileTree: [folder('adir')], currentDirectory: 'adir', expandedDirs: new Set(['adir']),
        directoryLoadStates: { '.': 'ready' } });
      render();
    });
    await act(async () => { roots.shift()!.resolve(); });
    assert.equal(directories.length, 1);
    const delayedRestore = directories.shift()!;
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-b' });
      useFileStore.setState({ fileTreeWorkspaceId: 'workspace-b', treeGeneration: useFileStore.getState().treeGeneration + 1,
        fileTree: [folder('bdir')], currentDirectory: 'bdir', expandedDirs: new Set(['bdir']), directoryLoadStates: { '.': 'ready' } });
    });
    const writesBefore = expansionWrites.length;
    await act(async () => { delayedRestore.resolve(); });
    assert.equal(expansionWrites.length, writesBefore, 'late A restore cannot prune B expanded directories');
    assert.equal(useFileStore.getState().currentDirectory, 'bdir');
    assert.deepEqual([...useFileStore.getState().expandedDirs], ['bdir']);
    assert.equal(document.querySelector('[data-file-path="adir"]'), null, 'previous workspace rows are never displayed in the new scope');
  } finally {
    await act(async () => { root.unmount(); });
    roots.forEach(({ resolve }) => resolve());
    directories.forEach(({ resolve }) => resolve());
    useFileStore.setState(initialFileState);
    useWorkspaceStore.setState(initialWorkspaceState);
    dom.window.close();
  }
  const documentSkeleton = renderToStaticMarkup(<DocumentLoadingSkeleton label="Loading document" path="notes.md" showHeader />);
  assert.match(documentSkeleton, /role="status"/);
  assert.match(documentSkeleton, /file-loading-skeleton/);
  assert.match(documentSkeleton, /notes.md/);
  const editorSkeleton = renderToStaticMarkup(<MarkdownEditor value="Private document content" onChange={() => undefined} />);
  assert.match(editorSkeleton, /file-loading-skeleton/);
  assert.doesNotMatch(editorSkeleton, /Private document content/);
  console.log('notebook-loading-surfaces-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
