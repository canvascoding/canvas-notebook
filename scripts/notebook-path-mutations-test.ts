import assert from 'node:assert/strict';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { findNodeInTree } from '../app/lib/files/tree-utils';
import type { WorkspacePathRenameMutation } from '../app/lib/files/file-events';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import type { CurrentFile, FileNode } from '../app/lib/files/types';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';

class Source extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  static latest: Source;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { super(); Source.latest = this; }
  close() {}
  emit(data: unknown) { this.dispatchEvent(new MessageEvent('filechange', { data: JSON.stringify(data) })); }
}
function setup() {
  // Unit session observation; no backend authentication is claimed.
  observeOpenedDocumentAuth({ data: { user: { id: 'mutation-user' }, session: { id: 'mutation-session' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' });
  useFileStore.getState().resetWorkspaceView('ws-a');
  useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [
    { path: 'docs/a.txt', name: 'a.txt', type: 'file' },
  ] }], currentDirectory: 'docs', expandedDirs: new Set(['docs']),
  currentFile: { path: 'docs/a.txt', content: 'base', stats: { size: 4, modified: 1, permissions: '100644' } },
  currentFileWorkspaceId: 'ws-a' });
  useEditorStore.getState().setActiveFile('docs/a.txt', 'base');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function main() {
  for (const eventFirst of [true, false]) {
    setup();
    const client = new FileWatcherClient(() => new Source());
    client.acquire();
    const response = deferred<Response>();
    const planId = (eventFirst ? 'a' : 'b').repeat(64);
    let previews = 0, applies = 0;
    const mutation: WorkspacePathRenameMutation = { type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-a', oldPath: 'docs/a.txt', newPath: 'docs/b.txt' };
    globalThis.fetch = (async (input, init) => {
      if (!String(input).includes('/rename')) return Response.json({ success: true, data: [] });
      const body = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), 'ws-a');
      if (body.dryRun === true) {
        previews++;
        assert.deepEqual(body, { oldPath: mutation.oldPath, newPath: mutation.newPath, dryRun: true });
        return Response.json({ dryRun: true, requiresRevalidation: true, plan: {
          planId, kind: 'rename', readiness: 'ready', pathMappings: [{ sourcePath: mutation.oldPath, destinationPath: mutation.newPath }],
          linkEdits: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
        } });
      }
      applies++;
      assert.match(String(body.idempotencyKey), /^[a-f0-9-]{36}$/u);
      assert.deepEqual(body, { oldPath: mutation.oldPath, newPath: mutation.newPath, overwrite: false,
        planId, idempotencyKey: body.idempotencyKey });
      return response.promise;
    }) as typeof fetch;
    const rename = useFileStore.getState().renamePath(mutation.oldPath, mutation.newPath, false, false);
    await tick();
    assert.equal(previews, 1, 'the real client reads its preview before the held apply');
    assert.equal(applies, 1, 'only apply is held while watcher/local edits interleave');
    // Local edits after the request starts must survive both delivery orders.
    useEditorStore.getState().updateDraft('local changes during rename');
    const emit = () => Source.latest.emit({ type: 'rename', workspaceId: 'ws-a', path: mutation.newPath, relativePath: mutation.newPath, dir: 'docs', timestamp: Date.now(), mutation });
    if (eventFirst) emit();
    response.resolve(Response.json({ success: true, mutation, operation: {
      batchId: `notebook-rename-${mutation.operationId}`, planId, workspaceId: 'ws-a', kind: 'rename',
      selections: [{ sourcePath: mutation.oldPath, destinationPath: mutation.newPath }],
      status: 'applied', phase: 'complete', completedActions: 1, totalActions: 1, errorCode: null,
    } }));
    await rename;
    if (!eventFirst) emit();
    emit();
    assert.equal(useFileStore.getState().currentFile?.path, 'docs/b.txt');
    assert.equal(useEditorStore.getState().draft, 'local changes during rename');
    assert.equal(useEditorStore.getState().activePath, 'docs/b.txt');
    assert.ok(findNodeInTree('docs/b.txt', useFileStore.getState().fileTree));
    assert.equal(findNodeInTree('docs/a.txt', useFileStore.getState().fileTree), null);
    client.disconnect();
  }

  setup();
  useEditorStore.getState().updateDraft('keep me');
  const client = new FileWatcherClient(() => new Source());
  client.acquire();
  const deletionChecks: string[] = [];
  globalThis.fetch = (async (input) => {
    deletionChecks.push(String(input));
    return Response.json({ success: true, data: { exists: false } });
  }) as typeof fetch;
  Source.latest.emit({ type: 'unlinkDir', workspaceId: 'ws-a', path: 'files', relativePath: 'files', dir: '.', timestamp: Date.now() });
  Source.latest.emit({ type: 'unlinkDir', workspaceId: 'ws-a', path: 'docs', relativePath: 'docs', dir: '.', timestamp: Date.now() });
  await tick();
  assert.deepEqual(deletionChecks, [
    '/api/files/exists?path=files&workspaceId=ws-a',
    '/api/files/exists?path=docs&workspaceId=ws-a',
  ]);
  assert.equal(deletionChecks.some((url) => url.includes('/api/files/read')), false, 'expected deletion checks must not create browser-visible 404 reads');
  assert.equal(useFileStore.getState().currentFile?.unavailable, 'deleted');
  assert.equal(useEditorStore.getState().draft, 'keep me');
  await assert.rejects(useFileStore.getState().prepareCurrentFileForTransition(), /no longer available/);
  await assert.rejects(useFileStore.getState().saveFile('docs/a.txt', 'keep me'), /moved or deleted/);
  client.disconnect();

  setup();
  const replacement = new FileWatcherClient(() => new Source());
  replacement.acquire();
  globalThis.fetch = (async () => Response.json({ success: true, data: { exists: true } })) as typeof fetch;
  Source.latest.emit({ type: 'unlink', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  await tick();
  assert.equal(useFileStore.getState().currentFile?.unavailable, undefined, 'atomic replacement must not detach an existing file');
  replacement.disconnect();

  setup();
  const delayed = new FileWatcherClient(() => new Source());
  delayed.acquire();
  const missing = deferred<Response>();
  let missingReads = 0;
  globalThis.fetch = (async () => ++missingReads === 1 ? missing.promise : Response.json({ success: true, data: { exists: true } })) as typeof fetch;
  Source.latest.emit({ type: 'unlink', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  Source.latest.emit({ type: 'add', workspaceId: 'ws-a', path: 'docs/a.txt', relativePath: 'docs/a.txt', dir: 'docs', timestamp: Date.now() });
  missing.resolve(Response.json({ success: true, data: { exists: false } }));
  await tick();
  assert.equal(useFileStore.getState().currentFile?.unavailable, undefined, 'a newer creation invalidates the earlier absence check');
  delayed.disconnect();

  setup();
  useEditorStore.getState().updateDraft('folder draft');
  const folderMutation: WorkspacePathRenameMutation = { type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-a', oldPath: 'docs', newPath: 'archive' };
  useFileStore.getState().applyPathRename(folderMutation);
  assert.equal(useFileStore.getState().currentFile?.path, 'archive/a.txt');
  assert.equal(useEditorStore.getState().draft, 'folder draft');
  assert.equal(useFileStore.getState().currentDirectory, 'archive');
  assert.ok(findNodeInTree('archive/a.txt', useFileStore.getState().fileTree));
  assert.equal(useFileStore.getState().applyPathRename(folderMutation), false);

  setup();
  useFileStore.getState().applyPathRename({ type: 'rename', operationId: crypto.randomUUID(), workspaceId: 'ws-other', oldPath: 'docs', newPath: 'elsewhere' });
  assert.equal(useFileStore.getState().currentFile?.path, 'docs/a.txt');

  // Unit lost-response replay through the actual client and stores. No backend
  // authentication, original receipt or committed filesystem action is claimed.
  for (const kind of ['rename', 'delete'] as const) for (const prepared of [true, false]) {
    setup();
    const suffix = `${kind}-${prepared ? 'prepared' : 'ordinary'}`;
    const oldPath = `docs/replay-${suffix}.md`, newPath = `docs/replay-${suffix}-moved.md`;
    const planId = (kind === 'rename' ? prepared ? 'c' : 'd' : prepared ? 'e' : 'f').repeat(64);
    const nativePlanId = prepared ? '9'.repeat(64) : planId;
    const oldNode: FileNode = { path: oldPath, name: oldPath.split('/').at(-1)!, type: 'file', title: `Original D1 ${suffix}`, modified: 1, size: 12 };
    useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: [oldNode] }],
      selectedNode: oldNode, currentFile: { path: oldPath, content: 'Original D1', viewId: `d1-${suffix}` }, currentFileWorkspaceId: 'ws-a' });
    useEditorStore.getState().setActiveFile(oldPath, 'Original D1');
    const methods = useFileStore.getState();
    const actualMethods = { rename: methods.renamePath, remove: methods.deletePath, refresh: methods.refreshDirectory,
      load: methods.loadSubdirectory, prepare: methods.prepareCurrentFileForTransition,
      applyRename: methods.applyPathRename, applyDelete: methods.applyPathsDeleted };
    const operation: WorkspacePathOperationPublic = {
      batchId: `replay-${crypto.randomUUID()}`, planId: nativePlanId, workspaceId: 'ws-a', kind,
      ...(prepared ? { preparation: { previewPlanId: planId } } : {}),
      selections: [{ sourcePath: oldPath, ...(kind === 'rename' ? { destinationPath: newPath } : {}) }],
      status: 'applied', phase: 'complete', completedActions: 1, totalActions: 1, errorCode: null,
    };
    const originalMutation: WorkspacePathRenameMutation = { type: 'rename', operationId: crypto.randomUUID(),
      workspaceId: 'ws-a', oldPath, newPath };
    const originalReply = kind === 'rename' ? { operation, historical: true as const, mutation: originalMutation }
      : { operation, historical: true as const, deleted: [oldPath], failed: [], trashEntries: [] };
    const lostReply = new Error(`Unit first ${suffix} reply was lost.`);
    const actions: Array<Record<string, unknown>> = [], treeReads: string[] = [];
    let previews = 0, replay = false;
    let currentChildren: FileNode[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'https://canvas.test');
      assert.equal(new Headers(init?.headers).get(WORKSPACE_ID_HEADER), 'ws-a');
      assert.equal(init?.credentials, 'include');
      if (url.pathname === '/api/files/tree') {
        assert(replay, 'no directory read may precede the explicit historical retry');
        assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.cache, 'no-store');
        assert.equal(url.searchParams.get('path'), 'docs'); assert.equal(url.searchParams.get('workspaceId'), 'ws-a');
        assert.match(url.searchParams.get('noCache') ?? '', /^\d+$/u); treeReads.push(url.pathname);
        return Response.json({ success: true, data: currentChildren });
      }
      assert.equal(url.pathname, kind === 'rename' ? '/api/files/rename' : '/api/files/delete');
      assert.equal(init?.method, kind === 'rename' ? 'POST' : 'DELETE');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const selectedRequest = kind === 'rename' ? { oldPath, newPath } : { path: [oldPath] };
      if (body.dryRun === true) {
        previews++; assert.deepEqual(body, { ...selectedRequest, dryRun: true });
        assert.equal(replay, false, 'the original unknown key must not re-preview a later D2');
        return Response.json({ dryRun: true, requiresRevalidation: true, plan: {
          planId, workspaceId: 'ws-a',
          ...(prepared ? { version: 1, kind: 'native-path-import-preparation', executionReady: false,
            readiness: 'requires-import-rebinding', imports: [{ path: oldPath, reasons: ['selected'] }], physicalLinkChanges: [] }
            : { version: kind === 'rename' ? 3 : 2, kind: kind === 'rename' ? 'native-path-change' : 'native-original-delete', readiness: 'ready' }),
          pathMappings: kind === 'rename' ? [{ sourcePath: oldPath, destinationPath: newPath }] : [], linkEdits: [],
          coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
        } });
      }
      assert.match(String(body.idempotencyKey), /^[a-f0-9-]{36}$/u);
      assert.deepEqual(body, { ...selectedRequest, ...(kind === 'rename' ? { overwrite: false } : {}),
        planId, idempotencyKey: body.idempotencyKey }); actions.push(body);
      if (!replay) throw lostReply;
      assert.deepEqual(body, actions[0], 'same operation key and original preview plan must survive the lost response');
      return Response.json(originalReply);
    };
    await assert.rejects(kind === 'rename'
      ? useFileStore.getState().renamePath(oldPath, newPath, false, true, 'ws-a')
      : useFileStore.getState().deletePath(oldPath, 'ws-a'), error => error === lostReply);
    assert.equal(previews, 1); assert.equal(actions.length, 1); assert.equal(treeReads.length, 0);

    // Fixture publication of today's replacement is data setup, never a method
    // override. A clean current draft avoids conflating replay with edit saving.
    const d2Text = `Today's distinct D2 content and draft ${suffix}`;
    const d2Node: FileNode = { path: oldPath, name: oldNode.name, type: 'file', title: `Replacement D2 ${suffix}`, modified: 200, size: d2Text.length };
    const d2File: CurrentFile = { path: oldPath, content: d2Text, viewId: `d2-${suffix}`, editorIdentity: `d2-editor-${suffix}`,
      stats: { size: d2Text.length, modified: 200, fileVersion: `unit-d2-${suffix}` } };
    currentChildren = [d2Node, ...(kind === 'rename' ? [{ ...oldNode, path: newPath, name: newPath.split('/').at(-1)! }] : [])];
    const selected = new Set([oldPath]);
    useFileStore.setState({ fileTree: [{ path: 'docs', name: 'docs', type: 'directory', children: currentChildren }],
      currentFile: d2File, currentFileWorkspaceId: 'ws-a', selectedNode: d2Node,
      multiSelectPaths: selected, isMultiSelectMode: true, currentDirectory: 'docs', expandedDirs: new Set(['docs']) });
    useEditorStore.getState().setActiveFile(oldPath, d2Text);
    const editor = useEditorStore.getState(), violations: string[] = [];
    let observedFileTransitions = 0;
    const stopFile = useFileStore.subscribe(state => {
      observedFileTransitions++;
      if (JSON.stringify(findNodeInTree(oldPath, state.fileTree)) !== JSON.stringify(d2Node)) violations.push('D2 tree changed');
      if (state.currentFile !== d2File || state.currentFile?.path !== oldPath) violations.push('D2 file adopted original replay');
      if (state.selectedNode !== d2Node || state.multiSelectPaths !== selected) violations.push('D2 selection changed');
    });
    const stopEditor = useEditorStore.subscribe(state => {
      if (state.activePath !== oldPath || state.draft !== d2Text || state.sessionId !== editor.sessionId) violations.push('D2 editor changed');
    });
    replay = true;
    try {
      const result = kind === 'rename'
        ? await useFileStore.getState().renamePath(oldPath, newPath, false, true, 'ws-a')
        : await useFileStore.getState().deletePath(oldPath, 'ws-a');
      assert(result); assert.equal(result.historical, true); assert.deepEqual(result.operation, operation);
      assert.equal(previews, 1); assert.equal(actions.length, 2); assert.deepEqual(actions[1], actions[0]);
      assert.equal(treeReads.length, 1, 'only the actual current parent directory is reloaded');
      assert.equal(useFileStore.getState().directoryErrors.docs, undefined); assert(observedFileTransitions > 0);
      assert.deepEqual(violations, [], 'no transient optimistic replay may alter or clear D2 before revalidation');
      assert.deepEqual(findNodeInTree(oldPath, useFileStore.getState().fileTree), d2Node);
      assert.equal(useFileStore.getState().currentFile, d2File); assert.equal(useFileStore.getState().currentFile?.path, oldPath);
      assert.equal(useFileStore.getState().selectedNode, d2Node); assert.equal(useFileStore.getState().multiSelectPaths, selected);
      assert.equal(useEditorStore.getState().activePath, oldPath); assert.equal(useEditorStore.getState().draft, d2Text);
      assert.equal(useEditorStore.getState().sessionId, editor.sessionId); assert.equal(useEditorStore.getState().isDirty, false);
      const after = useFileStore.getState();
      assert.deepEqual({ rename: after.renamePath, remove: after.deletePath, refresh: after.refreshDirectory,
        load: after.loadSubdirectory, prepare: after.prepareCurrentFileForTransition,
        applyRename: after.applyPathRename, applyDelete: after.applyPathsDeleted }, actualMethods);
    } finally { stopFile(); stopEditor(); }
  }
  console.log(JSON.stringify({ suite: 'notebook-path-mutations-historical-d2', families: 2, cases: 4,
    scope: 'actual client/store, prepared and ordinary HTTP unit fixtures; no backend/receipt/browser acceptance' }));
  console.log('notebook-path-mutations-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
