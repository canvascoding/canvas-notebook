import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { LocalFileWriteTracker } from '../app/lib/files/local-write-tracker';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { subscribeToFileReferenceValidationInvalidation,
  type FileReferenceValidationInvalidation } from '../app/lib/chat/validate-file-paths';

class FakeMessageEvent extends Event {
  data: string;

  constructor(type: string, data: unknown) {
    super(type);
    this.data = JSON.stringify(data);
  }
}

class FakeEventSource extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  static instances: FakeEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    this.dispatchEvent(new FakeMessageEvent(type, data));
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testLocalWriteTracker() {
  const tracker = new LocalFileWriteTracker();
  const path = 'notes/todos.md';

  tracker.record(path, '- [x] ship', 100);
  tracker.record(path, '- [ ] ship', 110);

  assert.equal(
    tracker.consumeMatchingWrite(path, '- [x] ship', 120),
    true,
    'the first local autosave must not be treated as an external change',
  );
  assert.equal(
    tracker.consumeMatchingWrite(path, '- [ ] ship', 130),
    true,
    'the quick follow-up autosave must also be recognized as local',
  );
  assert.equal(
    tracker.consumeMatchingWrite(path, 'changed in another tab', 140),
    false,
    'unrelated watcher content must still be treated as external',
  );

  tracker.record(path, 'first', 200);
  tracker.record(path, 'second', 210);
  assert.equal(
    tracker.consumeMatchingWrite(path, 'second', 220),
    true,
    'a coalesced watcher event must consume all older local writes',
  );
  assert.equal(
    tracker.consumeMatchingWrite(path, 'first', 230),
    false,
    'superseded writes must not mask a later external change',
  );

  tracker.record(path, 'failed write', 240);
  tracker.discard(path, 'failed write');
  assert.equal(
    tracker.consumeMatchingWrite(path, 'failed write', 250),
    false,
    'a failed save must not suppress the following external change',
  );

  tracker.record(path, 'expired', 300);
  assert.equal(
    tracker.consumeMatchingWrite(path, 'expired', 10_301),
    false,
    'stale local writes must not suppress later external changes',
  );
}

async function main() {
  const originalFetch = globalThis.fetch;
  const originalFileState = useFileStore.getState();
  const originalWorkspaceState = useWorkspaceStore.getState();
  let client: FileWatcherClient | null = null;
  let unsubscribeValidation: (() => void) | null = null;
  let unsubscribeVersion: (() => void) | null = null;
  const factoryUrls: string[] = [];
  const fetchCalls: Array<{ url: string; body: { clientId?: string; dirs?: string[] } | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ success: true });
  }) as typeof fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: null });

  let refreshVisibleCalls = 0;
  let contentRefreshCalls = 0;
  const visibleRefreshWorkspaces: Array<string | null> = [];
  const refreshedDirectories: Array<{ dirPath: string; noCache?: boolean }> = [];

  useFileStore.setState({
    browserMode: 'list',
    currentDirectory: 'docs/current',
    expandedDirs: new Set(['hidden-expanded']),
    refreshVisibleTree: async () => {
      refreshVisibleCalls += 1;
      visibleRefreshWorkspaces.push(useWorkspaceStore.getState().activeWorkspaceId);
    },
    refreshCurrentFileContent: async () => {
      contentRefreshCalls += 1;
      return useFileStore.getState().currentFile;
    },
    revalidateDirectory: async (dirPath) => {
      refreshedDirectories.push({ dirPath, noCache: true });
    },
  });

  try {
    testLocalWriteTracker();

    client = new FileWatcherClient((url) => { factoryUrls.push(url); return new FakeEventSource(url); });
    client.acquire();

    const source = FakeEventSource.instances[0];
    assert.ok(source, 'The transport factory should create a source on acquire');
    assert.equal(source.url, '/api/files/watch');
    assert.deepEqual(factoryUrls, ['/api/files/watch']);

    source.emit('connected', { clientId: 'client-1' });
    await delay(FileWatcherClient.SYNC_DEBOUNCE_MS + 25);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, '/api/files/watch');
    assert.equal(fetchCalls[0].body?.clientId, 'client-1');
    assert.deepEqual(fetchCalls[0].body?.dirs, ['docs/current']);

    useFileStore.setState({ browserMode: 'tree' });
    await delay(FileWatcherClient.SYNC_DEBOUNCE_MS + 25);

    assert.deepEqual(
      [...(fetchCalls.at(-1)?.body?.dirs ?? [])].sort(),
      ['docs/current', 'hidden-expanded'].sort()
    );

    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-two' });
    await delay(25);

    const workspaceSource = FakeEventSource.instances.at(-1);
    assert.ok(workspaceSource, 'workspace change should reconnect the watcher');
    assert.equal(workspaceSource.url, '/api/files/watch?workspaceId=workspace-two');
    workspaceSource.emit('connected', { clientId: 'client-2', workspaceId: 'workspace-two' });
    await delay(FileWatcherClient.SYNC_DEBOUNCE_MS + 25);
    assert.equal(fetchCalls.at(-1)?.url, '/api/files/watch?workspaceId=workspace-two');
    assert.equal(fetchCalls.at(-1)?.body?.clientId, 'client-2');

    workspaceSource.emit('filechange', {
      type: 'add',
      workspaceId: 'workspace-two',
      path: '/data/workspace/docs/current/fresh.md',
      relativePath: 'docs/current/fresh.md',
      dir: 'docs/current',
      timestamp: Date.now(),
      fileVersion: 'version-1',
    });
    await delay(550);

    assert.equal(refreshVisibleCalls, 2, 'each established connection revalidates visible directories');
    assert.deepEqual(refreshedDirectories, [{ dirPath: 'docs/current', noCache: true }]);

    const versionBeforeEcho = useFileStore.getState().workspaceFileVersion;
    workspaceSource.emit('filechange', {
      type: 'change', workspaceId: 'workspace-two', path: '/data/workspace/docs/current/fresh.md',
      relativePath: 'docs/current/fresh.md', dir: 'docs/current', timestamp: Date.now(), fileVersion: 'version-1',
    });
    await delay(550);
    assert.equal(refreshedDirectories.length, 1, 'native echo of the confirmed version causes no second refresh');
    assert.equal(useFileStore.getState().workspaceFileVersion, versionBeforeEcho);
    workspaceSource.emit('filechange', {
      type: 'change',
      workspaceId: 'workspace-two',
      path: '/data/workspace/docs/current/fresh.md',
      relativePath: 'docs/current/fresh.md',
      dir: 'docs/current',
      timestamp: Date.now(),
      fileVersion: 'version-2',
    });
    await delay(550);

    assert.equal(refreshVisibleCalls, 2, 'each established connection revalidates visible directories');
    assert.deepEqual(refreshedDirectories, [{ dirPath: 'docs/current', noCache: true }, { dirPath: 'docs/current', noCache: true }], 'content changes also refresh metadata');

    const terminalEvents: Array<{ type: string; detail: unknown }> = [];
    const validationInvalidations: FileReferenceValidationInvalidation[] = [];
    const workspaceVersionChanges: Array<{ workspaceId: string | null; version: number }> = [];
    let switchAfterValidation: string | null = null;
    let switchAfterVersion: string | null = null;
    const onValidationInvalidation = (event: FileReferenceValidationInvalidation) => {
      validationInvalidations.push({ ...event });
      if (switchAfterValidation !== null) {
        const nextWorkspaceId = switchAfterValidation;
        switchAfterValidation = null;
        useWorkspaceStore.setState({ activeWorkspaceId: nextWorkspaceId });
      }
    };
    const onWorkspaceVersionChanged: Parameters<typeof useFileStore.subscribe>[0] = (state, previous) => {
      if (state.workspaceFileVersion === previous.workspaceFileVersion) return;
      workspaceVersionChanges.push({ workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
        version: state.workspaceFileVersion });
      if (switchAfterVersion !== null) {
        const nextWorkspaceId = switchAfterVersion;
        switchAfterVersion = null;
        useWorkspaceStore.setState({ activeWorkspaceId: nextWorkspaceId });
      }
    };
    unsubscribeValidation = subscribeToFileReferenceValidationInvalidation(onValidationInvalidation);
    unsubscribeVersion = useFileStore.subscribe(onWorkspaceVersionChanged);
    const onWorkspaceInvalidated = (event: Event) => {
      terminalEvents.push({ type: event.type, detail: (event as CustomEvent<unknown>).detail });
    };
    client.addEventListener('workspace-invalidated', onWorkspaceInvalidated);
    client.addEventListener('filechange', onWorkspaceInvalidated);
    const beforeTerminalFile = useFileStore.getState().currentFile;
    const beforeTerminalFileWorkspaceId = useFileStore.getState().currentFileWorkspaceId;
    const terminalFile = { path: 'docs/current/live.md', content: 'Unsaved local editor content stays intact.' };
    useFileStore.setState({ currentFile: terminalFile, currentFileWorkspaceId: 'workspace-two' });
    const terminalVersion = useFileStore.getState().workspaceFileVersion;
    const terminalRefreshes = refreshedDirectories.length;
    const terminalVisible = refreshVisibleCalls;
    const terminalContentRefreshes = contentRefreshCalls;
    workspaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    assert.deepEqual(terminalEvents, [{ type: 'workspace-invalidated', detail: { workspaceId: 'workspace-two' } }]);
    assert(Object.isFrozen(terminalEvents[0].detail), 'terminal hints expose only an immutable workspace payload');
    assert.deepEqual(validationInvalidations, [{ workspaceId: 'workspace-two', path: null }]);
    assert.deepEqual(workspaceVersionChanges, [{ workspaceId: 'workspace-two', version: terminalVersion + 1 }]);
    assert.equal(useFileStore.getState().workspaceFileVersion, terminalVersion + 1);
    assert.equal(refreshVisibleCalls, terminalVisible + 1);
    assert.equal(visibleRefreshWorkspaces.at(-1), 'workspace-two');
    assert.equal(useFileStore.getState().currentFile, terminalFile);
    assert.equal(useFileStore.getState().currentFile?.path, 'docs/current/live.md');
    assert.equal(useFileStore.getState().currentFile?.content, 'Unsaved local editor content stays intact.');
    assert.equal(useFileStore.getState().currentFileWorkspaceId, 'workspace-two');
    assert.equal(contentRefreshCalls, terminalContentRefreshes);
    assert.equal(terminalContentRefreshes, 0, 'no current-file content refresh has been invoked');
    assert.equal(refreshedDirectories.length, terminalRefreshes, 'a terminal hint is separate from a filesystem mutation');
    for (const hint of [null, {}, [], { workspaceId: null }, { workspaceId: '' }, { workspaceId: 1 },
      { workspaceId: 'other-workspace' }, { workspaceId: 'workspace-two', path: 'private.md' },
      { workspaceId: 'workspace-two\n' }]) workspaceSource.emit('workspace-invalidated', hint);
    workspaceSource.dispatchEvent(Object.assign(new Event('workspace-invalidated'), { data: '{' }));
    workspaceSource.dispatchEvent(Object.assign(new Event('workspace-invalidated'), { data: { workspaceId: 'workspace-two' } }));
    assert.equal(terminalEvents.length, 1, 'malformed, extra-field and foreign hints are ignored');
    assert.equal(validationInvalidations.length, 1);
    assert.equal(workspaceVersionChanges.length, 1);
    assert.equal(refreshVisibleCalls, terminalVisible + 1);
    assert.equal(useFileStore.getState().workspaceFileVersion, terminalVersion + 1);
    assert.equal(useFileStore.getState().currentFile, terminalFile);
    assert.equal(useFileStore.getState().currentFile?.content, 'Unsaved local editor content stays intact.');
    assert.equal(contentRefreshCalls, terminalContentRefreshes);
    assert.equal(refreshedDirectories.length, terminalRefreshes);
    useFileStore.setState({ currentFile: beforeTerminalFile, currentFileWorkspaceId: beforeTerminalFileWorkspaceId });

    // Closed fixtures deliberately continue emitting. The client must reject a
    // retained source itself, including when A becomes the active workspace again.
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-three' });
    await delay(25);
    const middleSource = FakeEventSource.instances.at(-1)!;
    assert.notEqual(middleSource, workspaceSource);
    assert.equal(workspaceSource.closed, true);
    middleSource.emit('connected', { clientId: 'client-terminal-b', workspaceId: 'workspace-three' });
    const middleValidationCount = validationInvalidations.length;
    const middleVersion = useFileStore.getState().workspaceFileVersion;
    const middleVisible = refreshVisibleCalls;
    workspaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-three' });
    workspaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    assert.equal(terminalEvents.length, 1, 'retained A source cannot dispatch while B is current');
    assert.equal(validationInvalidations.length, middleValidationCount);
    assert.equal(useFileStore.getState().workspaceFileVersion, middleVersion);
    assert.equal(refreshVisibleCalls, middleVisible);
    middleSource.emit('workspace-invalidated', { workspaceId: 'workspace-three' });
    assert.deepEqual(terminalEvents.at(-1), { type: 'workspace-invalidated', detail: { workspaceId: 'workspace-three' } });
    assert.equal(terminalEvents.length, 2);

    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-two' });
    await delay(25);
    const returnedSource = FakeEventSource.instances.at(-1)!;
    assert.notEqual(returnedSource, workspaceSource);
    assert.notEqual(returnedSource, middleSource);
    returnedSource.emit('connected', { clientId: 'client-terminal-a2', workspaceId: 'workspace-two' });
    const returnedValidationCount = validationInvalidations.length;
    const returnedVersion = useFileStore.getState().workspaceFileVersion;
    const returnedVisible = refreshVisibleCalls;
    workspaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    middleSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    assert.equal(terminalEvents.length, 2, 'A to B to A does not revive either retained connection generation');
    assert.equal(validationInvalidations.length, returnedValidationCount);
    assert.equal(useFileStore.getState().workspaceFileVersion, returnedVersion);
    assert.equal(refreshVisibleCalls, returnedVisible);
    returnedSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    assert.deepEqual(terminalEvents.at(-1), { type: 'workspace-invalidated', detail: { workspaceId: 'workspace-two' } });
    assert.equal(terminalEvents.length, 3);

    useWorkspaceStore.setState({ activeWorkspaceId: null });
    await delay(25);
    const unscopedSource = FakeEventSource.instances.at(-1)!;
    assert.equal(unscopedSource.url, '/api/files/watch');
    unscopedSource.emit('connected', { clientId: 'client-terminal-null', workspaceId: 'workspace-two' });
    const unscopedValidationCount = validationInvalidations.length;
    const unscopedVersion = useFileStore.getState().workspaceFileVersion;
    const unscopedVisible = refreshVisibleCalls;
    unscopedSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    unscopedSource.emit('workspace-invalidated', { workspaceId: null });
    returnedSource.emit('workspace-invalidated', { workspaceId: 'workspace-two' });
    assert.equal(terminalEvents.length, 3, 'a null active workspace cannot adopt a workspace hint');
    assert.equal(validationInvalidations.length, unscopedValidationCount);
    assert.equal(useFileStore.getState().workspaceFileVersion, unscopedVersion);
    assert.equal(refreshVisibleCalls, unscopedVisible);

    // Cache listeners are synchronous and may retire the source mid-handler.
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-clear-race' });
    const clearRaceSource = FakeEventSource.instances.at(-1)!;
    clearRaceSource.emit('connected', { clientId: 'client-clear-race', workspaceId: 'workspace-clear-race' });
    const clearRaceVersion = useFileStore.getState().workspaceFileVersion;
    const clearRaceVersions = workspaceVersionChanges.length;
    const clearRaceVisible = refreshVisibleCalls;
    const clearRaceValidation = validationInvalidations.length;
    const clearRaceFile = useFileStore.getState().currentFile;
    switchAfterValidation = 'workspace-after-clear';
    clearRaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-clear-race' });
    assert.equal(clearRaceSource.closed, true);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-after-clear');
    assert.equal(validationInvalidations.length, clearRaceValidation + 1);
    assert.deepEqual(validationInvalidations.at(-1), { workspaceId: 'workspace-clear-race', path: null });
    assert.equal(workspaceVersionChanges.length, clearRaceVersions);
    assert.equal(useFileStore.getState().workspaceFileVersion, clearRaceVersion);
    assert.equal(refreshVisibleCalls, clearRaceVisible, 'cache invalidation cannot refresh a replacement workspace');
    assert.equal(terminalEvents.length, 3);
    assert.equal(refreshedDirectories.length, terminalRefreshes);
    assert.equal(useFileStore.getState().currentFile, clearRaceFile);
    assert.equal(contentRefreshCalls, terminalContentRefreshes);

    // Store subscribers are synchronous too: the version may publish before
    // retiring A, but neither B's tree nor an old hint may then be refreshed.
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-version-race' });
    const versionRaceSource = FakeEventSource.instances.at(-1)!;
    versionRaceSource.emit('connected', { clientId: 'client-version-race', workspaceId: 'workspace-version-race' });
    const versionRaceVersion = useFileStore.getState().workspaceFileVersion;
    const versionRaceVersions = workspaceVersionChanges.length;
    const versionRaceVisible = refreshVisibleCalls;
    const versionRaceValidation = validationInvalidations.length;
    const versionRaceFile = useFileStore.getState().currentFile;
    switchAfterVersion = 'workspace-after-version';
    versionRaceSource.emit('workspace-invalidated', { workspaceId: 'workspace-version-race' });
    assert.equal(versionRaceSource.closed, true);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-after-version');
    assert.equal(validationInvalidations.length, versionRaceValidation + 1);
    assert.deepEqual(validationInvalidations.at(-1), { workspaceId: 'workspace-version-race', path: null });
    assert.equal(workspaceVersionChanges.length, versionRaceVersions + 1);
    assert.deepEqual(workspaceVersionChanges.at(-1), { workspaceId: 'workspace-version-race', version: versionRaceVersion + 1 });
    assert.equal(useFileStore.getState().workspaceFileVersion, versionRaceVersion + 1);
    assert.equal(refreshVisibleCalls, versionRaceVisible, 'version publication cannot refresh a replacement workspace');
    assert.equal(terminalEvents.length, 3);
    assert.equal(refreshedDirectories.length, terminalRefreshes);
    assert.equal(useFileStore.getState().currentFile, versionRaceFile);
    assert.equal(contentRefreshCalls, terminalContentRefreshes);
    client.removeEventListener('workspace-invalidated', onWorkspaceInvalidated);
    client.removeEventListener('filechange', onWorkspaceInvalidated);

    client.disconnect();
    assert.equal(source.closed, true);
  } finally {
    unsubscribeValidation?.();
    unsubscribeVersion?.();
    client?.disconnect();
    useFileStore.setState(originalFileState, true);
    useWorkspaceStore.setState(originalWorkspaceState, true);
    globalThis.fetch = originalFetch;
  }

  console.log('file-watcher-client-test: ok');
}

void main();
