import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { documentCapabilities, withDocumentRevision } from '../app/lib/files/document-capabilities';
import { FileWatcherClient } from '../app/lib/file-watcher/client';

const stats = (hash: string) => ({ size: 20, modified: 1, permissions: '100644', sha256: hash });
const payload = (content: string, hash = 'new') => Response.json({ success: true, data: { content, stats: stats(hash) } });
function setup(path: string) {
  useWorkspaceStore.setState({ activeWorkspaceId: 'revisions' });
  useFileStore.getState().resetWorkspaceView('revisions');
  useFileStore.setState({ currentFile: { path, viewId: 'identity', content: 'base', stats: stats('base') }, currentFileWorkspaceId: 'revisions' });
  useEditorStore.getState().setActiveFile(path, 'base');
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
class Source extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  static latest: Source;
  constructor() { super(); Source.latest = this; }
  onerror: (() => void) | null = null;
  close() {}
  change(path: string) { this.dispatchEvent(new MessageEvent('filechange', { data: JSON.stringify({ type: 'change', relativePath: path, path, dir: '.', workspaceId: 'revisions', timestamp: Date.now() }) })); }
}
async function main() {
  for (const extension of ['ts', 'mdx', 'htm', 'html', 'excalidraw', 'png', 'pdf', 'docx', 'xlsx', 'csv', 'pptx', 'mp4', 'mp3']) {
    const path = `active.${extension}`; setup(path);
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input), 'http://localhost');
      assert.equal(url.searchParams.get('meta'), documentCapabilities(path).text ? null : '1');
      return payload('external');
    }) as typeof fetch;
    await useFileStore.getState().refreshCurrentFileContent(path);
    assert.equal(useFileStore.getState().currentFile?.stats?.sha256, 'new', extension);
    assert.equal(useFileStore.getState().currentFile?.viewId, 'identity');
    assert.equal(useFileStore.getState().currentFile?.content, documentCapabilities(path).text ? 'external' : 'base');
  }
  setup('active.ts');
  const slow = deferred<Response>();
  globalThis.fetch = (async () => slow.promise) as typeof fetch;
  const loading = useFileStore.getState().refreshCurrentFileContent('active.ts');
  useEditorStore.getState().updateDraft('typed during read');
  slow.resolve(payload('agent edit')); await loading;
  assert.equal(useEditorStore.getState().draft, 'typed during read');
  assert.equal(useFileStore.getState().pendingExternalFile?.content, 'agent edit');
  assert.equal(useFileStore.getState().documentSyncStatus, 'conflict');
  await assert.rejects(useFileStore.getState().saveFile('active.ts', 'typed during read'), /Resolve the conflict/);

  setup('active.ts');
  const writeReply = deferred<Response>();
  let writeStarted = false;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/write')) { writeStarted = true; return writeReply.promise; }
    return payload('own first save');
  }) as typeof fetch;
  useEditorStore.getState().updateDraft('own first save');
  const saving = useFileStore.getState().saveFile('active.ts', 'own first save');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writeStarted, true);
  useEditorStore.getState().updateDraft('typed after save started');
  await useFileStore.getState().refreshCurrentFileContent('active.ts');
  assert.equal(useFileStore.getState().pendingExternalFile, null, 'our own save echo is not an external conflict');
  writeReply.resolve(payload('own first save')); await saving;
  assert.equal(useEditorStore.getState().draft, 'typed after save started');

  for (const path of ['scene.excalidraw', 'book.docx', 'table.xlsx']) {
    setup(path);
    const unregister = registerDocumentTransitionGuard('revisions', path, { hasPendingChanges: () => true, prepare: async () => {} });
    globalThis.fetch = (async () => payload('agent edit')) as typeof fetch;
    assert.equal(await useFileStore.getState().refreshCurrentFileContent(path), null);
    assert.equal(useFileStore.getState().currentFile?.stats?.sha256, 'base', 'dirty view keeps its loaded revision');
    assert.equal(useFileStore.getState().pendingExternalFile?.stats?.sha256, 'new');
    await useFileStore.getState().refreshCurrentFileContent(path, { allowDirty: true });
    assert.equal(useFileStore.getState().pendingExternalFile, null);
    assert.equal(useFileStore.getState().currentFile?.stats?.sha256, 'new');
    unregister();
  }
  setup('book.docx');
  const officeWrite = deferred<Response>();
  const stopOfficeGuard = registerDocumentTransitionGuard('revisions', 'book.docx', { hasPendingChanges: () => true, prepare: async () => {} });
  globalThis.fetch = (async (input) => String(input).includes('/write') ? officeWrite.promise : payload('')) as typeof fetch;
  const savingOffice = useFileStore.getState().saveFile('book.docx', 'base64:AA==');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await useFileStore.getState().refreshCurrentFileContent('book.docx');
  assert.ok(useFileStore.getState().pendingExternalFile);
  officeWrite.resolve(payload('')); await savingOffice;
  assert.equal(useFileStore.getState().pendingExternalFile, null, 'a matching confirmed Office save resolves its own metadata echo');
  stopOfficeGuard();
  let nativeVersion = 1;
  const stopVersionGuard = registerDocumentTransitionGuard('revisions', 'book.docx', { hasPendingChanges: () => true, prepare: async () => {}, localChangeVersion: () => nativeVersion });
  const nativeRead = deferred<Response>();
  globalThis.fetch = (async () => nativeRead.promise) as typeof fetch;
  const reloadOffice = useFileStore.getState().refreshCurrentFileContent('book.docx', { allowDirty: true });
  nativeVersion += 1;
  nativeRead.resolve(payload('', 'newer')); await reloadOffice;
  assert.equal(useFileStore.getState().currentFile?.stats?.sha256, 'new');
  assert.equal(useFileStore.getState().pendingExternalFile?.stats?.sha256, 'newer', 'native edits made after reload was requested remain protected');
  stopVersionGuard();

  setup('active.ts');
  useEditorStore.getState().updateDraft('recover');
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  await useFileStore.getState().refreshCurrentFileContent('active.ts');
  assert.equal(useFileStore.getState().currentFile?.unavailable, 'deleted');
  assert.equal(useEditorStore.getState().draft, 'recover');

  setup('image.png');
  const client = new FileWatcherClient(() => new Source()); client.acquire();
  globalThis.fetch = (async () => payload('')) as typeof fetch;
  Source.latest.change('image.png');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(useFileStore.getState().fileRevisions['image.png'], 'new', 'revision arrives with no viewer mounted');
  client.disconnect();
  assert.equal(withDocumentRevision('/api/media/file?workspaceId=w#page=2', 'sha+1'), '/api/media/file?workspaceId=w&revision=sha%2B1#page=2');
  console.log('notebook-document-revisions-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
