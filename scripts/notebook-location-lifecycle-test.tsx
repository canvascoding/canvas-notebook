import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { CurrentFile, FileNode } from '../app/lib/files/types';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { readNotebookDocumentTabs, writeNotebookDocumentTabs } from '../app/lib/notebook/document-tabs';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'HTMLInputElement',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 1440 });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.scrollBy = () => {};

class Watcher extends dom.window.EventTarget {
  owners = 0;
  isConnected = true;
  acquire() { this.owners++; }
  releaseConnection() { this.owners--; }
  file(type: string, relativePath: string) {
    this.dispatchEvent(new dom.window.CustomEvent('filechange', { detail: { workspaceId: 'workspace', type, relativePath, dir: '.' } }));
  }
}

function file(path: string, id: string): CurrentFile {
  return { path, content: `Content of ${id}`, collaboration: {
    path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
}

async function main() {
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useEditorStore } = await import('../app/store/editor-store');
  const watcher = new Watcher();
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalFetch = globalThis.fetch;
  const noop = () => {};
  const files = new Map([['folder/a.md', file('folder/a.md', 'doc-a')], ['folder/b.md', file('folder/b.md', 'doc-b')]]);
  const locations = new Map([['doc-a', 'folder/a.md'], ['doc-b', 'folder/b.md']]);
  const errors: string[] = [];
  const searches: string[] = [];
  let holdLocation: ((documentId: string) => Promise<Response> | null) | null = null;
  let holdRead: ((path: string) => Promise<Response> | null) | null = null;
  let useLocation!: typeof import('../app/lib/collaboration/document-location-client').useCollaborationDocumentLocation;
  function EditorStandIn() {
    const current = useFileStore(state => state.currentFile);
    useEffect(() => {
      if (!current) return;
      useEditorStore.getState().setActiveFile(current.path, current.content);
      return registerDocumentTransitionGuard('workspace', current.path, { prepare: async () => {}, hasPendingChanges: () => false });
    }, [current]);
    useLocation({ workspaceId: 'workspace', documentId: current?.collaboration?.document?.id ?? null,
      documentKey: current?.editorIdentity, path: current?.path ?? null, lifecycleGeneration: 1, representation: 'tiptap_blocks', connection: 'live' });
    return <div data-editor-path={current?.path}>{current?.content}</div>;
  }
  const emptyComponents: Record<string, string[]> = {
    '@/app/components/navigation/AppBackButton': ['AppBackButton'], '@/app/apps/email/components/EmailClient': ['EmailClient'],
    '@/app/components/AppLauncher': ['AppLauncher'], '@/app/components/browser-lab/BrowserLabClient': ['BrowserLabClient'],
    '@/app/components/canvas-agent-chat/CanvasAgentChat': ['default'], '@/app/components/file-browser/FileBrowser': ['FileBrowser'],
    '@/app/components/notifications/NotificationBell': ['NotificationBell'], '@/app/components/terminal/Terminal': ['TerminalPanel'],
  };
  internals._load = (request, parent, isMain) => {
    if (request === 'next/navigation') return { useSearchParams: () => new URLSearchParams() };
    if (request === '@/app/lib/file-watcher/client') return { getFileWatcherClient: () => watcher };
    if (request === '@/app/components/editor/FileEditor') return { FileEditor: EditorStandIn };
    if (request === '@/app/components/layout/AppLayout') return { AppLayout: ({ main }: { main: React.ReactNode }) => <>{main}</> };
    if (request === '@/app/components/onboarding/HintProvider') return { HintProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> };
    if (request === '@/app/components/terminal/TerminalAvailabilityProvider') return { useTerminalAvailability: () => ({ ready: true, terminalEnabled: false }) };
    if (request === '@/app/components/workspaces/WorkspaceSwitcher') return { WorkspaceSwitcher: () => null, useShouldShowWorkspaceSwitcher: () => false };
    if (request === '@/app/apps/email/context/email-chat-context') return { useEmailChatContext: () => ({ chatContext: null }) };
    if (request === '@/app/components/notebook/useNotebookToolContext') return { useNotebookToolContext: () => ({ emailContext: null, browserContext: null, clearEmail: noop, clearBrowser: noop, openBrowser: noop }) };
    if (request === '@/app/components/canvas-agent-chat/useForcedChatSession') return { useForcedChatSession: () => ({ forceSession: noop, forcedSessionId: null, requestId: 0 }) };
    if (request === 'sonner') return { toast: { error: (message: string) => errors.push(message), success: noop } };
    if (emptyComponents[request]) return { __esModule: true, ...Object.fromEntries(emptyComponents[request].map(name => [name, () => null])) };
    return originalLoad(request, parent, isMain);
  };
  const locationResponse = (id: string) => locations.has(id) ? Response.json({ success: true, workspaceId: 'workspace', documentId: id,
    path: locations.get(id), lifecycleGeneration: 1, representation: 'tiptap_blocks' }) : new Response('', { status: 404 });
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/collaboration/location') {
      const id = url.searchParams.get('documentId')!; searches.push(id);
      return holdLocation?.(id) ?? locationResponse(id);
    }
    if (url.pathname === '/api/files/read') {
      const path = url.searchParams.get('path')!;
      const held = holdRead?.(path); if (held) return held;
      const data = files.get(path);
      return data ? Response.json({ success: true, data }) : new Response('', { status: 404 });
    }
    if (url.pathname === '/api/files/tree') {
      const nodes: FileNode[] = [];
      for (const [path] of files) {
        const [folder, name] = path.split('/');
        let node = nodes.find(node => node.path === folder);
        if (!node) { node = { path: folder, name: folder, type: 'directory', children: [] }; nodes.push(node); }
        node.children!.push({ path, name, type: 'file' });
      }
      const path = url.searchParams.get('path');
      return Response.json({ success: true, data: path === '.' ? nodes : nodes.find(node => node.path === path)?.children ?? [] });
    }
    return Response.json({ success: true, data: [] });
  };
  const root = createRoot(document.getElementById('root')!);
  const tabs = () => readNotebookDocumentTabs(window.localStorage, 'workspace');
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const select = async (index: number) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="notebook-document-${index}"]`)!;
    assert(button, `tab ${index} exists`);
    await act(async () => button.click()); await settle();
  };
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
    useFileStore.getState().resetWorkspaceView('workspace');
    writeNotebookDocumentTabs(window.localStorage, 'workspace', { activePath: 'folder/a.md', openPaths: ['folder/a.md', 'folder/b.md'],
      documentIds: { 'folder/a.md': 'doc-a', 'folder/b.md': 'doc-b' } });
    ({ useCollaborationDocumentLocation: useLocation } = await import('../app/lib/collaboration/document-location-client'));
    const { DashboardShell } = await import('../app/components/DashboardShell');
    await act(async () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <DashboardShell hintEnabled={false} />
    </NextIntlClientProvider></StrictMode>));
    await settle(); await settle();
    assert.equal(useFileStore.getState().currentFile?.path, 'folder/a.md');
    assert.equal(tabs().documentIds?.['folder/b.md'], 'doc-b');
    assert.equal(watcher.owners, 3, 'provider, active location hook and inactive-tab watcher each own one connection under StrictMode');

    const activeIdentity = useFileStore.getState().currentFile?.editorIdentity;
    locations.set('doc-a', 'renamed/a.md'); files.delete('folder/a.md'); files.set('renamed/a.md', file('renamed/a.md', 'doc-a'));
    locations.set('doc-b', 'renamed/b.md'); files.delete('folder/b.md'); files.set('renamed/b.md', file('renamed/b.md', 'doc-b'));
    await act(async () => watcher.file('unlinkDir', 'folder'));
    assert(tabs().openPaths.includes('folder/a.md'), 'raw unlink never closes the active collaborative tab');
    assert(tabs().openPaths.some(path => path.endsWith('/b.md')), 'raw unlink never closes the inactive collaborative tab');
    // The first mount already looked up B; its next request observes the one-second rate bound.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1050)); });
    assert.deepEqual(tabs().openPaths, ['renamed/a.md', 'renamed/b.md']);
    assert.equal(useFileStore.getState().currentFile?.path, 'renamed/a.md');
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, activeIdentity, 'active rename preserves its open editor identity');
    // Explorer updates are deliberately batched after location adoption.
    const treeDeadline = Date.now() + 2000;
    while (!useFileStore.getState().fileTree.some(node => node.path === 'renamed') && Date.now() < treeDeadline) await settle();
    assert(useFileStore.getState().fileTree.some(node => node.path === 'renamed'), 'the explorer store refreshes the confirmed directory');
    assert.equal(useFileStore.getState().fileTree.some(node => node.path === 'folder'), false);
    await select(1);
    assert.equal(useFileStore.getState().currentFile?.path, 'renamed/b.md');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-b');

    await select(0);
    files.set('renamed/b.md', file('renamed/b.md', 'impostor'));
    await select(1);
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-a', 'the store rejects replacement content after location lookup');
    assert(errors.some(message => message.includes('document at this path changed')));
    files.set('renamed/b.md', file('renamed/b.md', 'doc-b'));

    let lateRead!: (response: Response) => void;
    holdRead = path => path === 'renamed/b.md' ? new Promise(resolve => { lateRead = resolve; }) : null;
    await select(1); assert(lateRead, 'the location resolved and the file body is still pending');
    const bButton = document.querySelector<HTMLButtonElement>('[data-testid="notebook-document-1"]')!;
    await act(async () => bButton.parentElement!.querySelectorAll<HTMLButtonElement>('button')[1].click());
    assert.equal(tabs().openPaths.includes('renamed/b.md'), false);
    await act(async () => lateRead(Response.json({ success: true, data: file('renamed/b.md', 'doc-b') })));
    assert.equal(tabs().openPaths.includes('renamed/b.md'), false, 'the later file read cannot reopen a closed tab');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-a');
    assert.equal(useFileStore.getState().isLoadingFile, false);
    holdRead = null;
    await act(async () => { await useFileStore.getState().revealAndLoadFile('renamed/b.md', { revealInTree: false, expectedDocumentId: 'doc-b' }); });
    await select(0);

    const pending: ((response: Response) => void)[] = [];
    holdLocation = id => id === 'doc-b' ? new Promise(resolve => pending.push(resolve)) : null;
    const before = searches.length;
    await select(1);
    assert(searches.length > before && pending.length);
    await select(0);
    await act(async () => { for (const resolve of pending.splice(0)) resolve(locationResponse('doc-b')); });
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-a', 'a newer selection revokes a delayed open');
    holdLocation = null;
    holdRead = path => path === 'renamed/b.md' ? new Promise(resolve => { lateRead = resolve; }) : null;
    await select(1);
    const beforeUnmount = useFileStore.getState().currentFile;
    const oldButton = document.querySelector<HTMLButtonElement>('[data-testid="notebook-document-1"]')!;
    const propsKey = Object.keys(oldButton).find(key => key.startsWith('__reactProps'))!;
    assert(propsKey);
    const oldClick = (oldButton as unknown as Record<string, { onClick: () => void }>)[propsKey].onClick;
    await act(async () => root.unmount());
    assert.equal(watcher.owners, 0);
    await act(async () => lateRead(Response.json({ success: true, data: file('renamed/b.md', 'doc-b') })));
    assert.equal(useFileStore.getState().currentFile, beforeUnmount, 'unmount revokes a file read that already passed location lookup');
    const searchesAfterUnmount = searches.length;
    const fileRequestsAfterUnmount = useFileStore.getState().fileLoadRequestId;
    await act(async () => oldClick());
    assert.equal(searches.length, searchesAfterUnmount);
    assert.equal(useFileStore.getState().fileLoadRequestId, fileRequestsAfterUnmount, 'an old detached tab callback cannot start another open');
    console.log('Actual DashboardShell preserves collaborative tabs across unlink/rename, resolves inactive identity, rejects reused-path reads and revokes stale selection under StrictMode.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null }); dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
