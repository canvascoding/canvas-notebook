import assert from 'node:assert/strict';
import { mergeRootNodesPreservingChildren, mergeSubtreeChildren, mergeUploadedFileNodes } from '../app/lib/files/tree-utils';
import { sortFileTree } from '../app/lib/files/sort';
import { UploadTreeBatch, UploadVersionGuard } from '../app/lib/files/upload-tree-batch';
import { uploadWorkspaceFiles } from '../app/lib/files/client';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { beginUploadJob } from '../app/store/upload-store';
import type { FileNode } from '../app/lib/files/types';

const file = (path: string): FileNode => ({ path, name: path.split('/').pop()!, type: 'file' });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tree: FileNode[] = [{ path: 'docs', name: 'docs', type: 'directory', children: [file('docs/a.txt')] },
    { path: 'closed', name: 'closed', type: 'directory' }, file('z.txt')];
  assert.equal(mergeRootNodesPreservingChildren(tree.map((node) => ({ ...node })), tree), tree);
  assert.equal(mergeSubtreeChildren(tree, 'docs', [file('docs/a.txt')]), tree);
  const changed = mergeUploadedFileNodes(tree, [file('docs/b.txt'), ...Array.from({ length: 1000 }, (_, i) => file(`new/deep/${i}.txt`))]);
  assert.equal(changed[1], tree[1]);
  assert.equal(changed[2], tree[2]);
  assert.equal(changed[0].children?.[0], tree[0].children?.[0]);
  assert.deepEqual(changed.at(-1), { path: 'new', name: 'new', type: 'directory' });
  assert.equal(mergeUploadedFileNodes(tree, [file('closed/new.txt')]), tree, 'closed branch stays lazy');
  const sorted = sortFileTree(changed, 'name', 'asc');
  assert.equal(sortFileTree(changed, 'name', 'asc'), sorted, 'unchanged tree reuses sorting');
  assert.equal(sortFileTree(mergeUploadedFileNodes(changed, [file('new-root.txt')]), 'name', 'asc')[1], sorted[1]);

  const guard = new UploadVersionGuard();
  const since = guard.snapshot();
  const result = { targetPath: 'docs/new.txt', node: file('docs/new.txt'), fileVersion: 'v1' };
  assert.ok(guard.accepts('a', result, since));
  guard.observe('a', result.targetPath, 'v1');
  assert.ok(guard.accepts('a', result, since));
  guard.observe('a', result.targetPath, 'v2');
  assert.equal(guard.accepts('a', result, since), false, 'newer event wins over HTTP response');
  guard.observe('a', result.targetPath, 'v1');
  guard.observe('a', 'docs');
  assert.equal(guard.accepts('a', result, since), false, 'ancestor deletion suppresses stale inserts');
  let publications = 0;
  let published: FileNode[] = [];
  const batch = new UploadTreeBatch(() => true, (nodes) => { publications++; published = nodes; }, 10);
  for (let i = 0; i < 100; i++) batch.add({ targetPath: `f${i}.txt`, node: file(`f${i}.txt`) });
  assert.equal(publications, 0);
  await delay(20);
  assert.equal(publications, 1);
  assert.equal(published.length, 100);
  assert.ok(batch.directories.has('.'));

  const originalFetch = globalThis.fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: 'upload-tree' });
  useFileStore.getState().resetWorkspaceView('upload-tree');
  useFileStore.setState({ fileTree: tree, directoryLoadStates: { '.': 'ready', docs: 'ready' } });
  const empty = new File([], 'new.txt');
  const job = beginUploadJob([empty], 'docs', 'upload-tree');
  globalThis.fetch = (async (input) => {
    if (String(input) === '/api/files/uploads') return Response.json({ success: true, upload: { id: 's', files: [{ id: 'f', sourceIndex: 0, uploadedBytes: 0 }] } });
    return Response.json({ success: true, committed: { ...result, node: { ...result.node, size: 0, modified: 100 } } });
  }) as typeof fetch;
  try {
    await useFileStore.getState().uploadFile(empty, 'docs', undefined, undefined, { job, refreshTree: false });
    useFileStore.getState().applyPathsDeleted(['docs/new.txt'], 'upload-tree');
    await delay(520);
    assert.equal(useFileStore.getState().fileTree[0].children?.some((node) => node.name === 'new.txt'), false,
      'a deletion after confirmation but before batch publication wins');
    useWorkspaceStore.setState({ activeWorkspaceId: 'other' });
    await useFileStore.getState().reconcileUpload(job);
  } finally { globalThis.fetch = originalFetch; }

  const originalXhr = globalThis.XMLHttpRequest;
  class ConvertedUploadXhr {
    upload = {}; status = 200;
    responseText = JSON.stringify({ success: true, files: ['photo.jpg'], committed: [{ targetPath: 'photos/photo.jpg', node: file('photos/photo.jpg') }] });
    onload?: () => void;
    open() {} setRequestHeader() {}
    send() { queueMicrotask(() => this.onload?.()); }
  }
  globalThis.XMLHttpRequest = ConvertedUploadXhr as unknown as typeof XMLHttpRequest;
  try {
    const received: string[] = [];
    const converted = await uploadWorkspaceFiles({ files: [new File(['image'], 'photo.heic')], targetDir: 'photos',
      convertParams: [{ format: 'jpg', quality: 80 }], onFileCompleted: (entry) => received.push(entry.targetPath) });
    assert.equal(converted.completed[0].path, 'photo.jpg');
    assert.deepEqual(received, ['photos/photo.jpg']);
  } finally { globalThis.XMLHttpRequest = originalXhr; }
  console.log('notebook-upload-tree-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
