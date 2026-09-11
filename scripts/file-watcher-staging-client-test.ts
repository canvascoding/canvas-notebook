import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { subscribeWorkspaceLinkIndexInvalidation } from '../app/lib/markdown/workspace-link-index-client';

class Source extends EventTarget {
  static latest: Source;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor() { super(); Source.latest = this; }
  close() {}
  emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  let missing = false;
  let invalidations = 0;
  const client = new FileWatcherClient(() => new Source());
  const unsubscribe = subscribeWorkspaceLinkIndexInvalidation(() => { invalidations++; });
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files/read') {
      reads.push(url.searchParams.get('path')!);
      if (missing) return new Response(null, { status: 404 });
      return Response.json({ data: { content: 'live', stats: { size: 4, modified: 1, permissions: '100644' } } });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'staging-client' });
    useFileStore.getState().resetWorkspaceView('staging-client');
    useFileStore.setState({ currentFile: { path: 'live.md', content: 'live' }, currentFileWorkspaceId: 'staging-client',
      refreshVisibleTree: async () => {}, revalidateDirectory: async () => {} });
    useEditorStore.getState().setActiveFile('live.md', 'live');
    client.acquire();
    Source.latest.emit('connected', { clientId: 'staging', workspaceId: 'staging-client' });
    await delay(300);
    reads.length = 0; invalidations = 0;
    const event = { workspaceId: 'staging-client', dir: '.', timestamp: Date.now(), path: '/workspace/live.md' };
    const staging = 'live.md.canvas-write-c00591d7-9711-4a2d-ab12-54e2b4932093.tmp';
    for (const type of ['add', 'change', 'unlink']) {
      Source.latest.emit('filechange', { ...event, type, relativePath: staging });
    }
    await delay(550);
    assert.deepEqual(reads, [], 'staging events from an older server must cause no /files/read requests');
    assert.equal(invalidations, 0, 'staging events must not invalidate the workspace link index');

    Source.latest.emit('filechange', { ...event, type: 'unlink', relativePath: 'live.md' });
    await delay(20);
    assert.deepEqual(reads, ['live.md']);
    assert.equal(useFileStore.getState().currentFile?.unavailable, undefined,
      'a delayed unlink from atomic replacement must not detach an existing file');
    missing = true;
    Source.latest.emit('filechange', { ...event, type: 'unlink', relativePath: 'live.md' });
    await delay(20);
    assert.equal(useFileStore.getState().currentFile?.unavailable, 'deleted', 'a confirmed real delete must still preserve the recovery editor');
  } finally {
    client.disconnect(); unsubscribe();
    globalThis.fetch = originalFetch;
  }
  console.log('file-watcher-staging-client-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
