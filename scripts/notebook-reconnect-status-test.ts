import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { validateFileReference, invalidateFileReferenceValidationCache } from '../app/lib/chat/validate-file-paths';
import { previewMayDependOn, previewDependencyDirectories } from '../app/lib/files/preview-dependencies';

class Source extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  static instances: Source[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { super(); Source.instances.push(this); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(workspaceId: string) {
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [] }],
    currentDirectory: 'docs', currentFile: { path: 'docs/a.ts', content: 'base' }, currentFileWorkspaceId: workspaceId });
  useEditorStore.getState().setActiveFile('docs/a.ts', 'base');
}
async function main() {
  const calls: Array<{ path: string; workspaceId: string | null; body?: string }> = [];
  let serverContent = 'base';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push({ path: url.pathname + (url.searchParams.get('path') ?? ''), workspaceId: url.searchParams.get('workspaceId') ?? new Headers(init?.headers).get('X-Workspace-Id'), body: String(init?.body ?? '') });
    if (url.pathname === '/api/files/tree') return Response.json({ success: true, data: url.searchParams.get('path') === '.'
      ? [{ path: 'docs', name: 'docs', type: 'directory' }] : [{ path: 'docs/a.ts', name: 'a.ts', type: 'file', size: serverContent.length }] });
    return Response.json({ success: true, data: { content: serverContent, stats: { size: serverContent.length, modified: 1, permissions: '100644' } } });
  }) as typeof fetch;
  setup('a'); const client = new FileWatcherClient(url => new Source(url)); client.acquire();
  const first = Source.instances.at(-1)!;
  first.emit('connected', { clientId: 'first', workspaceId: 'a' }); await delay();
  assert.ok(calls.some((call) => call.path === '/api/files/tree.'));
  assert.ok(calls.some((call) => call.path === '/api/files/treedocs'));
  first.onerror?.(); serverContent = 'changed while disconnected';
  useEditorStore.getState().updateDraft('local draft');
  client.reconnectNow(); const reconnected = Source.instances.at(-1)!;
  reconnected.emit('connected', { clientId: 'second', workspaceId: 'a' }); await delay();
  assert.equal(useFileStore.getState().pendingExternalFile?.content, serverContent);
  assert.equal(useEditorStore.getState().draft, 'local draft');
  const event = { type: 'change', path: 'docs/a.ts', relativePath: 'docs/a.ts', dir: 'docs', workspaceId: 'a', timestamp: Date.now() };
  reconnected.emit('filechange', event); await delay();
  reconnected.emit('filechange', event); // leave a delayed metadata refresh queued
  client.syncDirs(['old-workspace-folder']);
  setup('b');
  const latest = Source.instances.at(-1)!;
  latest.emit('connected', { clientId: 'third', workspaceId: 'b' }); await delay();
  const version = useFileStore.getState().workspaceFileVersion;
  first.emit('connected', { clientId: 'obsolete', workspaceId: 'a' });
  reconnected.emit('filechange', { ...event, type: 'unlink' });
  await delay(300);
  assert.equal(useFileStore.getState().workspaceFileVersion, version, 'closed sources cannot affect the new workspace');
  assert.ok(calls.filter((call) => call.workspaceId === 'b').every((call) => !call.body?.includes('old-workspace-folder')));
  assert.equal(useFileStore.getState().currentFile?.unavailable, undefined);
  client.releaseConnection();
  setup('c');
  client.acquire();
  assert.ok(Source.instances.at(-1)?.url.includes('workspaceId=c'), 'reacquiring during the grace period cannot reuse another workspace connection');
  client.disconnect();
  setup('b');

  invalidateFileReferenceValidationCache({ workspaceId: 'b' });
  let finishOld!: (response: Response) => void;
  let validationReads = 0;
  globalThis.fetch = (async () => ++validationReads === 1 ? new Promise<Response>((resolve) => { finishOld = resolve; })
    : Response.json({ success: true, exists: false })) as typeof fetch;
  const oldValidation = validateFileReference('removed.ts', [], { preferFresh: true });
  invalidateFileReferenceValidationCache({ workspaceId: 'b', path: 'removed.ts' });
  const freshValidation = await validateFileReference('removed.ts', [{ path: 'removed.ts', name: 'removed.ts', type: 'file' }], { preferFresh: true });
  assert.equal(freshValidation.exists, false, 'stale cached tree entries cannot validate an invalidated chat reference');
  finishOld(Response.json({ success: true, exists: true, type: 'file' })); await oldValidation;
  assert.equal((await validateFileReference('removed.ts', [], { preferFresh: true })).exists, false, 'old replies cannot repopulate the invalidated cache');
  invalidateFileReferenceValidationCache({ workspaceId: 'b' });
  assert.deepEqual(previewDependencyDirectories('pages/index.htm', '<link href="../assets/site.css"><script src="https://external.test/app.js"></script>'), ['assets']);
  assert.equal(previewMayDependOn('pages/index.htm', '<link href="../assets/site.css">', 'assets/nested/font.woff2'), true);
  assert.equal(previewMayDependOn('pages/index.html', '', 'other/unrelated.md'), false);
  console.log('notebook-reconnect-status-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
