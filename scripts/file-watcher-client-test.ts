import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
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
