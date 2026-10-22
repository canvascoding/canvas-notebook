import assert from 'node:assert/strict';
import Module from 'node:module';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse, TextCollaborationRepresentation } from '../app/lib/collaboration/types';

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
  class FakeEventSource extends EventTarget {
    static instances: FakeEventSource[] = [];
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(..._args: unknown[]) { super(); FakeEventSource.instances.push(this); }
    close() {}
    emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
  }
  const originalFetch = globalThis.fetch;
  const internal = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internal._load;
  internal._load = (name, ...args) => {
    if (name === '@/app/lib/live-events/client' || name.endsWith('/app/lib/live-events/client')) {
      return { LiveEventSource: FakeEventSource };
    }
    return originalLoad(name, ...args);
  };
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useEditorStore } = await import('../app/store/editor-store');
  const { getFileWatcherClient } = await import('../app/lib/file-watcher/client');
  const { getNotebookQueryClient } = await import('../app/lib/queries/client');
  const { useCollaborationDocumentLocation } = await import('../app/lib/collaboration/document-location-client');
  const { useTextCollaborationSession } = await import('../app/lib/collaboration/client');
  const authRegistry = await import('../app/lib/collaboration/opened-document-registry');
  const requests: { gate: ReturnType<typeof deferred<Response>>; signal: AbortSignal; url: URL }[] = [];
  let sessionDocumentId = 'reused-path-document';
  let sessionAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://canvas.test');
    if (url.pathname === '/api/files/watch') return Response.json({ success: true });
    if (url.pathname === '/api/files/read') {
      const current = useFileStore.getState().currentFile;
      const isCurrent = url.searchParams.get('path') === current?.path;
      return Response.json({ success: true, data: { content: isCurrent ? current.content : '',
        collaboration: isCurrent ? current.collaboration : undefined,
        stats: { size: 7, modified: 1, permissions: '100644' } } });
    }
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
  let mountedGeneration: number | undefined = 1;
  let mountedRepresentation: TextCollaborationRepresentation | undefined = 'plain_text';
  let connection: 'live' | 'reconnecting' = 'live';
  let requestAdmissionRejoin: (() => Promise<void>) | undefined;
  function Probe() {
    const state = useFileStore();
    const issue = useCollaborationDocumentLocation({ workspaceId: state.currentFileWorkspaceId,
      documentId: state.currentFile?.collaboration?.document?.id ?? null,
      documentKey: state.currentFile?.editorIdentity, path: state.currentFile?.path ?? null,
      lifecycleGeneration: mountedGeneration, representation: mountedRepresentation, connection, requestAdmissionRejoin });
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
  const terminalHint = (detail: unknown) => act(async () => {
    source().emit('workspace-invalidated', detail);
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
    // A completion hint for another path must also wake an unchanged Incoming
    // location. Only the fixed registry request can obtain a new authorization.
    await act(async () => root.render(null));
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
    useFileStore.getState().resetWorkspaceView('workspace');
    useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace',
      refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
    let rejoins = 0, reservationBusy = true;
    requestAdmissionRejoin = async () => {
      rejoins++;
      if (reservationBusy) throw Object.assign(new Error('Synthetic reservation is still active'), { code: 'NATIVE_SESSION_BUSY', status: 409 });
    };
    const admissionBase = requests.length;
    await render(); await until(() => requests.length === admissionBase + 1);
    await reply(admissionBase, file.path); assert.equal(rejoins, 1); expectPath(file.path);
    await act(async () => { await new Promise(done => setTimeout(done, 1100)); });
    assert.equal(requests.length, admissionBase + 1); assert.equal(rejoins, 1, 'Busy rejoin cannot create a location retry loop');
    await structural('foreign.md', 'unlink', 'other-workspace'); await structural('unrelated.md', 'change');
    await act(async () => { await new Promise(done => setTimeout(done, 200)); });
    assert.equal(rejoins, 1); assert.equal(requests.length, admissionBase + 1);
    reservationBusy = false;
    await structural('actually-deleted.md'); await until(() => requests.length === admissionBase + 2);
    await reply(admissionBase + 1, file.path); assert.equal(rejoins, 2); expectPath(file.path);
    await structural('late-deleted.md'); await until(() => requests.length === admissionBase + 3);
    await act(async () => useFileStore.setState({ currentFile: { ...file, editorIdentity: 'other-open' } }));
    await reply(admissionBase + 2, file.path);
    assert.equal(rejoins, 2, 'a late original-tab location reply cannot wake the current registry entry');

    // This isolated hook model supplies the rejoin callback. It proves the
    // terminal hint -> gated ID lookup -> callback path, not a registry HTTP grant.
    await act(async () => root.render(null));
    for (const request of requests) request.gate.resolve(Response.json({ success: false }, { status: 404 }));
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.getState().resetWorkspaceView('workspace');
      useFileStore.setState({ currentFile: { ...file, editorIdentity: 'terminal-open-1' }, currentFileWorkspaceId: 'workspace',
        refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
    });
    let terminalRejoins = 0;
    requestAdmissionRejoin = async () => { terminalRejoins++; };
    const terminalInitial = requests.length;
    await render(); await until(() => requests.length === terminalInitial + 1);
    await reply(terminalInitial, file.path);
    assert.equal(terminalRejoins, 1);
    const ignoredTerminalBase = requests.length;
    for (const hint of [null, {}, [], { workspaceId: null }, { workspaceId: 'other-workspace' },
      { workspaceId: 'workspace', documentId: 'document' }]) await terminalHint(hint);
    await act(async () => { await new Promise(done => setTimeout(done, 1100)); });
    assert.equal(requests.length, ignoredTerminalBase, 'foreign and malformed terminal hints cannot request a location');
    assert.equal(terminalRejoins, 1);

    const terminalLookup = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === terminalLookup + 1);
    assert.equal(requests[terminalLookup].url.pathname, '/api/files/collaboration/location');
    assert.equal(requests[terminalLookup].signal.aborted, false);
    assert.equal(terminalRejoins, 1, 'a hint cannot rejoin before the actual location GET completes');
    expectPath(file.path);
    await reply(terminalLookup, file.path);
    assert.equal(terminalRejoins, 2, 'an unchanged path still requests admission rejoin after terminal completion');
    expectPath(file.path);

    const terminalIdentity = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === terminalIdentity + 1);
    await act(async () => useFileStore.setState({ currentFile: { ...file, editorIdentity: 'terminal-open-2' } }));
    assert.equal(requests[terminalIdentity].signal.aborted, true);
    await reply(terminalIdentity, 'late-terminal-identity.txt');
    expectPath(file.path);
    assert.equal(terminalRejoins, 2, 'a retained terminal lookup cannot rejoin a replacement editor identity');
    await until(() => requests.length === terminalIdentity + 2);
    await reply(terminalIdentity + 1, file.path);
    assert.equal(terminalRejoins, 3);

    const terminalScope = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === terminalScope + 1);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'other-workspace' }));
    await reply(terminalScope, 'late-terminal-workspace.txt');
    expectPath(file.path);
    assert.equal(terminalRejoins, 3, 'a retained terminal lookup cannot rejoin after the active workspace changes');

    // Controlled callback models only: one genuine terminal hint must keep its
    // finite window alive through a specifically marked clean read conflict.
    await act(async () => root.render(null));
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.getState().resetWorkspaceView('workspace');
      useFileStore.setState({ currentFile: { ...file, editorIdentity: 'retry-open' }, currentFileWorkspaceId: 'workspace',
        refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
    });
    let qualifiedBusy = false, retryRejoins = 0;
    useEditorStore.getState().setActiveFile(file.path, file.content);
    useEditorStore.getState().updateDraft('Local + peer draft');
    requestAdmissionRejoin = async () => {
      retryRejoins++;
      if (qualifiedBusy) throw Object.assign(new Error('Controlled clean read marker'), {
        code: 'NATIVE_SESSION_BUSY', status: 409, retryable: true,
      });
    };
    const retryInitial = requests.length;
    await render(); await until(() => requests.length === retryInitial + 1);
    await reply(retryInitial, file.path); assert.equal(retryRejoins, 1);
    qualifiedBusy = true;
    const oneHint = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === oneHint + 1);
    await reply(oneHint, file.path); assert.equal(retryRejoins, 2);
    qualifiedBusy = false;
    await until(() => requests.length === oneHint + 2);
    await reply(oneHint + 1, file.path); assert.equal(retryRejoins, 3);
    assert.equal(document.querySelector('#root output')?.textContent, 'ok');
    expectPath(file.path); assert.equal(useEditorStore.getState().draft, 'Local + peer draft');
    await act(async () => { await new Promise(done => setTimeout(done, 1100)); });
    assert.equal(requests.length, oneHint + 2, 'successful single-hint recovery closes the retry window');

    const lookupBusy = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === lookupBusy + 1);
    await act(async () => requests[lookupBusy].gate.resolve(Response.json({ success: false,
      code: 'FILE_MUTATION_LOCK_BUSY', retryable: true }, { status: 503 })));
    await until(() => requests.length === lookupBusy + 2);
    await reply(lookupBusy + 1, file.path); assert.equal(retryRejoins, 4);
    const unmarkedLookup = requests.length;
    await terminalHint({ workspaceId: 'workspace' });
    await until(() => requests.length === unmarkedLookup + 1);
    await act(async () => requests[unmarkedLookup].gate.resolve(Response.json({ success: false,
      code: 'FILE_MUTATION_LOCK_BUSY' }, { status: 503 })));
    await act(async () => { await new Promise(done => setTimeout(done, 1200)); });
    assert.equal(requests.length, unmarkedLookup + 1, 'generic or unmarked 503 cannot create polling');
    assert.equal(document.querySelector('#root output')?.textContent, 'lookupFailed');

    requestAdmissionRejoin = async () => { retryRejoins++; throw Object.assign(new Error('Revoked'), { status: 403 }); };
    await render();
    const denied = requests.length;
    await terminalHint({ workspaceId: 'workspace' }); await until(() => requests.length === denied + 1);
    await reply(denied, file.path);
    await act(async () => { await new Promise(done => setTimeout(done, 1200)); });
    assert.equal(requests.length, denied + 1, 'rights revocation ends the window without another hint or reload');

    requestAdmissionRejoin = async () => { throw Object.assign(new Error('Controlled clean read marker'), {
      code: 'NATIVE_SESSION_BUSY', status: 409, retryable: true,
    }); };
    await render();
    const authBusy = requests.length;
    await terminalHint({ workspaceId: 'workspace' }); await until(() => requests.length === authBusy + 1);
    await reply(authBusy, file.path);
    const { invalidateOpenedDocumentAuth } = await import('../app/lib/collaboration/opened-document-registry');
    await act(async () => invalidateOpenedDocumentAuth());
    await act(async () => { await new Promise(done => setTimeout(done, 1200)); });
    assert.equal(requests.length, authBusy + 1, 'auth invalidation cancels an already scheduled retry');

    const originalNow = Date.now;
    let fixtureClock = originalNow() + 21_000;
    Date.now = () => fixtureClock;
    try {
      let lateRejoins = 0;
      requestAdmissionRejoin = async () => { lateRejoins++; };
      await render();
      const lateDeadline = requests.length;
      await terminalHint({ workspaceId: 'workspace' }); await until(() => requests.length === lateDeadline + 1);
      fixtureClock += 10_001;
      await reply(lateDeadline, file.path);
      assert.equal(lateRejoins, 0, 'a fixed ten-second rejoin cannot start outside the remaining common deadline');
      assert.equal(document.querySelector('#root output')?.textContent, 'lookupFailed');
      await act(async () => { await new Promise(done => setTimeout(done, 1100)); });
      assert.equal(requests.length, lateDeadline + 1, 'deadline exhaustion is terminal');
    } finally { Date.now = originalNow; }
    // Existing isolated hook/fetch fixture: no real server or grant is claimed.
    await act(async () => root.render(null));
    authRegistry.observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'replacement-session' } } });
    requestAdmissionRejoin = undefined; mountedGeneration = 1; mountedRepresentation = 'plain_text';
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
    useFileStore.getState().resetWorkspaceView('workspace');
    useFileStore.setState({ currentFile: { ...file, editorIdentity: 'replacement-open' }, currentFileWorkspaceId: 'workspace',
      refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
    useEditorStore.getState().setActiveFile(file.path, file.content); useEditorStore.getState().updateDraft('Retained native draft');
    const replacementStart = requests.length;
    await render(); await until(() => requests.length === replacementStart + 1);
    const originalScope = { workspaceId: 'workspace', documentId: 'document', editorIdentity: 'replacement-open',
      path: file.path, treeGeneration: useFileStore.getState().treeGeneration };
    await act(async () => {
      assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(originalScope, 'moved/recovered.txt'), true);
    });
    await until(() => requests.length === replacementStart + 2);
    await act(async () => useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'workspace',
      oldPath: file.path, newPath: 'moved/recovered.txt', operationId: 'actual-original-rename' }));
    const retainedReplacement = useFileStore.getState().currentFile!;
    const retainedEditorSession = useEditorStore.getState().sessionId;
    assert.equal(retainedReplacement.unavailable, 'replaced');
    assert.equal(requests[replacementStart + 1].signal.aborted, true);
    await reply(replacementStart, file.path);
    await reply(replacementStart + 1, 'moved/recovered.txt');
    assert.equal(useFileStore.getState().currentFile, retainedReplacement,
      'Neither a pre-adoption nor a pre-replacement response can clear recovery.');
    await until(() => requests.length === replacementStart + 3);
    await reply(replacementStart + 2, 'moved/recovered.txt');
    const confirmedReplacement = useFileStore.getState().currentFile!;
    assert.equal(confirmedReplacement.unavailable, undefined);
    assert.equal(confirmedReplacement.path, 'moved/recovered.txt');
    assert.equal(confirmedReplacement.editorIdentity, retainedReplacement.editorIdentity);
    assert.equal(confirmedReplacement.collaboration?.document, retainedReplacement.collaboration?.document);
    assert.equal(useEditorStore.getState().draft, 'Retained native draft');
    assert.equal(useEditorStore.getState().sessionId, retainedEditorSession);

    for (const negative of ['unavailable-id', 'different-id', 'changed-generation', 'changed-representation', 'uninitialized',
      'deleted', 'missing-mounted-generation', 'missing-mounted-representation', 'stale-read-id', 'new-view', 'new-tree', 'new-auth'] as const) {
      await act(async () => root.render(null));
      authRegistry.observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'negative-' + negative } } });
      mountedGeneration = negative === 'missing-mounted-generation' ? undefined : 1;
      mountedRepresentation = negative === 'missing-mounted-representation' ? undefined : 'plain_text';
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.getState().resetWorkspaceView('workspace');
      const retained: CurrentFile = { ...file, editorIdentity: 'negative-' + negative,
        unavailable: negative === 'deleted' ? 'deleted' : 'replaced' };
      useFileStore.setState({ currentFile: retained, currentFileWorkspaceId: 'workspace',
        refreshDirectory: async () => {}, loadSubdirectory: async () => {} });
      useEditorStore.getState().setActiveFile(file.path, file.content);
      const index = requests.length;
      await render(); await until(() => requests.length === index + 1);
      if (negative === 'stale-read-id') await act(async () => useFileStore.setState({
        fileLoadRequestId: useFileStore.getState().fileLoadRequestId + 1 }));
      if (negative === 'new-view') await act(async () => useFileStore.setState({ currentFile: { ...retained, editorIdentity: 'new-lifetime' } }));
      if (negative === 'new-tree') await act(async () => useFileStore.setState({ treeGeneration: useFileStore.getState().treeGeneration + 1 }));
      if (negative === 'new-auth') await act(async () => authRegistry.invalidateOpenedDocumentAuth());
      if (negative === 'unavailable-id') {
        await act(async () => requests[index].gate.resolve(Response.json({ success: false, code: 'document_unavailable' }, { status: 404 })));
      } else {
        await reply(index, file.path, negative === 'different-id' ? { documentId: 'D2' }
          : negative === 'changed-generation' ? { lifecycleGeneration: 2 }
            : negative === 'changed-representation' ? { representation: 'tiptap_xml' }
              : negative === 'uninitialized' ? { lifecycleGeneration: null, representation: null } : {});
      }
      assert.equal(useFileStore.getState().currentFile?.unavailable, retained.unavailable, negative);
      assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'document', negative);
      assert.equal(useFileStore.getState().currentFile?.path, file.path, negative);
    }
    await act(async () => root.render(null));
    authRegistry.observeOpenedDocumentAuth(null);
    console.log('Location hook handles rename bursts, both reconnects, recovery errors, stale lifetimes, and reused-path session identity.');
  } finally {
    await act(async () => { root.unmount(); sessionRoot.unmount(); });
    getFileWatcherClient().disconnect();
    for (const request of requests) request.gate.resolve(Response.json({ success: false }, { status: 404 }));
    await getNotebookQueryClient().cancelQueries();
    getNotebookQueryClient().clear();
    authRegistry.observeOpenedDocumentAuth(null);
    globalThis.fetch = originalFetch;
    internal._load = originalLoad;
    useFileStore.getState().resetWorkspaceView(null);
    useEditorStore.getState().clear();
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
