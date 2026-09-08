import assert from 'node:assert/strict';
import { useFileStore, type FileNode } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { findNodeInTree } from '../app/lib/files/tree-utils';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
const file = (path: string): FileNode => ({ path, name: path.split('/').pop()!, type: 'file' });
const folder = (path: string, children?: FileNode[]): FileNode => ({ path, name: path.split('/').pop()!, type: 'directory', children });
const response = (nodes: FileNode[]) => Response.json({ success: true, data: nodes });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function setup() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.getState().resetWorkspaceView('ws-a');
  useFileStore.setState({ fileTree: [folder('docs', [file('docs/removed.txt'), folder('docs/nested', [file('docs/nested/kept.txt')])])],
    expandedDirs: new Set(['docs', 'docs/nested']) });
}

async function main() {
  setup();
  const requests: ReturnType<typeof deferred<Response>>[] = [];
  globalThis.fetch = (async () => {
    const request = deferred<Response>();
    requests.push(request);
    return request.promise;
  }) as typeof fetch;
  const first = useFileStore.getState().refreshDirectory('docs', true);
  assert.equal(useFileStore.getState().directoryLoadStates.docs, 'refreshing');
  assert.ok(findNodeInTree('docs/nested/kept.txt', useFileStore.getState().fileTree));
  useFileStore.getState().applyPathsDeleted(['docs/removed.txt'], 'ws-a');
  const second = useFileStore.getState().refreshDirectory('docs', true);
  let resurrected = false;
  const unsubscribe = useFileStore.subscribe((state) => {
    if (findNodeInTree('docs/removed.txt', state.fileTree)) resurrected = true;
  });
  requests[0].resolve(response([file('docs/removed.txt'), folder('docs/nested')]));
  await tick();
  assert.equal(requests.length, 2, 'mutation during a no-cache read requires another read');
  assert.equal(resurrected, false, 'an obsolete response must never be published');
  useFileStore.getState().markDirectoryStale('docs');
  requests[1].resolve(response([file('docs/intermediate.txt'), folder('docs/nested')]));
  await tick();
  assert.equal(requests.length, 3, 'an event alone also invalidates an active read');
  assert.equal(findNodeInTree('docs/intermediate.txt', useFileStore.getState().fileTree), null);
  useFileStore.getState().collapseAllDirectories();
  requests[2].resolve(response([file('docs/final.txt'), folder('docs/nested')]));
  await Promise.all([first, second]);
  unsubscribe();
  assert.equal(resurrected, false);
  assert.ok(findNodeInTree('docs/nested/kept.txt', useFileStore.getState().fileTree), 'parent refresh preserves loaded descendants');
  assert.equal(useFileStore.getState().expandedDirs.size, 0, 'background refresh must respect a later collapse');
  assert.equal(useFileStore.getState().directoryLoadStates.docs, 'ready');
  assert.equal(useFileStore.getState().staleDirs.has('docs'), false);

  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
  await useFileStore.getState().refreshDirectory('docs', true);
  assert.equal(useFileStore.getState().directoryLoadStates.docs, 'error');
  assert.ok(findNodeInTree('docs/final.txt', useFileStore.getState().fileTree), 'errors retain the previous snapshot');
  globalThis.fetch = (async () => response([file('docs/recovered.txt')])) as typeof fetch;
  await useFileStore.getState().refreshDirectory('docs', true);
  assert.equal(useFileStore.getState().directoryLoadStates.docs, 'ready');
  assert.equal(useFileStore.getState().directoryErrors.docs, undefined);

  setup();
  const staleRoot = deferred<Response>();
  let rootReads = 0;
  globalThis.fetch = (async () => ++rootReads === 1 ? staleRoot.promise : response([])) as typeof fetch;
  const root = useFileStore.getState().refreshRootTree(true);
  useFileStore.getState().applyPathsDeleted(['docs'], 'ws-a');
  staleRoot.resolve(response([folder('docs')]));
  await root;
  assert.equal(rootReads, 2);
  assert.deepEqual(useFileStore.getState().fileTree, []);

  setup();
  const oldWorkspace = deferred<Response>();
  globalThis.fetch = (async () => oldWorkspace.promise) as typeof fetch;
  const oldRead = useFileStore.getState().refreshDirectory('docs', true);
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' });
  useFileStore.getState().resetWorkspaceView('ws-b');
  oldWorkspace.resolve(response([file('docs/wrong-workspace.txt')]));
  await oldRead;
  assert.deepEqual(useFileStore.getState().fileTree, []);
  assert.deepEqual(useFileStore.getState().directoryLoadStates, {});
  console.log('notebook-directory-races-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
