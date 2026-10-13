import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import type { CurrentFile } from '../app/lib/files/types';
import messages from '../messages/en.json';

const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://canvas.test/en/files', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Window', 'Document', 'Element', 'HTMLElement', 'Node', 'NodeFilter', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'CustomEvent', 'Event', 'EventTarget', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true, WebSocket: class { static OPEN = 1; readyState = 0; close() {} send() {} } });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

function file(path: string, id = `doc-${path}`): CurrentFile {
  return { path, content: `Native ${path}`, stats: { modified: 1, size: 20 }, collaboration: {
    path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false, requiresRevisionCheck: false,
    latestRevision: null, activeLock: null, document: { id, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
}
const busy = () => Response.json({ success: false, error: 'Temporary native read contention.', code: 'ROOM_OWNER_BUSY' }, { status: 503 });
const success = (path: string, id?: string) => Response.json({ success: true, data: file(path, id) });

async function main() {
  const { createRoot } = await import('react-dom/client');
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useEditorStore } = await import('../app/store/editor-store');
  const { getNotebookQueryClient } = await import('../app/lib/queries/client');
  const { observeOpenedDocumentAuth } = await import('../app/lib/collaboration/opened-document-registry');
  observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'auth' } } });
  const client = getNotebookQueryClient(); client.setQueryDefaults(['notebook'], { gcTime: 0 });
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load, originalFetch = globalThis.fetch;
  const watcher = new class extends dom.window.EventTarget { isConnected = true; acquire() {} releaseConnection() {} }();
  const noop = () => {};
  const errors: string[] = [], results: Array<{ path: string; status: string }> = [];
  const requests: Array<{ path: string; workspace: string | null }> = [];
  let respond: (path: string, count: number) => Response | Promise<Response> = path => success(path);
  const counts = new Map<string, number>();
  const empty: Record<string, string[]> = {
    '@/app/components/navigation/AppBackButton': ['AppBackButton'], '@/app/components/AppLauncher': ['AppLauncher'],
    '@/app/components/notifications/NotificationBell': ['NotificationBell'], './CreateItemDialog': ['CreateItemDialog'],
    './UploadDialog': ['UploadDialog'], './DeleteConfirmDialog': ['DeleteConfirmDialog'], './PublicShareDialog': ['PublicShareDialog'],
    '@/app/components/shared/ImagePreprocessDialog': ['ImagePreprocessDialog'],
  };
  internals._load = (request, parent, isMain) => {
    if (request === 'next/navigation') return { useSearchParams: () => new URLSearchParams(window.location.search) };
    if (request === '@/i18n/navigation') return { useRouter: () => ({ push: noop, replace: noop }) };
    if (request === '@/app/components/workspaces/WorkspaceSwitcher') return { WorkspaceSwitcher: () => null, useShouldShowWorkspaceSwitcher: () => false };
    if (request === '@/app/lib/file-watcher/client') return { getFileWatcherClient: () => watcher };
    // The real preview dialog stays mounted. This stand-in proves loader/path
    // publication only; it makes no Tiptap, Yjs editing, undo or browser claim.
    if (request === '@/app/components/editor/FileEditor') return { FileEditor: () => {
      const current = useFileStore(state => state.currentFile);
      return current ? <div data-testid="loaded-preview">{current.path}</div> : null;
    } };
    if (request === 'sonner') return { toast: { error: (message: string) => errors.push(message), success: noop, info: noop } };
    if (empty[request]) return { __esModule: true, ...Object.fromEntries(empty[request].map(name => [name, () => null])) };
    return originalLoad(request, parent, isMain);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/read') {
      const path = url.searchParams.get('path')!;
      requests.push({ path, workspace: new Headers(init?.headers).get('x-canvas-workspace-id') });
      const count = (counts.get(path) ?? 0) + 1; counts.set(path, count);
      return respond(path, count);
    }
    if (url.pathname === '/api/files/tree') return Response.json({ success: true, data: [...counts.keys()].map(path => ({ path, name: path, type: 'file' })) });
    return Response.json({ success: true, data: [] });
  };
  const originalReveal = useFileStore.getState().revealAndLoadFile;
  useFileStore.setState({ revealAndLoadFile: async (...args: Parameters<typeof originalReveal>) => {
    const result = await originalReveal(...args); results.push({ path: args[0], status: result.status }); return result;
  } });
  const root = createRoot(document.getElementById('root')!);
  const { FileBrowser } = await import('../app/components/file-browser/FileBrowser');
  const render = async (path: string, workspace = 'workspace') => {
    window.history.replaceState(null, '', `/en/files?path=${path}&workspaceId=${workspace}`);
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><FileBrowser variant="fullscreen" /></NextIntlClientProvider>));
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert(predicate(), 'actual loader/UI must settle within its finite retry budget');
  };
  const reset = async () => {
    await act(async () => root.render(null)); client.clear(); errors.length = 0; results.length = 0; requests.length = 0; counts.clear();
    window.localStorage.clear(); useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace', initialized: true });
  };
  const preview = () => document.querySelector('[data-testid="loaded-preview"]')?.textContent ?? null;
  try {
    await reset(); respond = (path, count) => count === 1 ? busy() : success(path);
    await render('recovery.md'); await wait(() => preview() === 'recovery.md');
    assert.equal(counts.get('recovery.md'), 2); assert.deepEqual(errors, []); assert.equal(results.at(-1)?.status, 'opened');

    await reset(); respond = () => busy(); await render('exhausted.md');
    await wait(() => results.some(result => result.status === 'failed'));
    assert.equal(counts.get('exhausted.md'), 4); assert.equal(preview(), null); assert.equal(useFileStore.getState().currentFile, null);
    assert.deepEqual(errors, ['Temporary native read contention.']);

    for (const otherWorkspace of [false, true]) {
      await reset(); respond = (path, count) => path === 'old.md' && count === 1 ? busy() : success(path);
      await render('old.md'); await wait(() => counts.get('old.md') === 1);
      const nextWorkspace = otherWorkspace ? 'other-workspace' : 'workspace';
      await act(async () => { if (otherWorkspace) useWorkspaceStore.setState({ activeWorkspaceId: nextWorkspace }); });
      await render('new.md', nextWorkspace); await wait(() => preview() === 'new.md');
      await wait(() => results.some(result => result.path === 'old.md' && result.status === 'superseded'));
      assert.equal(useFileStore.getState().currentFileWorkspaceId, nextWorkspace);
      assert.equal(useFileStore.getState().currentFile?.path, 'new.md'); assert.deepEqual(errors, []);
      assert(requests.filter(request => request.path === 'old.md').every(request => request.workspace === 'workspace'), 'retries never retarget the old request into a new workspace');
    }

    await reset(); respond = path => success(path, 'original'); await render('identity.md'); await wait(() => preview() === 'identity.md');
    const original = useFileStore.getState().currentFile!; useEditorStore.getState().setActiveFile(original.path, original.content);
    counts.clear(); respond = (path, count) => count === 1 ? busy() : success(path, 'replacement');
    let identityResult!: Awaited<ReturnType<ReturnType<typeof useFileStore.getState>['loadFile']>>;
    await act(async () => { identityResult = await useFileStore.getState().loadFile('identity.md', true, 'workspace', 'original'); });
    assert.equal(identityResult.status, 'failed'); assert.equal(useFileStore.getState().currentFile, original);
    assert.equal(preview(), 'identity.md'); assert.equal(useEditorStore.getState().draft, original.content);
    console.log('PASS actual FileBrowser/explorer/stores/shared query: Busy recovery, exhaustion, path/workspace supersession and expected native identity rejection');
  } finally {
    await act(async () => root.unmount()); useFileStore.setState({ revealAndLoadFile: originalReveal });
    client.clear(); internals._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
