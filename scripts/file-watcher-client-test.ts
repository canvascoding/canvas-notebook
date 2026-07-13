import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { LocalFileWriteTracker } from '../app/lib/files/local-write-tracker';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

class FakeMessageEvent extends Event {
  data: string;

  constructor(type: string, data: unknown) {
    super(type);
    this.data = JSON.stringify(data);
  }
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;
  readonly withCredentials?: boolean;

  constructor(url: string, init?: EventSourceInit) {
    super();
    this.url = url;
    this.withCredentials = init?.withCredentials;
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
  const OriginalEventSource = globalThis.EventSource;
  const fetchCalls: Array<{ url: string; body: { clientId?: string; dirs?: string[] } | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ success: true });
  }) as typeof fetch;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  useWorkspaceStore.setState({ activeWorkspaceId: null });

  let refreshVisibleCalls = 0;
  const refreshedDirectories: Array<{ dirPath: string; noCache?: boolean }> = [];

  useFileStore.setState({
    browserMode: 'list',
    currentDirectory: 'docs/current',
    expandedDirs: new Set(['hidden-expanded']),
    refreshVisibleTree: async () => {
      refreshVisibleCalls += 1;
    },
    refreshDirectory: async (dirPath, noCache) => {
      refreshedDirectories.push({ dirPath, noCache });
    },
  });

  try {
    testLocalWriteTracker();

    const client = new FileWatcherClient();
    client.acquire();

    const source = FakeEventSource.instances[0];
    assert.ok(source, 'EventSource should be created on acquire');
    assert.equal(source.url, '/api/files/watch');
    assert.equal(source.withCredentials, true);

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
    });
    await delay(25);

    assert.equal(refreshVisibleCalls, 0);
    assert.deepEqual(refreshedDirectories, [{ dirPath: 'docs/current', noCache: true }]);

    workspaceSource.emit('filechange', {
      type: 'change',
      workspaceId: 'workspace-two',
      path: '/data/workspace/docs/current/fresh.md',
      relativePath: 'docs/current/fresh.md',
      dir: 'docs/current',
      timestamp: Date.now(),
    });
    await delay(FileWatcherClient.SYNC_DEBOUNCE_MS + 25);

    assert.equal(refreshVisibleCalls, 0);
    assert.deepEqual(refreshedDirectories, [{ dirPath: 'docs/current', noCache: true }]);

    client.disconnect();
    assert.equal(source.closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = OriginalEventSource;
  }

  console.log('file-watcher-client-test: ok');
}

void main();
