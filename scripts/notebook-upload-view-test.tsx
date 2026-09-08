import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useFileExplorerViewModel } from '../app/components/file-browser/useFileExplorerViewModel';
import { captureExplorerAnchor, restoreExplorerAnchor } from '../app/components/file-browser/useExplorerScrollAnchor';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element'] as const) Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let scrollCalls = 0;
dom.window.HTMLElement.prototype.scrollIntoView = () => { scrollCalls++; };
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const file = (path: string) => ({ path, name: path, type: 'file' as const });
function Explorer() {
  const ref = useRef<HTMLDivElement>(null);
  const view = useFileExplorerViewModel({ containerRef: ref, variant: 'default' });
  return <div ref={ref} tabIndex={-1} data-file-scroll-container>
    {view.searchResultNodes.map((node) => <div data-file-path={node.path} key={node.path}>{node.name}</div>)}
  </div>;
}

async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'view-test' });
  useFileStore.getState().resetWorkspaceView('view-test');
  let holdSearch = false;
  let completeSearch: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/api/files/tree')) return Response.json({ success: true, data: [file('selected.txt')] });
    if (holdSearch) return new Promise<Response>((resolve) => { completeSearch = resolve; });
    return Response.json({ success: true, files: [file('remote.txt')], total: 1 });
  }) as typeof fetch;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Explorer />));
  await wait(40);
  await act(async () => useFileStore.setState({ selectedNode: file('selected.txt') }));
  await wait(30);
  assert.equal(scrollCalls, 1, 'an explicit new selection is revealed');
  await act(async () => useFileStore.setState({ fileTree: [file('new-upload.txt'), file('selected.txt')] }));
  await wait(30);
  assert.equal(scrollCalls, 1, 'a background tree update does not scroll back to the old selection');
  await act(async () => useFileStore.setState({ browserReveal: { path: 'selected.txt', workspaceId: 'view-test', requestId: 1, status: 'ready' } }));
  await wait(30);
  assert.equal(scrollCalls, 2, 'a chat reveal still works for the already selected file');
  assert.equal(useFileStore.getState().browserReveal?.status, 'visible');

  await act(async () => useFileStore.getState().setSearchQuery('remote'));
  await wait(250);
  assert.ok(document.querySelector('[data-file-path="remote.txt"]'));
  holdSearch = true;
  await act(async () => useFileStore.setState((state) => ({ workspaceFileVersion: state.workspaceFileVersion + 1 })));
  await wait(250);
  assert.ok(completeSearch);
  assert.ok(document.querySelector('[data-file-path="remote.txt"]'), 'previous server search results remain during refresh');
  await act(async () => completeSearch!(Response.json({ success: true, files: [file('remote-new.txt')], total: 1 })));
  assert.ok(document.querySelector('[data-file-path="remote-new.txt"]'));
  const explorer = document.querySelector<HTMLElement>('[data-file-scroll-container]')!;
  await act(async () => {
    explorer.focus();
    explorer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  });
  assert.deepEqual([...useFileStore.getState().multiSelectPaths], ['remote-new.txt'], 'Ctrl+A selects visible search results only');
  await act(async () => {
    useFileStore.getState().clearMultiSelect();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    input.remove();
  });
  assert.equal(useFileStore.getState().multiSelectPaths.size, 0, 'Ctrl+A in an input preserves text selection');

  const surface = document.createElement('div');
  const row = document.createElement('div'); row.dataset.filePath = 'anchor'; surface.appendChild(row);
  let top = 20;
  surface.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 } as DOMRect);
  row.getBoundingClientRect = () => ({ top, bottom: top + 20, height: 20 } as DOMRect);
  const anchor = captureExplorerAnchor(surface)!;
  top = 60;
  restoreExplorerAnchor(surface, anchor);
  assert.equal(surface.scrollTop, 40, 'inserting rows above the anchor preserves its original viewport offset');
  await act(async () => root.unmount()); dom.window.close();
  console.log('notebook-upload-view-test: ok');
}
main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
