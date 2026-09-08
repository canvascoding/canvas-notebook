import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const dom = new JSDOM('<div id="root"></div><div id="session"></div>', { url: 'https://canvas.test', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'EventTarget', 'Event', 'CustomEvent', 'MessageEvent'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useEditorStore } = await import('../app/store/editor-store');
  const { getFileWatcherClient } = await import('../app/lib/file-watcher/client');
  const { useCollaborationDocumentLocation } = await import('../app/lib/collaboration/document-location-client');
  const { useTextCollaborationSession } = await import('../app/lib/collaboration/client');
  class FakeEventSource extends EventTarget {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(..._args: unknown[]) { super(); FakeEventSource.instances.push(this); }
    close() {}
    emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
  }
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: { gate: ReturnType<typeof deferred<Response>>; signal: AbortSignal; url: URL }[] = [];
  let sessionDocumentId = 'reused-path-document';
  let sessionAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/watch') return Response.json({ success: true });
    if (url.pathname === '/api/files/collaboration/session') {
      sessionAttempts++;
      return Response.json({ success: true, documentId: sessionDocumentId, documentName: sessionDocumentId,
        provider: 'yjs', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
        permission: 'write', documentSequence: 1, checkpointSequence: 1, stateVector: '', stateProof: '',
        token: 'test-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
        user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } });
    }
    assert.equal(url.pathname, '/api/files/collaboration/location');
    assert.equal(url.searchParams.get('documentId'), 'document');
    assert.equal(url.searchParams.get('workspaceId'), 'workspace');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.credentials, 'include');
    const request = { gate: deferred<Response>(), signal: init!.signal as AbortSignal, url };
    requests.push(request);
    // Deliberately ignore AbortSignal: late network replies must be harmless independently of fetch cancellation.
    return request.gate.promise;
  };
  const file: CurrentFile = { path: 'folder/A.txt', editorIdentity: 'open-1', content: 'Initial', collaboration: {
    path: 'folder/A.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id: 'document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
  useFileStore.getState().resetWorkspaceView('workspace');
  useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace',
    refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
  useEditorStore.getState().setActiveFile(file.path, file.content);
  useEditorStore.getState().updateDraft('Local + peer draft');
  let connection: 'live' | 'reconnecting' = 'live';
  function Probe() {
    const state = useFileStore();
    const issue = useCollaborationDocumentLocation({ workspaceId: state.currentFileWorkspaceId,
      documentId: state.currentFile?.collaboration?.document?.id ?? null,
      documentKey: state.currentFile?.editorIdentity, path: state.currentFile?.path ?? null,
      lifecycleGeneration: 1, representation: 'plain_text', connection });
    return <output>{issue ?? 'ok'}</output>;
  }
  let session: CollaborationSessionResponse | null = null;
  let retry: (() => void) | undefined;
  function SessionProbe() {
    const result = useTextCollaborationSession({ enabled: true, workspaceId: 'workspace', path: 'folder/A.txt',
      expectedDocumentId: 'document' });
    session = result.session; retry = result.retry;
    return <output>{result.error ?? result.session?.documentId ?? 'connecting'}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const sessionRoot = createRoot(document.getElementById('session')!);
  const render = () => act(async () => root.render(<StrictMode><Probe /></StrictMode>));
  const until = async (test: () => boolean) => {
    for (let i = 0; !test() && i < 150; i++) await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    assert(test(), 'expected asynchronous state did not arrive');
  };
  const reply = (index: number, path: string, extras: Record<string, unknown> = {}) => act(async () => {
    requests[index].gate.resolve(Response.json({ success: true, workspaceId: 'workspace', documentId: 'document',
      path, lifecycleGeneration: 1, representation: 'plain_text', ...extras }));
  });
  const source = () => FakeEventSource.instances.at(-1)!;
  const structural = (path: string, type = 'unlink', workspaceId = 'workspace') => act(async () => {
    source().emit('filechange', { type, workspaceId, relativePath: path, path, dir: 'folder', timestamp: Date.now() });
  });
  const expectPath = (path: string) => assert.equal(useFileStore.getState().currentFile?.path, path);
  try {
    await render();
    await act(async () => source().emit('connected', { workspaceId: 'workspace', clientId: 'one' }));
    await until(() => requests.length === 1);
    await reply(0, file.path);
    expectPath(file.path);

    await structural('folder/A.txt');
    await until(() => requests.length === 2);
    for (let i = 0; i < 8; i++) await structural('folder/B.txt', i % 2 ? 'add' : 'unlink');
    assert.equal(requests.length, 2, 'structural bursts share one in-flight lookup');
    await reply(1, 'folder/B.txt');
    expectPath(file.path);
    await until(() => requests.length === 3);
    await reply(2, 'moved/C.txt');
    expectPath('moved/C.txt');
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, 'open-1');
    assert.equal(useEditorStore.getState().draft, 'Local + peer draft');
    await until(() => requests.length === 4); // New view validates its adopted location too.
    await reply(3, 'moved/C.txt');
    await structural('moved/C.txt', 'change');
    await structural('moved/C.txt', 'unlink', 'other-workspace');
    await act(async () => { await new Promise((done) => setTimeout(done, 200)); });
    assert.equal(requests.length, 4, 'content-only and foreign-workspace events do not resolve locations');

    // A provider reconnect recovers an event missed by the SSE connection.
    connection = 'reconnecting'; await render();
    await until(() => requests.length === 5);
    await reply(4, 'moved/D.txt');
    expectPath('moved/D.txt');
    await until(() => requests.length === 6);
    await reply(5, 'moved/D.txt');
    await act(async () => source().emit('connected', { workspaceId: 'workspace', clientId: 'two' }));
    await until(() => requests.length === 7);
    await act(async () => requests[6].gate.resolve(Response.json({ success: false }, { status: 404 })));
    assert.equal(document.querySelector('#root output')?.textContent, 'unavailable');
    expectPath('moved/D.txt');
    assert.equal(useEditorStore.getState().draft, 'Local + peer draft');

    await act(async () => window.dispatchEvent(new Event('focus')));
    await until(() => requests.length === 8);
    await reply(7, 'unsafe.txt', { lifecycleGeneration: 2 });
    assert.equal(document.querySelector('#root output')?.textContent, 'generationChanged');
    expectPath('moved/D.txt');

    await structural('another.txt', 'add');
    await until(() => requests.length === 9);
    await reply(8, 'unsafe.txt', { documentId: 'reused-name' });
    assert.equal(document.querySelector('#root output')?.textContent, 'lookupFailed');
    expectPath('moved/D.txt');
    // A reconnect bypasses the retry backoff, but still respects the request rate limit.
    await act(async () => source().emit('connected', { workspaceId: 'workspace', clientId: 'three' }));
    await until(() => requests.length === 10);
    await reply(9, 'moved/D.txt');
    assert.equal(document.querySelector('#root output')?.textContent, 'ok');

    await structural('moved/D.txt');
    await until(() => requests.length === 11);
    await act(async () => useFileStore.setState({ currentFile: { ...useFileStore.getState().currentFile!, editorIdentity: 'open-2' } }));
    assert.equal(requests[10].signal.aborted, true);
    await reply(10, 'late-old-open.txt');
    expectPath('moved/D.txt');
    await until(() => requests.length === 12);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'other-workspace' }));
    await reply(11, 'late-old-workspace.txt');
    expectPath('moved/D.txt');

    // Session lookup must independently fence a path reused by a different document.
    await act(async () => sessionRoot.render(<SessionProbe />));
    await until(() => Boolean(document.querySelector('#session output')?.textContent?.includes('another document')));
    assert.equal(session, null);
    sessionDocumentId = 'document';
    await act(async () => retry?.());
    await until(() => session?.documentId === 'document');
    assert.equal(sessionAttempts, 2);
    console.log('Location hook handles rename bursts, both reconnects, recovery errors, stale lifetimes, and reused-path session identity.');
  } finally {
    await act(async () => { root.unmount(); sessionRoot.unmount(); });
    getFileWatcherClient().disconnect();
    for (const request of requests) request.gate.resolve(Response.json({ success: false }, { status: 404 }));
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    useFileStore.getState().resetWorkspaceView(null);
    useEditorStore.getState().clear();
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
