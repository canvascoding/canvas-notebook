import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { CurrentFile, FileNode, OpenWorkspaceFileResult } from '../app/lib/files/types';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { readNotebookDocumentTabs, writeNotebookDocumentTabs } from '../app/lib/notebook/document-tabs';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import { WORKSPACE_CHANGED_EVENT } from '../app/store/workspace-store';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?path=folder%2Fa.md&workspaceId=workspace#section', pretendToBeVisual: true,
});
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
    if (request === 'next/navigation') return { useSearchParams: () => new URLSearchParams(window.location.search) };
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
  let rootMounted = true;
  let cleanupScenario: (() => Promise<void>) | null = null;
  const tabs = () => readNotebookDocumentTabs(window.localStorage, 'workspace');
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const select = async (index: number) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="notebook-document-${index}"]`)!;
    assert(button, `tab ${index} exists`);
    await act(async () => button.click()); await settle();
  };
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace', initialized: true });
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
    assert.equal(new URL(window.location.href).searchParams.get('path'), 'renamed/a.md',
      'reload must follow the known document instead of reopening a reused old path');
    assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace');
    assert.equal(window.location.hash, '#section');
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
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'a pending read keeps the document skeleton visible');
    assert.equal(document.querySelector('[data-editor-path="renamed/a.md"]'), null, 'a new document never shows the previous editor behind its skeleton');
    const bButton = document.querySelector<HTMLButtonElement>('[data-testid="notebook-document-1"]')!;
    await act(async () => bButton.parentElement!.querySelectorAll<HTMLButtonElement>('button')[1].click());
    assert.equal(tabs().openPaths.includes('renamed/b.md'), false);
    assert.equal(useFileStore.getState().isLoadingFile, false, 'closing a pending tab immediately settles its file load');
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null);
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
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'identity lookup displays the same document skeleton before the read starts');
    assert.equal(document.querySelector('[data-editor-path="renamed/a.md"]'), null, 'identity lookup hides the previous document');
    await select(0);
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null, 'a newer selection settles the old lookup skeleton');
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
    rootMounted = false;
    assert.equal(watcher.owners, 0);
    await act(async () => lateRead(Response.json({ success: true, data: file('renamed/b.md', 'doc-b') })));
    assert.equal(useFileStore.getState().currentFile, beforeUnmount, 'unmount revokes a file read that already passed location lookup');
    const searchesAfterUnmount = searches.length;
    const fileRequestsAfterUnmount = useFileStore.getState().fileLoadRequestId;
    await act(async () => oldClick());
    assert.equal(searches.length, searchesAfterUnmount);
    assert.equal(useFileStore.getState().fileLoadRequestId, fileRequestsAfterUnmount, 'an old detached tab callback cannot start another open');
    console.log('Actual DashboardShell preserves collaborative tabs across unlink/rename, resolves inactive identity, rejects reused-path reads and revokes stale selection under StrictMode.');

    // A route/restore request is identity-bound. If the old document was deleted,
    // a same-path replacement must not be opened implicitly; the file-browser
    // selection is the explicit user intent that may open the replacement.
    const scenarioContainer = document.createElement('div');
    document.body.appendChild(scenarioContainer);
    const scenarioRoot = createRoot(scenarioContainer);
    cleanupScenario = async () => {
      await act(async () => scenarioRoot.unmount());
      scenarioContainer.remove();
      cleanupScenario = null;
    };
    const mountScenario = async (key: string, url: string) => {
      window.history.replaceState(null, '', url);
      act(() => scenarioRoot.render(<StrictMode key={key}><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <DashboardShell hintEnabled={false} />
      </NextIntlClientProvider></StrictMode>));
      await settle(); await settle();
    };
    const resetScenario = () => {
      errors.length = 0;
      searches.length = 0;
      holdLocation = null;
      holdRead = null;
      files.clear();
      files.set('folder/a.md', file('folder/a.md', 'doc-replacement'));
      locations.clear();
      locations.set('doc-replacement', 'folder/a.md');
      getNotebookQueryClient().clear();
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace', initialized: true });
      useFileStore.getState().resetWorkspaceView('workspace');
      useFileStore.setState({ currentFile: null, currentFileWorkspaceId: null });
      useEditorStore.getState().clear();
      window.localStorage.clear();
      writeNotebookDocumentTabs(window.localStorage, 'workspace', {
        activePath: 'folder/a.md', openPaths: ['folder/a.md'], documentIds: { 'folder/a.md': 'doc-old' },
      });
    };

    resetScenario();
    await mountScenario('route-old-identity', '/en/notebook?path=folder%2Fa.md&workspaceId=workspace');
    assert.equal(useFileStore.getState().currentFile, null, 'a route bound to an archived identity must not open the replacement');
    assert.equal(tabs().documentIds?.['folder/a.md'], 'doc-old', 'a failed route keeps the original tab identity pinned');
    assert(errors.some(message => /linked document is no longer available/iu.test(message)),
      'a failed route lookup reports that the linked document is unavailable');
    let replacement!: OpenWorkspaceFileResult;
    await act(async () => { replacement = await useFileStore.getState().revealAndLoadFile('folder/a.md', {
      workspaceId: 'workspace', revealInTree: false,
    }); });
    assert.equal(replacement.status, 'opened', 'an explicit file-browser selection opens the replacement');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-replacement');
    assert.equal(tabs().documentIds?.['folder/a.md'], 'doc-replacement', 'the tab adopts the replacement identity only after explicit selection');

    await act(async () => scenarioRoot.render(null));
    resetScenario();
    await mountScenario('restore-old-identity', '/en/notebook?workspaceId=workspace');
    assert.equal(useFileStore.getState().currentFile, null, 'saved-tab restore must not reopen a same-path replacement');
    assert.equal(tabs().documentIds?.['folder/a.md'], 'doc-old', 'a failed restore keeps the original tab identity pinned');
    assert(errors.some(message => /linked document is no longer available/iu.test(message)),
      'a failed saved-tab lookup reports that the linked document is unavailable');
    let restoredReplacement!: OpenWorkspaceFileResult;
    await act(async () => { restoredReplacement = await useFileStore.getState().revealAndLoadFile('folder/a.md', {
      workspaceId: 'workspace', revealInTree: false,
    }); });
    assert.equal(restoredReplacement.status, 'opened');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-replacement');

    await act(async () => scenarioRoot.render(null));
    resetScenario();
    const delayedLocation: Array<(response: Response) => void> = [];
    holdLocation = id => id === 'doc-old' ? new Promise<Response>(resolve => delayedLocation.push(resolve)) : null;
    await mountScenario('delayed-old-identity', '/en/notebook?path=folder%2Fa.md&workspaceId=workspace');
    assert(delayedLocation.length > 0, 'the old identity lookup must actually be in flight');
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'route entry shows the document skeleton throughout location lookup');
    assert.equal(tabs().documentIds?.['folder/a.md'], 'doc-old');
    assert.equal(errors.length, 0);
    let selectedReplacement!: OpenWorkspaceFileResult;
    await act(async () => { selectedReplacement = await useFileStore.getState().revealAndLoadFile('folder/a.md', {
      workspaceId: 'workspace', revealInTree: false,
    }); });
    assert.equal(selectedReplacement.status, 'opened');
    await act(async () => {
      for (const resolve of delayedLocation.splice(0)) resolve(new Response('', { status: 404 }));
    });
    await settle();
    assert.equal(errors.length, 0, 'a superseded old 404 must not show a misleading error after the new selection');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'doc-replacement');
    assert.equal(tabs().documentIds?.['folder/a.md'], 'doc-replacement');

    await act(async () => scenarioRoot.render(null));
    resetScenario();
    const oldWorkspaceLookup: Array<(response: Response) => void> = [];
    holdLocation = id => id === 'doc-old' ? new Promise<Response>(resolve => oldWorkspaceLookup.push(resolve)) : null;
    writeNotebookDocumentTabs(window.localStorage, 'other', { activePath: 'other.md', openPaths: ['other.md'] });
    files.set('other.md', { path: 'other.md', content: 'Other workspace document' });
    await mountScenario('workspace-switch', '/en/notebook?workspaceId=workspace');
    assert(oldWorkspaceLookup.length, 'the old workspace lookup is pending before the switch');
    let finishOtherRead!: (response: Response) => void;
    holdRead = path => path === 'other.md' ? new Promise(resolve => { finishOtherRead = resolve; }) : null;
    await act(async () => {
      window.history.replaceState(null, '', '/en/notebook?workspaceId=other');
      useFileStore.getState().resetWorkspaceView('other');
      useWorkspaceStore.setState({ activeWorkspaceId: 'other' });
      window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { activeWorkspaceId: 'other' } }));
    });
    await settle();
    assert(finishOtherRead, 'the new workspace document starts reading');
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'workspace switch shows the new document skeleton until its read finishes');
    assert.match(document.querySelector('[data-testid="file-loading-skeleton"]')?.textContent ?? '', /other\.md/);
    await act(async () => { for (const resolve of oldWorkspaceLookup.splice(0)) resolve(new Response('', { status: 404 })); });
    assert.equal(useFileStore.getState().currentFile, null, 'the old workspace lookup cannot restore its document after the switch');
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'the new workspace skeleton survives an old lookup response');
    await act(async () => finishOtherRead(Response.json({ success: true, data: { path: 'other.md', content: 'Other workspace document' } })));
    await settle();
    assert.equal(useFileStore.getState().currentFile?.path, 'other.md');
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null, 'the new workspace skeleton settles when its document is ready');

    await act(async () => scenarioRoot.render(null));
    resetScenario();
    useWorkspaceStore.setState({ activeWorkspaceId: 'other' });
    useFileStore.getState().resetWorkspaceView('other');
    files.set('folder/linked.md', { path: 'folder/linked.md', content: 'Linked document after workspace switch' });
    await mountScenario('cross-workspace-route', '/en/notebook?path=folder%2Flinked.md&workspaceId=workspace');
    let finishLinkedRead!: (response: Response) => void;
    holdRead = path => path === 'folder/linked.md' ? new Promise(resolve => { finishLinkedRead = resolve; }) : null;
    await act(async () => {
      useFileStore.getState().resetWorkspaceView('workspace');
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { activeWorkspaceId: 'workspace' } }));
    });
    await settle();
    assert(finishLinkedRead, 'a document deep link must start reading after its workspace becomes active');
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'cross-workspace links show the loader only while the read is pending');
    await act(async () => finishLinkedRead(Response.json({ success: true, data: files.get('folder/linked.md') })));
    await settle();
    assert.equal(useFileStore.getState().currentFile?.path, 'folder/linked.md');
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null, 'cross-workspace document links settle after loading');

    files.set('folder/linked.md', { path: 'folder/linked.md', content: 'Same path in another workspace' });
    await act(async () => {
      window.history.replaceState(null, '', '/en/notebook?path=folder%2Flinked.md&workspaceId=other');
      useFileStore.getState().resetWorkspaceView('other');
      useWorkspaceStore.setState({ activeWorkspaceId: 'other' });
      window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { activeWorkspaceId: 'other' } }));
    });
    await settle();
    assert.equal(useFileStore.getState().isLoadingFile, true, 'an existing notebook must reopen the same path in the new workspace');
    await act(async () => finishLinkedRead(Response.json({ success: true, data: files.get('folder/linked.md') })));
    await settle();
    assert.equal(useFileStore.getState().currentFileWorkspaceId, 'other');
    assert.equal(useFileStore.getState().currentFile?.content, 'Same path in another workspace');
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null);

    await act(async () => scenarioRoot.render(null));
    resetScenario();
    useWorkspaceStore.setState({ initialized: false });
    files.set('folder/linked.md', { path: 'folder/linked.md', content: 'Linked document after hydration' });
    let finishHydratedRead!: (response: Response) => void;
    holdRead = path => path === 'folder/linked.md' ? new Promise(resolve => { finishHydratedRead = resolve; }) : null;
    await mountScenario('delayed-workspace-hydration', '/en/notebook?path=folder%2Flinked.md&workspaceId=workspace');
    assert.equal(finishHydratedRead, undefined, 'route loading waits for workspace initialization');
    await act(async () => useWorkspaceStore.setState({ initialized: true }));
    await settle();
    assert(finishHydratedRead, 'workspace initialization must release the pending document route');
    await act(async () => finishHydratedRead(Response.json({ success: true, data: files.get('folder/linked.md') })));
    await settle();
    assert.equal(useFileStore.getState().currentFile?.content, 'Linked document after hydration');
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null);
    await cleanupScenario();
    assert.equal(watcher.owners, 0, 'scenario teardown releases every watcher subscription');
    console.log('Unavailable route/restore identities report failure without opening replacements; explicit selection rebinds safely and supersedes delayed 404 feedback.');
  } finally {
    if (cleanupScenario) await cleanupScenario();
    if (rootMounted) await act(async () => root.unmount());
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null }); dom.window.close();
    // The extra entry scenarios mount query-backed panels. Release their GC
    // timers just like their subscriptions, without forcing the process to exit.
    getNotebookQueryClient().clear();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
