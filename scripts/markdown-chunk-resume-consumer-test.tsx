import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { act, useSyncExternalStore } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import messages from '../messages/en.json';
import { invalidateOpenedDocumentAuth, observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import type { WorkspaceUploadCompletion } from '../app/lib/files/upload-result';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

const requireHere = createRequire(import.meta.url);
const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
  'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
type AuthState = { data: { user: { id: string }; session: { id: string } } | null; isPending: boolean; error: null };
let authState: AuthState = { data: null, isPending: true, error: null };
const authListeners = new Set<() => void>(), atomListeners = new Set<(value: AuthState) => void>();
const authClient = {
  useSession: () => useSyncExternalStore(listener => { authListeners.add(listener); return () => { authListeners.delete(listener); }; }, () => authState, () => authState),
  $store: { atoms: { session: { get: () => authState, listen: (listener: (value: AuthState) => void) => {
    atomListeners.add(listener); return () => { atomListeners.delete(listener); };
  } } }, notify: () => invalidateOpenedDocumentAuth() },
};
function setAuth(userId: string | null, sessionId = 'fixture-session') {
  authState = { data: userId ? { user: { id: userId }, session: { id: sessionId } } : null, isPending: false, error: null };
  observeOpenedDocumentAuth(authState);
  for (const listener of atomListeners) listener(authState);
  for (const listener of authListeners) listener();
}
const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = internals._load;
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/auth-client' || /\/app\/lib\/auth-client(?:\.ts)?$/u.test(request)) return { authClient };
  return originalLoad(request, parent, isMain);
};
class UploadRequest {
  static sends = 0;
  status = 200; statusText = ''; responseText = '{"success":true}'; withCredentials = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null; onerror = null; onabort = null;
  open() {}
  setRequestHeader() {}
  send() { UploadRequest.sends++; queueMicrotask(() => this.onload?.()); }
}
const uploadId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const targetPath = 'docs/import.md';
const locator = { workspaceId: 'ws-a', uploadId, fileId, targetPath };
const storageKey = 'canvas-markdown-upload-resumes:v1:alice';
const calls: Array<{ url: string; method: string; workspace: string | null; body: unknown }> = [];
let completionResponse: () => Promise<Response> = async () => { throw new Error('Missing fixture'); };
const completion = (status: WorkspaceUploadCompletion['status']): WorkspaceUploadCompletion => ({
  status, uploadId, fileId, targetPath, ...(status === 'completed' ? {} : { code: {
    projection_pending: 'MARKDOWN_UPLOAD_PROJECTION_PENDING', recovery_required: 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED',
    unavailable: 'MARKDOWN_UPLOAD_NATIVE_UNAVAILABLE',
  }[status] as WorkspaceUploadCompletion['code'] }),
});
const pendingResponse = (status: Exclude<WorkspaceUploadCompletion['status'], 'completed'> = 'projection_pending') =>
  Response.json({ success: true, completion: completion(status) }, { status: 202 });

async function main() {
  const originalFetch = globalThis.fetch, originalXhr = globalThis.XMLHttpRequest;
  let homeVersion = 0, failTree = false;
  globalThis.XMLHttpRequest = UploadRequest as unknown as typeof XMLHttpRequest;
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ url, method, workspace: new Headers(init?.headers).get('x-canvas-workspace-id'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/files/uploads' && method === 'POST') return Response.json({ success: true,
      upload: { id: uploadId, files: [{ id: fileId, sourceIndex: 0, targetPath, relativePath: 'import.md', size: 4, uploadedBytes: 0, status: 'pending' }] } }, { status: 201 });
    if (url.endsWith('/complete') && method === 'POST') return completionResponse();
    if (method === 'DELETE') return Response.json({ success: true });
    if (url.startsWith('/api/files/quick-access?')) return Response.json({ success: true, data: {
      files: homeVersion ? [{ path: targetPath, name: 'import.md', title: `Confirmed Home import ${homeVersion}`, openedAt: 1700000000000, isFavorite: false }] : [],
      total: homeVersion ? 1 : 0, workspaceFileCount: homeVersion ? 1 : 0,
    } });
    if (url.startsWith('/api/home/chats?')) return Response.json({ success: true, data: { chats: [], hasMore: false } });
    if (failTree && url.startsWith('/api/files/tree?')) return Response.json({ success: false, error: 'Own fixture tree read unavailable.' }, { status: 503 });
    if (method === 'GET') return Response.json({ success: true, data: [] });
    throw new Error(`Unexpected fixture request: ${method} ${url}`);
  };
  let root: ReturnType<typeof import('react-dom/client').createRoot> | undefined;
  try {
    const client = await import('../app/lib/files/workspace-upload-client');
    const store = await import('../app/store/upload-store');
    const { subscribeMarkdownUploadCompletion, useFileStore } = await import('../app/store/file-store');
    const nextConfirmedNotice = () => new Promise<void>(resolve => {
      const stop = subscribeMarkdownUploadCompletion(() => { stop(); resolve(); });
    });
    const { useWorkspaceStore } = await import('../app/store/workspace-store');
    const { WorkspaceUploadProgress } = await import('../app/components/file-browser/WorkspaceUploadProgress');
    const { createRoot } = await import('react-dom/client');
    setAuth('alice');
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
    useFileStore.getState().resetWorkspaceView('ws-a');
    useFileStore.setState({ fileTreeWorkspaceId: 'ws-a', fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [] }] });
    const file = new File(['body'], 'import.md', { type: 'text/markdown' });
    let callbacks = 0;
    async function expectRetained(response: () => Promise<Response>, expectedStatus: string) {
      calls.length = 0; completionResponse = response;
      await assert.rejects(client.uploadWorkspaceFilesInChunks({ files: [{ file, path: file.name }], targetDir: 'docs', workspaceId: 'ws-a',
        onFileCompleted: () => { callbacks++; } }), (error: unknown) => {
        assert(error instanceof client.WorkspaceMarkdownUploadPendingError);
        assert.equal(error.result.completed.length, 0); assert.equal(error.result.failed.length, 0);
        assert.equal(error.result.pending?.[0].resume.status, expectedStatus); return true;
      });
      assert.equal(callbacks, 0); assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
    }
    for (const status of ['projection_pending', 'recovery_required', 'unavailable'] as const) {
      await expectRetained(async () => pendingResponse(status), status);
    }
    for (const body of [{ success: true }, { success: true, completion: { ...completion('completed'), fileId: 'foreign' } },
      { success: true, completion: { ...completion('completed'), targetPath: 'foreign.md' } }]) {
      await expectRetained(async () => Response.json(body), 'unconfirmed');
    }
    await expectRetained(async () => Response.json({ success: true, completion: completion('completed') }, { status: 202 }), 'unconfirmed');
    await expectRetained(async () => { throw new TypeError('Lost response after submission'); }, 'unconfirmed');
    let releaseStale!: (response: Response) => void;
    completionResponse = () => new Promise(resolve => { releaseStale = resolve; });
    calls.length = 0;
    const stale = client.uploadWorkspaceFilesInChunks({ files: [{ file, path: file.name }], targetDir: 'docs', workspaceId: 'ws-a',
      onFileCompleted: () => { callbacks++; } });
    const staleResult = assert.rejects(stale, client.WorkspaceMarkdownUploadPendingError);
    while (!releaseStale) await new Promise(resolve => setTimeout(resolve, 0));
    setAuth('bob', 'bob-race');
    releaseStale(Response.json({ success: true, completion: completion('completed') }));
    await staleResult;
    assert.equal(callbacks, 0); assert.equal(calls.filter(call => call.method === 'DELETE').length, 0,
      'A stale-account completion response never publishes a callback or deletes its source.');
    setAuth('alice', 'alice-current');
    completionResponse = async () => pendingResponse(); calls.length = 0;
    const resumed = await client.resumeWorkspaceMarkdownUpload({ ...locator, status: 'projection_pending' });
    assert.equal(resumed.completion.status, 'projection_pending');
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { fileId });
    assert.equal(calls[0].url, `/api/files/uploads/${uploadId}/complete`);
    assert.equal(calls[0].workspace, 'ws-a');

    // Sanitized server destination differs from the selected source spelling.
    completionResponse = async () => Response.json({ success: true, completion: completion('completed') });
    const normalizedFile = new File(['body'], 'im?port.md');
    const confirmedTargets: string[] = [];
    const confirmed = await client.uploadWorkspaceFilesInChunks({ files: [{ file: normalizedFile, path: normalizedFile.name }],
      targetDir: 'docs', workspaceId: 'ws-a', onFileCompleted: result => confirmedTargets.push(result.targetPath) });
    assert.equal(confirmed.completed.length, 1);
    assert.deepEqual(confirmedTargets, [targetPath], 'Completed without committed uses the confirmed server path, never a reconstructed source name.');

    calls.length = 0; completionResponse = async () => pendingResponse();
    await assert.rejects(useFileStore.getState().uploadFile(file, 'docs', undefined, undefined, { workspaceId: 'ws-a' }), client.WorkspaceMarkdownUploadPendingError);
    const job = Object.values(store.useUploadStore.getState().jobs).find(value => value.items.some(item => item.resume))!;
    assert(job); assert.equal(job.phase, 'awaiting_completion');
    store.finishUploadJob(job, new Error('outer finally'));
    store.updateUploadJob(job, { phase: 'reconciling' }); store.finishUploadJob(job);
    assert.equal(store.useUploadStore.getState().jobs[job.id].phase, 'awaiting_completion');
    const beforeReconcile = calls.length;
    await useFileStore.getState().reconcileUpload(job);
    assert.equal(calls.length, beforeReconcile, 'Pending without a confirmed item does not read/publish a tree.');
    store.beginUploadJob([new File(['other'], 'other.txt')], '.', 'ws-a');
    assert(store.useUploadStore.getState().jobs[job.id], 'An independent upload preserves the pending attempt.');
    const saved = dom.window.localStorage.getItem(storageKey)!;
    assert.deepEqual(Object.keys(JSON.parse(saved).locators[0]).sort(), ['fileId', 'status', 'targetPath', 'uploadId', 'workspaceId']);
    assert.doesNotMatch(saved, /sessionId|token|receipt|fingerprint|stateProof|claimId/u);

    root = createRoot(document.getElementById('root')!);
    calls.length = 0;
    await act(async () => root!.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><WorkspaceUploadProgress /></NextIntlClientProvider>));
    assert.equal(calls.length, 0, 'Hydration/render does not resume automatically.');
    assert.match(document.body.textContent!, /has not been confirmed/);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
    assert.equal(document.querySelector('button'), null);
    await useFileStore.getState().resumeMarkdownUpload(job.id, 0);
    assert.equal(calls.length, 0, 'A workspace change cannot send a resume.');
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' }));
    let release!: (response: Response) => void;
    completionResponse = () => new Promise(resolve => { release = resolve; });
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click(); });
    assert.equal((document.querySelector('button') as HTMLButtonElement).disabled, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].workspace, 'ws-a');
    await act(async () => release(pendingResponse('recovery_required')));
    assert.equal(store.useUploadStore.getState().jobs[job.id].items[0].resume!.status, 'recovery_required');
    assert.equal(calls.length, 1, 'Pending retry has no Create, PUT, DELETE or tree read.');
    completionResponse = async () => Response.json({ success: true, completion: completion('completed'), committed: { targetPath } });
    let confirmedNotice = nextConfirmedNotice();
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click(); });
    await act(async () => confirmedNotice);
    assert.equal(store.useUploadStore.getState().jobs[job.id].items[0].status, 'completed');
    assert.equal(store.useUploadStore.getState().jobs[job.id].items[0].resume, undefined);
    assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!).locators.length, 0);
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
    await act(async () => root!.unmount()); root = undefined;

    // Home itself must hydrate an otherwise empty page, even with its dialog closed.
    setAuth('alice', 'home-reload');
    assert.equal(Object.keys(store.useUploadStore.getState().jobs).length, 0);
    dom.window.localStorage.setItem(storageKey, saved);
    const { HomeFilesPanel } = await import('../app/components/home/HomeFilesPanel');
    const { fireEvent } = await import('@testing-library/react');
    const workspace: ClientWorkspaceSummary = { id: 'ws-a', type: 'personal', name: 'Own Home workspace', color: 'gray' as ClientWorkspaceSummary['color'], status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    useWorkspaceStore.setState({ activeWorkspaceId: workspace.id, workspaces: [workspace], initialized: true });
    const router = { push: () => {}, replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, hmrRefresh: () => {}, bfcacheId: 'own-home' };
    const wrapHome = (homeWorkspace = workspace) => <AppRouterContext.Provider value={router}><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <HomeFilesPanel workspace={homeWorkspace} /></NextIntlClientProvider></AppRouterContext.Provider>;
    const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
    const homeReads = () => calls.filter(call => call.url.startsWith('/api/files/quick-access?'));
    const waitForHomeReads = async (count: number) => {
      for (let attempt = 0; homeReads().length < count && attempt < 100; attempt++) await settle();
    };
    const resumeButton = (container: ParentNode = document) => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === messages.notebook.uploadMarkdownResume)!;
    const click = async (button: HTMLButtonElement) => { assert(button); await act(async () => button.click()); await settle(); };
    const importedPending = async () => {
      completionResponse = async () => pendingResponse();
      await act(async () => {
        await assert.rejects(useFileStore.getState().uploadFile(file, 'docs', undefined, undefined, { workspaceId: workspace.id }), client.WorkspaceMarkdownUploadPendingError);
      });
    };
    const startDelayedResume = async () => {
      let release!: (response: Response) => void;
      completionResponse = () => new Promise(resolve => { release = resolve; });
      await click(resumeButton()); assert(release); return release;
    };
    root = createRoot(document.getElementById('root')!);
    calls.length = 0;
    await act(async () => root!.render(wrapHome())); await settle();
    assert(resumeButton(), 'Closed Home dialog must not prevent storage hydration or expose no resume.');
    assert.equal(calls.filter(call => call.url.endsWith('/complete')).length, 0, 'Home hydration never resumes automatically.');
    assert.equal(homeReads().length, 1);
    const importButton = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${messages.home.start.importFiles}"]`)!;
    await click(importButton());
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === messages.notebook.cancel)!);
    assert(resumeButton(document.getElementById('root')!), 'Closing the dialog leaves Home resume accessible.');
    await click(importButton());
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === messages.notebook.cancel)!);
    assert(resumeButton(), 'Reopening and closing the dialog does not lose the saved attempt.');
    const initialHomeReads = homeReads().length;
    for (const response of [async () => pendingResponse(), async () => pendingResponse('recovery_required'), async () => pendingResponse('unavailable'),
      async () => { throw new TypeError('Lost Home completion'); }, async () => Response.json({ success: true }),
      async () => Response.json({ success: true, completion: { ...completion('completed'), fileId: 'foreign' } })]) {
      completionResponse = response; await click(resumeButton());
      assert.equal(homeReads().length, initialHomeReads, 'Unconfirmed/pending/failed resume must not refresh Home.');
    }
    completionResponse = async () => { homeVersion++; return Response.json({ success: true, completion: completion('completed') }); };
    await click(resumeButton());
    await waitForHomeReads(initialHomeReads + 1);
    assert.equal(homeReads().length, initialHomeReads + 1);
    assert.equal(homeReads().at(-1)!.workspace, workspace.id);
    assert.match(document.body.textContent!, /Confirmed Home import 1/);
    assert.equal(resumeButton(), undefined);

    // The second real Progress instance in UploadDialog must notify Home too.
    await click(importButton());
    const beforeDialogImport = homeReads().length;
    completionResponse = async () => pendingResponse();
    const fileInput = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]')!;
    assert(fileInput);
    await act(async () => { fireEvent.change(fileInput, { target: { files: [file] } }); }); await settle();
    assert.equal(homeReads().length, beforeDialogImport, 'The original pending import does not refresh Home.');
    const dialog = document.querySelector('[role="dialog"]')!;
    assert(resumeButton(dialog)); assert(resumeButton(document.getElementById('root')!));
    completionResponse = async () => { homeVersion++; return Response.json({ success: true, completion: completion('completed') }); };
    await click(resumeButton(dialog));
    await waitForHomeReads(beforeDialogImport + 1);
    assert.equal(homeReads().length, beforeDialogImport + 1, 'Confirmed resume from the dialog refreshes Home exactly once.');
    assert.match(document.body.textContent!, /Confirmed Home import 2/);
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === messages.notebook.cancel)!);

    await importedPending();
    const beforeTreeFailure = homeReads().length;
    failTree = true;
    completionResponse = async () => { homeVersion++; return Response.json({ success: true, completion: completion('completed') }); };
    await click(resumeButton()); await waitForHomeReads(beforeTreeFailure + 1);
    assert.equal(homeReads().length, beforeTreeFailure + 1, 'Confirmed completion still refreshes Home when the independent tree revalidation fails.');
    assert.equal(resumeButton(), undefined); failTree = false;

    await importedPending();
    let releaseHome = await startDelayedResume();
    let beforeStaleHome = homeReads().length;
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' }));
    assert.equal(resumeButton(), undefined, 'Home prop ws-a must not display global-active ws-b jobs.');
    await act(async () => releaseHome(Response.json({ success: true, completion: completion('completed') }))); await settle();
    assert.equal(homeReads().length, beforeStaleHome, 'Workspace-stale completed response does not refresh Home.');
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: workspace.id }));
    await importedPending(); releaseHome = await startDelayedResume();
    await act(async () => root!.render(wrapHome({ ...workspace, id: 'ws-b' }))); await settle();
    beforeStaleHome = homeReads().length;
    assert.equal(resumeButton(), undefined, 'Home prop ws-b must not display global-active ws-a jobs.');
    confirmedNotice = nextConfirmedNotice();
    await act(async () => { releaseHome(Response.json({ success: true, completion: completion('completed') })); await confirmedNotice; }); await settle();
    assert.equal(homeReads().length, beforeStaleHome, 'A changed Home prop cannot receive the old workspace completion hint.');
    await act(async () => root!.render(wrapHome())); await settle();
    for (const [userId, sessionId] of [['alice', 'home-new-session'], ['bob', 'home-foreign-account']]) {
      await importedPending(); releaseHome = await startDelayedResume(); beforeStaleHome = homeReads().length;
      await act(async () => setAuth(userId, sessionId));
      await act(async () => releaseHome(Response.json({ success: true, completion: completion('completed') }))); await settle();
      assert.equal(homeReads().length, beforeStaleHome, 'Changed auth scope/account cannot refresh Home from a stale completion.');
      assert.equal(resumeButton(), undefined);
    }
    await act(async () => setAuth('alice', 'home-unmount'));
    await importedPending(); releaseHome = await startDelayedResume(); beforeStaleHome = homeReads().length;
    confirmedNotice = nextConfirmedNotice();
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => { releaseHome(Response.json({ success: true, completion: completion('completed') })); await confirmedNotice; }); await settle();
    assert.equal(homeReads().length, beforeStaleHome, 'Unmounted Home never refreshes from a later completion.');
    console.log('Home resume: closed/reopened dialog and persisted hydration; both buttons refresh only confirmed current completion; auth/workspace/unmount fences passed.');

    // A fresh module models reload: only public locators are restored, with no requests.
    dom.window.localStorage.setItem(storageKey, saved);
    delete requireHere.cache[requireHere.resolve('../app/store/upload-store')];
    const reloaded = requireHere('../app/store/upload-store') as typeof store;
    calls.length = 0; reloaded.hydrateMarkdownUploadResumes(openedDocumentAuthScope()!);
    assert.equal(Object.values(reloaded.useUploadStore.getState().jobs).length, 1);
    assert.equal(calls.length, 0);
    const foreignKey = 'canvas-markdown-upload-resumes:v1:bob';
    dom.window.localStorage.setItem(foreignKey, saved);
    setAuth('bob', 'bob-session'); reloaded.hydrateMarkdownUploadResumes(openedDocumentAuthScope()!);
    assert.equal(dom.window.localStorage.getItem(storageKey), null, 'Account reset deletes only the previous account storage.');
    assert.equal(dom.window.localStorage.getItem(foreignKey), saved);
    assert.equal(Object.values(reloaded.useUploadStore.getState().jobs).length, 0, 'Foreign-account envelopes do not hydrate.');
    setAuth('alice', 'alice-again');
    for (const bad of ['{bad-json', JSON.stringify({ version: 1, accountId: 'alice', locators: [{ ...locator, status: 'unconfirmed', token: 'forbidden' }] }),
      JSON.stringify({ version: 1, accountId: 'alice', locators: [{ ...locator, targetPath: '../foreign.md', status: 'unconfirmed' }] }),
      JSON.stringify({ version: 1, accountId: 'alice', locators: Array.from({ length: 17 }, () => ({ ...locator, status: 'unconfirmed' })) })]) {
      dom.window.localStorage.setItem(storageKey, bad);
      delete requireHere.cache[requireHere.resolve('../app/store/upload-store')];
      const fresh = requireHere('../app/store/upload-store') as typeof store;
      fresh.hydrateMarkdownUploadResumes(openedDocumentAuthScope()!);
      assert.equal(Object.values(fresh.useUploadStore.getState().jobs).length, 0);
    }
    const stableScope = openedDocumentAuthScope()!;
    const bounded = requireHere('../app/store/upload-store') as typeof store;
    for (let index = 0; index < 18; index++) {
      const next = bounded.beginUploadJob([file], 'docs', 'ws-a');
      bounded.updateUploadItem(next, { index: 0, path: file.name, size: 4, uploadedBytes: 4,
        status: 'awaiting_completion', attempt: 1, resume: { ...locator, fileId: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`, status: 'unconfirmed' } });
      bounded.finishUploadJob(next);
    }
    assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!).locators.length, 16, 'Saved public locators are bounded per account.');
    invalidateOpenedDocumentAuth();
    assert.notEqual(openedDocumentAuthScope(), stableScope);
    assert.equal(dom.window.localStorage.getItem(storageKey), null, 'Same-account scope invalidation also clears recovery locators.');
    assert.equal(Object.values(bounded.useUploadStore.getState().jobs).length, 0);
    assert.equal(calls.length, 0, 'Auth changes and malformed locator hydration never make requests.');
    setAuth(null);
    assert.equal(Object.values(reloaded.useUploadStore.getState().jobs).length, 0);
    console.log('markdown-chunk-resume-consumer-test: ok (real client/store/React resume; Auth/HTTP IO fixtures; no route/PG/browser proof)');
  } finally {
    if (root) await act(async () => root!.unmount());
    (await import('../app/lib/queries/client')).getNotebookQueryClient().clear();
    globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; internals._load = originalLoad; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
